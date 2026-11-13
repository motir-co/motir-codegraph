/**
 * The three repository-scoped maintenance kinds as jobs of the queue:
 * `compact`, `discard_stale` and `release`. A claimed job of one of them is run
 * here by calling its library (`src/layers/compact.ts`, `discard.ts`,
 * `release.ts`) bound as the client its row carries; the libraries own every
 * lock, guard and repeat, and a second run of any of them changes nothing.
 *
 * Where each is enqueued, once: `compact` by the request job's successful end,
 * when the commit's current layer is deeper than the compaction threshold
 * (`enqueueCompactionIfDue`); `discard_stale` and `release` by the worker's
 * tick for the repository of the job it just ran (`runMaintenanceTick`).
 * Re-extraction is not one of them: it runs on the owner login across every
 * tenant (`pnpm reextract`), which no job row could carry.
 *
 * Every statement here runs in a transaction bound with `BIND_TENANT_SQL`, and
 * nothing here selects or claims a job: the runner is handed a claimed row.
 */
import type pg from 'pg';

import type { LayerSettings, MaintenanceSettings } from '../config.js';
import type { JobRow, JobScope } from '../db/indexJobs.js';
import { readCurrentPublishedLayer } from '../db/layers.js';
import {
  enqueueMaintenanceJob,
  isMaintenanceKind,
  maintenanceDue,
  type MaintenanceKind,
} from '../db/maintenanceJobs.js';
import { inClaimTransaction, renewLease, type Claim } from '../db/workerJobs.js';
import { compactLayer, isCompactionDue, type CompactionResult } from '../layers/compact.js';
import { discardStaleLayers, TenantNotBoundError, type DiscardResult } from '../layers/discard.js';
import { releaseTenant, ReleaseTenantUnboundError, type ReleaseReport } from '../layers/release.js';
import { JobFailure, type WorkerLogger } from './runJob.js';

/** The layer settings the maintenance kinds use. */
export type MaintenanceLayerSettings = Pick<
  LayerSettings,
  'compactionThreshold' | 'stagedLayerStaleness'
>;

/** What a maintenance run needs from the worker. */
export interface MaintenanceDeps {
  /** A `codegraph_app` pool. */
  readonly pool: pg.Pool;
  readonly layerSettings: MaintenanceLayerSettings;
  /** The lease the run renews while the library works. */
  readonly settings: { readonly jobLeaseMs: number };
}

/** What a maintenance job's library answered, by kind. */
export type MaintenanceAnswer =
  | { readonly kind: 'compact'; readonly result: CompactionResult }
  | { readonly kind: 'discard_stale'; readonly result: DiscardResult }
  | { readonly kind: 'release'; readonly result: ReleaseReport };

/** `runMaintenanceJob`'s answer: the library's, or that the kind is not maintenance. */
export type MaintenanceOutcome =
  { readonly handled: false } | { readonly handled: true; readonly answer: MaintenanceAnswer };

/** The answer for a kind this module does not run. */
export const NOT_HANDLED: MaintenanceOutcome = { handled: false };

/**
 * Renews the job's lease every third of it while `fn` runs, so a long sweep
 * is not returned to the queue under itself. A renewal that finds the lease
 * gone is left to the run's end, which then writes nothing.
 */
async function withLeaseHeartbeat<T>(
  deps: MaintenanceDeps,
  claim: Claim,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = { tenantId: claim.tenantId, repositoryId: claim.repositoryId };
  let renewing: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    renewing = inClaimTransaction(deps.pool, claim, (db) =>
      renewLease(db, scope, claim.jobId, claim.claimedBy, deps.settings.jobLeaseMs),
    ).catch(() => undefined);
  }, deps.settings.jobLeaseMs / 3);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await renewing;
  }
}

/** Calls the job's library, mapping a refused binding to `binding_refused`. */
async function callLibrary(deps: MaintenanceDeps, job: JobRow): Promise<MaintenanceAnswer> {
  const bound = { tenantId: job.tenantId, clientId: job.clientId };
  try {
    switch (job.kind as MaintenanceKind) {
      case 'compact':
        return {
          kind: 'compact',
          result: await compactLayer(deps.pool, {
            ...bound,
            repositoryId: job.repositoryId,
            commitSha: job.commitSha as string,
            settings: deps.layerSettings,
          }),
        };
      case 'discard_stale':
        return {
          kind: 'discard_stale',
          result: await discardStaleLayers(deps.pool, {
            ...bound,
            repositoryId: job.repositoryId,
            settings: deps.layerSettings,
          }),
        };
      case 'release':
        return {
          kind: 'release',
          result: await releaseTenant(deps.pool, { ...bound, repositoryId: job.repositoryId }),
        };
    }
  } catch (error) {
    if (error instanceof TenantNotBoundError || error instanceof ReleaseTenantUnboundError) {
      throw new JobFailure('binding_refused', error.message);
    }
    throw error;
  }
}

/**
 * Runs a claimed maintenance job's library call and answers what it said, or
 * `NOT_HANDLED` (running and ending nothing) for any other kind. Every answer
 * of a library is a result, not a fault: `not_due`, `not_indexed` and
 * `no_longer_current` included, the last leaving its staged base to the
 * staleness discard. A refused binding raises `JobFailure` with
 * `binding_refused`, having removed nothing. The caller ends the job.
 */
export async function runMaintenanceJob(
  deps: MaintenanceDeps,
  claim: Claim,
  job: JobRow,
): Promise<MaintenanceOutcome> {
  if (!isMaintenanceKind(job.kind)) return NOT_HANDLED;
  const answer = await withLeaseHeartbeat(deps, claim, () => callLibrary(deps, job));
  return { handled: true, answer };
}

/**
 * The publish path's compaction trigger, in the caller's bound transaction:
 * when the commit's current published layer is deeper than the threshold
 * (the library's own `isCompactionDue`), enqueues one `compact` job for the
 * commit, as the request job's client, unless one is already queued or
 * running for it. Answers the new job's id, or null.
 */
export async function enqueueCompactionIfDue(
  db: pg.ClientBase,
  layerSettings: Pick<LayerSettings, 'compactionThreshold'>,
  job: Pick<JobRow, 'tenantId' | 'repositoryId' | 'clientId' | 'commitSha'>,
): Promise<string | null> {
  if (job.commitSha === null) return null;
  const scope = { tenantId: job.tenantId, repositoryId: job.repositoryId };
  const current = await readCurrentPublishedLayer(db, scope, job.commitSha);
  if (current === null || !isCompactionDue(current.depth, layerSettings.compactionThreshold)) {
    return null;
  }
  const row = await enqueueMaintenanceJob(db, {
    ...scope,
    clientId: job.clientId,
    kind: 'compact',
    commitSha: job.commitSha,
  });
  return row?.id ?? null;
}

/** What one tick looks at: the repository of the job just run, and that job's client. */
export interface TickTarget extends JobScope {
  readonly clientId: string;
}

/** What a tick needs. */
export interface MaintenanceTickDeps {
  readonly pool: pg.Pool;
  readonly layerSettings: Pick<LayerSettings, 'stagedLayerStaleness'>;
  readonly maintenance: MaintenanceSettings;
  readonly log: WorkerLogger;
  /** The clock, for the staleness cutoff. */
  readonly now?: () => Date;
}

/**
 * One maintenance look at one repository, in one transaction bound as the
 * client of the job the worker just ran: enqueues `discard_stale` when a
 * staged layer predates now minus the staleness window, and `release` when a
 * layer is releasable, each unless one is already queued or running, and at
 * most `MAINTENANCE_JOBS_PER_TICK` in all. Answers the kinds it enqueued.
 */
export async function runMaintenanceTick(
  deps: MaintenanceTickDeps,
  target: TickTarget,
): Promise<MaintenanceKind[]> {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - deps.layerSettings.stagedLayerStaleness);
  const scope = { tenantId: target.tenantId, repositoryId: target.repositoryId };
  const enqueued = await inClaimTransaction(deps.pool, target, async (db) => {
    const due = await maintenanceDue(db, scope, cutoff);
    const wanted: MaintenanceKind[] = [];
    if (due.discardStale) wanted.push('discard_stale');
    if (due.release) wanted.push('release');
    const done: MaintenanceKind[] = [];
    for (const kind of wanted) {
      if (done.length >= deps.maintenance.jobsPerTick) break;
      const row = await enqueueMaintenanceJob(db, { ...scope, clientId: target.clientId, kind });
      if (row !== null) done.push(kind);
    }
    return done;
  });
  if (enqueued.length > 0) {
    deps.log.info({ ...scope, enqueued }, 'maintenance jobs enqueued');
  }
  return enqueued;
}
