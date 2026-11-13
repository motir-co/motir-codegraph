/**
 * The indexer worker's own access to the queue, beside `src/db/indexJobs.ts`
 * (which reads and ends the job row): the claim, the job-lease renewal and
 * release, and the binding a claimed job's every write runs under.
 *
 * The claim is the queue's ONE cross-tenant statement: the definer function
 * `codegraph.codegraph_claim_index_job` answers identity only (the tenant,
 * repository and client a job is bound as, and the job and batch ids), so
 * everything after it runs in a transaction bound to that tenant and client.
 */
import type pg from 'pg';

import { BIND_TENANT_SQL } from '../server/binding.js';
import type { JobScope } from './indexJobs.js';

/** What a claim answers. `batchId` is set only when a batch was claimed. */
export interface Claim {
  readonly kind: 'job' | 'batch';
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly clientId: string;
  readonly jobId: string;
  readonly batchId: string | null;
  /** The claim's token: every later write of this claim matches on it. */
  readonly claimedBy: string;
}

export interface ClaimSettings {
  /** Milliseconds the claim's lease runs. */
  readonly jobLeaseMs: number;
  /** The claim at which a job ends `attempts_exhausted` instead. */
  readonly maxAttempts: number;
}

/** The one statement the worker issues outside a tenant-bound transaction. */
export const CLAIM_SQL = `SELECT claim_kind AS kind, tenant_id AS "tenantId",
    repository_id AS "repositoryId", client_id AS "clientId", job_id AS "jobId",
    batch_id AS "batchId", claimed_by AS "claimedBy"
  FROM codegraph.codegraph_claim_index_job($1, $2)`;

const BOUND_TENANT_SQL = 'SELECT codegraph.codegraph_bound_tenant() AS tenant';

const RENEW_JOB_LEASE_SQL = `UPDATE codegraph.index_jobs
  SET lease_expires_at = now() + make_interval(secs => $5::double precision / 1000)
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'running' AND claimed_by = $4
  RETURNING id`;

/**
 * Claims the next job or batch, or answers null when the queue holds nothing
 * claimable. Runs on a connection of its own from `pool`, outside any
 * transaction, so the claim commits as the statement ends.
 */
export async function claimNext(pool: pg.Pool, settings: ClaimSettings): Promise<Claim | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<Claim>(CLAIM_SQL, [
      settings.jobLeaseMs,
      settings.maxAttempts,
    ]);
    return rows[0] ?? null;
  } finally {
    client.release();
  }
}

/**
 * Extends the job's lease from the database's clock, if it is still this
 * claim's running job, and answers whether it was. False is a lost lease: the
 * job now belongs to whichever claim took it, and this one must write nothing.
 */
export async function renewLease(
  db: pg.ClientBase,
  scope: JobScope,
  jobId: string,
  claimedBy: string,
  leaseMs: number,
): Promise<boolean> {
  const { rows } = await db.query(RENEW_JOB_LEASE_SQL, [
    scope.tenantId,
    scope.repositoryId,
    jobId,
    claimedBy,
    leaseMs,
  ]);
  return rows.length > 0;
}

/**
 * The claimed job's client no longer holds a live grant on its tenant: the
 * binding reads unbound, so the row can be neither read nor written. A lost
 * grant, never a lost lease.
 */
export class GrantLostError extends Error {
  readonly tenantId: string;
  readonly clientId: string;

  constructor(tenantId: string, clientId: string) {
    super(`Client ${clientId} holds no live grant on tenant ${tenantId}; the job cannot be read.`);
    this.name = 'GrantLostError';
    this.tenantId = tenantId;
    this.clientId = clientId;
  }
}

/**
 * Runs `fn` in one transaction on its own connection from `pool`, bound with
 * `BIND_TENANT_SQL` to the claim's client and tenant. The bound-tenant guard
 * runs first: an unbound session raises `GrantLostError` before `fn` runs.
 * Commits when `fn` returns, rolls back when anything throws.
 */
export async function inClaimTransaction<T>(
  pool: pg.Pool,
  claim: Pick<Claim, 'tenantId' | 'clientId'>,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(BIND_TENANT_SQL, [claim.clientId, claim.tenantId]);
      const { rows } = await client.query<{ tenant: string | null }>(BOUND_TENANT_SQL);
      if (rows[0]?.tenant !== claim.tenantId) {
        throw new GrantLostError(claim.tenantId, claim.clientId);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

const RELEASE_JOB_LEASE_SQL = `UPDATE codegraph.index_jobs
  SET lease_expires_at = NULL, claimed_by = NULL
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'running' AND claimed_by = $4
  RETURNING id`;

/**
 * Clears the job's lease and token, if it is still this claim's running job,
 * and answers whether it was. The job stays `running` with its fetch URL: a
 * running job with no lease is owned by its batches, so the claim's
 * expired-lease sweep never re-queues it and no other job of its repository
 * is claimed. Called in the transaction that writes the job's batches.
 */
export async function releaseLease(
  db: pg.ClientBase,
  scope: JobScope,
  jobId: string,
  claimedBy: string,
): Promise<boolean> {
  const { rows } = await db.query(RELEASE_JOB_LEASE_SQL, [
    scope.tenantId,
    scope.repositoryId,
    jobId,
    claimedBy,
  ]);
  return rows.length > 0;
}
