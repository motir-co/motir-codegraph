import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ERROR_STATUS } from '../../src/server/errors.js';
import { REPOSITORY_STATUS_KEYS } from '../../src/server/status.js';
import { documentedErrorCodes } from '../helpers/apiContract.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import {
  runScript,
  startServerProcess,
  stopAll,
  waitForHealth,
  type ServerProcess,
} from '../helpers/processes.js';
import { call } from '../helpers/server.js';

// The story's verification recipe, steps 1–9, as one journey: the operator
// bootstrap command and two copies of the server run as separate processes,
// started the way their package.json scripts start them, over one real
// database. Each step builds on the one before, so the cases run in order.

let db: FreshDatabase;
let copyA: ServerProcess | undefined;
let copyB: ServerProcess | undefined;
let copyC: ServerProcess | undefined;

beforeAll(async () => {
  db = await freshDatabase();
  [copyA, copyB] = await Promise.all([
    startServerProcess(db.appUrl),
    startServerProcess(db.appUrl),
  ]);
}, 60_000);

afterAll(async () => {
  await stopAll([copyA, copyB, copyC]);
  await db.drop();
}, 30_000);

const copies = () => [copyA, copyB].map((copy) => (copy as ServerProcess).baseUrl);

type Answer = Awaited<ReturnType<typeof call>>;
type CallInit = Parameters<typeof call>[2];

/** Every answer of the journey, so later steps can check what was never said. */
const answers: { path: string; answer: Answer }[] = [];
const observedCodes = new Set<string>();

function record(path: string, answer: Answer): Answer {
  answers.push({ path, answer });
  const code = (answer.body as { error?: { code?: string } } | null)?.error?.code;
  if (code !== undefined) observedCodes.add(code);
  return answer;
}

/** A write or a call that mints ids, sent to copy n mod 2 for call n. */
let turn = 0;
async function alternate(path: string, init: CallInit = {}): Promise<Answer> {
  const url = copies()[turn % 2] as string;
  turn += 1;
  return record(path, await call(url, path, init));
}

/** A read sent to both copies, which must answer the same status and body. */
async function onBoth(path: string, init: CallInit = {}): Promise<Answer> {
  const [a, b] = await Promise.all(copies().map((url) => call(url, path, init)));
  const first = record(path, a as Answer);
  record(path, b as Answer);
  expect({ status: b?.status, body: b?.body }).toEqual({ status: a?.status, body: a?.body });
  return first;
}

/** One write on one copy, by name, so the check can be made on the other. */
async function on(copy: 'A' | 'B', path: string, init: CallInit = {}): Promise<Answer> {
  const url = (copy === 'A' ? copyA : copyB)?.baseUrl as string;
  return record(path, await call(url, path, init));
}

const json = (token: string, body?: unknown, method = 'POST'): CallInit => ({
  method,
  token,
  ...(body === undefined ? {} : { body }),
});

const error = (code: keyof typeof ERROR_STATUS) => ({
  status: ERROR_STATUS[code],
  body: { error: { code, message: expect.any(String) as string } },
});

let operatorToken = '';
let clientToken = '';
const ids = {
  tenantA: '',
  tenantB: '',
  repositoryA: '',
  repositoryB: '',
  clientId: '',
  credentialId: '',
};

describe('the story’s verification recipe, over two copies', () => {
  it('1–2: both copies are healthy, and the bootstrap command prints one cgk_ token', async () => {
    for (const url of copies()) {
      const health = await call(url, '/health');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: 'ok', database: { up: true } });
    }
    const bootstrap = await runScript('operator:bootstrap', { DATABASE_URL: db.ownerUrl });
    expect(bootstrap.code).toBe(0);
    const lines = bootstrap.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^cgk_[A-Za-z0-9_-]{43}$/);
    operatorToken = lines[0] as string;
  });

  it('3: the operator sets up two tenants, a client and its credential, seen once', async () => {
    const tenantA = await alternate(
      '/v1/operator/tenants',
      json(operatorToken, { displayName: 'Acme' }),
    );
    const tenantB = await alternate(
      '/v1/operator/tenants',
      json(operatorToken, { displayName: 'Globex' }),
    );
    expect([tenantA.status, tenantB.status]).toEqual([201, 201]);
    ids.tenantA = (tenantA.body as { tenantId: string }).tenantId;
    ids.tenantB = (tenantB.body as { tenantId: string }).tenantId;

    const repositoryA = await alternate(
      '/v1/operator/repositories',
      json(operatorToken, { tenantId: ids.tenantA, displayName: 'acme-web' }),
    );
    const repositoryB = await alternate(
      '/v1/operator/repositories',
      json(operatorToken, { tenantId: ids.tenantB, displayName: 'globex-core' }),
    );
    expect([repositoryA.status, repositoryB.status]).toEqual([201, 201]);
    ids.repositoryA = (repositoryA.body as { repositoryId: string }).repositoryId;
    ids.repositoryB = (repositoryB.body as { repositoryId: string }).repositoryId;

    const client = await alternate(
      '/v1/operator/clients',
      json(operatorToken, { name: 'motir-ai', kind: 'client' }),
    );
    expect(client.status).toBe(201);
    ids.clientId = (client.body as { clientId: string }).clientId;

    const issued = await alternate(
      `/v1/operator/clients/${ids.clientId}/credentials`,
      json(operatorToken),
    );
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const credential = issued.body as {
      credentialId: string;
      token: string;
      displayPrefix: string;
    };
    expect(credential.token).toMatch(/^cgk_/);
    expect(credential.displayPrefix).toBe(credential.token.slice(0, 12));
    clientToken = credential.token;
    ids.credentialId = credential.credentialId;

    const grant = await alternate(
      '/v1/operator/grants',
      json(operatorToken, { clientId: ids.clientId, tenantId: ids.tenantA }),
    );
    expect(grant.status).toBe(200);

    const read = await onBoth(`/v1/operator/clients/${ids.clientId}`, { token: operatorToken });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      clientId: ids.clientId,
      kind: 'client',
      credentials: [{ credentialId: ids.credentialId, displayPrefix: credential.displayPrefix }],
    });
    expect(JSON.stringify(read.body)).not.toMatch(/token/i);
  });

  it('4: the client reads its repository’s status as not_indexed, in the one shape', async () => {
    const status = await onBoth(
      `/v1/tenants/${ids.tenantA}/repositories/${ids.repositoryA}/status`,
      { token: clientToken },
    );
    expect(status.status).toBe(200);
    expect(Object.keys(status.body as object)).toEqual(REPOSITORY_STATUS_KEYS);
    expect(status.body).toEqual({
      tenantId: ids.tenantA,
      repositoryId: ids.repositoryA,
      state: 'not_indexed',
      indexedCommit: null,
      inProgressJob: null,
      lastFailure: null,
      languages: [],
    });
  });

  it('5: the client is refused tenant B, its repository, and an unknown repository', async () => {
    const token = { token: clientToken };
    expect(
      await onBoth(`/v1/tenants/${ids.tenantB}/repositories/${randomUUID()}/status`, token),
    ).toMatchObject(error('permission_denied'));
    expect(
      await onBoth(`/v1/tenants/${ids.tenantB}/repositories/${ids.repositoryB}/status`, token),
    ).toMatchObject(error('permission_denied'));
    expect(
      await onBoth(`/v1/tenants/${ids.tenantA}/repositories/${randomUUID()}/status`, token),
    ).toMatchObject(error('repository_not_found'));
  });

  it('6: no token and a made-up one are 401; the client on an operator call is 403, and nothing is created', async () => {
    const path = `/v1/tenants/${ids.tenantA}/repositories/${ids.repositoryA}/status`;
    expect(await onBoth(path)).toMatchObject(error('unauthenticated'));
    const madeUp = `cgk_${randomBytes(32).toString('base64url')}`;
    expect(await onBoth(path, { token: madeUp })).toMatchObject(error('unauthenticated'));

    const tenants = async () =>
      await withClient(
        db.ownerUrl,
        async (c) =>
          (await queryRows<{ n: number }>(c, 'SELECT count(*)::int AS n FROM codegraph.tenants'))[0]
            ?.n,
      );
    const before = await tenants();
    expect(
      await alternate('/v1/operator/tenants', json(clientToken, { displayName: 'Sneaky' })),
    ).toMatchObject(error('permission_denied'));
    expect(await tenants()).toBe(before);
  });

  it('7: a grant revoked through copy A refuses the client on copy B, with no restart', async () => {
    const revoked = await on(
      'A',
      '/v1/operator/grants/revoke',
      json(operatorToken, { clientId: ids.clientId, tenantId: ids.tenantA }),
    );
    expect(revoked).toMatchObject({ status: 200, body: { revoked: true } });
    expect(
      await on('B', `/v1/tenants/${ids.tenantA}/repositories/${ids.repositoryA}/status`, {
        token: clientToken,
      }),
    ).toMatchObject(error('permission_denied'));
  });

  it('8: re-granted, the client deletes its repository once; the operator deletes tenant B', async () => {
    const regrant = await on(
      'B',
      '/v1/operator/grants',
      json(operatorToken, { clientId: ids.clientId, tenantId: ids.tenantA }),
    );
    expect(regrant.status).toBe(200);

    const repositoryPath = `/v1/tenants/${ids.tenantA}/repositories/${ids.repositoryA}`;
    const first = await on('A', repositoryPath, { token: clientToken, method: 'DELETE' });
    expect(first.status).toBe(204);
    expect(first.body).toBeNull();
    expect(await on('B', repositoryPath, { token: clientToken, method: 'DELETE' })).toMatchObject(
      error('repository_not_found'),
    );

    expect(
      (await on('A', `/v1/tenants/${ids.tenantB}`, { token: operatorToken, method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect(
      await on('B', `/v1/tenants/${ids.tenantB}`, { token: operatorToken, method: 'DELETE' }),
    ).toMatchObject(error('tenant_not_found'));

    await withClient(db.ownerUrl, async (c) => {
      const count = async (sql: string, params: unknown[]) =>
        (await queryRows<{ n: number }>(c, sql, params))[0]?.n;
      expect(
        await count('SELECT count(*)::int AS n FROM codegraph.repositories WHERE id = $1', [
          ids.repositoryA,
        ]),
      ).toBe(0);
      expect(
        await count('SELECT count(*)::int AS n FROM codegraph.repositories WHERE tenant_id = $1', [
          ids.tenantB,
        ]),
      ).toBe(0);
      expect(
        await count('SELECT count(*)::int AS n FROM codegraph.grants WHERE tenant_id = $1', [
          ids.tenantB,
        ]),
      ).toBe(0);
      expect(
        await count('SELECT count(*)::int AS n FROM codegraph.tenants WHERE id = $1', [
          ids.tenantB,
        ]),
      ).toBe(0);
      expect(
        await count('SELECT count(*)::int AS n FROM codegraph.clients WHERE id = $1', [
          ids.clientId,
        ]),
      ).toBe(1);
      expect(
        await count(
          'SELECT count(*)::int AS n FROM codegraph.credentials WHERE id = $1 AND revoked_at IS NULL',
          [ids.credentialId],
        ),
      ).toBe(1);
    });
  });

  it('never shows the client’s token again after the answer that issued it', () => {
    const issuedAt = answers.findIndex(({ path }) => path.endsWith('/credentials'));
    expect(issuedAt).toBeGreaterThanOrEqual(0);
    for (const { path, answer } of answers.slice(issuedAt + 1)) {
      expect(JSON.stringify(answer.body), path).not.toContain(clientToken);
    }
  });

  it('observed only error codes the contract and the code map list', () => {
    expect(observedCodes.size).toBeGreaterThan(0);
    const documented = documentedErrorCodes();
    for (const code of observedCodes) {
      expect(documented, code).toHaveProperty(code);
      expect(ERROR_STATUS).toHaveProperty(code);
    }
  });

  it('9: a running copy’s /health turns 503 within 10 seconds once its database is gone', async () => {
    copyC = await startServerProcess(db.appUrl);
    expect((await call(copyC.baseUrl, '/health')).status).toBe(200);
    await db.drop();
    const down = await waitForHealth(copyC.baseUrl, 503, 10_000);
    expect(down.body).toMatchObject({ status: 'unavailable', database: { up: false } });
  }, 60_000);
});
