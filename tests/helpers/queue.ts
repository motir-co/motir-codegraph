import { randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';

import { BIND_TENANT_SQL } from '../../src/server/binding.js';

/** A tenant, one or more of its repositories, and a client granted the tenant. */
export interface QueueTenant {
  tenantId: string;
  repositoryId: string;
  clientId: string;
  /** Every repository of the tenant, the first being `repositoryId`. */
  repositoryIds: string[];
}

/** A lowercase git object id. */
export function sha(length: 40 | 64 = 40): string {
  return randomBytes(length / 2).toString('hex');
}

/**
 * Writes a tenant, `repositories` repositories and a `client`-kind client
 * holding a live grant on the tenant, as the OWNER (which the owner policy
 * admits), and answers their ids.
 */
export async function queueTenant(owner: pg.ClientBase, repositories = 1): Promise<QueueTenant> {
  const tenantId = randomUUID();
  const clientId = randomUUID();
  await owner.query("INSERT INTO codegraph.tenants (id, display_name) VALUES ($1, 'Queue')", [
    tenantId,
  ]);
  const repositoryIds: string[] = [];
  for (let i = 0; i < repositories; i += 1) {
    const id = randomUUID();
    await owner.query(
      'INSERT INTO codegraph.repositories (id, tenant_id, display_name) VALUES ($1, $2, $3)',
      [id, tenantId, `repo-${String(i)}`],
    );
    repositoryIds.push(id);
  }
  await owner.query("INSERT INTO codegraph.clients (id, name, kind) VALUES ($1, 'q', 'client')", [
    clientId,
  ]);
  await owner.query('INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
    clientId,
    tenantId,
  ]);
  return { tenantId, repositoryId: repositoryIds[0] as string, clientId, repositoryIds };
}

/** Revokes the client's grant on the tenant, as the owner. */
export async function revokeGrant(owner: pg.ClientBase, t: QueueTenant): Promise<void> {
  await owner.query(
    'UPDATE codegraph.grants SET revoked_at = now() WHERE client_id = $1 AND tenant_id = $2',
    [t.clientId, t.tenantId],
  );
}

/** Binds the transaction to the tenant's client and tenant, as the API does. */
export async function bindTo(app: pg.ClientBase, t: QueueTenant): Promise<void> {
  await app.query(BIND_TENANT_SQL, [t.clientId, t.tenantId]);
}

/** The columns a queued request job is inserted with, as the owner writes one. */
export async function ownerQueuedJob(
  owner: pg.ClientBase,
  t: QueueTenant,
  options: {
    repositoryId?: string;
    kind?: string;
    refName?: string;
    enqueuedAt?: string;
  } = {},
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO codegraph.index_jobs
       (tenant_id, repository_id, client_id, kind, commit_sha, ref_name, fetch_url, enqueued_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'https://example.test/src.tar.gz',
             COALESCE($7::timestamptz, now()))
     RETURNING id`,
    [
      t.tenantId,
      options.repositoryId ?? t.repositoryId,
      t.clientId,
      options.kind ?? 'first_index',
      sha(),
      options.refName ?? 'refs/heads/main',
      options.enqueuedAt ?? null,
    ],
  );
  return (rows[0] as { id: string }).id;
}
