import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  readLayerSettings,
  readMaintenanceSettings,
  type WorkerSettings,
} from '../../src/config.js';
import { listMissingBlobHashes } from '../../src/db/blobs.js';
import { enqueueJob, insertJobBatches } from '../../src/db/indexJobs.js';
import { CLAIM_SQL, claimNext, inClaimTransaction, type Claim } from '../../src/db/workerJobs.js';
import { gitBlobHash } from '../../src/fetch/gitBlob.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { createAppPool } from '../../src/server/pool.js';
import { runWorkerLoop, type TickContext, type WorkerLoopDeps } from '../../src/worker/loop.js';
import type { FetchStep, WorkerLogger } from '../../src/worker/runJob.js';
import { freshDatabase, queryRows, type FreshDatabase } from '../helpers/db.js';
import { scriptNodeArgs, runScript } from '../helpers/processes.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { bindTo, queueTenant, sha, type QueueTenant } from '../helpers/queue.js';
import { treeTarball } from '../helpers/tarball.js';
import { startTarballServer, type TarballServer } from '../helpers/tarballServer.js';

// The poll, in-process against a real database with its fetch step injected,
// and `pnpm worker` as a process with the real fetcher against the test's
// https tarball server.

const ROOT = new URL('../../', import.meta.url).pathname;
const PROCESS_TIMEOUT_MS = 60_000;

let db: FreshDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let log: QueryLog;
let scratch: string;
let t: QueueTenant;
let messages: string[];

const logger: WorkerLogger = {
  info: (_fields, message) => messages.push(message),
  warn: (_fields, message) => messages.push(message),
  error: (fields, message) => messages.push(`${message} ${JSON.stringify(fields)}`),
};

function settings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  return {
    pollMs: 20,
    jobLeaseMs: 60_000,
    maxAttempts: 3,
    scratchDir: scratch,
    blobStoreBatchSize: 500,
    ...overrides,
  };
}

const FILE = 'export const x = 1;\n';
const serveOne: FetchStep = async ({ dir }) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const root = join(dir, 'tree');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'x.ts'), FILE);
  return {
    ok: true,
    tree: {
      paths: new Map([['x.ts', gitBlobHash(Buffer.from(FILE))]]),
      sizes: new Map([['x.ts', FILE.length]]),
      fileCount: 1,
      totalBytes: FILE.length,
      root,
    },
  };
};

function loopDeps(overrides: Partial<WorkerLoopDeps> = {}): WorkerLoopDeps {
  return {
    pool,
    settings: settings(),
    layerSettings: readLayerSettings({}),
    maintenance: readMaintenanceSettings({}),
    fetch: serveOne,
    log: logger,
    ...overrides,
  };
}

async function enqueue(
  options: { repositoryId?: string; fetchUrl?: string; ref?: string } = {},
): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await bindTo(c, t);
    const row = await enqueueJob(c, {
      tenantId: t.tenantId,
      repositoryId: options.repositoryId ?? t.repositoryId,
      clientId: t.clientId,
      kind: 'first_index',
      commitSha: sha(),
      refName: options.ref ?? 'refs/heads/main',
      isDefaultBranch: (options.ref ?? 'refs/heads/main') === 'refs/heads/main',
      fetchUrl: options.fetchUrl ?? 'https://git.example/a.tar.gz',
    });
    await c.query('COMMIT');
    return row.id;
  } finally {
    c.release();
  }
}

async function states(): Promise<Record<string, string>> {
  const rows = await queryRows<{ id: string; state: string }>(
    owner,
    'SELECT id, state FROM codegraph.index_jobs',
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.state]));
}

/** Resolves once `predicate` holds, polling every 10 ms, or fails after `ms`. */
async function until(predicate: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  db = await freshDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  pool = createAppPool(db.appUrl);
  log = recordQueries(pool);
  scratch = await mkdtemp(join(tmpdir(), 'worker-loop-'));
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await rm(scratch, { recursive: true, force: true });
  await db.drop();
});

beforeEach(async () => {
  messages = [];
  await owner.query('DELETE FROM codegraph.index_jobs');
  t = await queueTenant(owner, 2);
  log.clear();
});

/**
 * Every statement that is not the claim sits inside a transaction whose first
 * statement after BEGIN is the tenant binding. Answers the offenders.
 */
function unboundStatements(texts: readonly string[]): string[] {
  const offenders: string[] = [];
  let inTransaction = false;
  let bound = false;
  let expectBind = false;
  for (const text of texts) {
    if (text === CLAIM_SQL && !inTransaction) continue;
    if (text === 'BEGIN') {
      inTransaction = true;
      bound = false;
      expectBind = true;
      continue;
    }
    if (expectBind) {
      expectBind = false;
      bound = text === BIND_TENANT_SQL;
      if (!bound) offenders.push(text);
      continue;
    }
    if (text === 'COMMIT' || text === 'ROLLBACK') {
      inTransaction = false;
      continue;
    }
    if (!inTransaction || !bound) offenders.push(text);
  }
  return offenders;
}

describe('the loop', () => {
  it('issues only the claim while idle, waiting the poll interval between claims', async () => {
    const ticks: TickContext[] = [];
    const loop = runWorkerLoop(
      loopDeps({ settings: settings({ pollMs: 50 }), onTick: (c) => void ticks.push(c) }),
    );
    await until(() => ticks.length >= 3);
    const started = Date.now();
    await until(() => ticks.length >= 5);
    await loop.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(new Set(log.texts())).toEqual(new Set([CLAIM_SQL]));
    expect(ticks.every((tick) => tick.ran === null && tick.pool === pool)).toBe(true);
  });

  it('runs a claimed job with every other statement in a tenant-bound transaction', async () => {
    const jobId = await enqueue();
    const ticks: TickContext[] = [];
    const loop = runWorkerLoop(loopDeps({ onTick: (c) => void ticks.push(c) }));
    await until(() => ticks.some((tick) => tick.ran !== null));
    await loop.stop();
    expect((await states())[jobId]).toBe('succeeded');
    expect(ticks.find((tick) => tick.ran !== null)?.ran).toEqual({
      outcome: 'succeeded',
      storedBlobs: 1,
    });
    const texts = log.texts();
    expect(texts.filter((text) => text === CLAIM_SQL).length).toBeGreaterThanOrEqual(1);
    expect(unboundStatements(texts)).toEqual([]);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('can fail: the binding check reports a statement outside a bound transaction', () => {
    expect(unboundStatements(['BEGIN', 'SELECT 1', 'COMMIT', 'SELECT 2', CLAIM_SQL])).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('hands a claimed batch to the batch runner, and by default to runBatch', async () => {
    const jobId = await enqueue();
    const claim = (await claimNext(pool, settings())) as Claim;
    const hash = gitBlobHash(Buffer.from(FILE));
    await inClaimTransaction(pool, claim, (c) =>
      insertJobBatches(c, t, jobId, [{ ordinal: 1, paths: ['x.ts'], gitBlobHashes: [hash] }]),
    );

    // An injected runner is handed the batch claim.
    const batches: Claim[] = [];
    const injected = runWorkerLoop(
      loopDeps({
        runBatch: (_deps, batch) => {
          batches.push(batch);
          return Promise.resolve({ outcome: 'lease_lost' });
        },
      }),
    );
    await until(() => batches.length >= 1);
    await injected.stop();
    expect(batches[0]).toMatchObject({ kind: 'batch', jobId });

    // Without one, runBatch stores the slice. The job still holds its own
    // lease here, so the last batch finalises nothing.
    await owner.query(
      "UPDATE codegraph.index_job_batches SET state = 'queued', lease_expires_at = NULL, claimed_by = NULL",
    );
    const ticks: TickContext[] = [];
    const loop = runWorkerLoop(loopDeps({ onTick: (c) => void ticks.push(c) }));
    await until(() => ticks.some((tick) => tick.ran !== null));
    await loop.stop();
    expect(ticks.find((tick) => tick.ran !== null)?.ran).toEqual({
      outcome: 'batch_stored',
      storedBlobs: 1,
      finalised: null,
    });
    const [batch] = await queryRows<{ state: string; stored_count: number }>(
      owner,
      'SELECT state, stored_count FROM codegraph.index_job_batches WHERE job_id = $1',
      [jobId],
    );
    expect(batch).toEqual({ state: 'stored', stored_count: 1 });
  });

  it('runs one job of a repository at a time, across two loops', async () => {
    await enqueue();
    await enqueue({ ref: 'refs/heads/b' });
    let inFlight = 0;
    let most = 0;
    const slow: FetchStep = async (target) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight -= 1;
      return await serveOne(target);
    };
    const loops = [
      runWorkerLoop(loopDeps({ fetch: slow })),
      runWorkerLoop(loopDeps({ fetch: slow })),
    ];
    await until(async () => Object.values(await states()).every((s) => s === 'succeeded'));
    await Promise.all(loops.map((loop) => loop.stop()));
    expect(most).toBe(1);
  });

  it('carries on past an iteration that throws and a tick that throws', async () => {
    let ticks = 0;
    const loop = runWorkerLoop(
      loopDeps({
        settings: settings({ maxAttempts: 0 }),
        onTick: () => {
          ticks += 1;
          if (ticks % 2 === 0) throw new Error('tick boom');
          // A hook may reject with anything; the loop still logs it and carries on.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('tick string');
        },
      }),
    );
    await until(() => ticks >= 3);
    await loop.stop();
    expect(
      messages.filter((m) => m.startsWith('worker iteration failed')).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      messages.filter((m) => m.startsWith('worker tick failed')).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('stops claiming on stop, letting the in-flight job reach its outcome', async () => {
    const jobId = await enqueue();
    await enqueue({ repositoryId: t.repositoryIds[1] as string });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetching = false;
    const gated: FetchStep = async (target) => {
      fetching = true;
      await gate;
      return await serveOne(target);
    };
    const loop = runWorkerLoop(loopDeps({ fetch: gated }));
    await until(() => fetching);
    const claimsBefore = log.texts().filter((text) => text === CLAIM_SQL).length;
    const stopped = loop.stop();
    release();
    await stopped;
    expect(log.texts().filter((text) => text === CLAIM_SQL).length).toBe(claimsBefore);
    const after = await states();
    expect(after[jobId]).toBe('succeeded');
    expect(Object.values(after).filter((s) => s === 'queued')).toHaveLength(1);
  });

  it('answers no missing hash for an empty list without a statement', async () => {
    log.clear();
    expect(await listMissingBlobHashes(owner, t.tenantId, [])).toEqual([]);
  });
});

describe('pnpm worker', () => {
  let server: TarballServer;

  beforeAll(async () => {
    server = await startTarballServer();
  });

  afterAll(async () => {
    await server.close();
  });

  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    DATABASE_APP_URL: db.appUrl,
    SCRATCH_DIR: scratch,
    WORKER_POLL_MS: '20',
    NODE_EXTRA_CA_CERTS: server.caFile,
    FETCH_ALLOWED_HOSTS: 'localhost',
    ...overrides,
  });

  it(
    'refuses to start without a usable SCRATCH_DIR or with a malformed setting, naming it',
    async () => {
      const missing = await runScript('worker', env({ SCRATCH_DIR: join(scratch, 'absent') }));
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('SCRATCH_DIR');
      const blank = await runScript('worker', env({ SCRATCH_DIR: ' ' }));
      expect(blank.code).toBe(1);
      expect(blank.stderr).toContain('SCRATCH_DIR');
      const malformed = await runScript('worker', env({ JOB_LEASE_MS: 'soon' }));
      expect(malformed.code).toBe(1);
      expect(malformed.stderr).toContain('JOB_LEASE_MS');
      const metrics = await runScript('worker', env({ METRICS_INTERVAL_MS: '0' }));
      expect(metrics.code).toBe(1);
      expect(metrics.stderr).toContain('METRICS_INTERVAL_MS');
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'indexes a job through the real fetcher, records a refusal, and exits 0 on SIGTERM',
    async () => {
      const url = server.commit(
        'acme',
        sha(),
        treeTarball({ 'a.ts': 'export const a = 1;\n' }, 'acme-x'),
      );
      const indexed = await enqueue({ fetchUrl: url });
      const refused = await enqueue({
        repositoryId: t.repositoryIds[1] as string,
        fetchUrl: url.replace('https://', 'http://'),
      });
      const child = spawn(process.execPath, scriptNodeArgs('worker'), {
        cwd: ROOT,
        env: { ...process.env, ...env() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      try {
        await until(async () => {
          const s = await states();
          return s[indexed] === 'succeeded' && s[refused] === 'failed';
        }, 30_000);
      } finally {
        child.kill('SIGTERM');
      }
      expect(await exited).toBe(0);
      const [failure] = await queryRows<{ code: string }>(
        owner,
        'SELECT failure_reason_code AS code FROM codegraph.index_jobs WHERE id = $1',
        [refused],
      );
      expect(failure?.code).toBe('not_https');
      const lines = output.split('\n').filter((line) => line.startsWith('{'));
      expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(
        expect.arrayContaining(['worker started', 'job succeeded', 'job failed', 'worker stopped']),
      );
      // The queue's metrics, published beside the loop as embedded-metric-format lines.
      const documents = lines
        .map(
          (line) => JSON.parse(line) as { _aws?: { CloudWatchMetrics: { Namespace: string }[] } },
        )
        .filter((doc) => doc._aws !== undefined);
      expect(documents.length).toBeGreaterThanOrEqual(1);
      expect(documents[0]?._aws?.CloudWatchMetrics[0]?.Namespace).toBe('Codegraph/IndexQueue');
      expect(output).not.toContain(url);
      expect(output).not.toContain('/archive/');
      expect(await readdir(scratch)).toEqual([]);
    },
    PROCESS_TIMEOUT_MS,
  );
});
