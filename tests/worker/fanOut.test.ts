import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_HARD_CEILING, type WorkerSettings } from '../../src/config.js';
import {
  ClaimLostError,
  insertJobBatches,
  JobNotWritableError,
  markBatchStoredAndLockJob,
} from '../../src/db/indexJobs.js';
import { appendLayerPaths, insertLayer } from '../../src/db/layers.js';
import { claimNext, inClaimTransaction, type Claim } from '../../src/db/workerJobs.js';
import { gitBlobHash } from '../../src/fetch/gitBlob.js';
import { openLayer } from '../../src/layers/openLayer.js';
import { resolveCommit } from '../../src/layers/resolution.js';
import { createAppPool } from '../../src/server/pool.js';
import {
  batchFailureOf,
  fanOutJob,
  finaliseJob,
  partitionMissing,
  runBatch,
  SOURCE_MISMATCH,
  type MissingBlob,
} from '../../src/worker/fanOut.js';
import { runJob, type FetchStep, type RunJobDeps } from '../../src/worker/runJob.js';
import { freshDatabase, queryRows, type FreshDatabase } from '../helpers/db.js';
import { recordQueries } from '../helpers/queryLog.js';
import { bindTo, queueTenant, revokeGrant, sha, type QueueTenant } from '../helpers/queue.js';
import {
  bigTree,
  capturingLogger,
  enqueueRequest,
  FETCH_SECRET,
  hashesOf,
  serveTree,
  type LogLine,
  type Tree,
} from '../helpers/workerRun.js';

// The fan-out seam against a real database, with the fetch step injected:
// the verdict and the partition, the last-batch decision, a batch's failures,
// and how the finaliser disposes of each publish outcome.

let db: FreshDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let scratch: string;
let t: QueueTenant;
let lines: LogLine[];

function settings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  return {
    pollMs: 10,
    jobLeaseMs: 60_000,
    maxAttempts: 3,
    scratchDir: scratch,
    blobStoreBatchSize: 2,
    ...overrides,
  };
}

function deps(fetch: FetchStep, overrides: Partial<RunJobDeps> = {}): RunJobDeps {
  return {
    pool,
    settings: settings(),
    layerSettings: { hardCeiling: DEFAULT_HARD_CEILING },
    fetch,
    log: capturingLogger(lines),
    ...overrides,
  };
}

const scopeOf = (tenant: QueueTenant) => ({
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
});

async function claim(): Promise<Claim> {
  const claimed = await claimNext(pool, settings());
  expect(claimed).not.toBeNull();
  return claimed as Claim;
}

async function jobRow(id: string) {
  const [row] = await queryRows<{
    state: string;
    claimed_by: string | null;
    lease_expires_at: Date | null;
    fetch_url: string | null;
    failure_reason_code: string | null;
    failure_message: string | null;
  }>(
    owner,
    `SELECT state, claimed_by, lease_expires_at, fetch_url, failure_reason_code, failure_message
       FROM codegraph.index_jobs WHERE id = $1`,
    [id],
  );
  return row;
}

async function batchRows(jobId: string) {
  return await queryRows<{
    ordinal: number;
    paths: string[];
    git_blob_hashes: string[];
    state: string;
    stored_count: number;
    failure_reason_code: string | null;
    failure_message: string | null;
  }>(
    owner,
    `SELECT ordinal, paths, git_blob_hashes, state, stored_count, failure_reason_code,
            failure_message
       FROM codegraph.index_job_batches WHERE job_id = $1 ORDER BY ordinal`,
    [jobId],
  );
}

async function layersOf(commit: string) {
  return await queryRows<{ id: string; state: string; superseded_at: Date | null }>(
    owner,
    `SELECT id, state, superseded_at FROM codegraph.commit_layers
      WHERE commit_sha = $1 ORDER BY staged_at, id`,
    [commit],
  );
}

async function storedHashes(tenant: QueueTenant): Promise<Set<string>> {
  const rows = await queryRows<{ git_blob_hash: string }>(
    owner,
    'SELECT git_blob_hash FROM codegraph.blob WHERE tenant_id = $1',
    [tenant.tenantId],
  );
  return new Set(rows.map((r) => r.git_blob_hash));
}

/** Enqueues a first index of `tree` and runs it until it fans out. */
async function fannedOut(tree: Tree): Promise<{ jobId: string; commit: string }> {
  const queued = await enqueueRequest(pool, t);
  const ran = await runJob(deps(serveTree(tree)), await claim());
  expect(ran.outcome).toBe('fanned_out');
  return queued;
}

beforeAll(async () => {
  db = await freshDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  pool = createAppPool(db.appUrl);
  scratch = await mkdtemp(join(tmpdir(), 'fanout-scratch-'));
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await rm(scratch, { recursive: true, force: true });
  await db.drop();
});

beforeEach(async () => {
  lines = [];
  await owner.query('DELETE FROM codegraph.index_jobs');
  t = await queueTenant(owner, 2);
});

describe('partitionMissing', () => {
  const missing: MissingBlob[] = Array.from({ length: 5 }, (_, i) => ({
    path: `p${String(i)}`,
    hash: sha(),
  }));

  it('puts every blob in exactly one slice of at most the size, numbered from 1', () => {
    const slices = partitionMissing(missing, 2);
    expect(slices.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(slices.map((s) => s.paths.length)).toEqual([2, 2, 1]);
    expect(slices.flatMap((s) => s.paths)).toEqual(missing.map((m) => m.path));
    expect(slices.flatMap((s) => s.gitBlobHashes)).toEqual(missing.map((m) => m.hash));
    expect(partitionMissing([], 2)).toEqual([]);
  });

  it('refuses a size that is not a positive whole number', () => {
    expect(() => partitionMissing(missing, 0)).toThrow(RangeError);
    expect(() => partitionMissing(missing, 1.5)).toThrow(RangeError);
  });
});

describe('fanOutJob', () => {
  it('keeps a job of no more than BLOB_STORE_BATCH_SIZE missing blobs in one pass, writing no batch', async () => {
    const { jobId, commit } = await enqueueRequest(pool, t);
    const tree = bigTree(2);
    const ran = await runJob(deps(serveTree(tree)), await claim());
    expect(ran).toEqual({ outcome: 'succeeded', storedBlobs: 2 });
    expect(await batchRows(jobId)).toEqual([]);
    expect((await jobRow(jobId))?.state).toBe('succeeded');
    expect((await layersOf(commit)).map((l) => l.state)).toEqual(['published']);

    // The verdict alone, at exactly the size: no write at all.
    const second = await enqueueRequest(pool, t, { repositoryId: t.repositoryIds[1] as string });
    const c = await claim();
    const missing = [...hashesOf(bigTree(2, 'other'))].map(([path, hash]) => ({ path, hash }));
    expect(await fanOutJob(deps(serveTree({})), c, { layerId: 'unused' }, missing)).toEqual({
      fannedOut: false,
    });
    expect(await batchRows(second.jobId)).toEqual([]);
    expect((await jobRow(second.jobId))?.claimed_by).toBe(c.claimedBy);
  });

  it('splits a larger store into slices and releases the lease in one transaction, keeping the URL', async () => {
    const tree = bigTree(5);
    const { jobId, commit } = await fannedOut(tree);
    const job = await jobRow(jobId);
    expect(job).toMatchObject({ state: 'running', claimed_by: null, lease_expires_at: null });
    expect(job?.fetch_url).toContain(FETCH_SECRET);

    const batches = await batchRows(jobId);
    expect(batches.map((b) => [b.ordinal, b.state, b.paths.length])).toEqual([
      [1, 'queued', 2],
      [2, 'queued', 2],
      [3, 'queued', 1],
    ]);
    const sliced = batches.flatMap((b) => b.paths.map((p, i) => [p, b.git_blob_hashes[i]]));
    expect(new Map(sliced as [string, string][])).toEqual(hashesOf(tree));
    expect(sliced).toHaveLength(5);
    expect((await layersOf(commit)).map((l) => l.state)).toEqual(['staged']);
    expect(lines.some((l) => l.message === 'job fanned out' && l.fields.batches === 3)).toBe(true);
    // The fetch step's scratch is gone: a claimant re-fetches.
    expect(await readdir(scratch)).toEqual([]);
  });

  it('writes nothing and answers lease_lost when the claim no longer holds the job', async () => {
    const { jobId } = await enqueueRequest(pool, t);
    const c = await claim();
    const missing = [...hashesOf(bigTree(3))].map(([path, hash]) => ({ path, hash }));
    await expect(
      fanOutJob(deps(serveTree({})), { ...c, claimedBy: 'another' }, { layerId: 'x' }, missing),
    ).rejects.toMatchObject({ name: 'LeaseLostError' });
    expect(await batchRows(jobId)).toEqual([]);
    expect((await jobRow(jobId))?.claimed_by).toBe(c.claimedBy);
  });
});

describe('runBatch', () => {
  it('stores only its slice, and the last batch finalises: one publish, the URL gone', async () => {
    const tree = bigTree(5);
    const { jobId, commit } = await fannedOut(tree);
    const before = await storedHashes(t);
    expect(before.size).toBe(0);

    const first = await claim();
    expect(first.kind).toBe('batch');
    const ran = await runBatch(deps(serveTree(tree)), first);
    expect(ran).toEqual({ outcome: 'batch_stored', storedBlobs: 2, finalised: null });
    const [b1] = await batchRows(jobId);
    expect(await storedHashes(t)).toEqual(new Set(b1?.git_blob_hashes));
    expect(b1).toMatchObject({ state: 'stored', stored_count: 2 });

    expect(await runBatch(deps(serveTree(tree)), await claim())).toMatchObject({
      finalised: null,
    });
    const last = await runBatch(deps(serveTree(tree)), await claim());
    expect(last).toEqual({
      outcome: 'batch_stored',
      storedBlobs: 1,
      finalised: { outcome: 'succeeded', storedBlobs: 0 },
    });
    expect(await claimNext(pool, settings())).toBeNull();

    const job = await jobRow(jobId);
    expect(job).toMatchObject({ state: 'succeeded', fetch_url: null, claimed_by: null });
    expect((await layersOf(commit)).map((l) => l.state)).toEqual(['published']);
    const resolution = await resolveCommit(owner, t.tenantId, t.repositoryId, commit);
    expect(resolution.state === 'indexed' ? resolution.paths : null).toEqual(
      new Map([...hashesOf(tree)].sort(([a], [b]) => (a < b ? -1 : 1))),
    );
    expect(await readdir(scratch)).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(FETCH_SECRET);
  });

  it('renews its lease while it stores when a third of the lease has passed', async () => {
    const tree = bigTree(5);
    await fannedOut(tree);
    const c = await claim();
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    try {
      const ran = await runBatch(
        { ...deps(serveTree(tree)), pool: recordingPool, settings: settings({ jobLeaseMs: 3 }) },
        c,
      );
      expect(ran.outcome).toBe('batch_stored');
    } finally {
      await recordingPool.end();
    }
    const texts = recorded.texts();
    const stores = texts.flatMap((text, i) =>
      text.startsWith('INSERT INTO codegraph.blob') ? [i] : [],
    );
    const renewals = texts.flatMap((text, i) =>
      text.includes('UPDATE codegraph.index_job_batches') && text.includes('SET lease_expires_at')
        ? [i]
        : [],
    );
    expect(stores.length).toBeGreaterThanOrEqual(2);
    expect(
      renewals.filter((i) => i > (stores[0] as number) && i < (stores.at(-1) as number)).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('ends a batch whose fetch is refused failed, and its job with the same code and no URL', async () => {
    const { jobId, commit } = await fannedOut(bigTree(5));
    const refuse: FetchStep = ({ url }) =>
      Promise.resolve({
        ok: false,
        reasonCode: 'fetch_failed',
        message: `GET ${url} answered 403`,
      });
    expect(await runBatch(deps(refuse), await claim())).toEqual({
      outcome: 'failed',
      reasonCode: 'fetch_failed',
    });
    const batches = await batchRows(jobId);
    expect(batches.map((b) => [b.state, b.failure_reason_code])).toEqual([
      ['failed', 'fetch_failed'],
      ['failed', 'job_failed'],
      ['failed', 'job_failed'],
    ]);
    expect(batches[0]?.failure_message).toContain('[fetch-url]');
    const job = await jobRow(jobId);
    expect(job).toMatchObject({
      state: 'failed',
      failure_reason_code: 'fetch_failed',
      fetch_url: null,
    });
    expect(JSON.stringify({ batches, job, lines })).not.toContain(FETCH_SECRET);
    // No other batch is handed out, and the staged layer is left for the discard.
    expect(await claimNext(pool, settings())).toBeNull();
    expect((await layersOf(commit)).map((l) => l.state)).toEqual(['staged']);
  });

  it('ends a batch source_mismatch when the re-fetched tree holds its path at another hash', async () => {
    const tree = bigTree(5);
    const { jobId } = await fannedOut(tree);
    const changed = { ...tree, 'src/f000.txt': 'changed since\n' };
    expect(await runBatch(deps(serveTree(changed)), await claim())).toEqual({
      outcome: 'failed',
      reasonCode: SOURCE_MISMATCH,
    });
    expect((await jobRow(jobId))?.failure_reason_code).toBe(SOURCE_MISMATCH);
    expect(await storedHashes(t)).toEqual(new Set());
  });

  it('writes nothing for a batch another claim holds, or whose grant is gone', async () => {
    const tree = bigTree(5);
    const { jobId } = await fannedOut(tree);
    const c = await claim();
    expect(await runBatch(deps(serveTree(tree)), { ...c, claimedBy: 'another' })).toEqual({
      outcome: 'lease_lost',
    });
    // A grant revoked mid-store: the batch can be neither marked nor failed.
    let revoked = false;
    const revoking: FetchStep = async (target) => {
      if (!revoked) {
        revoked = true;
        await revokeGrant(owner, t);
      }
      return await serveTree(tree)(target);
    };
    expect(await runBatch(deps(revoking), c)).toEqual({ outcome: 'grant_lost' });
    expect((await batchRows(jobId))[0]?.state).toBe('running');
    expect((await jobRow(jobId))?.state).toBe('running');
  });

  it('answers lease_lost when another batch failed the job while this one ran', async () => {
    const tree = bigTree(5);
    const { jobId } = await fannedOut(tree);
    const first = await claim();
    const second = await claim();
    const refuse: FetchStep = () =>
      Promise.resolve({ ok: false, reasonCode: 'fetch_failed', message: 'refused' });
    // The second batch's fetch fails only after the first batch has failed the job.
    const afterFirst: FetchStep = async (target) => {
      expect(await runBatch(deps(refuse), first)).toMatchObject({ outcome: 'failed' });
      return await refuse(target);
    };
    expect(await runBatch(deps(afterFirst), second)).toEqual({ outcome: 'lease_lost' });
    expect((await batchRows(jobId)).map((b) => b.failure_reason_code)).toEqual([
      'fetch_failed',
      'job_failed',
      'job_failed',
    ]);
  });

  it('raises past its own handling when the batch’s failure cannot be recorded', async () => {
    await fannedOut(bigTree(5));
    const malformed: FetchStep = () =>
      Promise.resolve({ ok: false, reasonCode: 'Not A Code', message: 'refused' });
    // The schema refuses a reason code of that shape; the loop logs the throw.
    await expect(runBatch(deps(malformed), await claim())).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('refuses a claim that is not a batch claim', async () => {
    await enqueueRequest(pool, t);
    await expect(runBatch(deps(serveTree({})), await claim())).rejects.toThrow(TypeError);
  });

  it('maps a refused binding to binding_refused', () => {
    expect(batchFailureOf(new JobNotWritableError('no'))).toEqual({
      reasonCode: 'binding_refused',
      message: 'no',
    });
    expect(batchFailureOf(new Error('boom')).reasonCode).toBe('internal_error');
  });
});

describe('markBatchStoredAndLockJob', () => {
  async function twoRunningBatches(): Promise<{ jobId: string; claims: Claim[] }> {
    const { jobId } = await fannedOut(bigTree(4));
    return { jobId, claims: [await claim(), await claim()] };
  }

  async function begin(c: Claim): Promise<pg.PoolClient> {
    const client = await pool.connect();
    await client.query('BEGIN');
    await bindTo(client, t);
    expect(c.tenantId).toBe(t.tenantId);
    return client;
  }

  it('makes exactly one finaliser of two claimants storing a job’s last two batches at once', async () => {
    const { jobId, claims } = await twoRunningBatches();
    const [a, b] = claims as [Claim, Claim];
    const ca = await begin(a);
    const cb = await begin(b);
    try {
      const marked = await markBatchStoredAndLockJob(
        ca,
        scopeOf(t),
        a.batchId as string,
        a.claimedBy,
        2,
        60_000,
      );
      expect(marked).toMatchObject({ unstoredBatches: 1, finaliserToken: null });
      // B waits on the job's row lock A holds, and counts after A commits.
      const pending = markBatchStoredAndLockJob(
        cb,
        scopeOf(t),
        b.batchId as string,
        b.claimedBy,
        2,
        60_000,
      );
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await ca.query('COMMIT');
      const last = await pending;
      expect(last.unstoredBatches).toBe(0);
      expect(last.finaliserToken).toEqual(expect.any(String));
      await cb.query('COMMIT');
      expect((await jobRow(jobId))?.claimed_by).toBe(last.finaliserToken);
    } finally {
      ca.release();
      cb.release();
    }
  });

  it('refuses a transaction bound to another tenant before its first write', async () => {
    const { jobId, claims } = await twoRunningBatches();
    const [a] = claims as [Claim];
    const other = await queueTenant(owner);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bindTo(client, other);
      await expect(
        markBatchStoredAndLockJob(client, scopeOf(t), a.batchId as string, a.claimedBy, 2, 1000),
      ).rejects.toBeInstanceOf(JobNotWritableError);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await batchRows(jobId)).map((b) => b.state)).toEqual(['running', 'running']);
  });

  it('refuses a batch not running under this token, and a non-positive lease', async () => {
    const { claims } = await twoRunningBatches();
    const [a] = claims as [Claim];
    await expect(
      inClaimTransaction(pool, a, (c) =>
        markBatchStoredAndLockJob(c, scopeOf(t), a.batchId as string, 'nope', 2, 1000),
      ),
    ).rejects.toBeInstanceOf(ClaimLostError);
    await expect(
      inClaimTransaction(pool, a, (c) =>
        markBatchStoredAndLockJob(c, scopeOf(t), a.batchId as string, a.claimedBy, 2, 0),
      ),
    ).rejects.toThrow(RangeError);
  });

  it('takes no lease for a job that still holds its own', async () => {
    const { jobId } = await enqueueRequest(pool, t);
    const job = await claim();
    const hash = gitBlobHash(Buffer.from('x'));
    await inClaimTransaction(pool, job, (c) =>
      insertJobBatches(c, scopeOf(t), jobId, [{ ordinal: 1, paths: ['x'], gitBlobHashes: [hash] }]),
    );
    const batch = await claim();
    const marked = await inClaimTransaction(pool, batch, (c) =>
      markBatchStoredAndLockJob(c, scopeOf(t), batch.batchId as string, batch.claimedBy, 1, 1000),
    );
    expect(marked).toMatchObject({ unstoredBatches: 0, finaliserToken: null });
    expect((await jobRow(jobId))?.claimed_by).toBe(job.claimedBy);
  });
});

describe('finaliseJob', () => {
  /** A fanned-out job whose batches are all stored, and the finaliser's claim. */
  async function readyToFinalise(
    tree: Tree,
  ): Promise<{ jobId: string; commit: string; fin: Claim }> {
    const queued = await fannedOut(tree);
    let next = await claimNext(pool, settings());
    while (next !== null) {
      await runBatch(deps(serveTree(tree)), next);
      next = await claimNext(pool, settings());
    }
    expect((await jobRow(queued.jobId))?.state).toBe('succeeded');
    // Rewind the job to "finaliser holds the lease" so each case drives finaliseJob itself.
    const [row] = await queryRows<{ token: string }>(
      owner,
      `UPDATE codegraph.index_jobs
          SET state = 'running', ended_at = NULL, fetch_url = 'https://git.example/x.tar.gz',
              claimed_by = 'fin', lease_expires_at = now() + interval '1 minute'
        WHERE id = $1 RETURNING claimed_by AS token`,
      [queued.jobId],
    );
    const fin: Claim = {
      kind: 'job',
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      clientId: t.clientId,
      jobId: queued.jobId,
      batchId: null,
      claimedBy: row?.token as string,
    };
    return { ...queued, fin };
  }

  it('publishes again harmlessly: one current layer, the ref head naming it', async () => {
    const tree = bigTree(3);
    const { jobId, commit, fin } = await readyToFinalise(tree);
    const before = await layersOf(commit);
    expect(await finaliseJob(deps(serveTree(tree)), fin)).toEqual({
      outcome: 'succeeded',
      storedBlobs: 0,
    });
    const after = await layersOf(commit);
    expect(after).toEqual(before);
    expect(after.filter((l) => l.state === 'published' && l.superseded_at === null)).toHaveLength(
      1,
    );
    const heads = await queryRows<{ layer_id: string }>(
      owner,
      'SELECT layer_id FROM codegraph.ref_heads WHERE repository_id = $1',
      [t.repositoryId],
    );
    expect(heads).toEqual([{ layer_id: after[0]?.id }]);
    expect((await jobRow(jobId))?.fetch_url).toBeNull();
  });

  it('ends the job succeeded when the publish is refused but the commit has a current layer', async () => {
    const tree = bigTree(3);
    const { jobId, commit, fin } = await readyToFinalise(tree);
    // A newer staged layer of the same commit names a blob nothing stored.
    await inClaimTransaction(pool, fin, async (c) => {
      const layer = await insertLayer(c, { ...scopeOf(t), commitSha: commit, kind: 'base' });
      await appendLayerPaths(c, scopeOf(t), layer.id, [
        { path: 'ghost.txt', gitBlobHash: gitBlobHash(Buffer.from('ghost')) },
      ]);
    });
    expect(await finaliseJob(deps(serveTree(tree)), fin)).toEqual({
      outcome: 'succeeded',
      storedBlobs: 0,
    });
    expect((await jobRow(jobId))?.state).toBe('succeeded');
    expect(lines.some((l) => l.fields.refusal === 'UnstoredBlobsError')).toBe(true);
  });

  it('ends the job failed with the missing count when the commit has no current layer', async () => {
    // The repository's previous commit, published through the one-pass run.
    const prior = await enqueueRequest(pool, t);
    expect((await runJob(deps(serveTree({ 'a.txt': 'a\n' })), await claim())).outcome).toBe(
      'succeeded',
    );
    const { jobId, commit } = await enqueueRequest(pool, t);
    const c = await claim();
    const opened = await openLayer(pool, {
      clientId: t.clientId,
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      commitSha: commit,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
      candidateAncestors: [],
      paths: hashesOf(bigTree(3, 'unstored')),
      settings: { hardCeiling: DEFAULT_HARD_CEILING },
    });
    expect(opened.state).toBe('staged');
    expect(await finaliseJob(deps(serveTree({})), c)).toEqual({
      outcome: 'failed',
      reasonCode: 'layer_unpublishable',
    });
    const job = await jobRow(jobId);
    expect(job?.failure_message).toMatch(/^3 blob\(s\) of the layer are not stored/);
    const heads = await queryRows<{ commit_sha: string }>(
      owner,
      'SELECT commit_sha FROM codegraph.ref_heads WHERE repository_id = $1',
      [t.repositoryId],
    );
    expect(heads).toEqual([{ commit_sha: prior.commit }]);
  });

  it('ends the job failed when the commit has neither a staged nor a current layer', async () => {
    const { jobId } = await enqueueRequest(pool, t);
    expect(await finaliseJob(deps(serveTree({})), await claim())).toEqual({
      outcome: 'failed',
      reasonCode: 'layer_unpublishable',
    });
    expect((await jobRow(jobId))?.failure_message).toContain('no staged or current layer');
  });

  it('ends a job failed with the refusal’s own reason when its layer goes before the publish', async () => {
    const { jobId, commit } = await enqueueRequest(pool, t);
    const c = await claim();
    const opened = await openLayer(pool, {
      clientId: t.clientId,
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      commitSha: commit,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
      candidateAncestors: [],
      paths: hashesOf({ 'a.txt': 'a\n' }),
      settings: { hardCeiling: DEFAULT_HARD_CEILING },
    });
    // The staged layer is removed between the finaliser's read and its publish
    // (a re-open replacing it), at the lease checkpoint that separates them.
    const hooked = createAppPool(db.appUrl);
    const connect = hooked.connect.bind(hooked) as () => Promise<pg.PoolClient>;
    (hooked as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
        ...args: unknown[]
      ) => {
        if (typeof args[0] === 'string' && args[0].startsWith('UPDATE codegraph.index_jobs')) {
          await owner.query('DELETE FROM codegraph.commit_layers WHERE id = $1', [opened.layerId]);
        }
        return await query(...args);
      };
      return client;
    };
    try {
      expect(await finaliseJob({ ...deps(serveTree({})), pool: hooked }, c)).toEqual({
        outcome: 'failed',
        reasonCode: 'layer_unpublishable',
      });
    } finally {
      await hooked.end();
    }
    expect((await jobRow(jobId))?.failure_message).toContain('not_found');
  });

  it('answers lease_lost when the lease moves on between the publish and the job’s end', async () => {
    const tree = bigTree(3);
    const { jobId, fin } = await readyToFinalise(tree);
    const hooked = createAppPool(db.appUrl);
    const connect = hooked.connect.bind(hooked) as () => Promise<pg.PoolClient>;
    (hooked as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
        ...args: unknown[]
      ) => {
        const result = await query(...args);
        if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO codegraph.ref_heads')) {
          await owner.query("UPDATE codegraph.index_jobs SET claimed_by = 'thief' WHERE id = $1", [
            jobId,
          ]);
        }
        return result;
      };
      return client;
    };
    try {
      expect(await finaliseJob({ ...deps(serveTree(tree)), pool: hooked }, fin)).toEqual({
        outcome: 'lease_lost',
      });
    } finally {
      await hooked.end();
    }
    expect((await jobRow(jobId))?.state).toBe('running');
  });

  it('answers lease_lost and writes nothing under a token that no longer holds the job', async () => {
    const tree = bigTree(3);
    const { jobId, fin } = await readyToFinalise(tree);
    expect(await finaliseJob(deps(serveTree(tree)), { ...fin, claimedBy: 'stale' })).toEqual({
      outcome: 'lease_lost',
    });
    expect((await jobRow(jobId))?.state).toBe('running');
  });

  it('publishes through publishLayer exactly once per finalisation', async () => {
    const tree = bigTree(3);
    const { fin } = await readyToFinalise(tree);
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    try {
      await finaliseJob({ ...deps(serveTree(tree)), pool: recordingPool }, fin);
    } finally {
      await recordingPool.end();
    }
    expect(
      recorded.texts().filter((text) => text.includes('INSERT INTO codegraph.ref_heads')),
    ).toHaveLength(1);
  });
});
