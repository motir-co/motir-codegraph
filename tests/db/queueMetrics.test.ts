import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withDatabase } from '../../src/db/connection.js';
import { endJob, insertJobBatches } from '../../src/db/indexJobs.js';
import { QUEUE_METRICS_SQL, readQueueMetrics } from '../../src/db/queueMetrics.js';
import { claimNext, inClaimTransaction, type Claim } from '../../src/db/workerJobs.js';
import { createAppPool } from '../../src/server/pool.js';
import {
  freshDatabase,
  queryRows,
  sqlState,
  withClient,
  type FreshDatabase,
} from '../helpers/db.js';
import { ownerQueuedJob, queueTenant, sha, type QueueTenant } from '../helpers/queue.js';
import { buildTenancyFixture, inBoundTransaction } from '../helpers/tenancy.js';

// codegraph.codegraph_index_queue_metrics (db/migrations/0011): the queue's one
// aggregate cross-tenant read, called on the app login with nothing bound, as
// the worker's publisher calls it. Each case starts from an empty queue.

const ROOT = new URL('../../', import.meta.url).pathname;
const WINDOW_MS = 300_000;

let db: FreshDatabase;
let owner: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  db = await freshDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  pool = createAppPool(db.appUrl);
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

beforeEach(async () => {
  await owner.query('DELETE FROM codegraph.index_jobs');
});

/** The four numbers, read on a fresh app connection with nothing bound. */
async function metrics(windowMs = WINDOW_MS) {
  return await withClient(db.appUrl, (c) => readQueueMetrics(c, windowMs));
}

async function failedJob(t: QueueTenant, endedSecondsAgo: number): Promise<void> {
  await owner.query(
    `INSERT INTO codegraph.index_jobs
       (tenant_id, repository_id, client_id, kind, commit_sha, ref_name, state, started_at,
        ended_at, failure_reason_code)
     VALUES ($1, $2, $3, 'first_index', $4, 'refs/heads/main', 'failed',
             now() - make_interval(secs => $5 + 10), now() - make_interval(secs => $5),
             'fetch_failed')`,
    [t.tenantId, t.repositoryId, t.clientId, sha(), endedSecondsAgo],
  );
}

describe('the function', () => {
  it('is a STABLE SECURITY DEFINER owned by codegraph_owner, pinned, and executable by codegraph_app only', async () => {
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
          WHERE p.oid = 'codegraph.codegraph_index_queue_metrics(bigint)'::regprocedure`,
      ),
    );
    expect(rows).toEqual([
      {
        owner: 'codegraph_owner',
        prosecdef: true,
        provolatile: 's',
        config: ['search_path=codegraph, pg_temp'],
        args: 'p_failed_window_ms bigint',
        executors: ['codegraph_app', 'codegraph_owner'],
      },
    ]);
  });

  it('answers one row of four non-negative whole numbers and no identifier, with nothing bound', async () => {
    const result = await withClient(db.appUrl, (c) =>
      c.query('SELECT * FROM codegraph.codegraph_index_queue_metrics($1)', [WINDOW_MS]),
    );
    expect(result.fields.map((f) => f.name)).toEqual([
      'queued_jobs',
      'queued_batches',
      'oldest_queued_job_age_seconds',
      'failed_jobs_recent',
    ]);
    expect(result.rows).toEqual([
      {
        queued_jobs: 0,
        queued_batches: 0,
        oldest_queued_job_age_seconds: 0,
        failed_jobs_recent: 0,
      },
    ]);
    expect(await metrics()).toEqual({
      queuedJobs: 0,
      queuedBatches: 0,
      oldestQueuedJobAgeSeconds: 0,
      failedJobsRecent: 0,
    });
  });

  it('refuses a window that is not a positive number of milliseconds', async () => {
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      expect(
        await sqlState(c, 'SELECT * FROM codegraph.codegraph_index_queue_metrics($1)', [0]),
      ).toBe('22023');
      expect(
        await sqlState(c, 'SELECT * FROM codegraph.codegraph_index_queue_metrics($1)', [null]),
      ).toBe('22023');
      await expect(readQueueMetrics(c, 0)).rejects.toThrow(RangeError);
      await expect(readQueueMetrics(c, 1.5)).rejects.toThrow(RangeError);
      await c.query('ROLLBACK');
    });
  });
});

describe('the four numbers', () => {
  it('counts every tenant’s queued jobs where a bound reader sees only its own', async () => {
    const fx = await buildTenancyFixture({ ownerUrl: db.ownerUrl, appUrl: db.appUrl });
    const a: QueueTenant = {
      tenantId: fx.tenantA.id,
      repositoryId: fx.tenantA.repositories[0]?.id as string,
      clientId: fx.readerId,
      repositoryIds: fx.tenantA.repositories.map((r) => r.id),
    };
    const b: QueueTenant = {
      tenantId: fx.tenantB.id,
      repositoryId: fx.tenantB.repositories[0]?.id as string,
      clientId: fx.readerId,
      repositoryIds: fx.tenantB.repositories.map((r) => r.id),
    };
    await ownerQueuedJob(owner, a);
    for (const repositoryId of b.repositoryIds) await ownerQueuedJob(owner, b, { repositoryId });

    await withClient(db.appUrl, async (c) => {
      const seen = await inBoundTransaction(
        c,
        { clientId: fx.readerId, tenantId: a.tenantId },
        () => queryRows(c, 'SELECT id FROM codegraph.index_jobs'),
      );
      expect(seen).toHaveLength(1);
      expect((await readQueueMetrics(c, WINDOW_MS)).queuedJobs).toBe(4);
    });
  });

  it('ages the oldest queued job in whole seconds, and keeps that age across a re-queue', async () => {
    const t = await queueTenant(owner);
    const jobId = await ownerQueuedJob(owner, t, {
      enqueuedAt: new Date(Date.now() - 90_000).toISOString(),
    });
    await ownerQueuedJob(owner, t, { repositoryId: t.repositoryId, refName: 'refs/heads/b' });
    const before = (await metrics()).oldestQueuedJobAgeSeconds;
    expect(before).toBeGreaterThanOrEqual(90);
    expect(before).toBeLessThan(95);

    // Claim the old job, lapse its lease, and let the claim re-queue it while
    // another session holds the repository, so it stays queued.
    const claim = (await claimNext(pool, { jobLeaseMs: 60_000, maxAttempts: 5 })) as Claim;
    expect(claim.jobId).toBe(jobId);
    await owner.query(
      "UPDATE codegraph.index_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    const holder = new pg.Client({ connectionString: db.ownerUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('codegraph.index_jobs.repository:' || $1 || ':' || $2))",
        [t.tenantId, t.repositoryId],
      );
      expect(await claimNext(pool, { jobLeaseMs: 60_000, maxAttempts: 5 })).toBeNull();
      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }
    const [row] = await queryRows<{ state: string; attempts: number }>(
      owner,
      'SELECT state, attempts FROM codegraph.index_jobs WHERE id = $1',
      [jobId],
    );
    expect(row).toEqual({ state: 'queued', attempts: 1 });
    expect((await metrics()).oldestQueuedJobAgeSeconds).toBeGreaterThanOrEqual(before);
  });

  it('counts failures that ended inside the window and not one that ended before it', async () => {
    const t = await queueTenant(owner);
    await failedJob(t, 290);
    await failedJob(t, 310);
    expect((await metrics(300_000)).failedJobsRecent).toBe(1);
    expect((await metrics(320_000)).failedJobsRecent).toBe(2);
    expect((await metrics(1_000)).failedJobsRecent).toBe(0);
  });

  it('counts queued and running batches only, and reads zero once the job ends them failed', async () => {
    const t = await queueTenant(owner);
    await ownerQueuedJob(owner, t);
    const claim = (await claimNext(pool, { jobLeaseMs: 60_000, maxAttempts: 3 })) as Claim;
    const scope = { tenantId: t.tenantId, repositoryId: t.repositoryId };
    const batches = await inClaimTransaction(pool, claim, (c) =>
      insertJobBatches(
        c,
        scope,
        claim.jobId,
        Array.from({ length: 10 }, (_, i) => ({
          ordinal: i + 1,
          paths: [`p${String(i)}`],
          gitBlobHashes: [sha()],
        })),
      ),
    );
    const ids = batches.map((b) => b.id);
    await owner.query(
      `UPDATE codegraph.index_job_batches SET state = 'running', claimed_by = 'w',
              lease_expires_at = now() + interval '1 minute' WHERE id = ANY($1::uuid[])`,
      [ids.slice(4, 6)],
    );
    await owner.query(
      "UPDATE codegraph.index_job_batches SET state = 'stored', stored_count = 1, ended_at = now() WHERE id = $1",
      [ids[6]],
    );
    await owner.query(
      `UPDATE codegraph.index_job_batches SET state = 'failed', ended_at = now(),
              failure_reason_code = 'fetch_failed' WHERE id = ANY($1::uuid[])`,
      [ids.slice(7)],
    );
    expect((await metrics()).queuedBatches).toBe(6);

    await inClaimTransaction(pool, claim, (c) =>
      endJob(c, scope, claim.jobId, claim.claimedBy, {
        state: 'failed',
        reasonCode: 'fetch_failed',
      }),
    );
    expect((await metrics()).queuedBatches).toBe(0);
    const [{ n }] = (await queryRows<{ n: number }>(
      owner,
      'SELECT count(*)::integer AS n FROM codegraph.index_job_batches WHERE job_id = $1',
      [claim.jobId],
    )) as [{ n: number }];
    expect(n).toBe(10);
  });

  it('answers the same numbers twice for an unchanged queue', async () => {
    const t = await queueTenant(owner);
    await ownerQueuedJob(owner, t);
    const first = await metrics();
    const second = await metrics();
    expect(second.queuedJobs).toBe(first.queuedJobs);
    expect(second.queuedBatches).toBe(first.queuedBatches);
    expect(second.failedJobsRecent).toBe(first.failedJobsRecent);
  });
});

describe('src/', () => {
  it('names the function only in src/db/queueMetrics.ts', async () => {
    const entries = await readdir(join(ROOT, 'src'), { recursive: true });
    const naming: string[] = [];
    for (const entry of entries.filter((e) => e.endsWith('.ts'))) {
      const text = await readFile(join(ROOT, 'src', entry), 'utf8');
      if (text.includes('codegraph_index_queue_metrics')) naming.push(entry);
    }
    expect(naming).toEqual(['db/queueMetrics.ts']);
    expect(QUEUE_METRICS_SQL).toContain('codegraph.codegraph_index_queue_metrics($1)');
  });
});
