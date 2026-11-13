import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  readLayerSettings,
  readMaintenanceSettings,
  type WorkerSettings,
} from '../../src/config.js';
import {
  ClaimLostError,
  finishBatch,
  JobNotWritableError,
  markBatchStoredAndLockJob,
  readBatch,
} from '../../src/db/indexJobs.js';
import { claimNext, type Claim } from '../../src/db/workerJobs.js';
import { resolveCommit } from '../../src/layers/resolution.js';
import { createAppPool } from '../../src/server/pool.js';
import { runWorkerLoop, type TickContext, type WorkerLoop } from '../../src/worker/loop.js';
import { runJob, type FetchStep, type RunResult } from '../../src/worker/runJob.js';
import { freshDatabase, queryRows, type FreshDatabase } from '../helpers/db.js';
import { bindTo, queueTenant, type QueueTenant } from '../helpers/queue.js';
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

// A first index too large for one batch, run by two real worker loops against
// the real Postgres: the batches run at once, one claimant finalises, the
// commit publishes once, and the fetch URL is gone from every row and line.

const WAIT_MS = 20_000;

let db: FreshDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let scratch: string;
let t: QueueTenant;
let lines: LogLine[];

function settings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  return {
    pollMs: 20,
    jobLeaseMs: 60_000,
    maxAttempts: 3,
    scratchDir: scratch,
    blobStoreBatchSize: 3,
    ...overrides,
  };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function startLoops(fetch: FetchStep, count: number, ran: RunResult[]): WorkerLoop[] {
  return Array.from({ length: count }, () =>
    runWorkerLoop({
      pool,
      settings: settings(),
      layerSettings: readLayerSettings({}),
      maintenance: readMaintenanceSettings({}),
      fetch,
      log: capturingLogger(lines),
      onTick: (tick: TickContext) => {
        if (tick.ran !== null) ran.push(tick.ran);
      },
    }),
  );
}

async function jobRow(id: string) {
  const [row] = await queryRows<{ state: string; fetch_url: string | null }>(
    owner,
    'SELECT state, fetch_url FROM codegraph.index_jobs WHERE id = $1',
    [id],
  );
  return row;
}

/** Every queue row of the tenant, as text, to search for the fetch URL. */
async function queueText(): Promise<string> {
  const rows = await queryRows(
    owner,
    `SELECT to_jsonb(j) AS row FROM codegraph.index_jobs j WHERE tenant_id = $1
     UNION ALL
     SELECT to_jsonb(b) FROM codegraph.index_job_batches b WHERE tenant_id = $1`,
    [t.tenantId],
  );
  return JSON.stringify(rows);
}

async function currentLayers(commit: string) {
  return await queryRows<{ id: string }>(
    owner,
    `SELECT id FROM codegraph.commit_layers
      WHERE commit_sha = $1 AND state = 'published' AND superseded_at IS NULL`,
    [commit],
  );
}

async function resolved(commit: string): Promise<Map<string, string> | null> {
  const resolution = await resolveCommit(owner, t.tenantId, t.repositoryId, commit);
  return resolution.state === 'indexed' ? resolution.paths : null;
}

const sorted = (map: Map<string, string>) => new Map([...map].sort(([a], [b]) => (a < b ? -1 : 1)));

beforeAll(async () => {
  db = await freshDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  pool = createAppPool(db.appUrl);
  scratch = await mkdtemp(join(tmpdir(), 'fanout-int-'));
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
  t = await queueTenant(owner);
});

describe('a first index fanned out across two workers', () => {
  it('runs two batches at once, finalises once, and publishes one current layer', async () => {
    const tree = bigTree(6);
    const { jobId, commit } = await enqueueRequest(pool, t);

    // The run's own fetch passes; the two claimants' fetches wait for each
    // other, so both batches are leased and running at the same moment.
    let fetches = 0;
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let during: { states: string[]; claimants: number; stored: number } | null = null;
    const fetch: FetchStep = async (target) => {
      fetches += 1;
      if (fetches > 1) {
        arrived += 1;
        if (arrived === 2) {
          const batches = await queryRows<{ state: string; claimed_by: string | null }>(
            owner,
            'SELECT state, claimed_by FROM codegraph.index_job_batches WHERE job_id = $1',
            [jobId],
          );
          const [{ n }] = (await queryRows<{ n: number }>(
            owner,
            'SELECT count(*)::integer AS n FROM codegraph.blob WHERE tenant_id = $1',
            [t.tenantId],
          )) as [{ n: number }];
          during = {
            states: batches.map((b) => b.state),
            claimants: new Set(batches.map((b) => b.claimed_by)).size,
            stored: n,
          };
          release();
        }
        await barrier;
      }
      return await serveTree(tree)(target);
    };

    const ran: RunResult[] = [];
    const loops = startLoops(fetch, 2, ran);
    try {
      await until(async () => (await jobRow(jobId))?.state === 'succeeded');
    } finally {
      await Promise.all(loops.map((loop) => loop.stop()));
    }

    // Both batches were running, under two claims, before either stored a blob.
    expect(during).toEqual({ states: ['running', 'running'], claimants: 2, stored: 0 });
    expect(ran.filter((r) => r.outcome === 'fanned_out')).toEqual([
      { outcome: 'fanned_out', batches: 2 },
    ]);
    const stored = ran.filter((r) => r.outcome === 'batch_stored');
    expect(stored).toHaveLength(2);
    // Exactly one claimant finalised, and each stored only its own slice.
    expect(stored.filter((r) => r.finalised !== null)).toHaveLength(1);
    expect(stored.map((r) => r.storedBlobs)).toEqual([3, 3]);

    expect(await currentLayers(commit)).toHaveLength(1);
    const heads = await queryRows<{ commit_sha: string; layer_id: string }>(
      owner,
      'SELECT commit_sha, layer_id FROM codegraph.ref_heads WHERE repository_id = $1',
      [t.repositoryId],
    );
    expect(heads).toEqual([{ commit_sha: commit, layer_id: (await currentLayers(commit))[0]?.id }]);
    expect(await resolved(commit)).toEqual(sorted(hashesOf(tree)));

    expect(await jobRow(jobId)).toEqual({ state: 'succeeded', fetch_url: null });
    const text = await queueText();
    expect(text).not.toContain(FETCH_SECRET);
    expect(text).not.toContain('git.example');
    expect(JSON.stringify(lines)).not.toContain(FETCH_SECRET);
  });
});

describe('a failed batch', () => {
  it('fails the job and leaves the repository on its previous commit', async () => {
    const before: Tree = { 'a.txt': 'previous\n' };
    const prior = await enqueueRequest(pool, t);
    const firstRun: RunResult[] = [];
    const [one] = startLoops(serveTree(before), 1, firstRun);
    try {
      await until(async () => (await jobRow(prior.jobId))?.state === 'succeeded');
    } finally {
      await one?.stop();
    }

    const { jobId, commit } = await enqueueRequest(pool, t);
    let fetches = 0;
    const fetch: FetchStep = async (target) => {
      fetches += 1;
      if (fetches === 1) return await serveTree(bigTree(6))(target);
      return {
        ok: false,
        reasonCode: 'fetch_timeout',
        message: `fetching ${target.url} timed out`,
      };
    };
    const ran: RunResult[] = [];
    const loops = startLoops(fetch, 2, ran);
    try {
      await until(async () => (await jobRow(jobId))?.state === 'failed');
      await until(() => ran.some((r) => r.outcome === 'failed'));
    } finally {
      await Promise.all(loops.map((loop) => loop.stop()));
    }

    const batches = await queryRows<{ state: string; failure_reason_code: string }>(
      owner,
      'SELECT state, failure_reason_code FROM codegraph.index_job_batches WHERE job_id = $1',
      [jobId],
    );
    expect(batches.every((b) => b.state === 'failed')).toBe(true);
    expect(batches.map((b) => b.failure_reason_code)).toContain('fetch_timeout');
    expect(await currentLayers(commit)).toEqual([]);
    expect(await resolved(commit)).toBeNull();
    expect(await resolved(prior.commit)).toEqual(sorted(hashesOf(before)));
    const heads = await queryRows<{ commit_sha: string }>(
      owner,
      'SELECT commit_sha FROM codegraph.ref_heads WHERE repository_id = $1',
      [t.repositoryId],
    );
    expect(heads).toEqual([{ commit_sha: prior.commit }]);
    expect(await queueText()).not.toContain(FETCH_SECRET);
    expect(JSON.stringify(lines)).not.toContain(FETCH_SECRET);
  });
});

describe('a batch write bound to the wrong tenant', () => {
  it('is refused, and reads and writes nothing of the job’s tenant', async () => {
    const { jobId } = await enqueueRequest(pool, t);
    const job = (await claimNext(pool, settings())) as Claim;
    const ran = await runJob(
      {
        pool,
        settings: settings(),
        layerSettings: readLayerSettings({}),
        fetch: serveTree(bigTree(6)),
        log: capturingLogger(lines),
      },
      job,
    );
    expect(ran.outcome).toBe('fanned_out');
    const batch = (await claimNext(pool, settings())) as Claim;
    const other = await queueTenant(owner);
    const scope = { tenantId: t.tenantId, repositoryId: t.repositoryId };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bindTo(client, other);
      await expect(
        markBatchStoredAndLockJob(client, scope, batch.batchId as string, batch.claimedBy, 3, 1000),
      ).rejects.toBeInstanceOf(JobNotWritableError);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await bindTo(client, other);
      expect(await readBatch(client, scope, batch.batchId as string)).toBeNull();
      await expect(
        finishBatch(client, scope, batch.batchId as string, batch.claimedBy, {
          state: 'stored',
          storedCount: 3,
        }),
      ).rejects.toBeInstanceOf(ClaimLostError);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const states = await queryRows<{ state: string }>(
      owner,
      'SELECT state FROM codegraph.index_job_batches WHERE job_id = $1 ORDER BY ordinal',
      [jobId],
    );
    expect(states.map((s) => s.state)).toEqual(['running', 'queued']);
  });
});
