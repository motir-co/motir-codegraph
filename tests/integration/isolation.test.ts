import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLayerSettings } from '../../src/config.js';
import { findNearestPublishedAncestor } from '../../src/db/layers.js';
import { storeBlob } from '../../src/indexing/storeBlob.js';
import { openLayer } from '../../src/layers/openLayer.js';
import { publishLayer } from '../../src/layers/publish.js';
import { resolveCommit, ResolutionRefusedError } from '../../src/layers/resolution.js';
import { queryRows, sqlState, withClient } from '../helpers/db.js';
import { asOperator, inBoundTransaction, type Binding } from '../helpers/tenancy.js';
import { foundation, type Foundation } from './foundation.fixture.js';

const RLS_VIOLATION = '42501';
const insertLog =
  'INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, $4)';

const SAMPLE = new URL('../../fixtures/sample-tree/languages/', import.meta.url);
const SHARED = readFileSync(new URL('typescript/shapes.ts', SAMPLE));
const ONLY_A = readFileSync(new URL('python/shapes.py', SAMPLE));
const ONLY_B = readFileSync(new URL('go/shapes.go', SAMPLE));

function gitBlobHash(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

/** The blob tables' rows, keyed and ordered so two reads compare exactly. */
const BLOB_READS = {
  blobs:
    'SELECT tenant_id, git_blob_hash, outcome FROM codegraph.blob ORDER BY tenant_id, git_blob_hash',
  contents:
    'SELECT tenant_id, git_blob_hash, md5(contents) AS digest FROM codegraph.blob_contents ORDER BY tenant_id, git_blob_hash',
  facts:
    'SELECT tenant_id, git_blob_hash, count(*)::int AS n FROM codegraph.blob_fact GROUP BY 1, 2 ORDER BY 1, 2',
} as const;

// A fresh foundation per test: the revoke cases change grants and credentials.
// Both tenants hold stored blobs, one hash in both, stored through the shipped
// entry point; B's by a second client granted B only, so the reader stays
// ungranted on B.
let f: Foundation;
beforeEach(async () => {
  f = await foundation();
  const writerB = (await asOperator<string>(
    f.db.appUrl,
    f.fx.operatorId,
    'codegraph.codegraph_create_client($1, $2)',
    ['writer-b', 'client'],
  )) as string;
  await asOperator(f.db.appUrl, f.fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
    writerB,
    f.fx.tenantB.id,
  ]);
  await withClient(f.db.appUrl, async (c) => {
    const stored: [string, string, Buffer][] = [
      [f.fx.tenantA.id, f.fx.readerId, SHARED],
      [f.fx.tenantA.id, f.fx.readerId, ONLY_A],
      [f.fx.tenantB.id, writerB, SHARED],
      [f.fx.tenantB.id, writerB, ONLY_B],
    ];
    for (const [tenantId, clientId, bytes] of stored) {
      const path = bytes === ONLY_A ? 'shapes.py' : bytes === ONLY_B ? 'shapes.go' : 'shapes.ts';
      await storeBlob(c, { tenantId, clientId, gitBlobHash: gitBlobHash(bytes), path, bytes });
    }
  });
});
afterEach(async () => {
  await f.db.drop();
});

async function visible(c: pg.Client) {
  return {
    tenants: await queryRows(c, 'SELECT id, display_name FROM codegraph.tenants ORDER BY id'),
    repositories: await queryRows(
      c,
      'SELECT id, tenant_id, display_name FROM codegraph.repositories ORDER BY id',
    ),
    blobs: await queryRows(c, BLOB_READS.blobs),
    contents: await queryRows(c, BLOB_READS.contents),
    facts: await queryRows(c, BLOB_READS.facts),
  };
}

const NOTHING = { tenants: [], repositories: [], blobs: [], contents: [], facts: [] };

/** One tenant's blob rows as the owner reads them, for the bound view to equal. */
async function blobRowsOf(tenantId: string) {
  return await withClient(f.db.ownerUrl, async (c) => {
    const only = async (sql: string) =>
      (await queryRows<{ tenant_id: string }>(c, sql)).filter((r) => r.tenant_id === tenantId);
    return {
      blobs: await only(BLOB_READS.blobs),
      contents: await only(BLOB_READS.contents),
      facts: await only(BLOB_READS.facts),
    };
  });
}

/** The whole tenant-owned population, read as the owner. */
async function population() {
  return await withClient(f.db.ownerUrl, async (c) => ({
    ...(await visible(c)),
    log: await queryRows(
      c,
      'SELECT tenant_id, repository_id, client_id, content_ref FROM codegraph.content_access_log ORDER BY content_ref',
    ),
  }));
}

function allRepositories() {
  return [f.fx.tenantA, f.fx.tenantB].flatMap((t) =>
    t.repositories.map((r) => ({ tenant: t.id, repository: r.id })),
  );
}

/** Every write the app login may attempt, each of which must touch nothing. */
async function attemptEveryWrite(c: pg.Client) {
  const shared = gitBlobHash(SHARED);
  for (const tenant of [f.fx.tenantA, f.fx.tenantB]) {
    const fresh = gitBlobHash(Buffer.from(`refused ${tenant.id}`));
    expect(
      await sqlState(
        c,
        `INSERT INTO codegraph.blob (tenant_id, git_blob_hash, size_bytes, outcome) VALUES ($1, $2, 1, 'binary')`,
        [tenant.id, fresh],
      ),
    ).toBe(RLS_VIOLATION);
    expect(
      await sqlState(
        c,
        'INSERT INTO codegraph.blob_contents (tenant_id, git_blob_hash, contents) VALUES ($1, $2, $3)',
        [tenant.id, shared, 'x'],
      ),
    ).toBe(RLS_VIOLATION);
    expect(
      await sqlState(
        c,
        `INSERT INTO codegraph.blob_fact (tenant_id, git_blob_hash, kind, language, producer, extractor_version, name, parent_name, relation)
         VALUES ($1, $2, 'inheritance', 'typescript', 'tree-sitter', 'v', 'A', 'B', 'extends')`,
        [tenant.id, shared],
      ),
    ).toBe(RLS_VIOLATION);
    const relabel = await c.query(
      "UPDATE codegraph.blob SET language = 'hijacked' WHERE tenant_id = $1",
      [tenant.id],
    );
    expect(relabel.rowCount).toBe(0);
    // No UPDATE is granted on contents or facts at all.
    expect(
      await sqlState(c, "UPDATE codegraph.blob_contents SET contents = 'x' WHERE tenant_id = $1", [
        tenant.id,
      ]),
    ).toBe(RLS_VIOLATION);
    expect(
      await sqlState(c, "UPDATE codegraph.blob_fact SET name = 'x' WHERE tenant_id = $1", [
        tenant.id,
      ]),
    ).toBe(RLS_VIOLATION);
    for (const table of ['blob_fact', 'blob_contents', 'blob']) {
      const remove = await c.query(`DELETE FROM codegraph.${table} WHERE tenant_id = $1`, [
        tenant.id,
      ]);
      expect(remove.rowCount, table).toBe(0);
    }
  }
  for (const { tenant, repository } of allRepositories()) {
    expect(await sqlState(c, insertLog, [tenant, repository, f.fx.readerId, 'refused'])).toBe(
      RLS_VIOLATION,
    );
    const rename = await c.query(
      "UPDATE codegraph.repositories SET display_name = 'hijacked' WHERE id = $1",
      [repository],
    );
    expect(rename.rowCount).toBe(0);
    const remove = await c.query('DELETE FROM codegraph.repositories WHERE id = $1', [repository]);
    expect(remove.rowCount).toBe(0);
  }
  for (const tenant of [f.fx.tenantA, f.fx.tenantB]) {
    const rename = await c.query("UPDATE codegraph.tenants SET display_name = 'x' WHERE id = $1", [
      tenant.id,
    ]);
    expect(rename.rowCount).toBe(0);
    const remove = await c.query('DELETE FROM codegraph.tenants WHERE id = $1', [tenant.id]);
    expect(remove.rowCount).toBe(0);
  }
}

describe('the granted tenant', () => {
  it('reads exactly its rows, renames its repository and appends to its access log', async () => {
    const { tenantA, readerId } = f.fx;
    const [web] = tenantA.repositories;
    if (web === undefined) throw new Error('fixture has no repository');
    const ref = `read-${randomUUID()}`;
    const ownBlobs = await blobRowsOf(tenantA.id);
    expect((await population()).blobs).toHaveLength(4);
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: readerId, tenantId: tenantA.id },
        async () => {
          const view = await visible(c);
          expect(view).toEqual({
            tenants: [{ id: tenantA.id, display_name: tenantA.name }],
            repositories: tenantA.repositories
              .map((r) => ({ id: r.id, tenant_id: tenantA.id, display_name: r.name }))
              .sort((x, y) => x.id.localeCompare(y.id)),
            ...ownBlobs,
          });
          // The shared hash is two rows in truth and one in this view.
          expect(view.blobs).toHaveLength(2);
          const rename = await c.query(
            "UPDATE codegraph.repositories SET display_name = 'acme-web-renamed' WHERE id = $1",
            [web.id],
          );
          expect(rename.rowCount).toBe(1);
          await c.query(insertLog, [tenantA.id, web.id, readerId, ref]);
        },
        { commit: true },
      ),
    );
    const after = await population();
    expect(after.log).toContainEqual({
      tenant_id: tenantA.id,
      repository_id: web.id,
      client_id: readerId,
      content_ref: ref,
    });
    expect(after.repositories).toContainEqual({
      id: web.id,
      tenant_id: tenantA.id,
      display_name: 'acme-web-renamed',
    });
  });

  it('cannot append a log row naming the other tenant and its repository', async () => {
    const [core] = f.fx.tenantB.repositories;
    if (core === undefined) throw new Error('fixture has no repository');
    const before = await population();
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: f.fx.readerId, tenantId: f.fx.tenantA.id }, async () => {
        expect(await sqlState(c, insertLog, [f.fx.tenantB.id, core.id, f.fx.readerId, 'x'])).toBe(
          RLS_VIOLATION,
        );
      }),
    );
    expect(await population()).toEqual(before);
  });
});

describe.each<[string, (fx: Foundation['fx']) => Binding]>([
  ['the ungranted tenant', (fx) => ({ clientId: fx.readerId, tenantId: fx.tenantB.id })],
  ['no setting', () => ({})],
  ['a malformed tenant', (fx) => ({ clientId: fx.readerId, tenantId: `${fx.tenantA.id}'--` })],
])('a session bound to %s', (_label, binding) => {
  it('reads nothing of either tenant, and every write is refused or affects zero rows', async () => {
    const before = await population();
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(
        c,
        binding(f.fx),
        async () => {
          expect(await visible(c)).toEqual(NOTHING);
          await attemptEveryWrite(c);
        },
        { commit: true },
      ),
    );
    expect(await population()).toEqual(before);
  });
});

describe('revocation', () => {
  it('a revoked grant shuts the next transaction out, with no change to the session code', async () => {
    const { tenantA, readerId, operatorId } = f.fx;
    const session = async (c: pg.Client) =>
      inBoundTransaction(c, { clientId: readerId, tenantId: tenantA.id }, () => visible(c));
    await withClient(f.db.appUrl, async (c) => {
      expect((await session(c)).repositories).toHaveLength(2);
      await inBoundTransaction(
        c,
        { clientId: operatorId },
        async () => {
          await c.query('SELECT codegraph.codegraph_revoke_access($1, $2)', [readerId, tenantA.id]);
        },
        { commit: true },
      );
      expect(await session(c)).toEqual(NOTHING);
      const before = await population();
      await inBoundTransaction(
        c,
        { clientId: readerId, tenantId: tenantA.id },
        async () => {
          await attemptEveryWrite(c);
        },
        { commit: true },
      );
      expect(await population()).toEqual(before);
    });
  });

  it('codegraph_authenticate answers the issued credential, and not once it is revoked', async () => {
    const { readerHash, readerId, tenantA, operatorId } = f.fx;
    const authenticate = () =>
      withClient(f.db.appUrl, (c) =>
        queryRows(
          c,
          'SELECT client_id, client_kind, tenant_ids::text[] AS tenant_ids FROM codegraph.codegraph_authenticate($1)',
          [readerHash],
        ),
      );
    expect(await authenticate()).toEqual([
      { client_id: readerId, client_kind: 'client', tenant_ids: [tenantA.id] },
    ]);
    const credentialId = await withClient(f.db.ownerUrl, async (c) => {
      const rows = await queryRows<{ id: string }>(
        c,
        'SELECT id FROM codegraph.credentials WHERE token_hash = $1',
        [readerHash],
      );
      return rows[0]?.id;
    });
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: operatorId },
        async () => {
          await c.query('SELECT codegraph.codegraph_revoke_credential($1)', [credentialId]);
        },
        { commit: true },
      ),
    );
    expect(await authenticate()).toEqual([]);
  });
});

describe('commit layers: a session bound to A resolves no commit of B', () => {
  it('refuses to resolve B’s commit, finds no ancestor among B’s commits, and changes none of B’s layer rows', async () => {
    const [repoB] = f.fx.tenantB.repositories;
    if (repoB === undefined) throw new Error('fixture has no repository in B');
    const scopeB = { tenantId: f.fx.tenantB.id, repositoryId: repoB.id };
    const writerB = (await asOperator<string>(
      f.db.appUrl,
      f.fx.operatorId,
      'codegraph.codegraph_create_client($1, $2)',
      ['layer-writer-b', 'client'],
    )) as string;
    await asOperator(f.db.appUrl, f.fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
      writerB,
      f.fx.tenantB.id,
    ]);

    // B's commit, indexed through the library over the blobs B already stores.
    const sha = createHash('sha1').update('globex commit').digest('hex');
    const pool = new pg.Pool({ connectionString: f.db.appUrl, max: 2 });
    try {
      const opened = await openLayer(pool, {
        clientId: writerB,
        ...scopeB,
        commitSha: sha,
        refName: 'refs/heads/main',
        isDefaultBranch: true,
        candidateAncestors: [],
        paths: new Map([
          ['shapes.ts', gitBlobHash(SHARED)],
          ['shapes.go', gitBlobHash(ONLY_B)],
        ]),
        settings: readLayerSettings({}),
      });
      await publishLayer(pool, {
        clientId: writerB,
        ...scopeB,
        layerId: opened.layerId,
        ref: { name: 'refs/heads/main', isDefaultBranch: true },
      });
    } finally {
      await pool.end();
    }

    const layerRowsOfB = () =>
      withClient(f.db.ownerUrl, async (c) => ({
        layers: await queryRows(c, 'SELECT * FROM codegraph.commit_layers WHERE tenant_id = $1', [
          scopeB.tenantId,
        ]),
        paths: await queryRows(
          c,
          'SELECT * FROM codegraph.layer_paths WHERE tenant_id = $1 ORDER BY path',
          [scopeB.tenantId],
        ),
        heads: await queryRows(c, 'SELECT * FROM codegraph.ref_heads WHERE tenant_id = $1', [
          scopeB.tenantId,
        ]),
      }));
    const before = await layerRowsOfB();
    expect(before.layers).toHaveLength(1);
    expect(before.paths).toHaveLength(2);

    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: f.fx.readerId, tenantId: f.fx.tenantA.id }, async () => {
        const refusal = resolveCommit(c, scopeB.tenantId, scopeB.repositoryId, sha);
        await expect(refusal).rejects.toBeInstanceOf(ResolutionRefusedError);
        await expect(refusal).rejects.toMatchObject({ reason: 'tenant_not_bound' });
      }),
    );
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: f.fx.readerId, tenantId: f.fx.tenantA.id },
        async () => {
          expect(await findNearestPublishedAncestor(c, scopeB, [sha])).toBeNull();
          const writes = [
            'UPDATE codegraph.commit_layers SET superseded_at = now() WHERE tenant_id = $1',
            "UPDATE codegraph.ref_heads SET commit_sha = repeat('0', 40) WHERE tenant_id = $1",
            'DELETE FROM codegraph.layer_paths WHERE tenant_id = $1',
            'DELETE FROM codegraph.commit_layers WHERE tenant_id = $1',
          ];
          for (const sql of writes) {
            expect((await c.query(sql, [scopeB.tenantId])).rowCount).toBe(0);
          }
        },
        { commit: true },
      ),
    );
    expect(await layerRowsOfB()).toEqual(before);
  });
});
