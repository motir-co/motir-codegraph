import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFetchSettings } from '../../src/config.js';
import type { FetchRefusalCode } from '../../src/fetch/errors.js';
import { resolveCommit } from '../../src/layers/resolution.js';
import type { ErrorCode } from '../../src/server/errors.js';
import { TOKEN_PREFIX } from '../../src/server/tokens.js';
import { documentedErrorCodes } from '../helpers/apiContract.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import {
  runScript,
  scriptNodeArgs,
  startServerProcess,
  type ServerProcess,
} from '../helpers/processes.js';
import { call } from '../helpers/server.js';
import { treeTarball } from '../helpers/tarball.js';
import { startTarballServer, type TarballServer } from '../helpers/tarballServer.js';
import { inBoundTransaction } from '../helpers/tenancy.js';

// The indexing queue's verification recipe, walked end to end: Postgres, the
// API started as `pnpm serve` starts it, the worker started as `pnpm worker`
// starts it, and an https source server. Each case builds on the state the one
// before it left, so the cases run in order. Every job state is read off the
// row; worker output is read only to prove the fetch URLs never reach it.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CASE_MS = 60_000;
const WAIT_MS = 30_000;
const REF = 'refs/heads/main';

/** The worker's configuration, set explicitly on every spawn. */
const WORKER_SETTINGS = {
  JOB_LEASE_MS: '5000',
  MAX_ATTEMPTS: '5',
  WORKER_POLL_MS: '50',
  // Above every recipe tree's file count, so each commit is stored in one pass.
  BLOB_STORE_BATCH_SIZE: '1000',
  FETCH_BYTE_CAP_BYTES: String(64 * 1024),
} as const;
const BYTE_CAP = readFetchSettings(WORKER_SETTINGS).byteCapBytes;

/** The fetch module's refusal codes the two failing pushes end with. */
const ADDRESS_REFUSED: FetchRefusalCode = 'address_refused';
const SOURCE_TOO_LARGE: FetchRefusalCode = 'source_too_large';
/** The contract's refusal for a client calling a tenant it holds no grant on. */
const DENIED: ErrorCode = 'permission_denied';

/** The request kinds a call enqueues; maintenance kinds the worker enqueues are not counted. */
const REQUEST_KINDS = ['first_index', 'push', 'refresh'];

// ── Fixtures ────────────────────────────────────────────────────────────────

type Tree = Record<string, Buffer>;

/** A git blob id, computed here rather than by the code under test. */
function blobId(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

const commitId = (label: string) => createHash('sha1').update(`commit ${label}`).digest('hex');

/** Six text files under each of four directories. */
const C1: Tree = Object.fromEntries(
  ['src', 'lib', 'docs', 'test'].flatMap((dir) =>
    Array.from({ length: 6 }, (_, i) => [
      `${dir}/file${String(i)}.txt`,
      Buffer.from(`${dir} file ${String(i)}\nline two of ${dir}/${String(i)}\n`),
    ]),
  ),
);
const changed = (base: Tree, edits: Record<string, string>): Tree => ({
  ...base,
  ...Object.fromEntries(Object.entries(edits).map(([path, text]) => [path, Buffer.from(text)])),
});
/** C1 without its docs: a subset, so it shares no contents with C2's changes. */
const C0: Tree = Object.fromEntries(
  Object.entries(C1).filter(([path]) => !path.startsWith('docs/')),
);
const C2_CHANGED = ['src/file0.txt', 'lib/file1.txt', 'docs/file2.txt'];
const C2 = changed(C1, Object.fromEntries(C2_CHANGED.map((path) => [path, `${path} at C2\n`])));
const C3 = changed(C2, { 'test/file0.txt': 'test/file0 at C3\n' });
const C4 = changed(C2, { 'test/file1.txt': 'test/file1 at C4\n' });
const C7 = changed(C2, { 'src/file5.txt': 'src/file5 at C7\n' });
/** Random bytes do not compress, so the gzipped tarball stays past the cap. */
const OVERSIZED: Tree = { 'blob.bin': randomBytes(BYTE_CAP * 2) };

const commits = {
  C0: commitId('C0'),
  C1: commitId('C1'),
  C2: commitId('C2'),
  C3: commitId('C3'),
  C4: commitId('C4'),
  C5: commitId('C5'),
  C6: commitId('C6'),
  C7: commitId('C7'),
};

/** Each tree wrapped in one top-level directory, as a host's archive is. */
const tarballOf = (tree: Tree, commit: string) => treeTarball(tree, `acme-web-${commit}`);

/** The tree's path → git blob id map, sorted by path. */
function mapOf(tree: Tree): Map<string, string> {
  return new Map(
    Object.entries(tree)
      .map(([path, bytes]) => [path, blobId(bytes)] as [string, string])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

// ── The worker process ──────────────────────────────────────────────────────

interface WorkerProcess {
  child: ChildProcess;
  output(): string;
  /** SIGTERM, then SIGKILL after five seconds. */
  stop(): Promise<void>;
  /** SIGKILL, now. */
  kill(): Promise<void>;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, 5_000);
  try {
    await exit;
  } finally {
    clearTimeout(timer);
  }
}

let db: FreshDatabase;
let owner: pg.Client;
let server: TarballServer;
let api: ServerProcess | undefined;
let scratch: string;
const workers: WorkerProcess[] = [];
let worker: WorkerProcess | undefined;

function workerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_APP_URL: db.appUrl,
    SCRATCH_DIR: scratch,
    FETCH_ALLOWED_HOSTS: new URL(server.origin).hostname,
    NODE_EXTRA_CA_CERTS: server.caFile,
    ...WORKER_SETTINGS,
  };
}

/** Starts a worker as `pnpm worker` does, resolving once it says it started. */
async function startWorker(): Promise<WorkerProcess> {
  const child = spawn(process.execPath, scriptNodeArgs('worker'), {
    cwd: ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const started: WorkerProcess = {
    child,
    output: () => output,
    stop: () => stopChild(child),
    async kill() {
      if (exited(child)) return;
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    },
  };
  workers.push(started);
  await until(() => {
    if (exited(child)) throw new Error(`the worker exited:\n${output}`);
    return output.includes('"msg":"worker started"');
  }, `the worker to start:\n${output}`);
  return started;
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface JobRow {
  state: string;
  attempts: number;
  fetch_url: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  failure_reason_code: string | null;
  failure_message: string | null;
  lease_expires_at: Date | null;
}

async function jobRow(id: string): Promise<JobRow> {
  const [row] = await queryRows<JobRow>(
    owner,
    `SELECT state, attempts, fetch_url, started_at, ended_at, failure_reason_code,
            failure_message, lease_expires_at
       FROM codegraph.index_jobs WHERE id = $1`,
    [id],
  );
  if (row === undefined) throw new Error(`no job row ${id}`);
  return row;
}

const TERMINAL = ['succeeded', 'failed', 'superseded'];

/** Polls the row to a terminal state; answers it and every distinct state sampled. */
async function settled(id: string): Promise<{ row: JobRow; seen: string[] }> {
  const deadline = Date.now() + WAIT_MS;
  const seen: string[] = [];
  for (;;) {
    const row = await jobRow(id);
    if (seen.at(-1) !== row.state) seen.push(row.state);
    if (TERMINAL.includes(row.state)) return { row, seen };
    if (Date.now() > deadline) {
      throw new Error(`job ${id} did not end; states seen: ${seen.join(' → ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The sampled states lie in queued → running → succeeded and never step back. */
function expectForward(seen: string[]): void {
  const order = ['queued', 'running', 'succeeded'];
  const ranks = seen.map((state) => order.indexOf(state));
  expect(ranks, seen.join(' → ')).not.toContain(-1);
  expect(ranks, seen.join(' → ')).toEqual([...ranks].sort((a, b) => a - b));
}

async function blobCount(): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    owner,
    'SELECT count(*)::int AS n FROM codegraph.blob WHERE tenant_id = $1',
    [ids.tenant],
  );
  return row?.n ?? 0;
}

async function requestJobCount(): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    owner,
    `SELECT count(*)::int AS n FROM codegraph.index_jobs
      WHERE tenant_id = $1 AND repository_id = $2 AND kind = ANY($3::text[])`,
    [ids.tenant, ids.repository, REQUEST_KINDS],
  );
  return row?.n ?? 0;
}

/** `resolveCommit`, bound to the tenant as the client that enqueued. */
async function resolved(commit: string) {
  return await withClient(db.appUrl, (c) =>
    inBoundTransaction(c, { clientId: ids.client, tenantId: ids.tenant }, () =>
      resolveCommit(c, ids.tenant, ids.repository, commit),
    ),
  );
}

/** The commit resolves indexed to exactly `tree`'s map: size, then path by path. */
async function expectResolvesTo(commit: string, tree: Tree): Promise<Map<string, string>> {
  const resolution = await resolved(commit);
  if (resolution.state !== 'indexed') throw new Error(`${commit} resolved ${resolution.state}`);
  const expected = mapOf(tree);
  expect(resolution.paths.size).toBe(expected.size);
  for (const [path, hash] of expected) expect(resolution.paths.get(path), path).toBe(hash);
  return resolution.paths;
}

// ── Calls ───────────────────────────────────────────────────────────────────

const ids = { tenant: '', repository: '', client: '' };
let operatorToken = '';
let clientToken = '';

const baseUrl = () => (api as ServerProcess).baseUrl;
const repositoryPath = () => `/v1/tenants/${ids.tenant}/repositories/${ids.repository}`;

async function operator(path: string, body?: unknown) {
  return await call(baseUrl(), path, {
    method: 'POST',
    token: operatorToken,
    ...(body === undefined ? {} : { body }),
  });
}

async function enqueue(
  route: 'first-index' | 'push' | 'refresh',
  body: Record<string, unknown>,
  token = clientToken,
) {
  return await call(baseUrl(), `${repositoryPath()}/${route}`, {
    method: 'POST',
    token,
    body: { ref: REF, isDefaultBranch: true, ...body },
  });
}

/** A 202 answer's job id, which must name one row of the repository. */
async function acceptedJob(answer: Awaited<ReturnType<typeof call>>): Promise<string> {
  expect(answer.status).toBe(202);
  const { jobId } = answer.body as { jobId: string };
  const rows = await queryRows(
    owner,
    'SELECT id FROM codegraph.index_jobs WHERE id = $1 AND tenant_id = $2 AND repository_id = $3',
    [jobId, ids.tenant, ids.repository],
  );
  expect(rows).toHaveLength(1);
  return jobId;
}

/** Every fetch URL a call sent, to be found nowhere a worker wrote. */
const sentUrls: string[] = [];
const urlFor = (tree: Tree, commit: string) => {
  const url = server.commit('acme-web', commit, tarballOf(tree, commit));
  sentUrls.push(url);
  return url;
};

let metadataUrl = '';
let oversizedUrl = '';

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = await freshDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  server = await startTarballServer({ originHost: '127.0.0.1' });
  scratch = await mkdtemp(join(tmpdir(), 'queue-recipe-'));
  api = await startServerProcess(db.appUrl);
}, CASE_MS);

afterAll(async () => {
  try {
    await Promise.all([...workers.map((w) => w.stop()), api?.stop()]);
    for (const w of workers) expect(exited(w.child)).toBe(true);
  } finally {
    await server.close();
    await owner.end();
    await rm(scratch, { recursive: true, force: true });
    await db.drop();
  }
}, CASE_MS);

// ── The recipe ──────────────────────────────────────────────────────────────

describe('the indexing queue’s verification recipe, across four processes', () => {
  it('the fixtures sit on the right side of the configured compressed byte cap', () => {
    for (const [name, tree] of Object.entries({ C0, C1, C2, C3, C4, C7 })) {
      expect(tarballOf(tree, name).length, name).toBeLessThan(BYTE_CAP);
    }
    expect(tarballOf(OVERSIZED, 'C6').length).toBeGreaterThan(BYTE_CAP);
    expect(Object.keys(C1).length).toBeLessThan(Number(WORKER_SETTINGS.BLOB_STORE_BATCH_SIZE));
  });

  it('1: db:migrate on the migrated database applies nothing, and both queue tables exist', async () => {
    const migrations = readdirSync(join(ROOT, 'db/migrations')).filter((f) => f.endsWith('.sql'));
    const migrated = await runScript('db:migrate', { DATABASE_URL: db.ownerUrl });
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toContain(
      `nothing to apply (${String(migrations.length)} already applied)`,
    );
    const [tables] = await queryRows<{ jobs: string | null; batches: string | null }>(
      owner,
      `SELECT to_regclass('codegraph.index_jobs')::text AS jobs,
              to_regclass('codegraph.index_job_batches')::text AS batches`,
    );
    expect(tables?.jobs).not.toBeNull();
    expect(tables?.batches).not.toBeNull();
  });

  it('2: the operator sets up a tenant, a repository, a client, its token and its grant', async () => {
    const bootstrap = await runScript('operator:bootstrap', { DATABASE_URL: db.ownerUrl });
    expect(bootstrap.code).toBe(0);
    operatorToken = bootstrap.stdout.trim();

    const tenant = await operator('/v1/operator/tenants', { displayName: 'Acme' });
    expect(tenant.status).toBe(201);
    ids.tenant = (tenant.body as { tenantId: string }).tenantId;
    const repository = await operator('/v1/operator/repositories', {
      tenantId: ids.tenant,
      displayName: 'acme-web',
    });
    expect(repository.status).toBe(201);
    ids.repository = (repository.body as { repositoryId: string }).repositoryId;
    const client = await operator('/v1/operator/clients', { name: 'motir-core', kind: 'client' });
    expect(client.status).toBe(201);
    ids.client = (client.body as { clientId: string }).clientId;
    const issued = await operator(`/v1/operator/clients/${ids.client}/credentials`);
    expect(issued.status).toBe(201);
    clientToken = (issued.body as { token: string }).token;

    // The token's prefix and its length, as the contract publishes them.
    const contract = readFileSync(join(ROOT, 'docs/api-contract.md'), 'utf8');
    const published = /base64url, (\d+) characters/.exec(contract)?.[1];
    expect(published).toBeDefined();
    expect(clientToken.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(clientToken).toHaveLength(Number(published));

    const grant = await operator('/v1/operator/grants', {
      clientId: ids.client,
      tenantId: ids.tenant,
    });
    expect(grant.status).toBe(200);
    const status = await call(baseUrl(), `${repositoryPath()}/status`, { token: clientToken });
    expect(status.status).toBe(200);
  });

  it('a refresh called before any worker exists stays queued, never started', async () => {
    const jobId = await acceptedJob(
      await enqueue('refresh', { commit: commits.C0, fetchUrl: urlFor(C0, commits.C0) }),
    );
    expect(await requestJobCount()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const row = await jobRow(jobId);
    expect(row.state).toBe('queued');
    expect(row.started_at).toBeNull();
  });

  it(
    '3: first-index of C1 with a worker running ends succeeded and resolves to C1’s map',
    async () => {
      worker = await startWorker();
      const jobId = await acceptedJob(
        await enqueue('first-index', { commit: commits.C1, fetchUrl: urlFor(C1, commits.C1) }),
      );
      const { row, seen } = await settled(jobId);
      expectForward(seen);
      expect(row.state).toBe('succeeded');
      expect(row.attempts).toBe(0);
      expect(row.started_at).not.toBeNull();
      expect(row.ended_at).not.toBeNull();
      expect((row.ended_at as Date).getTime()).toBeGreaterThanOrEqual(
        (row.started_at as Date).getTime(),
      );
      expect(row.fetch_url).toBeNull();
      expect(await readdir(scratch)).toEqual([]);
      await expectResolvesTo(commits.C1, C1);
    },
    CASE_MS,
  );

  let c2Map: Map<string, string>;

  it(
    '4: a push of C2 stores exactly its three new blobs and resolves to C2’s map',
    async () => {
      const before = await blobCount();
      const jobId = await acceptedJob(
        await enqueue('push', {
          commit: commits.C2,
          previousHead: commits.C1,
          changedPaths: C2_CHANGED,
          fetchUrl: urlFor(C2, commits.C2),
        }),
      );
      const { row, seen } = await settled(jobId);
      expectForward(seen);
      expect(row.state).toBe('succeeded');
      c2Map = await expectResolvesTo(commits.C2, C2);
      for (const path of C2_CHANGED) expect(c2Map.get(path)).toBe(blobId(C2[path] as Buffer));
      expect(await blobCount()).toBe(before + C2_CHANGED.length);
    },
    CASE_MS,
  );

  it(
    '5: the same push again, naming unchanged paths, stores nothing and resolves the same',
    async () => {
      const before = await blobCount();
      const jobId = await acceptedJob(
        await enqueue('push', {
          commit: commits.C2,
          previousHead: commits.C1,
          changedPaths: ['test/file3.txt', 'lib/file4.txt'],
          fetchUrl: urlFor(C2, commits.C2),
        }),
      );
      expect((await settled(jobId)).row.state).toBe('succeeded');
      expect(await expectResolvesTo(commits.C2, C2)).toEqual(c2Map);
      expect(await blobCount()).toBe(before);
    },
    CASE_MS,
  );

  it(
    '6: with the worker stopped, C4 supersedes the queued C3; restarted, C4 is indexed and C3 is not',
    async () => {
      await (worker as WorkerProcess).stop();
      const c3 = await acceptedJob(
        await enqueue('push', {
          commit: commits.C3,
          previousHead: commits.C2,
          changedPaths: ['test/file0.txt'],
          fetchUrl: urlFor(C3, commits.C3),
        }),
      );
      const queued = await jobRow(c3);
      expect(queued.state).toBe('queued');
      expect(queued.started_at).toBeNull();

      const c4 = await acceptedJob(
        await enqueue('push', {
          commit: commits.C4,
          previousHead: commits.C2,
          changedPaths: ['test/file1.txt'],
          fetchUrl: urlFor(C4, commits.C4),
        }),
      );
      const waiting = await jobRow(c4);
      expect(waiting.state).toBe('queued');
      expect(waiting.started_at).toBeNull();
      const superseded = await jobRow(c3);
      expect(superseded.state).toBe('superseded');
      expect(superseded.started_at).toBeNull();
      expect(superseded.fetch_url).toBeNull();

      worker = await startWorker();
      const { row, seen } = await settled(c4);
      expectForward(seen);
      expect(row.state).toBe('succeeded');
      const after = await jobRow(c3);
      expect(after.state).toBe('superseded');
      expect(after.started_at).toBeNull();
      await expectResolvesTo(commits.C4, C4);
      expect((await resolved(commits.C3)).state).toBe('not_indexed');
    },
    CASE_MS,
  );

  /** A failed row whose message and fetch URL hold no part of `url`. */
  function expectFailedWithout(row: JobRow, url: string): void {
    expect(row.state).toBe('failed');
    expect(row.fetch_url).toBeNull();
    expect(row.failure_message).not.toBeNull();
    expect(row.failure_message).not.toContain(url);
    expect(row.failure_message).not.toContain(new URL(url).host);
    expect(row.failure_message).not.toContain(new URL(url).search);
  }

  it(
    '7a: a push whose fetch URL names the metadata address ends failed, address refused',
    async () => {
      metadataUrl = `https://169.254.169.254/latest/acme-web/${commits.C5}.tar.gz?X-Amz-Signature=recipe7a`;
      const jobId = await acceptedJob(
        await enqueue('push', {
          commit: commits.C5,
          previousHead: commits.C4,
          changedPaths: ['src/file1.txt'],
          fetchUrl: metadataUrl,
        }),
      );
      const { row } = await settled(jobId);
      expectFailedWithout(row, metadataUrl);
      expect(row.failure_reason_code).toBe(ADDRESS_REFUSED);
    },
    CASE_MS,
  );

  it(
    '7b: a push whose tarball is past the cap ends failed, too large, and no URL reached any worker',
    async () => {
      oversizedUrl = `${server.serve(
        `/acme-web/archive/${commits.C6}.tar.gz`,
        tarballOf(OVERSIZED, commits.C6),
      )}?X-Amz-Signature=recipe7b`;
      sentUrls.push(oversizedUrl);
      const jobId = await acceptedJob(
        await enqueue('push', {
          commit: commits.C6,
          previousHead: commits.C4,
          changedPaths: ['blob.bin'],
          fetchUrl: oversizedUrl,
        }),
      );
      const { row } = await settled(jobId);
      expectFailedWithout(row, oversizedUrl);
      expect(row.failure_reason_code).toBe(SOURCE_TOO_LARGE);
      await expectResolvesTo(commits.C4, C4);

      const output = workers.map((w) => w.output()).join('\n');
      expect(output).not.toBe('');
      for (const url of [metadataUrl, oversizedUrl]) {
        expect(output).not.toContain(url);
        expect(output).not.toContain(new URL(url).host);
      }
      for (const url of sentUrls) expect(output).not.toContain(url);
    },
    CASE_MS,
  );

  it(
    '8: a worker killed mid-job leaves it running; the next one re-queues it, counted, and finishes it',
    async () => {
      // The first fetch of C7 is held open, so the job is caught mid-run.
      const held: ServerResponse[] = [];
      const tarball = tarballOf(C7, commits.C7);
      const url = server.route(`/acme-web/archive/${commits.C7}.tar.gz`, (_req, res) => {
        if (held.length === 0) {
          held.push(res);
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': String(tarball.length),
        });
        res.end(tarball);
      });
      sentUrls.push(url);
      const jobId = await acceptedJob(
        await enqueue('push', {
          commit: commits.C7,
          previousHead: commits.C4,
          changedPaths: ['src/file5.txt'],
          fetchUrl: url,
        }),
      );
      const seen: string[] = [];
      await until(async () => {
        const { state } = await jobRow(jobId);
        if (seen.at(-1) !== state) seen.push(state);
        if (TERMINAL.includes(state)) {
          throw new Error(`the job ended before the kill; states seen: ${seen.join(' → ')}`);
        }
        // Running on the row, and its fetch is at the source: the job is mid-flight.
        return state === 'running' && held.length === 1;
      }, 'the C7 job to run');
      await (worker as WorkerProcess).kill();
      for (const res of held) res.destroy();

      const orphaned = await jobRow(jobId);
      expect(orphaned.state).toBe('running');
      expect(orphaned.lease_expires_at).not.toBeNull();
      expect(orphaned.attempts).toBe(0);

      worker = await startWorker();
      const { row } = await settled(jobId);
      expect(row.state).toBe('succeeded');
      expect(row.attempts).toBe(1);
      expect(row.fetch_url).toBeNull();
      await expectResolvesTo(commits.C7, C7);
    },
    CASE_MS,
  );

  it('9: a client with a real credential and no grant is refused, and nothing is enqueued', async () => {
    const client = await operator('/v1/operator/clients', { name: 'stranger', kind: 'client' });
    expect(client.status).toBe(201);
    const { clientId } = client.body as { clientId: string };
    const issued = await operator(`/v1/operator/clients/${clientId}/credentials`);
    expect(issued.status).toBe(201);
    const strangerToken = (issued.body as { token: string }).token;

    const before = await requestJobCount();
    const refused = await enqueue(
      'first-index',
      { commit: commits.C1, fetchUrl: urlFor(C1, commits.C1) },
      strangerToken,
    );
    expect(refused.status).toBe(documentedErrorCodes()[DENIED]);
    expect((refused.body as { error: { code: string } }).error.code).toBe(DENIED);
    expect(await requestJobCount()).toBe(before);
  });
});
