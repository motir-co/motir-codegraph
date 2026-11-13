import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  readLayerSettings,
  readMaintenanceSettings,
  type LayerSettings,
  type WorkerSettings,
} from '../../src/config.js';
import { JobNotWritableError, readJob, type JobRow } from '../../src/db/indexJobs.js';
import { enqueueMaintenanceJob, maintenanceDue } from '../../src/db/maintenanceJobs.js';
import { claimNext, inClaimTransaction, type Claim } from '../../src/db/workerJobs.js';
import { gitBlobHash } from '../../src/fetch/gitBlob.js';
import { storeBlob } from '../../src/indexing/storeBlob.js';
import { openLayer } from '../../src/layers/openLayer.js';
import { resolveCommit } from '../../src/layers/resolution.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { createAppPool } from '../../src/server/pool.js';
import { runWorkerLoop } from '../../src/worker/loop.js';
import {
  enqueueCompactionIfDue,
  NOT_HANDLED,
  runMaintenanceJob,
  runMaintenanceTick,
} from '../../src/worker/maintenance.js';
import { runJob, type RunJobDeps, type RunResult } from '../../src/worker/runJob.js';
import { freshDatabase, queryRows, type FreshDatabase } from '../helpers/db.js';
import { recordQueries } from '../helpers/queryLog.js';
import { bindTo, queueTenant, revokeGrant, sha, type QueueTenant } from '../helpers/queue.js';
import {
  capturingLogger,
  enqueueRequest,
  hashesOf,
  serveTree,
  type LogLine,
  type Tree,
} from '../helpers/workerRun.js';

// The three maintenance kinds against a real database: where each is
// enqueued, what running it calls and answers, its refusals, and its repeat.

let db: FreshDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let scratch: string;
let t: QueueTenant;
let lines: LogLine[];

/** A threshold of 1: the second delta of a chain is due. */
const LAYERS: LayerSettings = readLayerSettings({ COMPACTION_THRESHOLD: '1' });
const HOUR = 3_600_000;

function settings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  return {
    pollMs: 10,
    jobLeaseMs: 60_000,
    maxAttempts: 3,
    scratchDir: scratch,
    blobStoreBatchSize: 500,
    ...overrides,
  };
}

function deps(tree: Tree = {}, overrides: Partial<RunJobDeps> = {}): RunJobDeps {
  return {
    pool,
    settings: settings(),
    layerSettings: LAYERS,
    fetch: serveTree(tree),
    log: capturingLogger(lines),
    ...overrides,
  };
}

function tickDeps(overrides: { jobsPerTick?: number } = {}) {
  return {
    pool,
    layerSettings: LAYERS,
    maintenance: { intervalMs: 60_000, jobsPerTick: overrides.jobsPerTick ?? 3 },
    log: capturingLogger(lines),
  };
}

const target = () => ({
  tenantId: t.tenantId,
  repositoryId: t.repositoryId,
  clientId: t.clientId,
});
const scope = () => ({ tenantId: t.tenantId, repositoryId: t.repositoryId });

async function claim(): Promise<Claim> {
  const claimed = await claimNext(pool, settings());
  expect(claimed).not.toBeNull();
  return claimed as Claim;
}

/** Enqueues a first index of `tree` (at `commit`) and runs it to its end. */
async function index(tree: Tree, commit = sha()): Promise<string> {
  await enqueueRequest(pool, t, { commit });
  const ran = await runJob(deps(tree), await claim());
  expect(ran.outcome).toBe('succeeded');
  return commit;
}

async function jobsOf(kind: string) {
  return await queryRows<{
    id: string;
    kind: string;
    commit_sha: string | null;
    client_id: string;
    fetch_url: string | null;
    state: string;
    failure_reason_code: string | null;
  }>(
    owner,
    `SELECT id, kind, commit_sha, client_id, fetch_url, state, failure_reason_code
       FROM codegraph.index_jobs WHERE tenant_id = $1 AND kind = $2 ORDER BY enqueued_at, id`,
    [t.tenantId, kind],
  );
}

async function layerRows() {
  return await queryRows<{
    id: string;
    commit_sha: string;
    state: string;
    superseded_at: Date | null;
    depth: number;
  }>(
    owner,
    `SELECT id, commit_sha, state, superseded_at, depth FROM codegraph.commit_layers
      WHERE tenant_id = $1 ORDER BY staged_at, id`,
    [t.tenantId],
  );
}

async function resolved(commit: string) {
  const resolution = await resolveCommit(owner, t.tenantId, t.repositoryId, commit);
  return resolution.state === 'indexed' ? resolution.paths : null;
}

/** Stages a layer naming `tree` for a fresh commit and backdates it `ageMs`. */
async function staleStaged(tree: Tree, ageMs: number): Promise<string> {
  const opened = await openLayer(pool, {
    clientId: t.clientId,
    tenantId: t.tenantId,
    repositoryId: t.repositoryId,
    commitSha: sha(),
    refName: 'refs/heads/main',
    isDefaultBranch: true,
    candidateAncestors: [],
    paths: hashesOf(tree),
    settings: LAYERS,
  });
  await owner.query(
    `UPDATE codegraph.commit_layers SET staged_at = now() - make_interval(secs => $2 / 1000.0)
      WHERE id = $1`,
    [opened.layerId, ageMs],
  );
  return opened.layerId;
}

/** Three published commits: a base, a delta, and a delta of depth 2 — past a threshold of 1. */
async function chainOfThree(): Promise<string[]> {
  const commits: string[] = [];
  let tree: Tree = { 'a.txt': 'a\n', 'b.txt': 'b\n' };
  for (let i = 0; i < 3; i += 1) {
    tree = { ...tree, [`f${String(i)}.txt`]: `v${String(i)}\n` };
    commits.push(await index(tree));
  }
  return commits;
}

beforeAll(async () => {
  db = await freshDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  pool = createAppPool(db.appUrl);
  scratch = await mkdtemp(join(tmpdir(), 'maintenance-scratch-'));
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

describe('compaction on the publish path', () => {
  it('enqueues one compact job when a publish leaves the commit deeper than the threshold', async () => {
    const [c1, c2, c3] = (await chainOfThree()) as [string, string, string];
    const compacts = await jobsOf('compact');
    // Depth 0 and 1 are at or below the threshold; depth 2 is past it.
    expect(compacts).toEqual([
      expect.objectContaining({
        commit_sha: c3,
        client_id: t.clientId,
        fetch_url: null,
        state: 'queued',
      }),
    ]);
    expect(compacts.map((j) => j.commit_sha)).not.toContain(c1);
    expect(compacts.map((j) => j.commit_sha)).not.toContain(c2);
    expect(lines.some((l) => l.message === 'compaction enqueued')).toBe(true);
  });

  it('enqueues no second compact for a commit with one queued or running, and one per commit', async () => {
    const [, c2, c3] = (await chainOfThree()) as [string, string, string];
    const job = {
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      clientId: t.clientId,
      commitSha: c3,
    };
    const again = await inClaimTransaction(pool, t, (c) => enqueueCompactionIfDue(c, LAYERS, job));
    expect(again).toBeNull();
    // A lower threshold makes c2 due too: its own job, beside c3's.
    const other = await inClaimTransaction(pool, t, (c) =>
      enqueueCompactionIfDue(c, { compactionThreshold: 0 }, { ...job, commitSha: c2 }),
    );
    expect(other).toEqual(expect.any(String));
    expect((await jobsOf('compact')).map((j) => j.commit_sha)).toEqual([c3, c2]);
    // A job with no commit, or a commit with no current layer, enqueues nothing.
    expect(
      await inClaimTransaction(pool, t, (c) =>
        enqueueCompactionIfDue(c, LAYERS, { ...job, commitSha: null }),
      ),
    ).toBeNull();
    expect(
      await inClaimTransaction(pool, t, (c) =>
        enqueueCompactionIfDue(c, LAYERS, { ...job, commitSha: sha() }),
      ),
    ).toBeNull();
  });

  it('runs the compact job through the claim: same map, the ref head on the new base, a repeat changes nothing', async () => {
    const [, , c3] = (await chainOfThree()) as [string, string, string];
    const before = await resolved(c3);
    const compactClaim = await claim();
    const [compactJob] = await jobsOf('compact');
    expect(compactClaim.jobId).toBe(compactJob?.id);

    const ran = await runJob(deps(), compactClaim);
    expect(ran).toMatchObject({
      outcome: 'maintained',
      answer: { kind: 'compact', result: { outcome: 'compacted' } },
    });
    expect((await jobsOf('compact'))[0]?.state).toBe('succeeded');
    expect(await resolved(c3)).toEqual(before);
    const base = (ran as Extract<RunResult, { outcome: 'maintained' }>).answer;
    const baseLayerId =
      base.kind === 'compact' && 'baseLayerId' in base.result ? base.result.baseLayerId : null;
    const heads = await queryRows<{ layer_id: string }>(
      owner,
      'SELECT layer_id FROM codegraph.ref_heads WHERE repository_id = $1',
      [t.repositoryId],
    );
    expect(heads).toEqual([{ layer_id: baseLayerId }]);

    // The same job run again (a lease that lapsed): the library answers not_due.
    const job = await inClaimTransaction(pool, t, (c) => readJob(c, scope(), compactClaim.jobId));
    expect(await runMaintenanceJob(deps(), compactClaim, job as JobRow)).toEqual({
      handled: true,
      answer: { kind: 'compact', result: { outcome: 'not_due', depth: 0, threshold: 1 } },
    });
  });

  it('answers not_indexed for a commit with no layer, and the job still succeeds', async () => {
    await inClaimTransaction(pool, t, (c) =>
      enqueueMaintenanceJob(c, { ...target(), kind: 'compact', commitSha: sha() }),
    );
    expect(await runJob(deps(), await claim())).toMatchObject({
      outcome: 'maintained',
      answer: { kind: 'compact', result: { outcome: 'not_indexed' } },
    });
    expect((await jobsOf('compact'))[0]?.state).toBe('succeeded');
  });

  it('re-runs a compact job whose lease lapsed under a new claim, and ends it once', async () => {
    const [, , c3] = (await chainOfThree()) as [string, string, string];
    const first = await claim();
    await owner.query(
      "UPDATE codegraph.index_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [first.jobId],
    );
    const second = await claim();
    expect(second.jobId).toBe(first.jobId);
    expect(await runJob(deps(), second)).toMatchObject({ outcome: 'maintained' });
    expect(await runJob(deps(), first)).toEqual({ outcome: 'lease_lost' });
    expect(await resolved(c3)).not.toBeNull();
    expect((await jobsOf('compact')).map((j) => j.state)).toEqual(['succeeded']);
  });
});

describe('the maintenance tick', () => {
  it('enqueues one discard_stale for a stale staged layer, as the given client, and deduplicates it', async () => {
    await staleStaged({ 'x.txt': 'x\n' }, LAYERS.stagedLayerStaleness + HOUR);
    expect(await runMaintenanceTick(tickDeps(), target())).toEqual(['discard_stale']);
    expect(await runMaintenanceTick(tickDeps(), target())).toEqual([]);
    expect(await jobsOf('discard_stale')).toEqual([
      expect.objectContaining({ client_id: t.clientId, fetch_url: null, commit_sha: null }),
    ]);
    expect(lines.some((l) => l.message === 'maintenance jobs enqueued')).toBe(true);
  });

  it('enqueues nothing for a staged layer inside the window, or for another repository', async () => {
    await staleStaged({ 'x.txt': 'x\n' }, 1_000);
    expect(await runMaintenanceTick(tickDeps(), target())).toEqual([]);
    await staleStaged({ 'y.txt': 'y\n' }, LAYERS.stagedLayerStaleness + HOUR);
    expect(
      await runMaintenanceTick(tickDeps(), {
        ...target(),
        repositoryId: t.repositoryIds[1] as string,
      }),
    ).toEqual([]);
  });

  it('enqueues release for a releasable layer, and at most MAINTENANCE_JOBS_PER_TICK in all', async () => {
    await chainOfThree();
    expect((await runJob(deps(), await claim())).outcome).toBe('maintained');
    await staleStaged({ 'x.txt': 'x\n' }, LAYERS.stagedLayerStaleness + HOUR);
    expect(
      await inClaimTransaction(pool, t, (c) =>
        maintenanceDue(c, scope(), new Date(Date.now() - LAYERS.stagedLayerStaleness)),
      ),
    ).toEqual({ discardStale: true, release: true });
    expect(await runMaintenanceTick(tickDeps({ jobsPerTick: 1 }), target())).toEqual([
      'discard_stale',
    ]);
    expect(await runMaintenanceTick(tickDeps(), target())).toEqual(['release']);
    expect(await runMaintenanceTick(tickDeps(), target())).toEqual([]);
  });

  it('runs every statement in a transaction bound as the given client', async () => {
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    try {
      await runMaintenanceTick({ ...tickDeps(), pool: recordingPool }, target());
    } finally {
      await recordingPool.end();
    }
    const texts = recorded.texts();
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toBe(BIND_TENANT_SQL);
    expect(texts.at(-1)).toBe('COMMIT');
    expect(texts.some((text) => text.includes('codegraph_claim_index_job'))).toBe(false);
  });

  it('refuses a transaction bound to another tenant', async () => {
    const other = await queueTenant(owner);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bindTo(client, other);
      await expect(maintenanceDue(client, scope(), new Date())).rejects.toBeInstanceOf(
        JobNotWritableError,
      );
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await bindTo(client, other);
      await expect(
        enqueueMaintenanceJob(client, { ...target(), kind: 'release' }),
      ).rejects.toBeInstanceOf(JobNotWritableError);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('the discard and release jobs', () => {
  it('discards the repository’s stale staged layer with its paths; a second run removes nothing', async () => {
    const stale = await staleStaged(
      { 'only.txt': 'only staged\n' },
      LAYERS.stagedLayerStaleness + HOUR,
    );
    await runMaintenanceTick(tickDeps(), target());
    const c = await claim();
    const ran = await runJob(deps(), c);
    expect(ran).toMatchObject({
      outcome: 'maintained',
      answer: { kind: 'discard_stale', result: { layerIds: [stale], pathCount: 1 } },
    });
    expect((await layerRows()).map((l) => l.id)).not.toContain(stale);
    const [job] = await jobsOf('discard_stale');
    const row = await inClaimTransaction(pool, t, (cl) => readJob(cl, scope(), job?.id as string));
    expect(await runMaintenanceJob(deps(), c, row as JobRow)).toMatchObject({
      handled: true,
      answer: { kind: 'discard_stale', result: { layerIds: [], pathCount: 0 } },
    });
  });

  it('releases the retired layer and unreferenced blobs, sparing a blob a staged layer names', async () => {
    await chainOfThree();
    expect((await runJob(deps(), await claim())).outcome).toBe('maintained');
    const retired = (await layerRows()).filter((l) => l.superseded_at !== null).map((l) => l.id);
    expect(retired).toHaveLength(1);
    // An orphan blob nothing names, and one only a fresh staged layer names.
    const orphan = Buffer.from('orphan\n');
    const pinned = Buffer.from('pinned\n');
    const client = await pool.connect();
    try {
      for (const bytes of [orphan, pinned]) {
        await storeBlob(client, {
          tenantId: t.tenantId,
          clientId: t.clientId,
          gitBlobHash: gitBlobHash(bytes),
          path: 'z.txt',
          bytes,
        });
      }
    } finally {
      client.release();
    }
    await staleStaged({ 'pinned.txt': 'pinned\n' }, 1_000);

    expect(await runMaintenanceTick(tickDeps(), target())).toEqual(['release']);
    const c = await claim();
    const ran = await runJob(deps(), c);
    expect(ran).toMatchObject({
      outcome: 'maintained',
      answer: {
        kind: 'release',
        result: { layerIds: retired, blobHashes: [gitBlobHash(orphan)] },
      },
    });
    const blobs = await queryRows<{ git_blob_hash: string }>(
      owner,
      'SELECT git_blob_hash FROM codegraph.blob WHERE tenant_id = $1',
      [t.tenantId],
    );
    const held = new Set(blobs.map((b) => b.git_blob_hash));
    expect(held.has(gitBlobHash(orphan))).toBe(false);
    expect(held.has(gitBlobHash(pinned))).toBe(true);

    // Again: nothing left to release.
    const [job] = await jobsOf('release');
    const row = await inClaimTransaction(pool, t, (cl) => readJob(cl, scope(), job?.id as string));
    expect(await runMaintenanceJob(deps(), c, row as JobRow)).toMatchObject({
      answer: { kind: 'release', result: { layerIds: [], blobHashes: [] } },
    });
  });

  it('refuses a revoked client’s discard and release with binding_refused, removing nothing', async () => {
    const stale = await staleStaged({ 'x.txt': 'x\n' }, LAYERS.stagedLayerStaleness + HOUR);
    await runMaintenanceTick(tickDeps(), target());
    const discardClaim = await claim();
    const [discard] = await jobsOf('discard_stale');
    const row = await inClaimTransaction(pool, t, (cl) =>
      readJob(cl, scope(), discard?.id as string),
    );
    await revokeGrant(owner, t);
    await expect(runMaintenanceJob(deps(), discardClaim, row as JobRow)).rejects.toMatchObject({
      name: 'JobFailure',
      reasonCode: 'binding_refused',
    });
    await expect(
      runMaintenanceJob(deps(), discardClaim, { ...(row as JobRow), kind: 'release' }),
    ).rejects.toMatchObject({ name: 'JobFailure', reasonCode: 'binding_refused' });
    expect((await layerRows()).map((l) => l.id)).toContain(stale);

    // Through the worker: the run can write nothing, and the claim's sweep ends
    // the job binding_refused once its lease lapses.
    expect(await runJob(deps(), discardClaim)).toEqual({ outcome: 'grant_lost' });
    await owner.query(
      "UPDATE codegraph.index_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [discardClaim.jobId],
    );
    expect(await claimNext(pool, settings())).toBeNull();
    expect((await jobsOf('discard_stale'))[0]).toMatchObject({
      state: 'failed',
      failure_reason_code: 'binding_refused',
    });
  });

  it('raises any other library error past the binding mapping', async () => {
    await inClaimTransaction(pool, t, (c) =>
      enqueueMaintenanceJob(c, { ...target(), kind: 'discard_stale' }),
    );
    const c = await claim();
    const row = await inClaimTransaction(pool, t, (cl) => readJob(cl, scope(), c.jobId));
    await expect(
      runMaintenanceJob(
        deps({}, { layerSettings: { ...LAYERS, stagedLayerStaleness: Number.NaN } }),
        c,
        row as JobRow,
      ),
    ).rejects.not.toMatchObject({ name: 'JobFailure' });
  });

  it('answers lease_lost when the lease moves on while the library runs', async () => {
    await inClaimTransaction(pool, t, (c) =>
      enqueueMaintenanceJob(c, { ...target(), kind: 'release' }),
    );
    const c = await claim();
    const hooked = createAppPool(db.appUrl);
    const connect = hooked.connect.bind(hooked) as () => Promise<pg.PoolClient>;
    (hooked as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
        ...args: unknown[]
      ) => {
        if (typeof args[0] === 'string' && args[0].includes('ORDER BY l.depth DESC')) {
          await owner.query("UPDATE codegraph.index_jobs SET claimed_by = 'thief' WHERE id = $1", [
            c.jobId,
          ]);
        }
        return await query(...args);
      };
      return client;
    };
    try {
      expect(await runJob({ ...deps(), pool: hooked }, c)).toEqual({ outcome: 'lease_lost' });
    } finally {
      await hooked.end();
    }
    expect((await jobsOf('release'))[0]?.state).toBe('running');
  });

  it('answers NOT_HANDLED for a request kind, running and ending nothing', async () => {
    const { jobId } = await enqueueRequest(pool, t);
    const c = await claim();
    const row = await inClaimTransaction(pool, t, (cl) => readJob(cl, scope(), jobId));
    expect(await runMaintenanceJob(deps(), c, row as JobRow)).toBe(NOT_HANDLED);
  });

  it('renews the job’s lease while a library call runs', async () => {
    await chainOfThree();
    const c = await claim();
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    try {
      const ran = await runJob(
        { ...deps(), pool: recordingPool, settings: settings({ jobLeaseMs: 3 }) },
        c,
      );
      expect(ran.outcome).toBe('maintained');
    } finally {
      await recordingPool.end();
    }
    expect(
      recorded
        .texts()
        .some(
          (text) => text.includes('UPDATE codegraph.index_jobs') && text.includes('make_interval'),
        ),
    ).toBe(true);
  });
});

describe('the loop’s tick', () => {
  it('cleans up after a job that left a staged layer: the next job’s tick enqueues the discard, which runs', async () => {
    const stale = await staleStaged(
      { 'left.txt': 'left behind\n' },
      LAYERS.stagedLayerStaleness + HOUR,
    );
    await owner.query(
      `INSERT INTO codegraph.index_jobs
         (tenant_id, repository_id, client_id, kind, commit_sha, ref_name, state, attempts,
          started_at, ended_at, failure_reason_code)
       VALUES ($1, $2, $3, 'first_index', $4, 'refs/heads/main', 'failed', 3, now(), now(),
               'attempts_exhausted')`,
      [t.tenantId, t.repositoryId, t.clientId, sha()],
    );
    const { jobId } = await enqueueRequest(pool, t);
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    const loop = runWorkerLoop({
      ...deps({ 'a.txt': 'a\n' }),
      pool: recordingPool,
      maintenance: readMaintenanceSettings({}),
    });
    try {
      const deadline = Date.now() + 20_000;
      while ((await jobsOf('discard_stale'))[0]?.state !== 'succeeded') {
        if (Date.now() > deadline) throw new Error('the discard never ran');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await loop.stop();
      await recordingPool.end();
    }
    expect((await jobsOf('first_index')).find((j) => j.id === jobId)?.state).toBe('succeeded');
    expect((await layerRows()).map((l) => l.id)).not.toContain(stale);
    const paths = await queryRows(
      owner,
      'SELECT 1 FROM codegraph.layer_paths WHERE layer_id = $1',
      [stale],
    );
    expect(paths).toEqual([]);
    // Two runs of one repository inside the interval: one tick.
    const ticks = recorded.texts().filter((text) => text.includes(') AS due'));
    expect(ticks).toHaveLength(1);
  });

  it('ticks a repository again once the interval has passed, and never after a lost grant', async () => {
    await enqueueRequest(pool, t);
    await enqueueRequest(pool, t);
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    const loop = runWorkerLoop({
      ...deps({ 'a.txt': 'a\n' }),
      pool: recordingPool,
      maintenance: { intervalMs: 1, jobsPerTick: 3 },
    });
    try {
      const deadline = Date.now() + 20_000;
      while ((await jobsOf('first_index')).some((j) => j.state !== 'succeeded')) {
        if (Date.now() > deadline) throw new Error('the jobs never ran');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await loop.stop();
    }
    expect(
      recorded.texts().filter((text) => text.includes(') AS due')).length,
    ).toBeGreaterThanOrEqual(2);

    // A run that lost its grant gives no tick.
    recorded.clear();
    await enqueueRequest(pool, t, { repositoryId: t.repositoryIds[1] as string });
    const revoking = runWorkerLoop({
      ...deps(),
      fetch: async (target) => {
        await revokeGrant(owner, t);
        return await serveTree({ 'a.txt': 'a\n' })(target);
      },
      pool: recordingPool,
      maintenance: { intervalMs: 1, jobsPerTick: 3 },
    });
    try {
      const deadline = Date.now() + 20_000;
      while (!lines.some((l) => l.message.includes('no live grant'))) {
        if (Date.now() > deadline) throw new Error('the grant was never lost');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await revoking.stop();
      await recordingPool.end();
    }
    expect(recorded.texts().some((text) => text.includes(') AS due'))).toBe(false);
  });

  it('ticks nothing before a first claim', async () => {
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    const loop = runWorkerLoop({
      ...deps(),
      pool: recordingPool,
      maintenance: readMaintenanceSettings({}),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await loop.stop();
    await recordingPool.end();
    expect(recorded.texts().some((text) => text.includes(') AS due'))).toBe(false);
  });

  it('logs a tick that fails and carries on', async () => {
    await enqueueRequest(pool, t);
    const loop = runWorkerLoop({
      ...deps({ 'a.txt': 'a\n' }),
      layerSettings: { ...LAYERS, stagedLayerStaleness: Number.NaN },
      maintenance: readMaintenanceSettings({}),
    });
    const deadline = Date.now() + 20_000;
    while (!lines.some((l) => l.message === 'maintenance tick failed')) {
      if (Date.now() > deadline) throw new Error('no tick failure logged');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await loop.stop();
  });
});
