import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BatchState,
  ClaimLostError,
  DuplicateBatchOrdinalError,
  endJob,
  enqueueJob,
  finishBatch,
  insertJobBatches,
  JobKind,
  JobNotWritableError,
  JobState,
  readBatch,
  readJob,
  renewBatchLease,
  REQUEST_KINDS,
  supersedeQueuedPushes,
  type NewJob,
} from '../../src/db/indexJobs.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { bindTo, queueTenant, sha, type QueueTenant } from '../helpers/queue.js';

// src/db/indexJobs.ts on the app login: every operation inside a transaction
// bound with BIND_TENANT_SQL, and the same operations on a transaction bound to
// another tenant or to none. The claim is tests/db/claimIndexJob.test.ts's.

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function tenant(): Promise<QueueTenant> {
  return withClient(db.ownerUrl, (c) => queueTenant(c, 2));
}

/** Runs `fn` on the app login in a transaction bound to `t` (or nothing), then commits. */
async function bound<T>(t: QueueTenant | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(db.appUrl, async (c) => {
    await c.query('BEGIN');
    try {
      if (t !== null) await bindTo(c, t);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

function push(t: QueueTenant, overrides: Partial<NewJob> = {}): NewJob {
  return {
    tenantId: t.tenantId,
    repositoryId: t.repositoryId,
    clientId: t.clientId,
    kind: JobKind.Push,
    commitSha: sha(),
    refName: 'refs/heads/main',
    isDefaultBranch: true,
    candidateAncestors: [sha()],
    changedPaths: ['src/a.ts', 'README.md'],
    fetchUrl: 'https://example.test/archive.tar.gz?token=secret',
    ...overrides,
  };
}

/** Makes a job running under `token` as the owner, as the claim would. */
async function claimAsOwner(t: QueueTenant, jobId: string, token: string | null = 'tok') {
  await withClient(db.ownerUrl, (c) =>
    c.query(
      `UPDATE codegraph.index_jobs SET state = 'running', started_at = now(),
         lease_expires_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() + interval '1 minute' END,
         claimed_by = $2 WHERE id = $1`,
      [jobId, token],
    ),
  );
}

async function claimBatchAsOwner(batchId: string, token: string) {
  await withClient(db.ownerUrl, (c) =>
    c.query(
      `UPDATE codegraph.index_job_batches SET state = 'running',
         lease_expires_at = now() + interval '1 minute', claimed_by = $2 WHERE id = $1`,
      [batchId, token],
    ),
  );
}

const slices = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ordinal: i + 1,
    paths: [`f${String(i)}.ts`, `g${String(i)}.ts`],
    gitBlobHashes: [sha(), sha()],
  }));

describe('the vocabularies', () => {
  it('are values matching the schema', () => {
    expect(Object.values(JobKind)).toEqual([
      'first_index',
      'push',
      'refresh',
      'compact',
      'discard_stale',
      'release',
    ]);
    expect(REQUEST_KINDS).toEqual(['first_index', 'push', 'refresh']);
    expect(Object.values(JobState)).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'superseded',
    ]);
    expect(Object.values(BatchState)).toEqual(['queued', 'running', 'stored', 'failed']);
  });
});

describe('enqueueJob', () => {
  it('writes one queued row carrying everything it was given, and answers it', async () => {
    const t = await tenant();
    const input = push(t);
    const row = await bound(t, (c) => enqueueJob(c, input));
    expect(row).toMatchObject({
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      clientId: t.clientId,
      kind: 'push',
      commitSha: input.commitSha,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
      candidateAncestors: input.candidateAncestors,
      changedPaths: ['src/a.ts', 'README.md'],
      fetchUrl: input.fetchUrl,
      state: 'queued',
      attempts: 0,
      leaseExpiresAt: null,
      claimedBy: null,
      startedAt: null,
      endedAt: null,
    });
    expect(row.enqueuedAt).toBeInstanceOf(Date);
    expect(await bound(t, (c) => readJob(c, t, row.id))).toEqual(row);
  });

  it('defaults a maintenance kind’s optional columns', async () => {
    const t = await tenant();
    const row = await bound(t, (c) =>
      enqueueJob(c, {
        tenantId: t.tenantId,
        repositoryId: t.repositoryId,
        clientId: t.clientId,
        kind: JobKind.DiscardStale,
      }),
    );
    expect(row).toMatchObject({
      commitSha: null,
      refName: null,
      fetchUrl: null,
      isDefaultBranch: false,
      candidateAncestors: [],
      changedPaths: [],
    });
  });

  it('writes nothing on a transaction bound to another tenant or to none', async () => {
    const t = await tenant();
    const other = await tenant();
    await expect(bound(other, (c) => enqueueJob(c, push(t)))).rejects.toBeInstanceOf(
      JobNotWritableError,
    );
    await expect(bound(null, (c) => enqueueJob(c, push(t)))).rejects.toBeInstanceOf(
      JobNotWritableError,
    );
    const rows = await withClient(db.ownerUrl, (c) =>
      queryRows(c, 'SELECT id FROM codegraph.index_jobs WHERE tenant_id = $1', [t.tenantId]),
    );
    expect(rows).toEqual([]);
  });

  it('passes any other refusal through', async () => {
    const t = await tenant();
    await expect(bound(t, (c) => enqueueJob(c, push(t, { fetchUrl: null })))).rejects.toMatchObject(
      { code: '23514' },
    );
  });
});

describe('supersedeQueuedPushes', () => {
  it('supersedes every queued push of the ref and nothing else', async () => {
    const t = await tenant();
    const [older, newer, otherRef, running, firstIndex] = await bound(t, async (c) => [
      await enqueueJob(c, push(t)),
      await enqueueJob(c, push(t)),
      await enqueueJob(c, push(t, { refName: 'refs/heads/dev' })),
      await enqueueJob(c, push(t, { repositoryId: t.repositoryIds[1] as string })),
      await enqueueJob(c, push(t, { kind: JobKind.FirstIndex })),
    ]);
    // A running push of the same ref in the second repository, and one here.
    await claimAsOwner(t, running.id);
    const ids = await bound(t, (c) => supersedeQueuedPushes(c, t, 'refs/heads/main'));
    expect(ids.sort()).toEqual([older.id, newer.id].sort());
    const read = await bound(t, async (c) => ({
      older: await readJob(c, t, older.id),
      otherRef: await readJob(c, t, otherRef.id),
      firstIndex: await readJob(c, t, firstIndex.id),
    }));
    expect(read.older).toMatchObject({ state: 'superseded', fetchUrl: null, startedAt: null });
    expect(read.older?.endedAt).toBeInstanceOf(Date);
    expect(read.otherRef?.state).toBe('queued');
    expect(read.firstIndex?.state).toBe('queued');
    const second = await bound(t, (c) =>
      supersedeQueuedPushes(
        c,
        { ...t, repositoryId: t.repositoryIds[1] as string },
        'refs/heads/main',
      ),
    );
    expect(second).toEqual([]);
  });

  it('touches nothing on a transaction bound to another tenant', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    const other = await tenant();
    expect(await bound(other, (c) => supersedeQueuedPushes(c, t, 'refs/heads/main'))).toEqual([]);
    expect((await bound(t, (c) => readJob(c, t, job.id)))?.state).toBe('queued');
  });
});

describe('readJob and readBatch', () => {
  it('answer null for a row the bound tenant does not hold', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    const other = await tenant();
    expect(await bound(other, (c) => readJob(c, t, job.id))).toBeNull();
    expect(await bound(null, (c) => readJob(c, t, job.id))).toBeNull();
    expect(await bound(t, (c) => readJob(c, t, randomUUID()))).toBeNull();
    expect(await bound(t, (c) => readBatch(c, t, randomUUID()))).toBeNull();
  });
});

describe('insertJobBatches', () => {
  it('writes one queued row per slice, in ordinal order', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await claimAsOwner(t, job.id, null);
    const input = slices(3).reverse();
    const rows = await bound(t, (c) => insertJobBatches(c, t, job.id, input));
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({
      jobId: job.id,
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      state: 'queued',
      attempts: 0,
      storedCount: 0,
      paths: ['f0.ts', 'g0.ts'],
      gitBlobHashes: input[2]?.gitBlobHashes,
    });
    expect(await bound(t, (c) => readBatch(c, t, rows[1]?.id as string))).toEqual(rows[1]);
  });

  it('refuses an empty list and a repeated ordinal, writing nothing', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await expect(bound(t, (c) => insertJobBatches(c, t, job.id, []))).rejects.toBeInstanceOf(
      RangeError,
    );
    await bound(t, (c) => insertJobBatches(c, t, job.id, slices(1)));
    await expect(bound(t, (c) => insertJobBatches(c, t, job.id, slices(2)))).rejects.toBeInstanceOf(
      DuplicateBatchOrdinalError,
    );
    const twice = [...slices(1), ...slices(1)];
    const job2 = await bound(t, (c) => enqueueJob(c, push(t)));
    await expect(bound(t, (c) => insertJobBatches(c, t, job2.id, twice))).rejects.toBeInstanceOf(
      DuplicateBatchOrdinalError,
    );
    const counted = await withClient(db.ownerUrl, (c) =>
      queryRows<{ n: number }>(
        c,
        'SELECT count(*)::int AS n FROM codegraph.index_job_batches WHERE tenant_id = $1',
        [t.tenantId],
      ),
    );
    expect(counted).toEqual([{ n: 1 }]);
  });

  it('writes nothing for an unbound transaction, and passes other refusals through', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await expect(
      bound(null, (c) => insertJobBatches(c, t, job.id, slices(1))),
    ).rejects.toBeInstanceOf(JobNotWritableError);
    await expect(
      bound(t, (c) =>
        insertJobBatches(c, t, job.id, [{ ordinal: 1, paths: ['a'], gitBlobHashes: [] }]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('renewBatchLease', () => {
  it('moves the lease of a batch running under the token, and refuses any other', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await claimAsOwner(t, job.id, null);
    const [b] = await bound(t, (c) => insertJobBatches(c, t, job.id, slices(1)));
    if (!b) throw new Error('no batch');
    await expect(bound(t, (c) => renewBatchLease(c, t, b.id, 'tok', 60_000))).rejects.toEqual(
      new ClaimLostError('batch', b.id),
    );
    await claimBatchAsOwner(b.id, 'tok');
    const renewed = await bound(t, (c) => renewBatchLease(c, t, b.id, 'tok', 3_600_000));
    expect(renewed.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    await expect(
      bound(t, (c) => renewBatchLease(c, t, b.id, 'stolen', 60_000)),
    ).rejects.toBeInstanceOf(ClaimLostError);
    await expect(bound(t, (c) => renewBatchLease(c, t, b.id, 'tok', 0))).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(bound(t, (c) => renewBatchLease(c, t, b.id, 'tok', 1.5))).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('endJob', () => {
  it('ends the job, clears its secret and lease, and fails its unfinished batches', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await claimAsOwner(t, job.id);
    const [b1, b2] = await bound(t, (c) => insertJobBatches(c, t, job.id, slices(2)));
    if (!b1 || !b2) throw new Error('no batches');
    await claimBatchAsOwner(b2.id, 'bt');
    const ended = await bound(t, (c) =>
      endJob(c, t, job.id, 'tok', {
        state: 'failed',
        reasonCode: 'fetch_failed',
        message: 'The source could not be fetched.',
      }),
    );
    expect(ended).toMatchObject({
      state: 'failed',
      fetchUrl: null,
      leaseExpiresAt: null,
      claimedBy: null,
      failureReasonCode: 'fetch_failed',
      failureMessage: 'The source could not be fetched.',
    });
    expect(ended.startedAt).toBeInstanceOf(Date);
    expect(ended.endedAt).toBeInstanceOf(Date);
    for (const id of [b1.id, b2.id]) {
      expect(await bound(t, (c) => readBatch(c, t, id))).toMatchObject({
        state: 'failed',
        failureReasonCode: 'job_failed',
        failureMessage: 'The source could not be fetched.',
        leaseExpiresAt: null,
        claimedBy: null,
      });
    }
  });

  it('ends succeeded with no failure, and fills a default batch message', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await claimAsOwner(t, job.id);
    const [b] = await bound(t, (c) => insertJobBatches(c, t, job.id, slices(1)));
    const ended = await bound(t, (c) => endJob(c, t, job.id, 'tok', { state: 'succeeded' }));
    expect(ended).toMatchObject({ state: 'succeeded', failureReasonCode: null, fetchUrl: null });
    expect(await bound(t, (c) => readBatch(c, t, b?.id as string))).toMatchObject({
      state: 'failed',
      failureReasonCode: 'job_failed',
      failureMessage: 'The job ended succeeded before this batch finished.',
    });
    const job2 = await bound(t, (c) => enqueueJob(c, push(t)));
    await claimAsOwner(t, job2.id);
    expect(
      await bound(t, (c) => endJob(c, t, job2.id, 'tok', { state: 'failed', reasonCode: 'x' })),
    ).toMatchObject({ failureMessage: null, failureReasonCode: 'x' });
  });

  it('refuses a job not running under the token, writing nothing', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await expect(
      bound(t, (c) => endJob(c, t, job.id, 'tok', { state: 'succeeded' })),
    ).rejects.toEqual(new ClaimLostError('job', job.id));
    await claimAsOwner(t, job.id);
    await expect(
      bound(t, (c) => endJob(c, t, job.id, 'other', { state: 'succeeded' })),
    ).rejects.toBeInstanceOf(ClaimLostError);
    const other = await tenant();
    await expect(
      bound(other, (c) => endJob(c, t, job.id, 'tok', { state: 'succeeded' })),
    ).rejects.toBeInstanceOf(ClaimLostError);
    expect((await bound(t, (c) => readJob(c, t, job.id)))?.state).toBe('running');
  });
});

describe('finishBatch', () => {
  async function fannedOut(n: number) {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await claimAsOwner(t, job.id, null);
    const batches = await bound(t, (c) => insertJobBatches(c, t, job.id, slices(n)));
    return { t, job, batches };
  }

  it('stores a batch: its count, its end, its lease cleared', async () => {
    const { t, job, batches } = await fannedOut(2);
    const b = batches[0];
    if (!b) throw new Error('no batch');
    await claimBatchAsOwner(b.id, 'bt');
    const stored = await bound(t, (c) =>
      finishBatch(c, t, b.id, 'bt', { state: 'stored', storedCount: 2 }),
    );
    expect(stored).toMatchObject({
      state: 'stored',
      storedCount: 2,
      leaseExpiresAt: null,
      claimedBy: null,
    });
    expect(stored.endedAt).toBeInstanceOf(Date);
    expect((await bound(t, (c) => readJob(c, t, job.id)))?.state).toBe('running');
    expect((await bound(t, (c) => readBatch(c, t, batches[1]?.id as string)))?.state).toBe(
      'queued',
    );
    await expect(
      bound(t, (c) => finishBatch(c, t, b.id, 'bt', { state: 'stored', storedCount: 2 })),
    ).rejects.toBeInstanceOf(ClaimLostError);
  });

  it('fails a batch: its reason, its job failed with it, the siblings ended', async () => {
    const { t, job, batches } = await fannedOut(3);
    const [b1, b2, b3] = batches;
    if (!b1 || !b2 || !b3) throw new Error('no batches');
    await claimBatchAsOwner(b1.id, 'one');
    await claimBatchAsOwner(b3.id, 'three');
    await bound(t, (c) => finishBatch(c, t, b3.id, 'three', { state: 'stored', storedCount: 1 }));
    const failed = await bound(t, (c) =>
      finishBatch(c, t, b1.id, 'one', {
        state: 'failed',
        reasonCode: 'store_failed',
        message: 'A blob could not be stored.',
      }),
    );
    expect(failed).toMatchObject({
      state: 'failed',
      failureReasonCode: 'store_failed',
      failureMessage: 'A blob could not be stored.',
    });
    const after = await bound(t, async (c) => ({
      job: await readJob(c, t, job.id),
      b2: await readBatch(c, t, b2.id),
      b3: await readBatch(c, t, b3.id),
    }));
    expect(after.job).toMatchObject({
      state: 'failed',
      failureReasonCode: 'store_failed',
      failureMessage: 'A blob could not be stored.',
      fetchUrl: null,
    });
    expect(after.b2).toMatchObject({ state: 'failed', failureReasonCode: 'job_failed' });
    expect(after.b3?.state).toBe('stored');
  });

  it('fails without a message, filling the siblings’ default', async () => {
    const { t, batches } = await fannedOut(2);
    const [b1, b2] = batches;
    if (!b1 || !b2) throw new Error('no batches');
    await claimBatchAsOwner(b1.id, 'one');
    await bound(t, (c) =>
      finishBatch(c, t, b1.id, 'one', { state: 'failed', reasonCode: 'store_failed' }),
    );
    expect(await bound(t, (c) => readBatch(c, t, b2.id))).toMatchObject({
      failureMessage: `Batch ${b1.id} of the job failed (store_failed).`,
    });
    await expect(
      bound(t, (c) => finishBatch(c, t, b2.id, 'x', { state: 'failed', reasonCode: 'y' })),
    ).rejects.toBeInstanceOf(ClaimLostError);
  });
});

describe('a lease renewal is one guarded write', () => {
  it('matches no row for a job another run has claimed, with two connections on the same job', async () => {
    const t = await tenant();
    const job = await bound(t, (c) => enqueueJob(c, push(t)));
    await claimAsOwner(t, job.id, 'current');
    const renew = `UPDATE codegraph.index_jobs SET lease_expires_at = $3
      WHERE id = $1 AND state = 'running' AND claimed_by = $2 RETURNING id`;
    const before = (await bound(t, (c) => readJob(c, t, job.id)))?.leaseExpiresAt;
    const [stale, live] = await Promise.all([
      bound(t, (c) => c.query(renew, [job.id, 'previous', new Date(Date.now() + 9e6)])),
      bound(t, (c) => c.query(renew, [job.id, 'current', new Date(Date.now() + 6e6)])),
    ]);
    expect(stale.rowCount).toBe(0);
    expect(live.rowCount).toBe(1);
    const after = (await bound(t, (c) => readJob(c, t, job.id)))?.leaseExpiresAt;
    expect(after?.getTime()).not.toBe(before?.getTime());
    expect(Math.abs((after?.getTime() ?? 0) - (Date.now() + 6e6))).toBeLessThan(60_000);
  });
});
