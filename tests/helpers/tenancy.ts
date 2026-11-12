import { createHash, randomBytes } from 'node:crypto';

import type pg from 'pg';

import { queryRows, withClient } from './db.js';

/** What a request binds before it touches a tenant-owned table. */
export interface Binding {
  clientId?: string;
  tenantId?: string;
}

/**
 * Opens a transaction, binds `app.client_id` and `app.tenant_id` with
 * `set_config(..., true)` exactly as the API will, runs `fn`, and rolls back
 * unless `commit` is set. An omitted value is left unset.
 */
export async function inBoundTransaction<T>(
  client: pg.Client,
  binding: Binding,
  fn: () => Promise<T>,
  options: { commit?: boolean } = {},
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (binding.clientId !== undefined) {
      await client.query("SELECT set_config('app.client_id', $1, true)", [binding.clientId]);
    }
    if (binding.tenantId !== undefined) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [binding.tenantId]);
    }
    const result = await fn();
    await client.query(options.commit === true ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** A fresh token's SHA-256, the only form the database ever stores. */
export function tokenHash(): Buffer {
  return newToken().hash;
}

/** A fresh raw token and its SHA-256, hashed the way the server hashes one. */
export function newToken(): { token: string; hash: Buffer } {
  const token = `test_${randomBytes(24).toString('base64url')}`;
  return { token, hash: createHash('sha256').update(token, 'utf8').digest() };
}

async function scalar(client: pg.Client, sql: string, params: unknown[]): Promise<string> {
  const rows = await queryRows<{ value: string }>(client, sql, params);
  const value = rows[0]?.value;
  if (value === undefined) {
    throw new Error(`no value from: ${sql}`);
  }
  return value;
}

export interface TenancyFixture {
  operatorId: string;
  readerId: string;
  readerHash: Buffer;
  /** The raw tokens behind the operator's and the reader's credentials. */
  operatorToken: string;
  readerToken: string;
  tenantA: { id: string; name: string; repositories: { id: string; name: string }[] };
  tenantB: { id: string; name: string; repositories: { id: string; name: string }[] };
}

/**
 * Two tenants whose names and repository counts differ, and a `client`-kind
 * reader granted A only, built the way production builds them: the first
 * operator bootstrapped as codegraph_owner, everything else through the
 * operator functions as codegraph_app.
 */
export async function buildTenancyFixture(
  urls: { ownerUrl: string; appUrl: string },
  repositoryNames: { a: string[]; b: string[] } = {
    a: ['acme-web', 'acme-api'],
    b: ['globex-core', 'globex-ui', 'globex-docs'],
  },
): Promise<TenancyFixture> {
  const suffix = randomBytes(3).toString('hex');
  const operator = newToken();
  const reader = newToken();
  const operatorId = await withClient(urls.ownerUrl, (c) =>
    scalar(c, 'SELECT codegraph.codegraph_bootstrap_operator($1, $2, $3) AS value', [
      `operator-${suffix}`,
      operator.hash,
      'cg_op',
    ]),
  );
  return await withClient(urls.appUrl, (c) =>
    inBoundTransaction(
      c,
      { clientId: operatorId },
      async () => {
        const call = (sql: string, params: unknown[]) =>
          scalar(c, `SELECT ${sql} AS value`, params);
        const makeTenant = async (name: string, repositoryNames: string[]) => {
          const id = await call('codegraph.codegraph_create_tenant($1)', [name]);
          const repositories = [];
          for (const repositoryName of repositoryNames) {
            repositories.push({
              id: await call('codegraph.codegraph_register_repository($1, $2)', [
                id,
                repositoryName,
              ]),
              name: repositoryName,
            });
          }
          return { id, name, repositories };
        };
        const tenantA = await makeTenant(`Acme ${suffix}`, repositoryNames.a);
        const tenantB = await makeTenant(`Globex ${suffix}`, repositoryNames.b);
        const readerId = await call('codegraph.codegraph_create_client($1, $2)', [
          `reader-${suffix}`,
          'client',
        ]);
        const readerHash = reader.hash;
        await call('codegraph.codegraph_issue_credential($1, $2, $3)', [
          readerId,
          readerHash,
          'cg_rd',
        ]);
        await call('codegraph.codegraph_grant_access($1, $2)', [readerId, tenantA.id]);
        return {
          operatorId,
          readerId,
          readerHash,
          operatorToken: operator.token,
          readerToken: reader.token,
          tenantA,
          tenantB,
        };
      },
      { commit: true },
    ),
  );
}

/**
 * Runs one operator function as codegraph_app with `operatorId` bound, and
 * commits: the way an operator route will call it.
 */
export async function asOperator<T = unknown>(
  appUrl: string,
  operatorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return await withClient(appUrl, (c) =>
    inBoundTransaction(
      c,
      { clientId: operatorId },
      async () => (await queryRows<{ value: T }>(c, `SELECT ${sql} AS value`, params))[0]?.value,
      { commit: true },
    ),
  );
}
