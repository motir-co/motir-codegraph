import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapOperator, OperatorExistsError } from '../../src/db/operator.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { call, startServer } from '../helpers/server.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

/** `pnpm operator:bootstrap`, run as the script runs it, with this database's owner URL. */
async function bootstrapCommand(ownerUrl: string) {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', 'src/cli/bootstrap-operator.ts'],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: ownerUrl } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
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
