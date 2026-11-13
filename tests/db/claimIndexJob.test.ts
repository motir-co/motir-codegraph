import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withDatabase } from '../../src/db/connection.js';
import { insertJobBatches } from '../../src/db/indexJobs.js';
import {
  freshDatabase,
  queryRows,
  sqlState,
  withClient,
  type FreshDatabase,
} from '../helpers/db.js';
import {
  bindTo,
  ownerQueuedJob,
  queueTenant,
  revokeGrant,
  sha,
  type QueueTenant,
} from '../helpers/queue.js';

// codegraph.codegraph_claim_index_job (db/migrations/0010_index_queue.sql): the
// queue's one cross-tenant read, called on the app login with nothing bound,
// as a worker calls it. Each case starts from an empty queue: the claim sees
// every tenant's rows, so one case's jobs would otherwise be another's.

const CLAIM = 'SELECT * FROM codegraph.codegraph_claim_index_job($1, $2)';
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;

interface Claim {
  claim_kind: 'job' | 'batch';
  tenant_id: string;
  repository_id: string;
  client_id: string;
  job_id: string;
  batch_id: string | null;
  claimed_by: string;
}

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await withClient(db.ownerUrl, (c) => c.query('DELETE FROM codegraph.index_jobs'));
});

/** One claim in its own transaction on a fresh app connection. */
async function claim(leaseMs = LEASE_MS, maxAttempts = MAX_ATTEMPTS): Promise<Claim[]> {
  return withClient(db.appUrl, (c) => queryRows<Claim>(c, CLAIM, [leaseMs, maxAttempts]));
}

function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(db.ownerUrl, fn);
}

async function tenant(repositories = 1): Promise<QueueTenant> {
  return owner((c) => queueTenant(c, repositories));
}

interface JobState {
  state: string;
  attempts: number;
  started_at: Date | null;
  lease_expires_at: Date | null;
  claimed_by: string | null;
  fetch_url: string | null;
  failure_reason_code: string | null;
}

async function jobRow(id: string): Promise<JobState> {
  const rows = await owner((c) =>
    queryRows<JobState>(
      c,
      `SELECT state, attempts, started_at, lease_expires_at, claimed_by, fetch_url,
              failure_reason_code FROM codegraph.index_jobs WHERE id = $1`,
      [id],
    ),
  );
  return rows[0] as JobState;
}

async function batchRow(id: string) {
  const rows = await owner((c) =>
    queryRows<{
      state: string;
      attempts: number;
      claimed_by: string | null;
      failure_reason_code: string | null;
    }>(
      c,
      `SELECT state, attempts, claimed_by, failure_reason_code
         FROM codegraph.index_job_batches WHERE id = $1`,
      [id],
    ),
  );
  return rows[0];
}

/** Puts a job's (or a batch's) lease in the past, as the owner. */
async function expire(table: 'index_jobs' | 'index_job_batches', id: string): Promise<void> {
  await owner((c) =>
    c.query(
      `UPDATE codegraph.${table} SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    ),
  );
}

/** Claims the job, then fans it out into `n` queued batches, as a worker would. */
async function fannedOut(t: QueueTenant, n: number): Promise<{ jobId: string; batches: string[] }> {
  const jobId = await owner((c) => ownerQueuedJob(c, t));
  const [claimed] = await claim();
  expect(claimed?.job_id).toBe(jobId);
  const batches = await withClient(db.appUrl, async (c) => {
    await c.query('BEGIN');
    await bindTo(c, t);
    await c.query(
      `UPDATE codegraph.index_jobs SET lease_expires_at = NULL, claimed_by = NULL WHERE id = $1`,
      [jobId],
    );
    const rows = await insertJobBatches(
      c,
      t,
      jobId,
      Array.from({ length: n }, (_, i) => ({
        ordinal: i + 1,
        paths: [`f${String(i)}.ts`],
        gitBlobHashes: [sha()],
      })),
    );
    await c.query('COMMIT');
    return rows.map((r) => r.id);
  });
  return { jobId, batches };
}

describe('the function', () => {
  it('is a VOLATILE SECURITY DEFINER owned by codegraph_owner, pinned, and executable by codegraph_app only', async () => {
    const rows = await withClient(withDatabase(db.adminUrl, db.name), (c) =>
      queryRows(
        c,
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile,
                p.proconfig::text[] AS config,
                pg_get_function_identity_arguments(p.oid) AS args,
                ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                           ELSE pg_get_userbyid(a.grantee) END
                        FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'
                       ORDER BY 1)::text[] AS executors
           FROM pg_proc p
          WHERE p.oid = 'codegraph.codegraph_claim_index_job(integer, integer)'::regprocedure`,
      ),
    );
    expect(rows).toEqual([
      {
        owner: 'codegraph_owner',
        prosecdef: true,
        provolatile: 'v',
        config: ['search_path=codegraph, pg_temp'],
        args: 'lease_ms integer, max_attempts integer',
        executors: ['codegraph_app', 'codegraph_owner'],
      },
    ]);
  });

  it('answers exactly the closed column list, and zero rows when nothing is claimable', async () => {
    const result = await withClient(db.appUrl, (c) => c.query(CLAIM, [LEASE_MS, MAX_ATTEMPTS]));
    expect(result.rows).toEqual([]);
    expect(result.fields.map((f) => f.name)).toEqual([
      'claim_kind',
      'tenant_id',
      'repository_id',
      'client_id',
      'job_id',
      'batch_id',
      'claimed_by',
    ]);
  });

  it('refuses a non-positive lease or attempt bound before any statement', async () => {
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      for (const args of [
        [0, 3],
        [-1, 3],
        [null, 3],
        [1000, 0],
        [1000, null],
      ]) {
        expect(await sqlState(c, CLAIM, args)).toBe('22023');
      }
      await c.query('ROLLBACK');
    });
  });

  it('is the one cross-tenant read: an unbound connection claims, while a plain SELECT on it sees no row', async () => {
    const t = await tenant();
    const jobId = await owner((c) => ownerQueuedJob(c, t));
    await withClient(db.appUrl, async (c) => {
      const [answer] = await queryRows<Claim>(c, CLAIM, [LEASE_MS, MAX_ATTEMPTS]);
      expect(answer).toMatchObject({
        claim_kind: 'job',
        tenant_id: t.tenantId,
        repository_id: t.repositoryId,
        client_id: t.clientId,
        job_id: jobId,
        batch_id: null,
      });
      expect(await queryRows(c, 'SELECT id FROM codegraph.index_jobs')).toEqual([]);
      expect(await queryRows(c, 'SELECT id FROM codegraph.index_job_batches')).toEqual([]);
    });
  });
});

describe('claiming a job', () => {
  it('answers the oldest queued job first and leaves it running under a lease and a token', async () => {
    const t = await tenant(2);
    const newer = await owner((c) => ownerQueuedJob(c, t, { enqueuedAt: '2026-01-02T00:00:00Z' }));
    const older = await owner((c) =>
      ownerQueuedJob(c, t, {
        repositoryId: t.repositoryIds[1] as string,
        enqueuedAt: '2026-01-01T00:00:00Z',
      }),
    );
    const before = Date.now();
    const [first] = await claim();
    expect(first?.job_id).toBe(older);
    const row = await jobRow(older);
    expect(row.state).toBe('running');
    expect(row.started_at).toBeInstanceOf(Date);
    expect(row.claimed_by).toBe(first?.claimed_by);
    expect(row.claimed_by).toMatch(/^[0-9a-f-]{36}$/);
    const ahead = (row.lease_expires_at?.getTime() ?? 0) - before;
    expect(ahead).toBeGreaterThan(LEASE_MS - 5_000);
    expect(ahead).toBeLessThan(LEASE_MS + 5_000);
    expect(row.fetch_url).not.toBeNull();
    const [second] = await claim();
    expect(second?.job_id).toBe(newer);
    expect(second?.claimed_by).not.toBe(first?.claimed_by);
    expect(await claim()).toEqual([]);
  });

  it('gives one of two concurrent claims a job of one repository and the other none', async () => {
    const t = await tenant();
    await owner((c) => ownerQueuedJob(c, t));
    await owner((c) => ownerQueuedJob(c, t));
    await withClient(db.appUrl, async (one) => {
      await withClient(db.appUrl, async (two) => {
        await one.query('BEGIN');
        await two.query('BEGIN');
        const first = await queryRows<Claim>(one, CLAIM, [LEASE_MS, MAX_ATTEMPTS]);
        const second = await queryRows<Claim>(two, CLAIM, [LEASE_MS, MAX_ATTEMPTS]);
        await one.query('COMMIT');
        await two.query('COMMIT');
        expect(first).toHaveLength(1);
        expect(second).toEqual([]);
      });
    });
    // Committed, the running job still holds the repository.
    expect(await claim()).toEqual([]);
  });

  it('gives each of two concurrent claims a job when the jobs are of different repositories', async () => {
    const t = await tenant(2);
    const a = await owner((c) => ownerQueuedJob(c, t));
    const b = await owner((c) =>
      ownerQueuedJob(c, t, { repositoryId: t.repositoryIds[1] as string }),
    );
    await withClient(db.appUrl, async (one) => {
      await withClient(db.appUrl, async (two) => {
        await one.query('BEGIN');
        await two.query('BEGIN');
        const first = await queryRows<Claim>(one, CLAIM, [LEASE_MS, MAX_ATTEMPTS]);
        const second = await queryRows<Claim>(two, CLAIM, [LEASE_MS, MAX_ATTEMPTS]);
        await one.query('COMMIT');
        await two.query('COMMIT');
        expect([first[0]?.job_id, second[0]?.job_id].sort()).toEqual([a, b].sort());
      });
    });
  });

  it('answers no job of a repository whose job is running, held by a run or fanned out', async () => {
    const t = await tenant();
    const { batches } = await fannedOut(t, 1);
    await owner((c) => ownerQueuedJob(c, t));
    // The fanned-out job's batch is claimable; the queued job is not.
    const [b] = await claim();
    expect(b).toMatchObject({ claim_kind: 'batch', batch_id: batches[0] });
    expect(await claim()).toEqual([]);

    const u = await tenant();
    await owner((c) => ownerQueuedJob(c, u));
    await owner((c) => ownerQueuedJob(c, u));
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toEqual([]);
  });

  it('holds no advisory lock once the claiming transaction commits', async () => {
    const t = await tenant();
    await owner((c) => ownerQueuedJob(c, t));
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      expect(await queryRows<Claim>(c, CLAIM, [LEASE_MS, MAX_ATTEMPTS])).toHaveLength(1);
      const held = await queryRows(
        c,
        "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
      );
      expect(held).toHaveLength(1);
      await c.query('COMMIT');
      expect(
        await queryRows(
          c,
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
        ),
      ).toEqual([]);
    });
    // Another transaction takes the same repository's key without waiting.
    const [taken] = await withClient(db.appUrl, (c) =>
      queryRows<{ ok: boolean }>(
        c,
        `SELECT pg_try_advisory_xact_lock(hashtext('codegraph.index_jobs.repository:'
                || $1::text || ':' || $2::text)) AS ok`,
        [t.tenantId, t.repositoryId],
      ),
    );
    expect(taken?.ok).toBe(true);
  });

  it('skips a job a concurrent claim has locked, and a candidate it finds busy under the lock', async () => {
    const t = await tenant(2);
    const a = await owner((c) => ownerQueuedJob(c, t, { enqueuedAt: '2026-01-01T00:00:00Z' }));
    const b = await owner((c) =>
      ownerQueuedJob(c, t, {
        repositoryId: t.repositoryIds[1] as string,
        enqueuedAt: '2026-01-02T00:00:00Z',
      }),
    );
    // The owner holds job a's row lock (not the advisory lock): the claim skips it.
    await withClient(db.ownerUrl, async (locker) => {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM codegraph.index_jobs WHERE id = $1 FOR UPDATE', [a]);
      const [got] = await claim();
      expect(got?.job_id).toBe(b);
      await locker.query('ROLLBACK');
    });
    expect((await jobRow(a)).state).toBe('queued');
  });
});

describe('leases and attempts', () => {
  it('returns an expired job whose client holds a grant to queued with one more attempt', async () => {
    const t = await tenant();
    const jobId = await owner((c) => ownerQueuedJob(c, t));
    await claim();
    await expire('index_jobs', jobId);
    const [again] = await claim();
    // Swept back to queued and claimed again in the same call.
    expect(again?.job_id).toBe(jobId);
    expect(await jobRow(jobId)).toMatchObject({ state: 'running', attempts: 1 });
    await expire('index_jobs', jobId);
    // Push it behind another tenant's job, so the sweep's requeue can be read
    // before a claim takes it again.
    await owner((c) =>
      c.query(
        `UPDATE codegraph.index_jobs SET enqueued_at = now() + interval '1 hour' WHERE id = $1`,
        [jobId],
      ),
    );
    const other = await tenant();
    const otherJob = await owner((c) => ownerQueuedJob(c, other));
    const [first] = await claim(LEASE_MS, 10);
    expect(first?.job_id).toBe(otherJob);
    expect(await jobRow(jobId)).toMatchObject({
      state: 'queued',
      attempts: 2,
      started_at: null,
      lease_expires_at: null,
      claimed_by: null,
    });
    expect((await jobRow(jobId)).fetch_url).not.toBeNull();
  });

  it('fails a job at max_attempts lease expiries, and every unfinished batch of it', async () => {
    const t = await tenant();
    const { jobId, batches } = await fannedOut(t, 2);
    // The finaliser re-took the job's lease, and it expired on the last attempt.
    await owner((c) =>
      c.query(
        `UPDATE codegraph.index_jobs SET attempts = 2, claimed_by = 'fin',
           lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [jobId],
      ),
    );
    expect(await claim(LEASE_MS, 3)).toEqual([]);
    expect(await jobRow(jobId)).toMatchObject({
      state: 'failed',
      attempts: 3,
      failure_reason_code: 'attempts_exhausted',
      fetch_url: null,
      lease_expires_at: null,
      claimed_by: null,
    });
    for (const id of batches) {
      expect(await batchRow(id)).toMatchObject({
        state: 'failed',
        failure_reason_code: 'job_failed',
      });
    }
  });

  it('fails a queued or an expired job whose client holds no live grant, never requeuing it', async () => {
    const t = await tenant(2);
    const running = await owner((c) => ownerQueuedJob(c, t));
    await claim();
    const queued = await owner((c) =>
      ownerQueuedJob(c, t, { repositoryId: t.repositoryIds[1] as string }),
    );
    await owner((c) => revokeGrant(c, t));
    await expire('index_jobs', running);
    expect(await claim()).toEqual([]);
    for (const id of [running, queued]) {
      expect(await jobRow(id)).toMatchObject({
        state: 'failed',
        failure_reason_code: 'binding_refused',
        fetch_url: null,
        claimed_by: null,
      });
    }
  });
});

describe('claiming a batch', () => {
  it('answers a queued batch of a running job before any job, and never a batch of a job not running', async () => {
    const t = await tenant(2);
    const { jobId, batches } = await fannedOut(t, 2);
    const queuedJob = await owner((c) =>
      ownerQueuedJob(c, t, { repositoryId: t.repositoryIds[1] as string }),
    );
    const [first] = await claim();
    expect(first).toMatchObject({
      claim_kind: 'batch',
      tenant_id: t.tenantId,
      repository_id: t.repositoryId,
      client_id: t.clientId,
      job_id: jobId,
      batch_id: batches[0],
    });
    expect(await batchRow(batches[0] as string)).toMatchObject({
      state: 'running',
      claimed_by: first?.claimed_by,
    });
    const [second] = await claim();
    expect(second?.batch_id).toBe(batches[1]);
    const [third] = await claim();
    expect(third).toMatchObject({ claim_kind: 'job', job_id: queuedJob });

    // A queued batch of a job that is not running is never answered.
    const u = await tenant();
    const notRunning = await owner((c) => ownerQueuedJob(c, u));
    await owner((c) =>
      c.query(
        `INSERT INTO codegraph.index_job_batches
           (tenant_id, repository_id, job_id, ordinal, paths, git_blob_hashes)
         VALUES ($1, $2, $3, 1, ARRAY['a.ts'], ARRAY[$4])`,
        [u.tenantId, u.repositoryId, notRunning, sha()],
      ),
    );
    const [next] = await claim();
    expect(next).toMatchObject({ claim_kind: 'job', job_id: notRunning });
  });

  it('returns an expired batch to queued with one more attempt', async () => {
    const t = await tenant();
    const { batches } = await fannedOut(t, 1);
    const id = batches[0] as string;
    await claim();
    await expire('index_job_batches', id);
    const [again] = await claim();
    expect(again?.batch_id).toBe(id);
    expect(await batchRow(id)).toMatchObject({ state: 'running', attempts: 1 });
  });

  it('fails a batch at max_attempts, its job with the same code, and its siblings', async () => {
    const t = await tenant();
    const { jobId, batches } = await fannedOut(t, 3);
    const [b1, b2, b3] = batches as [string, string, string];
    await claim();
    await claim();
    await owner((c) =>
      c.query(
        `UPDATE codegraph.index_job_batches SET attempts = 1,
           lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [b1],
      ),
    );
    expect(await claim(LEASE_MS, 2)).toEqual([]);
    expect(await batchRow(b1)).toMatchObject({
      state: 'failed',
      attempts: 2,
      failure_reason_code: 'attempts_exhausted',
    });
    expect(await jobRow(jobId)).toMatchObject({
      state: 'failed',
      failure_reason_code: 'attempts_exhausted',
      fetch_url: null,
    });
    for (const id of [b2, b3]) {
      expect(await batchRow(id)).toMatchObject({
        state: 'failed',
        failure_reason_code: 'job_failed',
        claimed_by: null,
      });
    }
  });
});
