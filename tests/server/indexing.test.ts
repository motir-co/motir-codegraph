import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, registeredRoutes, unversionedRoutes } from '../../src/server/app.js';
import { ERROR_STATUS } from '../../src/server/errors.js';
import { createAppPool } from '../../src/server/pool.js';
import {
  FETCH_URL_REFUSED,
  isFetchUrlShape,
  MAX_CHANGED_PATH_LENGTH,
  MAX_CHANGED_PATHS,
  MAX_FETCH_URL_LENGTH,
  MAX_REF_LENGTH,
} from '../../src/server/routes/indexing.js';
import { documentedErrorCodes, markdownSection } from '../helpers/apiContract.js';
import { freshDatabase, queryRows, type FreshDatabase } from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import {
  asOperator,
  buildTenancyFixture,
  newToken,
  type TenancyFixture,
} from '../helpers/tenancy.js';

// The three indexing calls against one copy whose real logger writes to a
// buffer. Rows are read back as the owner on a separate connection, which
// sees every tenant, so a row a refusal wrote anywhere would show.

let db: FreshDatabase;
let fx: TenancyFixture;
let server: ServerCopy;
let log: QueryLog;
let owner: pg.Client;
let logged = '';

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logged += chunk.toString();
      done();
    },
  });
  server = await startServer(db.appUrl, { logger: { level: 'trace', stream } });
  log = recordQueries(server.pool);
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await server.stop();
  await db.drop();
});

beforeEach(async () => {
  await owner.query('DELETE FROM codegraph.index_jobs');
  log.clear();
});

const sha = () => randomBytes(20).toString('hex');
const repoA = () => (fx.tenantA.repositories[0] as { id: string }).id;
const repoA2 = () => (fx.tenantA.repositories[1] as { id: string }).id;
const repoB = () => (fx.tenantB.repositories[0] as { id: string }).id;
const path = (call: string, repositoryId = repoA(), tenantId = fx.tenantA.id) =>
  `/v1/tenants/${tenantId}/repositories/${repositoryId}/${call}`;
const FETCH = 'https://git.example/acme/archive.tar.gz';

/** As the reader, as `token`, or with no credential at all (`null`). */
function post(route: string, body: unknown, token: string | null = fx.readerToken) {
  return call(server.baseUrl, route, {
    method: 'POST',
    ...(token === null ? {} : { token }),
    body,
  });
}

const requestBody = (overrides: Record<string, unknown> = {}) => ({
  commit: sha(),
  ref: 'refs/heads/main',
  isDefaultBranch: true,
  fetchUrl: FETCH,
  ...overrides,
});
const pushBody = (overrides: Record<string, unknown> = {}) => ({
  ...requestBody(),
  previousHead: sha(),
  changedPaths: ['src/a.ts', 'README.md'],
  ...overrides,
});

interface JobRecord {
  id: string;
  tenant_id: string;
  repository_id: string;
  client_id: string;
  kind: string;
  state: string;
  commit_sha: string;
  ref_name: string;
  is_default_branch: boolean;
  candidate_ancestors: string[];
  changed_paths: string[];
  fetch_url: string | null;
}

async function jobs(repositoryId?: string): Promise<JobRecord[]> {
  return await queryRows<JobRecord>(
    owner,
    `SELECT id, tenant_id, repository_id, client_id, kind, state, commit_sha, ref_name,
            is_default_branch, candidate_ancestors, changed_paths, fetch_url
       FROM codegraph.index_jobs
      WHERE $1::uuid IS NULL OR repository_id = $1 ORDER BY enqueued_at, id`,
    [repositoryId ?? null],
  );
}

async function queuedCount(): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    owner,
    "SELECT count(*)::int AS n FROM codegraph.index_jobs WHERE state = 'queued'",
  );
  return rows[0]?.n ?? -1;
}

function jobIdOf(response: { status: number; body: unknown }): string {
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  expect(Object.keys(response.body as object)).toEqual(['jobId']);
  return (response.body as { jobId: string }).jobId;
}

describe('the three calls each enqueue one queued job', () => {
  it('first-index writes a first_index row with the commit, ref, flag, fetch URL and caller', async () => {
    const body = requestBody();
    const jobId = jobIdOf(await post(path('first-index'), body));
    expect(await jobs()).toEqual([
      {
        id: jobId,
        tenant_id: fx.tenantA.id,
        repository_id: repoA(),
        client_id: fx.readerId,
        kind: 'first_index',
        state: 'queued',
        commit_sha: body.commit,
        ref_name: body.ref,
        is_default_branch: true,
        candidate_ancestors: [],
        changed_paths: [],
        fetch_url: FETCH,
      },
    ]);
  });

  it('push writes previousHead as the one candidate and changedPaths in the order sent', async () => {
    const body = pushBody({ isDefaultBranch: false, changedPaths: ['z', 'a', 'm/x.py'] });
    const jobId = jobIdOf(await post(path('push'), body));
    expect(await jobs()).toEqual([
      expect.objectContaining({
        id: jobId,
        kind: 'push',
        state: 'queued',
        commit_sha: body.commit,
        is_default_branch: false,
        candidate_ancestors: [body.previousHead],
        changed_paths: ['z', 'a', 'm/x.py'],
        fetch_url: FETCH,
        client_id: fx.readerId,
      }) as unknown,
    ]);
  });

  it('refresh writes a refresh row with no candidate and no path, for a commit new or not', async () => {
    const body = requestBody();
    jobIdOf(await post(path('first-index'), body));
    const first = jobIdOf(await post(path('refresh'), body));
    const second = jobIdOf(await post(path('refresh'), requestBody()));
    const refreshes = (await jobs()).filter((job) => job.kind === 'refresh');
    expect(refreshes.map((job) => job.id)).toEqual([first, second]);
    for (const job of refreshes) {
      expect(job).toMatchObject({ state: 'queued', candidate_ancestors: [], changed_paths: [] });
    }
    expect(refreshes[0]?.commit_sha).toBe(body.commit);
  });

  it('accepts a ref exactly as sent, and an http fetch URL, without normalising either', async () => {
    const jobId = jobIdOf(
      await post(
        path('first-index'),
        requestBody({ ref: ' main ', fetchUrl: 'http://10.0.0.1/x' }),
      ),
    );
    expect((await jobs()).find((job) => job.id === jobId)).toMatchObject({
      ref_name: ' main ',
      fetch_url: 'http://10.0.0.1/x',
    });
  });
});

describe('refusals', () => {
  const ROUTES = ['first-index', 'push', 'refresh'] as const;
  const bodyFor = (route: (typeof ROUTES)[number]) =>
    route === 'push' ? pushBody() : requestBody();
  const codes = documentedErrorCodes();

  async function expectRefused(
    response: { status: number; body: unknown },
    code: keyof typeof ERROR_STATUS,
  ): Promise<void> {
    expect(response.status).toBe(codes[code]);
    expect(response.body).toMatchObject({ error: { code } });
    expect(await queuedCount()).toBe(0);
  }

  it.each(ROUTES)('%s: no credential, or a revoked one, is unauthenticated', async (route) => {
    await expectRefused(await post(path(route), bodyFor(route), null), 'unauthenticated');
    const { token, hash } = newToken();
    const credentialId = await asOperator<string>(
      db.appUrl,
      fx.operatorId,
      "codegraph.codegraph_issue_credential($1, $2, 'cg_ix')",
      [fx.readerId, hash],
    );
    await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_revoke_credential($1)', [
      credentialId,
    ]);
    await expectRefused(await post(path(route), bodyFor(route), token), 'unauthenticated');
  });

  it.each(ROUTES)('%s: an ungranted tenant is permission_denied', async (route) => {
    await expectRefused(
      await post(path(route, repoB(), fx.tenantB.id), bodyFor(route)),
      'permission_denied',
    );
    await expectRefused(
      await post(path(route, repoA(), 'not-a-uuid'), bodyFor(route)),
      'permission_denied',
    );
  });

  it.each(ROUTES)(
    '%s: a missing, malformed or other-tenant repository is repository_not_found',
    async (route) => {
      for (const repositoryId of [randomUUID(), 'not-a-uuid', repoB()]) {
        await expectRefused(
          await post(path(route, repositoryId), bodyFor(route)),
          'repository_not_found',
        );
      }
      // The resolver answers first: a bad fetch URL on an invisible repository is still 404.
      await expectRefused(
        await post(path(route, randomUUID()), { ...bodyFor(route), fetchUrl: 'ftp://x' }),
        'repository_not_found',
      );
    },
  );

  it('maps no new code: the documented codes are exactly ERROR_STATUS', () => {
    expect(codes).toEqual({ ...ERROR_STATUS });
  });

  const INVALID: [string, (typeof ROUTES)[number], Record<string, unknown>][] = [
    ['an unknown field', 'first-index', { ...requestBody(), extra: 1 }],
    ['a changedPaths field on first-index', 'first-index', { ...requestBody(), changedPaths: [] }],
    ['a missing isDefaultBranch', 'refresh', omit(requestBody(), 'isDefaultBranch')],
    ['a missing fetchUrl', 'push', omit(pushBody(), 'fetchUrl')],
    ['a missing previousHead', 'push', omit(pushBody(), 'previousHead')],
    ['a string isDefaultBranch', 'first-index', requestBody({ isDefaultBranch: 'true' })],
    ['changedPaths not an array', 'push', pushBody({ changedPaths: 'src/a.ts' })],
    ['an empty changed path', 'push', pushBody({ changedPaths: ['a', ''] })],
    ['a non-string changed path', 'push', pushBody({ changedPaths: [1] })],
    [
      'too many changed paths',
      'push',
      pushBody({ changedPaths: Array.from({ length: MAX_CHANGED_PATHS + 1 }, () => 'a') }),
    ],
    [
      'a changed path over its bound',
      'push',
      pushBody({ changedPaths: ['a'.repeat(MAX_CHANGED_PATH_LENGTH + 1)] }),
    ],
    ['an upper-case commit', 'first-index', requestBody({ commit: sha().toUpperCase() })],
    ['a short commit', 'refresh', requestBody({ commit: sha().slice(0, 39) })],
    ['a 64-hex commit', 'first-index', requestBody({ commit: sha() + sha().slice(0, 24) })],
    ['a 64-hex previousHead', 'push', pushBody({ previousHead: sha() + sha().slice(0, 24) })],
    ['a blank ref', 'push', pushBody({ ref: ' \t ' })],
    ['an empty ref', 'first-index', requestBody({ ref: '' })],
    ['a missing ref', 'refresh', omit(requestBody(), 'ref')],
    ['a ref over its bound', 'refresh', requestBody({ ref: 'r'.repeat(MAX_REF_LENGTH + 1) })],
    ['a relative fetch URL', 'first-index', requestBody({ fetchUrl: '/archive.tar.gz' })],
    ['an ftp fetch URL', 'push', pushBody({ fetchUrl: 'ftp://git.example/a.tar.gz' })],
    ['a scheme without //', 'refresh', requestBody({ fetchUrl: 'https:git.example/a' })],
    ['a fetch URL that is not a URL', 'refresh', requestBody({ fetchUrl: 'https://' })],
    [
      'a fetch URL over its bound',
      'first-index',
      requestBody({ fetchUrl: `https://git.example/${'a'.repeat(MAX_FETCH_URL_LENGTH)}` }),
    ],
    ['a non-string fetch URL', 'push', pushBody({ fetchUrl: 7 })],
  ];

  it.each(INVALID)('%s is invalid_request and writes no job', async (_name, route, body) => {
    await expectRefused(await post(path(route), body), 'invalid_request');
  });

  it('refuses a fetch URL of the wrong shape with a fixed sentence that never echoes it', async () => {
    const marker = `secret-${randomUUID()}`;
    for (const fetchUrl of [`ftp://h/a?token=${marker}`, `${marker}?sig=${marker}`]) {
      const response = await post(path('push'), pushBody({ fetchUrl }));
      await expectRefused(response, 'invalid_request');
      expect((response.body as { error: { message: string } }).error.message).toBe(
        FETCH_URL_REFUSED,
      );
      expect(JSON.stringify(response.body)).not.toContain(marker);
    }
    expect(logged).not.toContain(marker);
  });
});

function omit(body: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
}

describe('the request does no indexing work', () => {
  const LAYER_TABLES = [
    'codegraph.blob',
    'codegraph.commit_layers',
    'codegraph.layer_paths',
    'codegraph.index_job_batches',
  ];

  it('touches no blob, layer or batch table, on any of the three calls', async () => {
    jobIdOf(await post(path('first-index'), requestBody()));
    jobIdOf(await post(path('push'), pushBody()));
    jobIdOf(await post(path('refresh'), requestBody()));
    for (const text of log.texts()) {
      for (const table of LAYER_TABLES) {
        expect(text).not.toMatch(new RegExp(`${table.replace('.', '\\.')}\\b`));
      }
    }
  });

  it('issues as many statements with six pushes queued as with one', async () => {
    const counted = async (): Promise<number> => {
      log.clear();
      jobIdOf(await post(path('push', repoA2()), pushBody({ ref: 'refs/heads/other' })));
      return log.texts().length;
    };
    // One queued push of another ref beside the measured one, then six.
    jobIdOf(await post(path('push', repoA2()), pushBody({ ref: 'refs/heads/side-0' })));
    const withOne = await counted();
    for (let i = 1; i <= 5; i += 1) {
      jobIdOf(
        await post(path('push', repoA2()), pushBody({ ref: `refs/heads/side-${String(i)}` })),
      );
    }
    expect(await counted()).toBe(withOne);
  });
});

describe('a push supersedes the queued pushes of its ref', () => {
  it('leaves one queued push for the ref, the newer one, in one transaction', async () => {
    const earlier = jobIdOf(await post(path('push'), pushBody()));
    log.clear();
    const later = jobIdOf(await post(path('push'), pushBody()));
    const texts = log.texts();
    expect(texts.filter((text) => text === 'BEGIN')).toHaveLength(1);
    expect(texts.filter((text) => text === 'COMMIT')).toHaveLength(1);
    expect(await jobs(repoA())).toEqual([
      expect.objectContaining({ id: earlier, state: 'superseded', fetch_url: null }) as unknown,
      expect.objectContaining({ id: later, state: 'queued', fetch_url: FETCH }) as unknown,
    ]);
  });

  it('leaves a push of another ref, or of another repository, queued', async () => {
    const main = jobIdOf(await post(path('push'), pushBody()));
    const otherRepo = jobIdOf(await post(path('push', repoA2()), pushBody()));
    jobIdOf(await post(path('push'), pushBody({ ref: 'refs/heads/feature' })));
    jobIdOf(await post(path('push', repoA2()), pushBody({ ref: 'refs/heads/feature' })));
    const states = new Map((await jobs()).map((job) => [job.id, job.state]));
    expect(states.get(main)).toBe('queued');
    expect(states.get(otherRepo)).toBe('queued');
    expect([...states.values()].every((state) => state === 'queued')).toBe(true);
  });

  it('a first-index or a refresh supersedes nothing', async () => {
    const push = jobIdOf(await post(path('push'), pushBody()));
    jobIdOf(await post(path('first-index'), requestBody()));
    jobIdOf(await post(path('refresh'), requestBody()));
    expect((await jobs()).find((job) => job.id === push)?.state).toBe('queued');
  });
});

describe('changedPaths is carried, never trusted', () => {
  it('accepts paths not in the commit and an empty list, storing exactly what was sent', async () => {
    const odd = ['no/such/file.ts', 'x'.repeat(200), 'dup', 'dup'];
    const oddJob = jobIdOf(await post(path('push'), pushBody({ changedPaths: odd })));
    const emptyJob = jobIdOf(
      await post(path('push'), pushBody({ ref: 'refs/heads/b', changedPaths: [] })),
    );
    const byId = new Map((await jobs()).map((job) => [job.id, job.changed_paths]));
    expect(byId.get(oddJob)).toEqual(odd);
    expect(byId.get(emptyJob)).toEqual([]);
  });
});

describe('the fetch URL reaches no body and no log', () => {
  it('logs no line and answers no body carrying a marker in its query string', async () => {
    const marker = `sig-${randomUUID()}`;
    const response = await post(
      path('push'),
      pushBody({ fetchUrl: `https://git.example/a.tar.gz?X-Signature=${marker}` }),
    );
    jobIdOf(response);
    expect(JSON.stringify(response.body)).not.toContain(marker);
    expect(logged.length).toBeGreaterThan(0); // the logger is live
    expect(logged).not.toContain(marker);
  });
});

describe('registration and the contract', () => {
  it('registers the three routes only through V1_ROUTE_MODULES', async () => {
    const pool = createAppPool(db.appUrl);
    const app = await buildApp({ pool });
    try {
      const routes = registeredRoutes(app);
      for (const call of ['first-index', 'push', 'refresh']) {
        expect(routes).toContainEqual({
          method: 'POST',
          url: `/v1/tenants/:tenantId/repositories/:repositoryId/${call}`,
        });
      }
      expect(unversionedRoutes(routes)).toEqual([]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('documents the calls in section 12 and keeps the checklist as section 13', () => {
    const section = markdownSection('docs/api-contract.md', /^## 12\. Indexing requests/);
    for (const text of [
      '/first-index',
      '/push',
      '/refresh',
      '{ commit, ref, isDefaultBranch, previousHead, changedPaths, fetchUrl }',
      '{ "jobId": "<uuid>" }',
      '40 lowercase hex',
      'stored exactly as sent',
      'checked for shape only',
      'unauthenticated',
      'permission_denied',
      'repository_not_found',
      'invalid_request',
    ]) {
      expect(section).toContain(text);
    }
    expect(markdownSection('docs/api-contract.md', /^## 13\. Adding a route/)).toContain(
      'V1_ROUTE_MODULES',
    );
  });

  it('judges a fetch URL by shape alone', () => {
    expect(isFetchUrlShape('https://169.254.169.254/latest')).toBe(true);
    expect(isFetchUrlShape('HTTP://git.example/a')).toBe(true);
    expect(isFetchUrlShape('file:///etc/passwd')).toBe(false);
  });
});
