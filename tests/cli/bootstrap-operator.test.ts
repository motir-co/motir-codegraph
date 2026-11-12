import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashToken } from '../../src/server/auth.js';
import { mintToken } from '../../src/server/tokens.js';
import {
  bootstrapOperator,
  InvalidOperatorTokenError,
  OperatorExistsError,
} from '../../src/db/operator.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { call, startServer } from '../helpers/server.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

/**
 * `pnpm operator:bootstrap`, run as the script runs it, with this database's
 * owner URL, and OPERATOR_TOKEN set to `operatorToken` when one is given (and
 * unset otherwise, whatever the test process holds).
 */
async function bootstrapCommand(ownerUrl: string, operatorToken?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: ownerUrl };
  delete env.OPERATOR_TOKEN;
  if (operatorToken !== undefined) env.OPERATOR_TOKEN = operatorToken;
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', 'src/cli/bootstrap-operator.ts'],
      { cwd: ROOT, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

/** Every credential row, as the owner reads it. */
async function credentials(ownerUrl: string) {
  return await withClient(ownerUrl, (c) =>
    queryRows<{ client_id: string; token_hash: Buffer; display_prefix: string }>(
      c,
      'SELECT client_id, token_hash, display_prefix FROM codegraph.credentials ORDER BY id',
    ),
  );
}

async function operators(ownerUrl: string) {
  return await withClient(ownerUrl, (c) =>
    queryRows<{ id: string; credentials: number }>(
      c,
      `SELECT c.id, (SELECT count(*)::int FROM codegraph.credentials cr WHERE cr.client_id = c.id) AS credentials
         FROM codegraph.clients c WHERE c.kind = 'operator'`,
    ),
  );
}

describe('pnpm operator:bootstrap', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('creates one operator on an empty database and prints only its token', async () => {
    const first = await bootstrapCommand(db.ownerUrl);
    expect(first.code).toBe(0);
    const lines = first.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    const [token] = lines as [string];
    expect(token).toMatch(/^cgk_[A-Za-z0-9_-]{43}$/);
    expect(first.stderr).toContain('created operator client');
    expect(first.stderr).not.toContain(token);
    expect(await operators(db.ownerUrl)).toEqual([
      { id: expect.any(String) as string, credentials: 1 },
    ]);

    const server = await startServer(db.appUrl);
    try {
      const created = await call(server.baseUrl, '/v1/operator/tenants', {
        method: 'POST',
        token,
        body: { displayName: 'First tenant' },
      });
      expect(created.status).toBe(201);
    } finally {
      await server.stop();
    }

    const second = await bootstrapCommand(db.ownerUrl);
    expect(second.code).toBe(1);
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain('1 operator client already exists');
    expect(await operators(db.ownerUrl)).toHaveLength(1);
  });
});

describe('pnpm operator:bootstrap with OPERATOR_TOKEN (MOTIR-11103)', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('refuses a token without the cgk_ prefix and creates nothing', async () => {
    const refused = await bootstrapCommand(db.ownerUrl, 'not-a-codegraph-token-at-all');
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('OPERATOR_TOKEN is not a cgk_ token');
    expect(refused.stderr).not.toContain('not-a-codegraph-token-at-all');
    expect(await operators(db.ownerUrl)).toEqual([]);
  });

  it('registers the token on an empty database, printing nothing on stdout', async () => {
    const { token } = mintToken();
    const first = await bootstrapCommand(db.ownerUrl, token);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('');
    expect(first.stderr).toContain('from OPERATOR_TOKEN');
    expect(first.stderr).not.toContain(token);
    const [operator] = await operators(db.ownerUrl);
    expect(operator?.credentials).toBe(1);
    const stored = await credentials(db.ownerUrl);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash.equals(hashToken(token))).toBe(true);
    expect(stored[0]?.display_prefix).toBe(token.slice(0, 12));

    // The token it was given now authenticates as the operator.
    const server = await startServer(db.appUrl);
    try {
      const created = await call(server.baseUrl, '/v1/operator/tenants', {
        method: 'POST',
        token,
        body: { displayName: 'From the deploy' },
      });
      expect(created.status).toBe(201);
    } finally {
      await server.stop();
    }
  });

  it('exits 0 and changes no row when an operator already exists', async () => {
    const before = {
      operators: await operators(db.ownerUrl),
      credentials: await credentials(db.ownerUrl),
    };
    const again = await bootstrapCommand(db.ownerUrl, mintToken().token);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('');
    expect(again.stderr).toContain('1 operator client already exists');
    expect(again.stderr).toContain('nothing changed');
    expect({
      operators: await operators(db.ownerUrl),
      credentials: await credentials(db.ownerUrl),
    }).toEqual(before);
  });

  it('treats an empty OPERATOR_TOKEN as unset: mints, prints, and exits 1 once an operator exists', async () => {
    const empty = await bootstrapCommand(db.ownerUrl, '');
    expect(empty.code).toBe(1);
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toContain('1 operator client already exists');
  });
});

describe('bootstrapOperator', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('refuses a login other than the owner', async () => {
    await expect(bootstrapOperator({ ownerUrl: db.appUrl })).rejects.toThrow(
      'DATABASE_URL must connect as codegraph_owner, not codegraph_app.',
    );
  });

  it('creates one operator when two runs race, and names how many exist', async () => {
    const results = await Promise.allSettled([
      bootstrapOperator({ ownerUrl: db.ownerUrl, name: 'racer one' }),
      bootstrapOperator({ ownerUrl: db.ownerUrl, name: 'racer two' }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const refused = results.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(OperatorExistsError);
    expect((refused.reason as OperatorExistsError).operators).toBe(1);
    expect(await operators(db.ownerUrl)).toHaveLength(1);
  });

  it('refuses a token that is not a cgk_ token before it connects', async () => {
    for (const token of ['abc_0123456789abcdef', 'cgk_', 'cgk_short']) {
      await expect(bootstrapOperator({ ownerUrl: 'not a url', token })).rejects.toBeInstanceOf(
        InvalidOperatorTokenError,
      );
    }
  });

  it('pluralises the refusal when several operators exist', () => {
    expect(new OperatorExistsError(2).message).toMatch(/^2 operator clients already exist;/);
  });
});

describe('bootstrapOperator with no name', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('names the operator "bootstrap operator"', async () => {
    const created = await bootstrapOperator({ ownerUrl: db.ownerUrl });
    const rows = await withClient(db.ownerUrl, (c) =>
      queryRows<{ name: string }>(c, 'SELECT name FROM codegraph.clients WHERE id = $1', [
        created.clientId,
      ]),
    );
    expect(rows).toEqual([{ name: 'bootstrap operator' }]);
  });
});

describe('bootstrapOperator with a token', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('stores the hash and display prefix of the token it was given, and returns it', async () => {
    const { token } = mintToken();
    const created = await bootstrapOperator({ ownerUrl: db.ownerUrl, token });
    expect(created.token).toBe(token);
    expect(created.displayPrefix).toBe(token.slice(0, 12));
    const stored = await credentials(db.ownerUrl);
    expect(stored.map((c) => c.client_id)).toEqual([created.clientId]);
    expect(stored[0]?.token_hash.equals(hashToken(token))).toBe(true);
  });
});
