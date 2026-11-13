/**
 * The database-client layer over the indexing queue's two tables,
 * `codegraph.index_jobs` and `codegraph.index_job_batches`
 * (db/migrations/0010_index_queue.sql): every tenant-bound write and read
 * either table needs, so neither table has a second dialect of SQL elsewhere.
 *
 * THE CALLER'S TRANSACTION, NEVER OURS. Every function takes the client it is
 * handed and runs its statements on it; none of them begins, commits or rolls
 * back. The caller must already be inside a transaction bound to the job's
 * tenant and client (`BIND_TENANT_SQL`), because the tables' policies admit no
 * row otherwise: a row another tenant holds reads as absent, never as an error.
 *
 * What lives elsewhere: the one cross-tenant read, the claim, is the definer
 * function `codegraph.codegraph_claim_index_job`, and its wrapper (`claimNext`)
 * and the job-lease renewal (`renewLease`) are the worker's
 * (src/db/workerJobs.ts).
 *
 * Every value reaches the database as a parameter. A refusal is a typed error,
 * never a silent zero-row answer.
 */
import type pg from 'pg';

/** What a job does. The first three are requests a /v1 call makes; the rest are maintenance. */
export const JobKind = {
  FirstIndex: 'first_index',
  Push: 'push',
  Refresh: 'refresh',
  Compact: 'compact',
  DiscardStale: 'discard_stale',
  Release: 'release',
} as const;
export type JobKind = (typeof JobKind)[keyof typeof JobKind];

/** The kinds a /v1 call enqueues: each carries a commit, a ref and a fetch URL. */
export const REQUEST_KINDS: readonly JobKind[] = [
  JobKind.FirstIndex,
  JobKind.Push,
  JobKind.Refresh,
];

/** Where a job is. `superseded` is a queued push replaced by a newer push of its ref. */
export const JobState = {
  Queued: 'queued',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Superseded: 'superseded',
} as const;
export type JobState = (typeof JobState)[keyof typeof JobState];

/** Where one slice of a job's missing blobs is. */
export const BatchState = {
  Queued: 'queued',
  Running: 'running',
  Stored: 'stored',
  Failed: 'failed',
} as const;
export type BatchState = (typeof BatchState)[keyof typeof BatchState];

/** The failure code a batch is ended with when its job ends under it. */
export const JOB_FAILED = 'job_failed';

/** The tenant and repository every job and batch row belongs to. */
export interface JobScope {
  readonly tenantId: string;
  readonly repositoryId: string;
}

/** One job row, as the table declares it. */
export interface JobRow {
  readonly id: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly clientId: string;
  readonly kind: JobKind;
  readonly commitSha: string | null;
  readonly refName: string | null;
  readonly isDefaultBranch: boolean;
  readonly candidateAncestors: readonly string[];
  readonly changedPaths: readonly string[];
  readonly fetchUrl: string | null;
  readonly state: JobState;
  readonly attempts: number;
  readonly leaseExpiresAt: Date | null;
  readonly claimedBy: string | null;
  readonly failureReasonCode: string | null;
  readonly failureMessage: string | null;
  readonly enqueuedAt: Date;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

/** One batch row, as the table declares it. */
export interface BatchRow {
  readonly id: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly jobId: string;
  readonly ordinal: number;
  readonly paths: readonly string[];
  readonly gitBlobHashes: readonly string[];
  readonly state: BatchState;
  readonly attempts: number;
  readonly leaseExpiresAt: Date | null;
  readonly claimedBy: string | null;
  readonly storedCount: number;
  readonly failureReasonCode: string | null;
  readonly failureMessage: string | null;
  readonly enqueuedAt: Date;
  readonly endedAt: Date | null;
}

/**
 * What enqueuing a job supplies. A request kind names its commit, ref and
 * fetch URL; `compact` names only its commit; `discard_stale` and `release`
 * name neither. The schema refuses any other combination.
 */
export interface NewJob extends JobScope {
  /** The client that enqueues: every later write binds it. */
  readonly clientId: string;
  readonly kind: JobKind;
  readonly commitSha?: string | null;
  readonly refName?: string | null;
  readonly isDefaultBranch?: boolean;
  readonly candidateAncestors?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly fetchUrl?: string | null;
}

/** One slice of a job's missing blobs, paths and hashes position for position. */
export interface NewBatch {
  readonly ordinal: number;
  readonly paths: readonly string[];
  readonly gitBlobHashes: readonly string[];
}

/** How a claimed job ends. `failed` carries a reason code. */
export type JobEnd =
  | { readonly state: 'succeeded' | 'superseded' }
  | { readonly state: 'failed'; readonly reasonCode: string; readonly message?: string | null };

/** How a claimed batch ends. */
export type BatchEnd =
  | { readonly state: 'stored'; readonly storedCount: number }
  | { readonly state: 'failed'; readonly reasonCode: string; readonly message?: string | null };

/** A write the bound transaction may not make: no tenant is bound, or another one is. */
export class JobNotWritableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobNotWritableError';
  }
}

/**
 * A write aimed at a job or batch this claim no longer holds: it is not
 * running, not this repository's, or another claim's token is on it.
 */
export class ClaimLostError extends Error {
  readonly target: 'job' | 'batch';
  readonly id: string;

  constructor(target: 'job' | 'batch', id: string) {
    super(`The ${target} ${id} is not running under this claim.`);
    this.name = 'ClaimLostError';
    this.target = target;
    this.id = id;
  }
}

/** A slice list that repeats an ordinal, or names one the job already has. */
export class DuplicateBatchOrdinalError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job ${jobId} already has a batch at one of these ordinals.`);
    this.name = 'DuplicateBatchOrdinalError';
    this.jobId = jobId;
  }
}

/** The table's columns, aliased to `JobRow`'s names: the one place they are listed. */
const JOB_COLUMNS = `id, tenant_id AS "tenantId", repository_id AS "repositoryId",
  client_id AS "clientId", kind, commit_sha AS "commitSha", ref_name AS "refName",
  is_default_branch AS "isDefaultBranch", candidate_ancestors AS "candidateAncestors",
  changed_paths AS "changedPaths", fetch_url AS "fetchUrl", state, attempts,
  lease_expires_at AS "leaseExpiresAt", claimed_by AS "claimedBy",
  failure_reason_code AS "failureReasonCode", failure_message AS "failureMessage",
  enqueued_at AS "enqueuedAt", started_at AS "startedAt", ended_at AS "endedAt"`;

const BATCH_COLUMNS = `id, tenant_id AS "tenantId", repository_id AS "repositoryId",
  job_id AS "jobId", ordinal, paths, git_blob_hashes AS "gitBlobHashes", state, attempts,
  lease_expires_at AS "leaseExpiresAt", claimed_by AS "claimedBy",
  stored_count AS "storedCount", failure_reason_code AS "failureReasonCode",
  failure_message AS "failureMessage", enqueued_at AS "enqueuedAt", ended_at AS "endedAt"`;

const INSERT_JOB_SQL = `INSERT INTO codegraph.index_jobs
  (tenant_id, repository_id, client_id, kind, commit_sha, ref_name, is_default_branch,
   candidate_ancestors, changed_paths, fetch_url)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10)
  RETURNING ${JOB_COLUMNS}`;

const SUPERSEDE_PUSHES_SQL = `UPDATE codegraph.index_jobs
  SET state = 'superseded', fetch_url = NULL, ended_at = now()
  WHERE tenant_id = $1 AND repository_id = $2 AND kind = 'push' AND state = 'queued'
    AND ref_name = $3
  RETURNING id`;

const SELECT_JOB_SQL = `SELECT ${JOB_COLUMNS} FROM codegraph.index_jobs
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3`;

const SELECT_BATCH_SQL = `SELECT ${BATCH_COLUMNS} FROM codegraph.index_job_batches
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3`;

const RENEW_BATCH_LEASE_SQL = `UPDATE codegraph.index_job_batches
  SET lease_expires_at = now() + make_interval(secs => $5::double precision / 1000)
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'running' AND claimed_by = $4
  RETURNING ${BATCH_COLUMNS}`;

const END_JOB_SQL = `UPDATE codegraph.index_jobs
  SET state = $5, ended_at = now(), fetch_url = NULL, lease_expires_at = NULL,
      claimed_by = NULL, failure_reason_code = $6, failure_message = $7
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'running' AND claimed_by = $4
  RETURNING ${JOB_COLUMNS}`;

// A job ended by one of its batches carries no token of its own (it is fanned
// out), so this end matches on the state alone.
const FAIL_JOB_SQL = `UPDATE codegraph.index_jobs
  SET state = 'failed', ended_at = now(), fetch_url = NULL, lease_expires_at = NULL,
      claimed_by = NULL, failure_reason_code = $4, failure_message = $5
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state IN ('queued', 'running')`;

const END_UNFINISHED_BATCHES_SQL = `UPDATE codegraph.index_job_batches
  SET state = 'failed', ended_at = now(), lease_expires_at = NULL, claimed_by = NULL,
      failure_reason_code = '${JOB_FAILED}', failure_message = $4
  WHERE tenant_id = $1 AND repository_id = $2 AND job_id = $3
    AND state IN ('queued', 'running')`;

const INSERT_BATCHES_SQL = `INSERT INTO codegraph.index_job_batches
  (tenant_id, repository_id, job_id, ordinal, paths, git_blob_hashes)
  SELECT $1, $2, $3, s.ordinal, s.paths, s.git_blob_hashes
    FROM jsonb_to_recordset($4::jsonb) AS s(ordinal integer, paths text[], git_blob_hashes text[])
  RETURNING ${BATCH_COLUMNS}`;

const STORE_BATCH_SQL = `UPDATE codegraph.index_job_batches
  SET state = 'stored', stored_count = $5, ended_at = now(), lease_expires_at = NULL,
      claimed_by = NULL
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'running' AND claimed_by = $4
  RETURNING ${BATCH_COLUMNS}`;

const FAIL_BATCH_SQL = `UPDATE codegraph.index_job_batches
  SET state = 'failed', ended_at = now(), lease_expires_at = NULL, claimed_by = NULL,
      failure_reason_code = $5, failure_message = $6
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'running' AND claimed_by = $4
  RETURNING ${BATCH_COLUMNS}`;

const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function positiveMs(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`leaseMs must be a positive integer, not ${String(value)}.`);
  }
  return value;
}

/**
 * Writes ONE `queued` job in the caller's transaction and answers the row.
 * Refuses with `JobNotWritableError`, writing nothing, when the transaction is
 * bound to no tenant or to a tenant other than the job's. A kind whose columns
 * disagree with it fails the schema's check (23514).
 */
export async function enqueueJob(db: pg.ClientBase, job: NewJob): Promise<JobRow> {
  let rows: JobRow[];
  try {
    ({ rows } = await db.query<JobRow>(INSERT_JOB_SQL, [
      job.tenantId,
      job.repositoryId,
      job.clientId,
      job.kind,
      job.commitSha ?? null,
      job.refName ?? null,
      job.isDefaultBranch ?? false,
      job.candidateAncestors ?? [],
      job.changedPaths ?? [],
      job.fetchUrl ?? null,
    ]));
  } catch (error) {
    if (sqlState(error) === INSUFFICIENT_PRIVILEGE) {
      throw new JobNotWritableError(
        `No job may be written for tenant ${job.tenantId} in a transaction not bound to it.`,
      );
    }
    throw error;
  }
  const row = rows[0];
  /* v8 ignore next 3 -- an INSERT ... RETURNING that did not raise returns its row */
  if (row === undefined) {
    throw new Error('A job was inserted but not returned.');
  }
  return row;
}

/**
 * Marks every still-QUEUED push of `refName` in this repository `superseded`,
 * clearing its fetch URL and stamping its end, and answers their ids. A push
 * of another ref and a running push of this one are left as they are. Runs
 * before `enqueueJob` in the request's one transaction.
 */
export async function supersedeQueuedPushes(
  db: pg.ClientBase,
  scope: JobScope,
  refName: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(SUPERSEDE_PUSHES_SQL, [
    scope.tenantId,
    scope.repositoryId,
    refName,
  ]);
  return rows.map((r) => r.id);
}

/** The bound tenant's job, or null — never an error — for one it does not hold. */
export async function readJob(
  db: pg.ClientBase,
  scope: JobScope,
  jobId: string,
): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(SELECT_JOB_SQL, [
    scope.tenantId,
    scope.repositoryId,
    jobId,
  ]);
  return rows[0] ?? null;
}

/** The bound tenant's batch, or null — never an error — for one it does not hold. */
export async function readBatch(
  db: pg.ClientBase,
  scope: JobScope,
  batchId: string,
): Promise<BatchRow | null> {
  const { rows } = await db.query<BatchRow>(SELECT_BATCH_SQL, [
    scope.tenantId,
    scope.repositoryId,
    batchId,
  ]);
  return rows[0] ?? null;
}

/**
 * Moves a running batch's lease to `leaseMs` from the database's now, in ONE
 * guarded write that matches only while the batch is running under `claimedBy`.
 * Refuses with `ClaimLostError` when it is not, writing nothing.
 */
export async function renewBatchLease(
  db: pg.ClientBase,
  scope: JobScope,
  batchId: string,
  claimedBy: string,
  leaseMs: number,
): Promise<BatchRow> {
  const { rows } = await db.query<BatchRow>(RENEW_BATCH_LEASE_SQL, [
    scope.tenantId,
    scope.repositoryId,
    batchId,
    claimedBy,
    positiveMs(leaseMs),
  ]);
  const row = rows[0];
  if (row === undefined) {
    throw new ClaimLostError('batch', batchId);
  }
  return row;
}

/**
 * Ends a running job this claim holds: sets the end state, clears its fetch
 * URL, lease and token, stamps its end, and records a failure's reason. Every
 * unfinished batch of the job ends `failed` with `job_failed` and the same
 * message. Refuses with `ClaimLostError`, writing nothing, when the job is not
 * running under `claimedBy`.
 */
export async function endJob(
  db: pg.ClientBase,
  scope: JobScope,
  jobId: string,
  claimedBy: string,
  end: JobEnd,
): Promise<JobRow> {
  const failed = end.state === 'failed';
  const message = failed ? (end.message ?? null) : null;
  const { rows } = await db.query<JobRow>(END_JOB_SQL, [
    scope.tenantId,
    scope.repositoryId,
    jobId,
    claimedBy,
    end.state,
    failed ? end.reasonCode : null,
    message,
  ]);
  const row = rows[0];
  if (row === undefined) {
    throw new ClaimLostError('job', jobId);
  }
  await db.query(END_UNFINISHED_BATCHES_SQL, [
    scope.tenantId,
    scope.repositoryId,
    jobId,
    message ?? `The job ended ${end.state} before this batch finished.`,
  ]);
  return row;
}

/**
 * Writes one `queued` batch per slice of a job's missing blobs, in ONE
 * statement, and answers the rows in ordinal order. Refuses an empty list
 * (RangeError), and a slice at an ordinal the list repeats or the job already
 * has (`DuplicateBatchOrdinalError`), writing nothing. A slice whose paths and
 * hashes differ in length fails the schema's check (23514).
 */
export async function insertJobBatches(
  db: pg.ClientBase,
  scope: JobScope,
  jobId: string,
  slices: readonly NewBatch[],
): Promise<BatchRow[]> {
  if (slices.length === 0) {
    throw new RangeError('A job is fanned out into at least one batch.');
  }
  const payload = JSON.stringify(
    slices.map((s) => ({
      ordinal: s.ordinal,
      paths: s.paths,
      git_blob_hashes: s.gitBlobHashes,
    })),
  );
  let rows: BatchRow[];
  try {
    ({ rows } = await db.query<BatchRow>(INSERT_BATCHES_SQL, [
      scope.tenantId,
      scope.repositoryId,
      jobId,
      payload,
    ]));
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) {
      throw new DuplicateBatchOrdinalError(jobId);
    }
    if (sqlState(error) === INSUFFICIENT_PRIVILEGE) {
      throw new JobNotWritableError(
        `No batch may be written for tenant ${scope.tenantId} in a transaction not bound to it.`,
      );
    }
    throw error;
  }
  return [...rows].sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Ends a running batch this claim holds. `stored` records how many blobs it
 * stored and clears its lease. `failed` records the reason on the batch, ends
 * its job `failed` with the same reason, and ends the job's other unfinished
 * batches `failed` with `job_failed`. Refuses with `ClaimLostError`, writing
 * nothing, when the batch is not running under `claimedBy`.
 */
export async function finishBatch(
  db: pg.ClientBase,
  scope: JobScope,
  batchId: string,
  claimedBy: string,
  end: BatchEnd,
): Promise<BatchRow> {
  const key = [scope.tenantId, scope.repositoryId, batchId, claimedBy];
  if (end.state === 'stored') {
    const { rows } = await db.query<BatchRow>(STORE_BATCH_SQL, [...key, end.storedCount]);
    const row = rows[0];
    if (row === undefined) {
      throw new ClaimLostError('batch', batchId);
    }
    return row;
  }
  const message = end.message ?? null;
  const { rows } = await db.query<BatchRow>(FAIL_BATCH_SQL, [...key, end.reasonCode, message]);
  const row = rows[0];
  if (row === undefined) {
    throw new ClaimLostError('batch', batchId);
  }
  await db.query(FAIL_JOB_SQL, [
    scope.tenantId,
    scope.repositoryId,
    row.jobId,
    end.reasonCode,
    message,
  ]);
  await db.query(END_UNFINISHED_BATCHES_SQL, [
    scope.tenantId,
    scope.repositoryId,
    row.jobId,
    message ?? `Batch ${batchId} of the job failed (${end.reasonCode}).`,
  ]);
  return row;
}

/** What marking a batch stored answers. */
export interface BatchStored {
  readonly batch: BatchRow;
  /** The job's batches still `queued` or `running` once this one is stored. */
  readonly unstoredBatches: number;
  /**
   * The job lease's new token when this claimant is the job's finaliser: the
   * one whose transaction saw no batch of the job left un-stored. Null for
   * every other claimant.
   */
  readonly finaliserToken: string | null;
}

const BOUND_TENANT_SQL = 'SELECT codegraph.codegraph_bound_tenant() AS tenant';

// The job's row is locked BEFORE the batch is written: a claimant then holds
// no batch row while it waits, so it can never deadlock with a failing batch,
// which writes its own row, then the job, then the job's other batches.
const LOCK_JOB_OF_BATCH_SQL = `SELECT id FROM codegraph.index_jobs
  WHERE tenant_id = $1 AND repository_id = $2
    AND id = (SELECT job_id FROM codegraph.index_job_batches
              WHERE tenant_id = $1 AND repository_id = $2 AND id = $3)
  FOR UPDATE`;

const COUNT_UNSTORED_BATCHES_SQL = `SELECT count(*)::integer AS n FROM codegraph.index_job_batches
  WHERE tenant_id = $1 AND repository_id = $2 AND job_id = $3 AND state IN ('queued', 'running')`;

// A fanned-out job runs with no lease; the finaliser takes one, so a finaliser
// that dies is recovered by the lease's expiry like any other run.
const TAKE_JOB_LEASE_SQL = `UPDATE codegraph.index_jobs
  SET lease_expires_at = now() + make_interval(secs => $4::double precision / 1000),
      claimed_by = gen_random_uuid()::text
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'running' AND claimed_by IS NULL
  RETURNING claimed_by AS "claimedBy"`;

/**
 * Marks a running batch this claim holds `stored` with `storedCount`, and
 * decides in the SAME transaction whether its claimant is the job's
 * finaliser. Its statements, in order: the bound tenant is asserted to be the
 * batch's; the job's row is locked (`FOR UPDATE`); the batch is written; the
 * job's batches still `queued` or `running` are counted; and when none is,
 * the job's lease is taken with a fresh token for `leaseMs`.
 *
 * The lock is what makes the finaliser unique. Under READ COMMITTED each
 * statement reads what was committed when it began, so the count, taken after
 * the lock, sees every batch an earlier holder of the lock stored: of two
 * claimants storing a job's last two batches at once, the first to take the
 * lock counts the other's batch un-stored, and the second, which waits for the
 * first to commit, counts none. Never two finalisers, and never none.
 *
 * Refuses with `JobNotWritableError` before its first write when the
 * transaction is bound to no tenant or another one, and with `ClaimLostError`
 * when the batch is not running under `claimedBy`.
 */
export async function markBatchStoredAndLockJob(
  db: pg.ClientBase,
  scope: JobScope,
  batchId: string,
  claimedBy: string,
  storedCount: number,
  leaseMs: number,
): Promise<BatchStored> {
  const { rows: bound } = await db.query<{ tenant: string | null }>(BOUND_TENANT_SQL);
  if (bound[0]?.tenant !== scope.tenantId) {
    throw new JobNotWritableError(
      `No batch may be written for tenant ${scope.tenantId} in a transaction not bound to it.`,
    );
  }
  const lease = positiveMs(leaseMs);
  const { rows: jobs } = await db.query<{ id: string }>(LOCK_JOB_OF_BATCH_SQL, [
    scope.tenantId,
    scope.repositoryId,
    batchId,
  ]);
  const { rows } = await db.query<BatchRow>(STORE_BATCH_SQL, [
    scope.tenantId,
    scope.repositoryId,
    batchId,
    claimedBy,
    storedCount,
  ]);
  const batch = rows[0];
  const job = jobs[0];
  // A running batch belongs to a running job: ending a job ends its batches.
  if (batch === undefined || job === undefined) {
    throw new ClaimLostError('batch', batchId);
  }
  const { rows: counted } = await db.query<{ n: number }>(COUNT_UNSTORED_BATCHES_SQL, [
    scope.tenantId,
    scope.repositoryId,
    job.id,
  ]);
  const unstoredBatches = counted[0]?.n ?? 0;
  if (unstoredBatches > 0) return { batch, unstoredBatches, finaliserToken: null };
  const { rows: taken } = await db.query<{ claimedBy: string }>(TAKE_JOB_LEASE_SQL, [
    scope.tenantId,
    scope.repositoryId,
    job.id,
    lease,
  ]);
  return { batch, unstoredBatches, finaliserToken: taken[0]?.claimedBy ?? null };
}
