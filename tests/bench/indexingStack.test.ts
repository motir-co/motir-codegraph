import { access, readdir } from 'node:fs/promises';
import { get } from 'node:https';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKER_CONFIG,
  readBenchUrls,
  scriptArgs,
  SOURCE_CERT_FILE,
  startStack,
  workerEnv,
  type BenchUrls,
} from '../../src/bench/indexing/stack.js';
import { materialise, pushBase } from '../../src/bench/indexing/tree.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';

// The benchmark's world (src/bench/indexing/stack.ts) brought up for real on a
// fresh database with one worker: it seeds a tenant through the operator calls,
// serves a tree, indexes it through the API and the worker, resolves it bound
// to the tenant, and tears every part of itself down. `pnpm bench:indexing`
// times the same doors; this file only shows they open.

const SETTLE_MS = 30_000;

function* first<T>(items: Iterable<T>, n: number): Generator<T> {
  let i = 0;
  for (const item of items) {
    if (i >= n) return;
    yield item;
    i += 1;
  }
}

/** A GET against the stack's source, trusting its certificate: the status code. */
const statusOf = (url: string) =>
  new Promise<number>((resolve, reject) => {
    get(url, { ca: readFileSync(SOURCE_CERT_FILE, 'utf8') }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });

const benchScratch = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('indexing-bench-')).sort();

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('the stack’s settings', () => {
  it('reads the three database URLs and the database they name, refusing a missing one by name', () => {
    const urls = readBenchUrls({
      DATABASE_URL: 'postgres://o:p@localhost:5432/bench_db',
      DATABASE_APP_URL: 'postgres://a:p@localhost:5432/bench_db',
      DATABASE_ADMIN_URL: 'postgres://s:p@localhost:5432/postgres',
    });
    expect(urls.database).toBe('bench_db');
    expect(urls.adminUrl).toContain('/postgres');
    expect(() =>
      readBenchUrls({ DATABASE_URL: 'postgres://o:p@h/d', DATABASE_APP_URL: ' ' }),
    ).toThrow(/DATABASE_APP_URL is not set/);
  });

  it('starts a worker as `pnpm worker` does, and refuses a script that does not run node', () => {
    expect(scriptArgs('worker')).toContain('src/worker/main.ts');
    expect(() => scriptArgs('no-such-script')).toThrow(/does not run node/);
  });

  it('gives each worker the run’s settings and the source’s certificate, over the base environment', () => {
    const urls: BenchUrls = {
      ownerUrl: 'o',
      appUrl: 'postgres://a@h/d',
      adminUrl: 's',
      database: 'd',
    };
    const env = workerEnv(urls, { ...DEFAULT_WORKER_CONFIG, workers: 2 }, '/scratch', {
      KEEP: 'yes',
      DATABASE_APP_URL: 'overridden',
    });
    expect(env).toMatchObject({
      KEEP: 'yes',
      DATABASE_APP_URL: 'postgres://a@h/d',
      SCRATCH_DIR: '/scratch',
      WORKER_POLL_MS: '100',
      JOB_LEASE_MS: '60000',
      MAX_ATTEMPTS: '3',
      BLOB_STORE_BATCH_SIZE: '500',
      FETCH_ALLOWED_HOSTS: '127.0.0.1',
      NODE_EXTRA_CA_CERTS: SOURCE_CERT_FILE,
    });
  });
});

describe('startStack', () => {
  let db: FreshDatabase;
  let urls: BenchUrls;

  beforeAll(async () => {
    db = await freshDatabase();
    urls = {
      ownerUrl: db.ownerUrl,
      appUrl: db.appUrl,
      adminUrl: db.adminUrl,
      database: db.name,
    };
  });

  afterAll(async () => {
    await db.drop();
  });

  it('refuses a malformed layer setting before it starts anything', async () => {
    await expect(
      startStack({
        urls,
        config: { ...DEFAULT_WORKER_CONFIG, workers: 1 },
        run: 'bad-env',
        env: { ...process.env, COMPACTION_THRESHOLD: 'often' },
      }),
    ).rejects.toThrow(/COMPACTION_THRESHOLD/);
  });

  it('cleans up after a database it cannot migrate, having started nothing else', async () => {
    const before = await benchScratch();
    await expect(
      startStack({
        urls: { ...urls, ownerUrl: urls.ownerUrl.replace(db.name, `${db.name}_absent`) },
        config: { ...DEFAULT_WORKER_CONFIG, workers: 1 },
        run: 'no-database',
      }),
    ).rejects.toThrow();
    expect(await benchScratch()).toEqual(before);
  });

  it(
    'tears down what it started when a worker does not start, and leaves no scratch directory',
    async () => {
      const before = await benchScratch();
      await expect(
        startStack({
          urls,
          config: { ...DEFAULT_WORKER_CONFIG, workers: 1 },
          run: 'bad-worker',
          env: { ...process.env, FETCH_BYTE_CAP_BYTES: 'lots' },
        }),
      ).rejects.toThrow(/a worker did not start[\s\S]*FETCH_BYTE_CAP_BYTES/);
      expect(await benchScratch()).toEqual(before);
    },
    SETTLE_MS,
  );

  it(
    'seeds, indexes a served tree through the API and a worker, resolves it, and tears down whole',
    async () => {
      const stack = await startStack({
        urls,
        config: { ...DEFAULT_WORKER_CONFIG, workers: 1 },
        run: 'stack-test',
      });
      try {
        const { tenantId, repositoryIds } = await stack.seedTenant('stack test', 1);
        const repositoryId = repositoryIds[0] as string;
        const commit = 'a'.repeat(40);
        const tree = await materialise([...first(pushBase('stack'), 25)], {
          dir: join(stack.scratchRoot, 'tree'),
          tarball: join(stack.scratchRoot, 'tree.tar.gz'),
          prefix: 'stack-tree',
        });

        const refused = await stack.call(
          `/v1/tenants/${tenantId}/repositories/${repositoryId}/first-index`,
          { commit },
        );
        expect(refused.status).toBe(400);

        const answer = await stack.call(
          `/v1/tenants/${tenantId}/repositories/${repositoryId}/first-index`,
          {
            commit,
            ref: 'refs/heads/main',
            isDefaultBranch: true,
            fetchUrl: stack.serve('tree.tar.gz', join(stack.scratchRoot, 'tree.tar.gz')),
          },
        );
        expect(answer.status, JSON.stringify(answer.body)).toBe(202);
        const { jobId } = answer.body as { jobId: string };

        const deadline = Date.now() + SETTLE_MS;
        let job = await stack.job(jobId);
        while (job.state !== 'succeeded' && Date.now() < deadline) {
          expect(job.state, `${job.reason ?? ''} ${stack.workerTail()}`).not.toBe('failed');
          await new Promise((resolve) => setTimeout(resolve, 100));
          job = await stack.job(jobId);
        }
        expect(job).toEqual({ state: 'succeeded', reason: null, message: null });

        const resolution = await stack.resolve({ tenantId, repositoryId }, commit);
        expect(resolution.state).toBe('indexed');
        if (resolution.state === 'indexed') {
          expect(new Map(resolution.paths)).toEqual(tree.map);
        }
        await expect(stack.job('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
          /no job row/,
        );
        expect(stack.workerTail()).toContain('worker 0:');

        // The source answers only what it was given, and a given file that is gone is not found.
        expect(await statusOf(stack.serve('gone.tar.gz', join(stack.scratchRoot, 'gone')))).toBe(
          404,
        );
        expect(await statusOf(stack.serve('x', 'y').replace(/x$/, 'unknown'))).toBe(404);

        await expect(stack.seedTenant(' ', 1)).rejects.toThrow(/creating a tenant answered 400/);
        await stack.deleteTenant(tenantId);
        // A tenant still held at teardown is deleted by it.
        await stack.seedTenant('left for teardown', 1);
      } finally {
        await stack.teardown();
        // Idempotent: a second teardown is the first one's answer.
        await stack.teardown();
      }
      expect(await exists(stack.scratchRoot)).toBe(false);
    },
    SETTLE_MS * 2,
  );
});
