/**
 * The maintenance kinds' two reads and one write over the queue, beside
 * `src/db/indexJobs.ts` (whose `enqueueJob` is the insert): whether a
 * repository is due a discard or a release, and the enqueue that refuses a
 * duplicate of a job already queued or running.
 *
 * THE CALLER'S TRANSACTION, NEVER OURS. Both functions run on the client they
 * are handed, inside a transaction the caller has bound to the job's tenant
 * and client with `BIND_TENANT_SQL`; each asserts that binding before its
 * first read, and neither selects, claims or ends a job.
 */
import type pg from 'pg';

import { listSupersededLayerIds } from './release.js';
import { enqueueJob, JobNotWritableError, type JobRow, type JobScope } from './indexJobs.js';

/** The three maintenance kinds a worker runs. Re-extraction is not one: it runs on the owner login. */
export const MAINTENANCE_KINDS = ['compact', 'discard_stale', 'release'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

/** True for a job kind the worker's maintenance runner owns. */
export function isMaintenanceKind(kind: string): kind is MaintenanceKind {
  return (MAINTENANCE_KINDS as readonly string[]).includes(kind);
}

/** Which tick-enqueued kinds one repository is due. */
export interface MaintenanceDue {
  /** A staged layer of the repository was staged before the cutoff. */
  readonly discardStale: boolean;
  /** A layer of the repository is releasable. */
  readonly release: boolean;
}

/** One maintenance job to enqueue. Only `compact` names a commit. */
export interface NewMaintenanceJob extends JobScope {
  /** The client the job is bound as when it runs: the enqueuing job's own. */
  readonly clientId: string;
  readonly kind: MaintenanceKind;
  readonly commitSha?: string;
}

const BOUND_TENANT_SQL = 'SELECT codegraph.codegraph_bound_tenant() AS tenant';

// For this repository alone: a tenant-wide page of the oldest staged layers
// would hide a repository whose stale layer sits behind a page of others.
const STALE_STAGED_SQL = `SELECT EXISTS (
    SELECT 1 FROM codegraph.commit_layers
    WHERE tenant_id = $1 AND repository_id = $2 AND state = 'staged' AND staged_at < $3
  ) AS due`;

// Serialises two ticks (or two publishes) deciding the same job at once, so
// the read below and the insert after it cannot both pass for two of them.
const LOCK_MAINTENANCE_KEY_SQL = `SELECT pg_advisory_xact_lock(
    hashtext('codegraph.index_jobs.maintenance:' || $1::text || ':' || $2::text || ':'
             || $3::text || ':' || COALESCE($4::text, '')))`;

const PENDING_SQL = `SELECT EXISTS (
    SELECT 1 FROM codegraph.index_jobs
    WHERE tenant_id = $1 AND repository_id = $2 AND kind = $3
      AND state IN ('queued', 'running') AND commit_sha IS NOT DISTINCT FROM $4
  ) AS pending`;

async function assertBound(db: pg.ClientBase, tenantId: string): Promise<void> {
  const { rows } = await db.query<{ tenant: string | null }>(BOUND_TENANT_SQL);
  if (rows[0]?.tenant !== tenantId) {
    throw new JobNotWritableError(
      `No maintenance job may be read or written for tenant ${tenantId} in a transaction not bound to it.`,
    );
  }
}

/**
 * Whether this repository has a staged layer staged before `cutoff` (now
 * minus the staleness window, as `discardStaleLayers` computes it) and
 * whether it has a releasable layer, read with the release library's own
 * rule. Two statements, both about this repository alone. Refuses an unbound
 * transaction with `JobNotWritableError`.
 */
export async function maintenanceDue(
  db: pg.ClientBase,
  scope: JobScope,
  cutoff: Date,
): Promise<MaintenanceDue> {
  await assertBound(db, scope.tenantId);
  const { rows } = await db.query<{ due: boolean }>(STALE_STAGED_SQL, [
    scope.tenantId,
    scope.repositoryId,
    cutoff,
  ]);
  const releasable = await listSupersededLayerIds(db, scope.tenantId, 1, {
    repositoryId: scope.repositoryId,
  });
  return { discardStale: rows[0]?.due === true, release: releasable.length > 0 };
}

/**
 * Enqueues one maintenance job unless one of the same kind is already queued
 * or running for the same repository (and, for `compact`, the same commit),
 * and answers the new row, or null when a pending one made it a duplicate.
 * The check and the insert hold a transaction-scoped advisory lock on that
 * key, so two callers cannot both enqueue it. Refuses an unbound transaction
 * with `JobNotWritableError`.
 */
export async function enqueueMaintenanceJob(
  db: pg.ClientBase,
  job: NewMaintenanceJob,
): Promise<JobRow | null> {
  await assertBound(db, job.tenantId);
  const key = [job.tenantId, job.repositoryId, job.kind, job.commitSha ?? null];
  await db.query(LOCK_MAINTENANCE_KEY_SQL, key);
  const { rows } = await db.query<{ pending: boolean }>(PENDING_SQL, key);
  if (rows[0]?.pending === true) return null;
  return await enqueueJob(db, {
    tenantId: job.tenantId,
    repositoryId: job.repositoryId,
    clientId: job.clientId,
    kind: job.kind,
    commitSha: job.commitSha ?? null,
  });
}
