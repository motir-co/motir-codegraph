import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appendLayerPaths,
  insertLayer,
  markPublished,
  markSuperseded,
  type LayerRow,
  type LayerScope,
  type PathEntry,
} from '../../src/db/layers.js';
import {
  resolveCommit,
  RESOLVE_COMMIT_SQL,
  ResolutionRefusedError,
  type Resolution,
} from '../../src/layers/resolution.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, withClient, type FreshDatabase } from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;
let pool: pg.Pool;
let log: QueryLog;
let web: LayerScope;
let globex: LayerScope;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  log = recordQueries(pool);
  const [a1] = fx.tenantA.repositories;
  const [b1] = fx.tenantB.repositories;
  if (a1 === undefined || b1 === undefined) throw new Error('fixture');
  web = { tenantId: fx.tenantA.id, repositoryId: a1.id };
  globex = { tenantId: fx.tenantB.id, repositoryId: b1.id };
  // The operator is granted tenant B so B's rows can be written as the app.
  await withClient(db.ownerUrl, (c) =>
    c.query('INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
      fx.operatorId,
      fx.tenantB.id,
    ]),
  );
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

function sha(): string {
  return randomBytes(20).toString('hex');
}

function clientFor(tenantId: string): string {
  return tenantId === fx.tenantA.id ? fx.readerId : fx.operatorId;
}

/** Runs `fn` in a transaction on a pooled app connection bound to `tenantId`. */
async function bound<T>(
  tenantId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
  options: { commit?: boolean } = {},
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId !== null) {
      await c.query(BIND_TENANT_SQL, [clientFor(tenantId), tenantId]);
    }
    try {
      const result = await fn(c);
      await c.query(options.commit === true ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  } finally {
    c.release();
  }
}

/** Opens a layer over `parent` (a base when null), appends `paths`, publishes, commits. */
async function publish(
  scope: LayerScope,
  parent: string | null,
  paths: PathEntry[],
  commitSha = sha(),
): Promise<LayerRow> {
  return bound(
    scope.tenantId,
    async (c) => {
      const layer =
        parent === null
          ? await insertLayer(c, { ...scope, commitSha, kind: 'base' })
          : await insertLayer(c, { ...scope, commitSha, kind: 'delta', parentLayerId: parent });
      await appendLayerPaths(c, scope, layer.id, paths);
      return markPublished(c, scope, layer.id);
    },
    { commit: true },
  );
}

function resolve(scope: LayerScope, commitSha: string): Promise<Resolution> {
  return bound(scope.tenantId, (c) =>
    resolveCommit(c, scope.tenantId, scope.repositoryId, commitSha),
  );
}

function mapOf(resolution: Resolution): Map<string, string> {
  if (resolution.state !== 'indexed') throw new Error(`not indexed`);
  return resolution.paths;
}

const blob = (n: number): string => n.toString(16).padStart(40, '0');

/** base ← d1 ← d2, carrying a base-only, a once-changed, a twice-changed and a tombstoned path. */
async function threeLayerChain(scope: LayerScope): Promise<{
  base: LayerRow;
  d1: LayerRow;
  d2: LayerRow;
}> {
  const base = await publish(scope, null, [
    { path: 'README.md', gitBlobHash: blob(1) },
    { path: 'src/once.ts', gitBlobHash: blob(2) },
    { path: 'src/twice.ts', gitBlobHash: blob(3) },
    { path: 'src/gone.ts', gitBlobHash: blob(4) },
  ]);
  const d1 = await publish(scope, base.id, [
    { path: 'src/once.ts', gitBlobHash: blob(12) },
    { path: 'src/twice.ts', gitBlobHash: blob(13) },
    { path: 'src/gone.ts', gitBlobHash: blob(14) },
  ]);
  const d2 = await publish(scope, d1.id, [
    { path: 'src/twice.ts', gitBlobHash: blob(23) },
    { path: 'src/gone.ts', gitBlobHash: null },
    { path: 'src/new.ts', gitBlobHash: blob(25) },
  ]);
  return { base, d1, d2 };
}

describe('resolveCommit', () => {
  it('answers the nearest entry per path, drops tombstones, and not-indexed for an unknown commit', async () => {
    const { d2, d1, base } = await threeLayerChain(web);
    const at = await resolve(web, d2.commitSha);
    expect(at).toEqual({
      state: 'indexed',
      layerId: d2.id,
      paths: new Map([
        ['README.md', blob(1)],
        ['src/new.ts', blob(25)],
        ['src/once.ts', blob(12)],
        ['src/twice.ts', blob(23)],
      ]),
    });
    expect(mapOf(await resolve(web, d1.commitSha)).get('src/gone.ts')).toBe(blob(14));
    expect(mapOf(await resolve(web, base.commitSha)).get('src/twice.ts')).toBe(blob(3));
    expect(await resolve(web, sha())).toEqual({ state: 'not_indexed' });
  });

  it('resolves a compacted commit through its current layer only, never the retired one', async () => {
    const commitSha = sha();
    const retired = await publish(
      web,
      null,
      [
        { path: 'a', gitBlobHash: blob(1) },
        { path: 'b', gitBlobHash: blob(2) },
      ],
      commitSha,
    );
    const current = await bound(
      web.tenantId,
      async (c) => {
        await markSuperseded(c, web, retired.id);
        const layer = await insertLayer(c, { ...web, commitSha, kind: 'base' });
        await appendLayerPaths(c, web, layer.id, [{ path: 'a', gitBlobHash: blob(9) }]);
        return markPublished(c, web, layer.id);
      },
      { commit: true },
    );
    expect(await resolve(web, commitSha)).toEqual({
      state: 'indexed',
      layerId: current.id,
      paths: new Map([['a', blob(9)]]),
    });
  });

  it('issues exactly one statement, the same text at depth 0 and at depth 31, with no transaction control or lock', async () => {
    const shallow = await publish(web, null, [{ path: 'x', gitBlobHash: blob(1) }]);
    let top = await publish(web, null, [{ path: 'p0', gitBlobHash: blob(100) }]);
    for (let i = 1; i < 32; i++) {
      top = await publish(web, top.id, [{ path: `p${String(i)}`, gitBlobHash: blob(100 + i) }]);
    }
    expect(top.depth).toBe(31);
    expect(top.chain).toHaveLength(32);

    const texts: string[][] = [];
    for (const layer of [shallow, top]) {
      const answer = await bound(web.tenantId, async (c) => {
        log.clear();
        const result = await resolveCommit(c, web.tenantId, web.repositoryId, layer.commitSha);
        texts.push(log.texts());
        return result;
      });
      expect(answer.state).toBe('indexed');
    }
    expect(texts).toEqual([[RESOLVE_COMMIT_SQL], [RESOLVE_COMMIT_SQL]]);
    expect(RESOLVE_COMMIT_SQL).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|advisory)\b/i);
    expect(RESOLVE_COMMIT_SQL).not.toMatch(/RECURSIVE/i);
    expect(mapOf(await resolve(web, top.commitSha)).size).toBe(32);
  });

  it('keeps not-indexed and an empty tree apart, and errors on neither', async () => {
    const base = await publish(web, null, [{ path: 'only', gitBlobHash: blob(1) }]);
    const emptied = await publish(web, base.id, [{ path: 'only', gitBlobHash: null }]);
    expect(await resolve(web, emptied.commitSha)).toEqual({
      state: 'indexed',
      layerId: emptied.id,
      paths: new Map(),
    });
    const empty = await publish(web, null, []);
    expect(await resolve(web, empty.commitSha)).toEqual({
      state: 'indexed',
      layerId: empty.id,
      paths: new Map(),
    });
    expect(await resolve(web, sha())).toEqual({ state: 'not_indexed' });
  });

  it('never reads a staged layer for the same commit', async () => {
    const base = await publish(web, null, [{ path: 'kept', gitBlobHash: blob(1) }]);
    const before = await resolve(web, base.commitSha);
    // A staged layer cannot share a commit with a current one through the
    // writer, so it is staged as a re-index of the commit: retire nothing, and
    // write a staged base for the same sha with different paths.
    await bound(
      web.tenantId,
      async (c) => {
        const staged = await insertLayer(c, { ...web, commitSha: base.commitSha, kind: 'base' });
        await appendLayerPaths(c, web, staged.id, [
          { path: 'kept', gitBlobHash: blob(7) },
          { path: 'other', gitBlobHash: blob(8) },
        ]);
      },
      { commit: true },
    );
    expect(await resolve(web, base.commitSha)).toEqual(before);
    // A commit whose only layer is staged is not indexed.
    const stagedOnly = sha();
    await bound(
      web.tenantId,
      async (c) => {
        const staged = await insertLayer(c, { ...web, commitSha: stagedOnly, kind: 'base' });
        await appendLayerPaths(c, web, staged.id, [{ path: 'a', gitBlobHash: blob(1) }]);
      },
      { commit: true },
    );
    expect(await resolve(web, stagedOnly)).toEqual({ state: 'not_indexed' });
  });

  it('refuses a session bound to another tenant or to none, and serves the owner either tenant', async () => {
    const ours = await publish(web, null, [{ path: 'a', gitBlobHash: blob(1) }]);
    const theirs = await publish(globex, null, [{ path: 'b', gitBlobHash: blob(2) }]);

    const mismatch = bound(web.tenantId, (c) =>
      resolveCommit(c, globex.tenantId, globex.repositoryId, theirs.commitSha),
    );
    await expect(mismatch).rejects.toBeInstanceOf(ResolutionRefusedError);
    await expect(mismatch).rejects.toMatchObject({ reason: 'tenant_not_bound' });

    await expect(
      bound(null, (c) => resolveCommit(c, web.tenantId, web.repositoryId, ours.commitSha)),
    ).rejects.toMatchObject({ reason: 'tenant_not_bound' });

    // A client with no grant on the tenant it binds is refused the same way.
    await expect(
      (async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(BIND_TENANT_SQL, [fx.readerId, fx.tenantB.id]);
          return await resolveCommit(c, globex.tenantId, globex.repositoryId, theirs.commitSha);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      })(),
    ).rejects.toMatchObject({ reason: 'tenant_not_bound' });

    expect(mapOf(await resolve(web, ours.commitSha))).toEqual(new Map([['a', blob(1)]]));

    await withClient(db.ownerUrl, async (c) => {
      expect(mapOf(await resolveCommit(c, web.tenantId, web.repositoryId, ours.commitSha))).toEqual(
        new Map([['a', blob(1)]]),
      );
      expect(
        mapOf(await resolveCommit(c, globex.tenantId, globex.repositoryId, theirs.commitSha)),
      ).toEqual(new Map([['b', blob(2)]]));
    });
  });

  it('refuses a chain that names a missing layer row, with no partial map', async () => {
    const { d2 } = await threeLayerChain(web);
    // The writer cannot produce this; the owner breaks the chain's third
    // member (the shape check pins only self and parent).
    await withClient(db.ownerUrl, (c) =>
      c.query('UPDATE codegraph.commit_layers SET chain[3] = gen_random_uuid() WHERE id = $1', [
        d2.id,
      ]),
    );
    const refused = resolve(web, d2.commitSha);
    await expect(refused).rejects.toBeInstanceOf(ResolutionRefusedError);
    await expect(refused).rejects.toMatchObject({ reason: 'chain_incomplete' });
  });

  it('answers a fresh, path-ordered ES Map that carries prototype-named paths', async () => {
    const layer = await publish(web, null, [
      { path: 'zeta', gitBlobHash: blob(1) },
      { path: '__proto__', gitBlobHash: blob(2) },
      { path: 'constructor', gitBlobHash: blob(3) },
      { path: 'alpha', gitBlobHash: blob(4) },
    ]);
    const first = mapOf(await resolve(web, layer.commitSha));
    const second = mapOf(await resolve(web, layer.commitSha));
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first.get('__proto__')).toBe(blob(2));
    expect(first.get('constructor')).toBe(blob(3));
    expect(first.size).toBe(4);
    const order = await withClient(db.ownerUrl, async (c) =>
      (
        await c.query<{ path: string }>(
          'SELECT path FROM unnest($1::text[]) AS path ORDER BY path',
          [[...first.keys()]],
        )
      ).rows.map((r) => r.path),
    );
    expect([...first.keys()]).toEqual(order);
    first.delete('zeta');
    expect(mapOf(await resolve(web, layer.commitSha)).has('zeta')).toBe(true);
    expect(second.has('zeta')).toBe(true);
  });
});
