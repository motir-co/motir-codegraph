/**
 * The indexing benchmark's world: the API in-process on an ephemeral port
 * (`runServer`, as `pnpm serve` starts it), N workers as child processes
 * running the `worker` package script, a local https source serving the
 * generated tarballs behind the repository's committed test certificate, and
 * the tenants, repositories and granted client the arms run as.
 *
 * The workers trust that certificate through NODE_EXTRA_CA_CERTS and pass the
 * address screen through FETCH_ALLOWED_HOSTS=127.0.0.1, never through a
 * bypassed TLS check. The source is named by that IP literal rather than by
 * `localhost`: the fetcher connects to the first address a name resolves to,
 * and on a host whose `localhost` answers ::1 first the IPv4 listener would be
 * missed. Every client credential is minted through
 * `POST /v1/operator/clients/:clientId/credentials`, the one answer a token
 * appears in, so every measured call carries a real bearer token.
 *
 * `teardown()` is idempotent and safe on every exit path: it stops every
 * worker (SIGTERM, then SIGKILL), deletes every tenant the run created,
 * revokes every credential it minted, closes the API, the source and the
 * pools, and removes the scratch root.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { readLayerSettings } from '../../config.js';
import { parseConnectionUrl } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { bootstrapOperator } from '../../db/operator.js';
import { resolveCommit, type Resolution } from '../../layers/resolution.js';
import { BIND_TENANT_SQL } from '../../server/binding.js';
import { createAppPool } from '../../server/pool.js';
import { runServer, type RunningServer } from '../../server/run.js';
import { mintToken } from '../../server/tokens.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The repository's committed loopback certificate (tests/helpers/tarballServer.ts serves the same). */
export const SOURCE_CERT_FILE = join(ROOT, 'tests/helpers/certs/tarball-server-cert.pem');
/** The source's host: an IP literal on the certificate, so no resolver order decides it. */
const SOURCE_HOST = '127.0.0.1';
const SOURCE_KEY_FILE = join(ROOT, 'tests/helpers/certs/tarball-server-key.pem');

/** The worker configuration every spawned worker gets, explicitly. */
export interface WorkerConfig {
  readonly workers: number;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly batchSize: number;
}

export const DEFAULT_WORKER_CONFIG: Omit<WorkerConfig, 'workers'> = {
  pollMs: 100,
  leaseMs: 60_000,
  maxAttempts: 3,
  batchSize: 500,
};

export interface BenchUrls {
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly adminUrl: string;
  /** The database every URL names. */
  readonly database: string;
}

export interface Seeded {
  readonly tenantId: string;
  readonly repositoryIds: string[];
}

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export interface Stack {
  readonly urls: BenchUrls;
  readonly config: WorkerConfig;
  readonly scratchRoot: string;
  readonly clientId: string;
  /** A JSON call on the in-process API with the bench client's token. */
  call(path: string, body: unknown): Promise<Answer>;
  /** Serves the file at `/<name>` on the https source; answers its URL. */
  serve(name: string, file: string): string;
  /** A tenant with `repositories` repositories, granted to the bench client. */
  seedTenant(name: string, repositories: number): Promise<Seeded>;
  /** Deletes a tenant the run created, through the operator call. */
  deleteTenant(tenantId: string): Promise<void>;
  /** `resolveCommit` on a session bound to the tenant as the bench client. */
  resolve(scope: { tenantId: string; repositoryId: string }, commit: string): Promise<Resolution>;
  /** The job row's state and failure, read on the owner login. */
  job(jobId: string): Promise<{ state: string; reason: string | null; message: string | null }>;
  /** The last lines each worker wrote, for a failure's message. */
  workerTail(): string;
  teardown(): Promise<void>;
}

/** The three database URLs, each naming the same database. */
export function readBenchUrls(env: NodeJS.ProcessEnv): BenchUrls {
  const need = (name: string) => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(`${name} is not set; the benchmark needs all three database URLs.`);
    }
    return value;
  };
  const ownerUrl = need('DATABASE_URL');
  const appUrl = need('DATABASE_APP_URL');
  const adminUrl = need('DATABASE_ADMIN_URL');
  return {
    ownerUrl,
    appUrl,
    adminUrl,
    database: parseConnectionUrl('DATABASE_URL', ownerUrl).database,
  };
}

/** The `node` arguments of a package.json script, so a worker starts as `pnpm worker` does. */
export function scriptArgs(name: string): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts[name];
  const [command, ...args] = (script ?? '').split(/\s+/);
  if (command !== 'node') throw new Error(`package.json script ${name} does not run node`);
  return args;
}

export function workerEnv(
  urls: BenchUrls,
  config: WorkerConfig,
  scratchDir: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...base,
    DATABASE_APP_URL: urls.appUrl,
    SCRATCH_DIR: scratchDir,
    WORKER_POLL_MS: String(config.pollMs),
    JOB_LEASE_MS: String(config.leaseMs),
    MAX_ATTEMPTS: String(config.maxAttempts),
    BLOB_STORE_BATCH_SIZE: String(config.batchSize),
    FETCH_ALLOWED_HOSTS: SOURCE_HOST,
    NODE_EXTRA_CA_CERTS: SOURCE_CERT_FILE,
    // The queue's metrics are not read here; keep their lines rare.
    METRICS_INTERVAL_MS: '600000',
  };
}

interface Worker {
  child: ChildProcess;
  tail: string[];
}

async function stopWorker(worker: Worker): Promise<void> {
  const { child } = worker;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

function startWorker(env: NodeJS.ProcessEnv): Worker {
  const child = spawn(process.execPath, scriptArgs('worker'), {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const worker: Worker = { child, tail: [] };
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line === '' || line.startsWith('{"_aws"')) continue;
      worker.tail.push(line);
      if (worker.tail.length > 20) worker.tail.shift();
    }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return worker;
}

async function waitForStart(worker: Worker, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!worker.tail.some((line) => line.includes('"msg":"worker started"'))) {
    if (worker.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`a worker did not start:\n${worker.tail.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startSource(): Promise<{
  server: Server;
  origin: string;
  routes: Map<string, string>;
}> {
  const routes = new Map<string, string>();
  const server = createServer(
    { key: readFileSync(SOURCE_KEY_FILE, 'utf8'), cert: readFileSync(SOURCE_CERT_FILE, 'utf8') },
    (req, res) => {
      const file = routes.get((req.url ?? '/').split('?')[0] ?? '/');
      if (file === undefined) {
        res.writeHead(404).end('not found');
        return;
      }
      stat(file).then(
        ({ size }) => {
          res.writeHead(200, {
            'content-type': 'application/gzip',
            'content-length': String(size),
          });
          createReadStream(file).pipe(res);
        },
        () => res.writeHead(404).end('not found'),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, SOURCE_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `https://${SOURCE_HOST}:${String(port)}`, routes };
}

/** The run's operator: a fresh operator client and credential, created as an existing operator. */
async function benchOperator(urls: BenchUrls, run: string): Promise<{ id: string; token: string }> {
  const owner = new pg.Client({ connectionString: urls.ownerUrl });
  await owner.connect();
  let existing: string;
  try {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM codegraph.clients WHERE kind = 'operator' ORDER BY id LIMIT 1",
    );
    existing = rows[0]?.id ?? (await bootstrapOperator({ ownerUrl: urls.ownerUrl })).clientId;
  } finally {
    await owner.end();
  }
  const app = new pg.Client({ connectionString: urls.appUrl });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.client_id', $1, true)", [existing]);
    const id = (
      await app.query<{ v: string }>('SELECT codegraph.codegraph_create_client($1, $2) AS v', [
        `indexing bench operator ${run}`,
        'operator',
      ])
    ).rows[0]?.v as string;
    const minted = mintToken();
    await app.query('SELECT codegraph.codegraph_issue_credential($1, $2, $3)', [
      id,
      minted.hash,
      minted.displayPrefix,
    ]);
    await app.query('COMMIT');
    return { id, token: minted.token };
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  } finally {
    await app.end();
  }
}

async function jsonCall(
  base: string,
  path: string,
  init: { method?: string; token: string; body?: unknown },
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      authorization: `Bearer ${init.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

function expectStatus(answer: Answer, status: number, what: string): Record<string, string> {
  if (answer.status !== status) {
    throw new Error(`${what} answered ${String(answer.status)}: ${JSON.stringify(answer.body)}`);
  }
  return answer.body as Record<string, string>;
}

export async function startStack(options: {
  urls: BenchUrls;
  config: WorkerConfig;
  run: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Stack> {
  const { urls, config, run } = options;
  const env = options.env ?? process.env;
  readLayerSettings(env); // a malformed layer knob fails here, before anything starts
  const scratchRoot = await mkdtemp(join(tmpdir(), 'indexing-bench-'));
  const workers: Worker[] = [];
  const tenants = new Set<string>();
  const credentials: string[] = [];
  let api: RunningServer | undefined;
  let source: Awaited<ReturnType<typeof startSource>> | undefined;
  let owner: pg.Pool | undefined;
  let app: pg.Pool | undefined;
  let operator: { id: string; token: string } | undefined;
  let tornDown: Promise<void> | undefined;

  const teardown = () => {
    tornDown ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (step: () => Promise<unknown>) => {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      };
      await Promise.all(workers.map((w) => attempt(() => stopWorker(w))));
      if (api !== undefined && operator !== undefined) {
        const base = api.address;
        const token = operator.token;
        for (const tenantId of tenants) {
          await attempt(() =>
            jsonCall(base, `/v1/tenants/${tenantId}`, { method: 'DELETE', token }),
          );
        }
        for (const credentialId of credentials) {
          await attempt(() =>
            jsonCall(base, `/v1/operator/credentials/${credentialId}/revoke`, { token }),
          );
        }
      }
      if (api !== undefined) await attempt(() => (api as RunningServer).shutdown());
      if (source !== undefined) {
        const server = source.server;
        await attempt(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => {
                resolve();
              });
            }),
        );
      }
      if (owner !== undefined) await attempt(() => (owner as pg.Pool).end());
      if (app !== undefined) await attempt(() => (app as pg.Pool).end());
      await attempt(() => rm(scratchRoot, { recursive: true, force: true }));
      if (errors.length > 0)
        throw new AggregateError(errors, 'the benchmark did not tear down cleanly');
    })();
    return tornDown;
  };

  try {
    await migrate({ connectionString: urls.ownerUrl });
    owner = new pg.Pool({ connectionString: urls.ownerUrl, max: 2 });
    // An idle connection lost is the next query's error, never the process's.
    owner.on('error', () => undefined);
    app = createAppPool(urls.appUrl);
    api = await runServer(
      { ...env, DATABASE_APP_URL: urls.appUrl, PORT: '0', HOST: '127.0.0.1' },
      false,
    );
    source = await startSource();
    operator = await benchOperator(urls, run);
    const op = operator;
    const base = api.address;
    const operatorCall = (path: string, body?: unknown) =>
      jsonCall(base, path, { token: op.token, ...(body === undefined ? {} : { body }) });

    const client = expectStatus(
      await operatorCall('/v1/operator/clients', { name: `indexing bench ${run}`, kind: 'client' }),
      201,
      'creating the bench client',
    );
    const clientId = client.clientId as string;
    const issued = expectStatus(
      await operatorCall(`/v1/operator/clients/${clientId}/credentials`),
      201,
      'issuing the bench credential',
    );
    const clientToken = issued.token as string;
    credentials.push(issued.credentialId as string);
    // The run's own operator credential is revoked last, after the deletes it authorises.
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM codegraph.credentials WHERE client_id = $1',
      [op.id],
    );
    credentials.push(...rows.map((r) => r.id));

    for (let i = 0; i < config.workers; i += 1) {
      const dir = join(scratchRoot, `worker-${String(i)}`);
      await mkdir(dir);
      workers.push(startWorker(workerEnv(urls, config, dir, env)));
    }
    await Promise.all(workers.map((w) => waitForStart(w)));
    const sourceState = source;
    const ownerPool = owner;
    const appPool = app;

    return {
      urls,
      config,
      scratchRoot,
      clientId,
      call: (path, body) => jsonCall(base, path, { token: clientToken, body }),
      serve(name, file) {
        sourceState.routes.set(`/${name}`, file);
        return `${sourceState.origin}/${name}`;
      },
      async seedTenant(name, repositories) {
        const tenant = expectStatus(
          await operatorCall('/v1/operator/tenants', { displayName: name }),
          201,
          'creating a tenant',
        );
        const tenantId = tenant.tenantId as string;
        tenants.add(tenantId);
        const repositoryIds: string[] = [];
        for (let r = 0; r < repositories; r += 1) {
          const repository = expectStatus(
            await operatorCall('/v1/operator/repositories', {
              tenantId,
              displayName: `${name} r${String(r + 1)}`,
            }),
            201,
            'registering a repository',
          );
          repositoryIds.push(repository.repositoryId as string);
        }
        expectStatus(
          await operatorCall('/v1/operator/grants', { clientId, tenantId }),
          200,
          'granting the bench client',
        );
        return { tenantId, repositoryIds };
      },
      async deleteTenant(tenantId) {
        expectStatus(
          await jsonCall(base, `/v1/tenants/${tenantId}`, { method: 'DELETE', token: op.token }),
          204,
          'deleting a tenant',
        );
        tenants.delete(tenantId);
      },
      async resolve(scope, commit) {
        const c = await appPool.connect();
        try {
          await c.query('BEGIN');
          await c.query(BIND_TENANT_SQL, [clientId, scope.tenantId]);
          return await resolveCommit(c, scope.tenantId, scope.repositoryId, commit);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      },
      async job(jobId) {
        const { rows: jobs } = await ownerPool.query<{
          state: string;
          reason: string | null;
          message: string | null;
        }>(
          `SELECT state, failure_reason_code AS reason, failure_message AS message
             FROM codegraph.index_jobs WHERE id = $1`,
          [jobId],
        );
        const [row] = jobs;
        if (row === undefined) throw new Error(`no job row ${jobId}`);
        return row;
      },
      workerTail: () =>
        workers.map((w, i) => `worker ${String(i)}:\n${w.tail.join('\n')}`).join('\n'),
      teardown,
    };
  } catch (error) {
    await teardown().catch(() => undefined);
    throw error;
  }
}
