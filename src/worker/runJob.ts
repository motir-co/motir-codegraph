/**
 * One claimed job, from its row to its recorded outcome, in
 * `docs/commit-layers.md` §2's order: fetch and hash the commit's tree, run
 * the pre-layer checks, open the layer with the WHOLE tree, store the blobs
 * the tenant lacks, publish with the job's ref, end the job.
 *
 * Every database write runs in a transaction bound to the job's tenant and as
 * the job's client: the claim is the only statement that is not, and it is the
 * loop's. A lost lease (another claim took the row) writes nothing more; a
 * lost grant (the binding reads unbound) can write nothing at all. Every exit
 * deletes the job's scratch directory, and the fetch URL is a secret for the
 * whole run: it never reaches a log line or a recorded message.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type pg from 'pg';

import type { LayerSettings, WorkerSettings } from '../config.js';
import { listMissingBlobHashes } from '../db/blobs.js';
import { ClaimLostError, endJob, readJob, type JobEnd, type JobRow } from '../db/indexJobs.js';
import { listCurrentPublishedCommits } from '../db/layers.js';
import { GrantLostError, inClaimTransaction, renewLease, type Claim } from '../db/workerJobs.js';
import { storeBlob, type StoreBlobOptions } from '../indexing/storeBlob.js';
import { openLayer, type OpenedLayer } from '../layers/openLayer.js';
import {
  LayerNotPublishableError,
  publishLayer,
  PublishUnboundError,
  UnstoredBlobsError,
  type PublishedLayer,
} from '../layers/publish.js';
import { fanOutJob, type MissingBlob } from './fanOut.js';
import {
  enqueueCompactionIfDue,
  runMaintenanceJob,
  type MaintenanceAnswer,
} from './maintenance.js';
import { PRE_LAYER_CHECKS, runPreLayerChecks, type PreLayerCheck } from './preLayerCheck.js';

/** Published commits offered as ancestors after a job's own, at most. */
export const CANDIDATE_ANCESTOR_LIMIT = 16;

/** Hashes per missing-blob read. */
const MISSING_READ_CHUNK = 1_000;

/** The reason codes a job can end `failed` with here, besides a pre-layer check's own. */
export const JOB_FAILURE_CODES = [
  'fetch_failed',
  'not_https',
  'address_refused',
  'source_too_large',
  'fetch_timeout',
  'binding_refused',
  'layer_unpublishable',
  'internal_error',
] as const;

/** A fetched, hashed tree on scratch disk. */
export interface FetchedSource {
  /** Tree path → git blob id. */
  readonly paths: ReadonlyMap<string, string>;
  /** Tree path → bytes. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** The tree's root: `join(root, ...path.split('/'))` is that file. */
  readonly root: string;
}

/** The fetch step's answer: the tree, or a refusal with its reason code. */
export type FetchOutcome =
  | { readonly ok: true; readonly tree: FetchedSource }
  | { readonly ok: false; readonly reasonCode: string; readonly message: string };

/** Fetches `url` into `dir`. Bound to the real fetcher in `main.ts`; injected in tests. */
export type FetchStep = (target: {
  readonly url: string;
  readonly dir: string;
}) => Promise<FetchOutcome>;

/** A JSON-lines logger: fields first, then the message. */
export interface WorkerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface RunJobDeps {
  /** A `codegraph_app` pool. */
  readonly pool: pg.Pool;
  readonly settings: WorkerSettings;
  readonly layerSettings: Pick<
    LayerSettings,
    'hardCeiling' | 'compactionThreshold' | 'stagedLayerStaleness'
  >;
  readonly fetch: FetchStep;
  readonly log: WorkerLogger;
  /** The pre-layer checks; `PRE_LAYER_CHECKS` when omitted. */
  readonly checks?: readonly PreLayerCheck[];
  /** Passed to every `storeBlob` call. */
  readonly storeOptions?: StoreBlobOptions;
}

/** How a run ended, as the loop sees it. */
export type RunResult =
  | { readonly outcome: 'succeeded'; readonly storedBlobs: number }
  | { readonly outcome: 'failed'; readonly reasonCode: string }
  /** Another claim holds the row now: nothing more was written. */
  | { readonly outcome: 'lease_lost' }
  /** The job's client holds no live grant: the row can be neither read nor written. */
  | { readonly outcome: 'grant_lost' }
  /** A maintenance job ran its library call; `answer` is what the library said. */
  | { readonly outcome: 'maintained'; readonly answer: MaintenanceAnswer }
  /** The job's missing blobs were written as `batches` batch rows; the job runs on in them. */
  | { readonly outcome: 'fanned_out'; readonly batches: number }
  /**
   * A claimed batch stored its slice. `finalised` is the job's outcome when
   * this claimant was its finaliser, and null when other batches remained.
   */
  | {
      readonly outcome: 'batch_stored';
      readonly storedBlobs: number;
      readonly finalised: RunResult | null;
    };

/** A step's refusal: ends the job `failed` with this code. */
export class JobFailure extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = 'JobFailure';
    this.reasonCode = reasonCode;
  }
}

/** The lease moved on at a checkpoint: this run must write nothing more. */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`The lease on job ${jobId} was lost; another claim holds it.`);
    this.name = 'LeaseLostError';
  }
}

/** One claimed request job, read back under its own binding. */
export interface ClaimedJob extends JobRow {
  readonly commitSha: string;
  readonly refName: string;
  readonly fetchUrl: string;
}

/** Replaces the fetch URL, and its query string, wherever `text` carries them. */
export function redactFetchUrl(text: string, fetchUrl: string | null): string {
  if (fetchUrl === null || fetchUrl === '') return text;
  const secrets = [fetchUrl];
  if (URL.canParse(fetchUrl)) {
    const url = new URL(fetchUrl);
    secrets.push(url.href);
    if (url.search.length > 1) secrets.push(url.search.slice(1));
  }
  let redacted = text;
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join('[fetch-url]');
  }
  return redacted;
}

/** The job's scratch directory: one per job, under `SCRATCH_DIR`. */
export function scratchDirFor(settings: Pick<WorkerSettings, 'scratchDir'>, jobId: string): string {
  return join(settings.scratchDir, `job-${jobId}`);
}

/** Deletes a job's scratch directory and everything under it; absent is fine. */
export async function discardScratch(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function scopeOf(claim: Pick<Claim, 'tenantId' | 'repositoryId'>) {
  return { tenantId: claim.tenantId, repositoryId: claim.repositoryId };
}

export function idsOf(claim: Claim, job?: JobRow | null): Record<string, unknown> {
  return {
    jobId: claim.jobId,
    tenantId: claim.tenantId,
    repositoryId: claim.repositoryId,
    ...(job === undefined || job === null
      ? {}
      : { kind: job.kind, commit: job.commitSha, ref: job.refName }),
  };
}

/** A lease checkpoint: renews the job's lease, or raises `LeaseLostError`. */
export async function checkpoint(deps: RunJobDeps, claim: Claim): Promise<void> {
  const held = await inClaimTransaction(deps.pool, claim, (db) =>
    renewLease(db, scopeOf(claim), claim.jobId, claim.claimedBy, deps.settings.jobLeaseMs),
  );
  if (!held) throw new LeaseLostError(claim.jobId);
}

/**
 * The claimed row, read under the claim's own binding. Raises
 * `GrantLostError` when the binding reads unbound, and `LeaseLostError` when
 * the row is not running under this claim's token.
 */
export async function readClaimedJob(deps: RunJobDeps, claim: Claim): Promise<JobRow> {
  const job = await inClaimTransaction(deps.pool, claim, (db) =>
    readJob(db, scopeOf(claim), claim.jobId),
  );
  if (job?.state !== 'running' || job.claimedBy !== claim.claimedBy) {
    throw new LeaseLostError(claim.jobId);
  }
  return job;
}

/** A request job's three required fields, present by the table's own check. */
export function requestJob(job: JobRow): ClaimedJob {
  /* v8 ignore next 3 -- the table's checks keep all three on a running request job */
  if (job.commitSha === null || job.refName === null || job.fetchUrl === null) {
    throw new JobFailure('internal_error', `Job ${job.id} carries no commit, ref or fetch URL.`);
  }
  return job as ClaimedJob;
}

/** Fetches and hashes the job's tree into `dir`; a refusal ends the job with its code. */
export async function fetchJobTree(
  deps: RunJobDeps,
  job: ClaimedJob,
  dir: string,
): Promise<FetchedSource> {
  await mkdir(dir, { recursive: true });
  const outcome = await deps.fetch({ url: job.fetchUrl, dir });
  if (!outcome.ok) throw new JobFailure(outcome.reasonCode, outcome.message);
  return outcome.tree;
}

/** Runs the pre-layer checks on the fetched tree; a refusal ends the job with its code. */
export async function applyPreLayerChecks(
  deps: RunJobDeps,
  job: ClaimedJob,
  tree: FetchedSource,
): Promise<void> {
  const outcome = await runPreLayerChecks(
    {
      tenantId: job.tenantId,
      repositoryId: job.repositoryId,
      commitSha: job.commitSha,
      refName: job.refName,
      isDefaultBranch: job.isDefaultBranch,
      tree: {
        paths: tree.paths,
        sizes: tree.sizes,
        fileCount: tree.fileCount,
        totalBytes: tree.totalBytes,
      },
    },
    deps.checks ?? PRE_LAYER_CHECKS,
  );
  if (!outcome.ok) throw new JobFailure(outcome.reasonCode, outcome.message);
}

/**
 * The job's own candidates first, then the repository's current published
 * commits newest published first (at most `CANDIDATE_ANCESTOR_LIMIT`), without
 * repeats and without the job's own commit. The service keeps no clone, so its
 * indexed commits are the only ancestry it can offer a job that carries none.
 */
export async function candidateAncestors(
  deps: RunJobDeps,
  claim: Claim,
  job: ClaimedJob,
): Promise<string[]> {
  const published = await inClaimTransaction(deps.pool, claim, (db) =>
    listCurrentPublishedCommits(db, scopeOf(claim), CANDIDATE_ANCESTOR_LIMIT),
  );
  const seen = new Set<string>([job.commitSha]);
  const candidates: string[] = [];
  for (const sha of [...job.candidateAncestors, ...published]) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    candidates.push(sha);
  }
  return candidates;
}

/** The blobs the opened layer names that the tenant lacks, one path per hash, in layer order. */
export async function missingBlobs(
  deps: RunJobDeps,
  claim: Claim,
  opened: OpenedLayer,
): Promise<MissingBlob[]> {
  const pathOf = new Map<string, string>();
  for (const entry of opened.entries) {
    if (entry.gitBlobHash !== null && !pathOf.has(entry.gitBlobHash)) {
      pathOf.set(entry.gitBlobHash, entry.path);
    }
  }
  const hashes = [...pathOf.keys()];
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += MISSING_READ_CHUNK) {
    const chunk = hashes.slice(i, i + MISSING_READ_CHUNK);
    missing.push(
      ...(await inClaimTransaction(deps.pool, claim, (db) =>
        listMissingBlobHashes(db, claim.tenantId, chunk),
      )),
    );
  }
  return missing.map((hash) => ({ hash, path: pathOf.get(hash) as string }));
}

/**
 * Stores, through `storeBlob`, every blob the opened layer names that the
 * tenant does not hold (`missing`, when the caller has already read it), in
 * passes of `BLOB_STORE_BATCH_SIZE`, renewing the lease between passes.
 * Answers how many blobs it created.
 */
export async function storeMissingBlobs(
  deps: RunJobDeps,
  claim: Claim,
  opened: OpenedLayer,
  tree: FetchedSource,
  missing?: readonly MissingBlob[],
): Promise<number> {
  missing ??= await missingBlobs(deps, claim, opened);
  const pass = deps.settings.blobStoreBatchSize;
  let created = 0;
  for (let i = 0; i < missing.length; i += pass) {
    if (i > 0) await checkpoint(deps, claim);
    const client = await deps.pool.connect();
    try {
      for (const { path, hash } of missing.slice(i, i + pass)) {
        const bytes = await readFile(join(tree.root, ...path.split('/')));
        const stored = await storeBlob(
          client,
          { tenantId: claim.tenantId, clientId: claim.clientId, gitBlobHash: hash, path, bytes },
          deps.storeOptions,
        );
        if (!stored.alreadyStored) created += 1;
      }
    } finally {
      client.release();
    }
  }
  return created;
}

/**
 * Publishes the opened layer with the job's ref. A layer refused for an
 * unstored blob is stored once more and published again, as
 * `docs/commit-layers.md` §3 asks; a second refusal ends the job
 * `layer_unpublishable`. Answers the publish and the blobs the retry created.
 */
export async function publishJobLayer(
  deps: RunJobDeps,
  claim: Claim,
  job: ClaimedJob,
  opened: OpenedLayer,
  tree: FetchedSource,
): Promise<{ published: PublishedLayer; storedOnRetry: number }> {
  const publish = () =>
    publishLayer(deps.pool, {
      tenantId: claim.tenantId,
      clientId: claim.clientId,
      repositoryId: claim.repositoryId,
      layerId: opened.layerId,
      ref: { name: job.refName, isDefaultBranch: job.isDefaultBranch },
    });
  await checkpoint(deps, claim);
  try {
    return { published: await publish(), storedOnRetry: 0 };
  } catch (error) {
    if (!(error instanceof UnstoredBlobsError)) throw error;
  }
  const storedOnRetry = await storeMissingBlobs(deps, claim, opened, tree);
  await checkpoint(deps, claim);
  try {
    return { published: await publish(), storedOnRetry };
  } catch (error) {
    if (error instanceof UnstoredBlobsError) {
      throw new JobFailure('layer_unpublishable', error.message);
    }
    throw error;
  }
}

/** What a job's runner did: stored and published, or fanned the store out into batches. */
export type RunnerOutcome = { readonly storedBlobs: number } | { readonly fannedOut: number };

/** The three request kinds share one run: they differ only in the candidates they carry. */
async function runRequestJob(
  deps: RunJobDeps,
  claim: Claim,
  row: JobRow,
  dir: string,
): Promise<RunnerOutcome> {
  const job = requestJob(row);
  const tree = await fetchJobTree(deps, job, dir);
  await checkpoint(deps, claim);
  await applyPreLayerChecks(deps, job, tree);
  const opened = await openLayer(deps.pool, {
    clientId: claim.clientId,
    tenantId: claim.tenantId,
    repositoryId: claim.repositoryId,
    commitSha: job.commitSha,
    refName: job.refName,
    isDefaultBranch: job.isDefaultBranch,
    candidateAncestors: await candidateAncestors(deps, claim, job),
    // The WHOLE tree, never `changed_paths`: a partial map is a commit that
    // deleted every path it left out.
    paths: tree.paths,
    settings: deps.layerSettings,
  });
  const missing = await missingBlobs(deps, claim, opened);
  // Too many for one pass: the batches store them, and their last one publishes.
  const verdict = await fanOutJob(deps, claim, opened, missing);
  if (verdict.fannedOut) return { fannedOut: verdict.batches };
  const stored = await storeMissingBlobs(deps, claim, opened, tree, missing);
  const { storedOnRetry } = await publishJobLayer(deps, claim, job, opened, tree);
  return { storedBlobs: stored + storedOnRetry };
}

/** A job's run, by kind. A kind with no entry ends the job `internal_error`, naming it. */
export type JobRunner = (
  deps: RunJobDeps,
  claim: Claim,
  job: JobRow,
  dir: string,
) => Promise<RunnerOutcome>;

export const JOB_RUNNERS: Readonly<Record<string, JobRunner | undefined>> = {
  first_index: runRequestJob,
  push: runRequestJob,
  refresh: runRequestJob,
};

/** The reason code and message a thrown error ends the job with. */
export function failureOf(error: unknown): { reasonCode: string; message: string } {
  if (error instanceof JobFailure) return { reasonCode: error.reasonCode, message: error.message };
  if (error instanceof PublishUnboundError) {
    return { reasonCode: 'binding_refused', message: error.message };
  }
  if (error instanceof LayerNotPublishableError) {
    return { reasonCode: 'layer_unpublishable', message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { reasonCode: 'internal_error', message };
}

/** Ends the job in one bound transaction; false when the claim no longer holds it. */
export async function endClaimedJob(deps: RunJobDeps, claim: Claim, end: JobEnd): Promise<boolean> {
  try {
    await inClaimTransaction(deps.pool, claim, (db) =>
      endJob(db, scopeOf(claim), claim.jobId, claim.claimedBy, end),
    );
    return true;
  } catch (error) {
    if (error instanceof ClaimLostError) return false;
    throw error;
  }
}

/**
 * Ends a job `succeeded` and, in the SAME bound transaction, enqueues a
 * `compact` job for its commit when the publish left the commit's current
 * layer deeper than the compaction threshold. False when the claim no longer
 * holds the job, in which case nothing is written.
 */
export async function endJobSucceeded(
  deps: RunJobDeps,
  claim: Claim,
  job: JobRow,
): Promise<boolean> {
  try {
    await inClaimTransaction(deps.pool, claim, async (db) => {
      await endJob(db, scopeOf(claim), claim.jobId, claim.claimedBy, { state: 'succeeded' });
      const compactJobId = await enqueueCompactionIfDue(db, deps.layerSettings, job);
      if (compactJobId !== null) {
        deps.log.info({ ...idsOf(claim, job), compactJobId }, 'compaction enqueued');
      }
    });
    return true;
  } catch (error) {
    if (error instanceof ClaimLostError) return false;
    throw error;
  }
}

/**
 * Runs one claimed job to its recorded outcome. Never throws for the job's
 * own failure: a refusal or an error ends the row `failed` with its reason
 * (when the claim still holds it), a lost lease or grant writes nothing, and
 * the scratch directory is deleted on every exit.
 */
export async function runJob(deps: RunJobDeps, claim: Claim): Promise<RunResult> {
  const dir = scratchDirFor(deps.settings, claim.jobId);
  let job: JobRow | null = null;
  try {
    try {
      job = await readClaimedJob(deps, claim);
      deps.log.info(idsOf(claim, job), 'job started');
      const maintained = await runMaintenanceJob(deps, claim, job);
      if (maintained.handled) {
        const { answer } = maintained;
        if (!(await endClaimedJob(deps, claim, { state: 'succeeded' }))) {
          throw new LeaseLostError(claim.jobId);
        }
        deps.log.info(
          { ...idsOf(claim, job), outcome: summary(answer) },
          'maintenance job succeeded',
        );
        return { outcome: 'maintained', answer };
      }
      const runner = JOB_RUNNERS[job.kind];
      if (runner === undefined) {
        throw new JobFailure('internal_error', `No runner is registered for job kind ${job.kind}.`);
      }
      const ran = await runner(deps, claim, job, dir);
      if ('fannedOut' in ran) {
        deps.log.info({ ...idsOf(claim, job), batches: ran.fannedOut }, 'job fanned out');
        return { outcome: 'fanned_out', batches: ran.fannedOut };
      }
      const { storedBlobs } = ran;
      if (!(await endJobSucceeded(deps, claim, job))) {
        throw new LeaseLostError(claim.jobId);
      }
      deps.log.info({ ...idsOf(claim, job), storedBlobs }, 'job succeeded');
      return { outcome: 'succeeded', storedBlobs };
    } catch (error) {
      return await settle(deps, claim, job, error);
    }
  } finally {
    await discardScratch(dir);
  }
}

/** A maintenance answer in one loggable line. */
function summary(answer: MaintenanceAnswer): string {
  switch (answer.kind) {
    case 'compact':
      return answer.result.outcome;
    case 'discard_stale':
      return `${String(answer.result.layerIds.length)} layer(s) discarded`;
    case 'release':
      return `${String(answer.result.layerIds.length)} layer(s), ${String(answer.result.blobHashes.length)} blob(s) released`;
  }
}

/**
 * Records a run's outcome from what it threw: a lost grant or lease writes
 * nothing; anything else ends the job `failed` with its reason code and a
 * message with the fetch URL redacted, when the claim still holds it.
 */
export async function settle(
  deps: RunJobDeps,
  claim: Claim,
  job: JobRow | null,
  error: unknown,
): Promise<RunResult> {
  if (error instanceof GrantLostError) {
    deps.log.warn(idsOf(claim, job), 'job abandoned: its client holds no live grant on the tenant');
    return { outcome: 'grant_lost' };
  }
  if (error instanceof LeaseLostError) {
    deps.log.warn(idsOf(claim, job), 'job abandoned: its lease was lost to another claim');
    return { outcome: 'lease_lost' };
  }
  const failure = failureOf(error);
  const message = redactFetchUrl(failure.message, job?.fetchUrl ?? null);
  let ended: boolean;
  try {
    ended = await endClaimedJob(deps, claim, {
      state: 'failed',
      reasonCode: failure.reasonCode,
      message,
    });
  } catch (endError) {
    if (endError instanceof GrantLostError) return await settle(deps, claim, job, endError);
    throw endError;
  }
  if (!ended) return await settle(deps, claim, job, new LeaseLostError(claim.jobId));
  deps.log.error({ ...idsOf(claim, job), reasonCode: failure.reasonCode, message }, 'job failed');
  return { outcome: 'failed', reasonCode: failure.reasonCode };
}
