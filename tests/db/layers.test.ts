import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appendLayerPaths,
  deleteLayerById,
  findNearestPublishedAncestor,
  insertLayer,
  LayerNotPublishedError,
  LayerNotStagedError,
  LayerStillReferencedError,
  listReferencedBlobHashes,
  listRefHeadsNamingLayer,
  listStagedLayersStagedBefore,
  lockTenantExclusive,
  lockTenantShared,
  markPublished,
  markSuperseded,
  moveRefHead,
  ParentNotPublishedError,
  readCurrentPublishedLayer,
  readLayerById,
  readLayerPathsByLayerIds,
  readRefHead,
  UnknownLayerError,
  type LayerRow,
  type LayerScope,
  type PathEntry,
} from '../../src/db/layers.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import {
  freshDatabase,
  INSUFFICIENT_PRIVILEGE,
  queryRows,
  withClient,
  type FreshDatabase,
} from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const LOCK_NOT_AVAILABLE = '55P03';

let db: FreshDatabase;
let fx: TenancyFixture;
let pool: pg.Pool;
let log: QueryLog;
let web: LayerScope;
let api: LayerScope;
let globex: LayerScope;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  log = recordQueries(pool);
  const [a1, a2] = fx.tenantA.repositories;
  const [b1] = fx.tenantB.repositories;
  if (a1 === undefined || a2 === undefined || b1 === undefined) throw new Error('fixture');
  web = { tenantId: fx.tenantA.id, repositoryId: a1.id };
  api = { tenantId: fx.tenantA.id, repositoryId: a2.id };
  globex = { tenantId: fx.tenantB.id, repositoryId: b1.id };
  // Tenant B is reached through the operator, granted B for the cross-tenant rows.
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

/**
 * Runs `fn` on a pooled app connection inside a transaction bound to `tenantId`
 * (by the reader for tenant A, the operator for tenant B), and commits only
 * when asked.
 */
async function bound<T>(
  tenantId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
  options: { commit?: boolean; clientId?: string } = {},
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId !== null) {
      const clientId =
        options.clientId ?? (tenantId === fx.tenantA.id ? fx.readerId : fx.operatorId);
      await c.query(BIND_TENANT_SQL, [clientId, tenantId]);
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

const commit = { commit: true } as const;

/** Opens and publishes a base (optionally with paths), committed. */
async function publishedBase(
  scope: LayerScope,
  commitSha = sha(),
  paths: PathEntry[] = [],
): Promise<LayerRow> {
  return bound(
    scope.tenantId,
    async (c) => {
      const layer = await insertLayer(c, { ...scope, commitSha, kind: 'base' });
      await appendLayerPaths(c, scope, layer.id, paths);
      return markPublished(c, scope, layer.id);
    },
    commit,
  );
}

async function publishedDelta(
  scope: LayerScope,
  parent: string,
  commitSha = sha(),
  paths: PathEntry[] = [],
): Promise<LayerRow> {
  return bound(
    scope.tenantId,
    async (c) => {
      const layer = await insertLayer(c, {
        ...scope,
        commitSha,
        kind: 'delta',
        parentLayerId: parent,
      });
      await appendLayerPaths(c, scope, layer.id, paths);
      return markPublished(c, scope, layer.id);
    },
    commit,
  );
}

async function stagedLayer(scope: LayerScope, commitSha = sha()): Promise<LayerRow> {
  return bound(
    scope.tenantId,
    (c) => insertLayer(c, { ...scope, commitSha, kind: 'base' }),
    commit,
  );
}

/** The statements the pool ran during `fn`, minus the bound transaction's own. */
async function statementsOf(fn: () => Promise<unknown>): Promise<string[]> {
  log.clear();
  await fn();
  return log
    .texts()
    .filter((t) => !['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t) && t !== BIND_TENANT_SQL);
}

describe("the caller's transaction", () => {
  it('opens none of its own: a rollback leaves nothing, and a second connection sees nothing before commit', async () => {
    const commitSha = sha();
    const seen = await bound(fx.tenantA.id, async (c) => {
      const layer = await insertLayer(c, { ...web, commitSha, kind: 'base' });
      await appendLayerPaths(c, web, layer.id, [{ path: 'a.ts', gitBlobHash: sha() }]);
      await markPublished(c, web, layer.id);
      const other = await bound(fx.tenantA.id, async (o) => ({
        layer: await readLayerById(o, web, layer.id),
        paths: await readLayerPathsByLayerIds(o, web, [layer.id]),
      }));
      return { id: layer.id, other };
    });
    expect(seen.other).toEqual({ layer: null, paths: [] });
    await bound(fx.tenantA.id, async (c) => {
      expect(await readLayerById(c, web, seen.id)).toBeNull();
      expect(await readCurrentPublishedLayer(c, web, commitSha)).toBeNull();
    });
  });
});

describe('insertLayer', () => {
  it('mints the id and writes a staged base: no parent, depth 0, a chain of its own id', async () => {
    const commitSha = sha();
    const layer = await stagedLayer(web, commitSha);
    expect(layer).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      tenantId: web.tenantId,
      repositoryId: web.repositoryId,
      commitSha,
      kind: 'base',
      parentLayerId: null,
      depth: 0,
      chain: [layer.id],
      state: 'staged',
      stagedAt: expect.any(Date) as Date,
      publishedAt: null,
      supersededAt: null,
    });
  });

  it('composes a delta: its own id then the parent chain, at the parent depth plus one', async () => {
    const base = await publishedBase(web);
    const d1 = await publishedDelta(web, base.id);
    const d2 = await bound(
      web.tenantId,
      (c) => insertLayer(c, { ...web, commitSha: sha(), kind: 'delta', parentLayerId: d1.id }),
      commit,
    );
    expect(d1).toMatchObject({ kind: 'delta', parentLayerId: base.id, depth: 1 });
    expect(d1.chain).toEqual([d1.id, base.id]);
    expect(d2).toMatchObject({ parentLayerId: d1.id, depth: 2, state: 'staged' });
    expect(d2.chain).toEqual([d2.id, d1.id, base.id]);
  });

  it('refuses an unusable parent without writing a row', async () => {
    const foreignRepo = await publishedBase(api);
    const foreignTenant = await publishedBase(globex);
    const staged = await stagedLayer(web);
    const commitSha = sha();
    await bound(web.tenantId, async (c) => {
      const delta = (parentLayerId: string) =>
        insertLayer(c, { ...web, commitSha, kind: 'delta', parentLayerId });
      await expect(
        insertLayer(c, { ...web, commitSha, kind: 'delta' } as never),
      ).rejects.toBeInstanceOf(UnknownLayerError);
      for (const parent of [randomUUID(), foreignRepo.id, foreignTenant.id]) {
        await expect(delta(parent)).rejects.toBeInstanceOf(UnknownLayerError);
      }
      await expect(delta(staged.id)).rejects.toBeInstanceOf(ParentNotPublishedError);
      await expect(
        insertLayer(c, { ...web, commitSha, kind: 'base', parentLayerId: staged.id } as never),
      ).rejects.toBeInstanceOf(RangeError);
      const rows = await queryRows(
        c as unknown as pg.Client,
        'SELECT 1 FROM codegraph.commit_layers WHERE commit_sha = $1',
        [commitSha],
      );
      expect(rows).toEqual([]);
    });
  });
});

describe('appendLayerPaths', () => {
  it('writes a whole batch in one statement, and a second call appends more', async () => {
    const layer = await stagedLayer(web);
    const batch: PathEntry[] = Array.from({ length: 500 }, (_, i) => ({
      path: `src/file-${String(i).padStart(3, '0')}.ts`,
      gitBlobHash: i % 50 === 0 ? null : sha(),
    }));
    const statements = await statementsOf(() =>
      bound(web.tenantId, (c) => appendLayerPaths(c, web, layer.id, batch), commit),
    );
    expect(statements).toHaveLength(1);
    await bound(
      web.tenantId,
      (c) => appendLayerPaths(c, web, layer.id, [{ path: 'README.md', gitBlobHash: sha() }]),
      commit,
    );
    const rows = await bound(web.tenantId, (c) => readLayerPathsByLayerIds(c, web, [layer.id]));
    expect(rows).toHaveLength(501);
    expect(rows.map((r) => r.path)).toEqual([...rows.map((r) => r.path)].sort());
    expect(rows.find((r) => r.path === 'src/file-000.ts')?.gitBlobHash).toBeNull();
    expect(rows.find((r) => r.path === 'src/file-001.ts')?.gitBlobHash).toBe(batch[1]?.gitBlobHash);
  });

  it('refuses a published or unknown layer, an oversized batch, and a duplicate path without changing rows', async () => {
    const published = await publishedBase(web, sha(), [{ path: 'a.ts', gitBlobHash: sha() }]);
    const staged = await stagedLayer(web);
    const first = sha();
    await bound(
      web.tenantId,
      (c) => appendLayerPaths(c, web, staged.id, [{ path: 'a.ts', gitBlobHash: first }]),
      commit,
    );
    await bound(web.tenantId, async (c) => {
      const one = [{ path: 'b.ts', gitBlobHash: sha() }];
      await expect(appendLayerPaths(c, web, published.id, one)).rejects.toBeInstanceOf(
        LayerNotStagedError,
      );
      await expect(appendLayerPaths(c, api, staged.id, one)).rejects.toBeInstanceOf(
        LayerNotStagedError,
      );
      await expect(appendLayerPaths(c, web, randomUUID(), one)).rejects.toBeInstanceOf(
        LayerNotStagedError,
      );
      await expect(
        appendLayerPaths(c, web, staged.id, [...one, ...one], { batchSize: 1 }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(await appendLayerPaths(c, web, staged.id, [])).toBe(0);
    });
    const duplicate = await bound(web.tenantId, async (c) => {
      try {
        await appendLayerPaths(c, web, staged.id, [
          { path: 'c.ts', gitBlobHash: sha() },
          { path: 'a.ts', gitBlobHash: sha() },
        ]);
        return null;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(duplicate).toBe(UNIQUE_VIOLATION);
    const rows = await bound(web.tenantId, (c) =>
      readLayerPathsByLayerIds(c, web, [published.id, staged.id]),
    );
    expect(rows.filter((r) => r.layerId === staged.id)).toEqual([
      { layerId: staged.id, path: 'a.ts', gitBlobHash: first },
    ]);
    expect(rows.filter((r) => r.layerId === published.id).map((r) => r.path)).toEqual(['a.ts']);
  });
});

describe('readLayerById and readLayerPathsByLayerIds', () => {
  it('answer raw rows, null for a layer the tenant does not hold, and one statement per chunk', async () => {
    const layers: LayerRow[] = [];
    for (let i = 0; i < 8; i += 1) {
      layers.push(
        await publishedBase(web, sha(), [
          { path: `z${String(i)}.ts`, gitBlobHash: sha() },
          { path: `a${String(i)}.ts`, gitBlobHash: null },
        ]),
      );
    }
    const foreign = await publishedBase(globex, sha(), [{ path: 'x.ts', gitBlobHash: sha() }]);
    const ids = layers.map((l) => l.id);
    await bound(web.tenantId, async (c) => {
      expect(await readLayerById(c, web, ids[0] ?? '')).toEqual(layers[0]);
      expect(await readLayerById(c, web, foreign.id)).toBeNull();
      expect(await readLayerById(c, api, ids[0] ?? '')).toBeNull();
      expect(await readLayerById(c, web, randomUUID())).toBeNull();
    });
    const chunked = await statementsOf(() =>
      bound(web.tenantId, (c) => readLayerPathsByLayerIds(c, web, ids, { batchSize: 2 })),
    );
    expect(chunked).toHaveLength(4);
    const whole = await statementsOf(() =>
      bound(web.tenantId, (c) => readLayerPathsByLayerIds(c, web, ids)),
    );
    expect(whole).toHaveLength(1);
    const rows = await bound(web.tenantId, (c) =>
      readLayerPathsByLayerIds(c, web, [...ids, foreign.id], { batchSize: 3 }),
    );
    expect(rows).toEqual(
      layers.flatMap((l, i) => [
        { layerId: l.id, path: `a${String(i)}.ts`, gitBlobHash: null },
        { layerId: l.id, path: `z${String(i)}.ts`, gitBlobHash: expect.any(String) as string },
      ]),
    );
    await bound(web.tenantId, async (c) => {
      await expect(readLayerPathsByLayerIds(c, web, ids, { batchSize: 0 })).rejects.toThrow(
        RangeError,
      );
    });
  });
});

describe('markPublished and markSuperseded', () => {
  it('publishes a staged layer once; a second publish is refused and the stamp never moves', async () => {
    const staged = await stagedLayer(web);
    const published = await bound(web.tenantId, (c) => markPublished(c, web, staged.id), commit);
    expect(published).toMatchObject({ id: staged.id, state: 'published', supersededAt: null });
    expect(published.publishedAt).toBeInstanceOf(Date);
    await bound(web.tenantId, async (c) => {
      await expect(markPublished(c, web, staged.id)).rejects.toBeInstanceOf(LayerNotStagedError);
      await expect(markPublished(c, api, randomUUID())).rejects.toBeInstanceOf(LayerNotStagedError);
      expect((await readLayerById(c, web, staged.id))?.publishedAt).toEqual(published.publishedAt);
    });
  });

  it('supersedes a current published layer, keeping its state, time and paths', async () => {
    const commitSha = sha();
    const current = await publishedBase(web, commitSha, [{ path: 'a.ts', gitBlobHash: sha() }]);
    const staged = await stagedLayer(web);
    const retired = await bound(web.tenantId, (c) => markSuperseded(c, web, current.id), commit);
    expect(retired).toMatchObject({
      id: current.id,
      state: 'published',
      publishedAt: current.publishedAt,
    });
    expect(retired.supersededAt).toBeInstanceOf(Date);
    await bound(web.tenantId, async (c) => {
      for (const id of [staged.id, current.id, randomUUID()]) {
        await expect(markSuperseded(c, web, id)).rejects.toBeInstanceOf(LayerNotPublishedError);
      }
      expect(await readLayerPathsByLayerIds(c, web, [current.id])).toHaveLength(1);
      expect((await readLayerById(c, web, current.id))?.supersededAt).toEqual(retired.supersededAt);
      expect(await readCurrentPublishedLayer(c, web, commitSha)).toBeNull();
    });
  });
});

describe('readCurrentPublishedLayer', () => {
  it('answers only the current published layer of this repository', async () => {
    const commitSha = sha();
    await stagedLayer(web, commitSha);
    expect(await bound(web.tenantId, (c) => readCurrentPublishedLayer(c, web, commitSha))).toBe(
      null,
    );
    const old = await publishedBase(web, commitSha);
    await bound(web.tenantId, (c) => markSuperseded(c, web, old.id), commit);
    const current = await publishedBase(web, commitSha);
    await publishedBase(api, commitSha);
    await publishedBase(globex, commitSha);
    await bound(web.tenantId, async (c) => {
      expect((await readCurrentPublishedLayer(c, web, commitSha))?.id).toBe(current.id);
      expect(await readCurrentPublishedLayer(c, web, sha())).toBeNull();
    });
  });

  it('with the row lock, serialises two callers so only one still sees the layer', async () => {
    const commitSha = sha();
    const layer = await publishedBase(web, commitSha);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      for (const c of [first, second]) {
        await c.query('BEGIN');
        await c.query(BIND_TENANT_SQL, [fx.readerId, web.tenantId]);
      }
      expect(
        (await readCurrentPublishedLayer(first, web, commitSha, { forUpdate: true }))?.id,
      ).toBe(layer.id);
      const waiting = readCurrentPublishedLayer(second, web, commitSha, { forUpdate: true });
      await markSuperseded(first, web, layer.id);
      await first.query('COMMIT');
      expect(await waiting).toBeNull();
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
  });
});

describe('findNearestPublishedAncestor', () => {
  it('answers the first candidate, in the caller’s order, with a current published layer here', async () => {
    const a = sha();
    const b = sha();
    const x = sha();
    const otherRepo = sha();
    const otherTenant = sha();
    const layerA = await publishedBase(web, a);
    const layerB = await publishedBase(web, b);
    await stagedLayer(web, x);
    await publishedBase(api, otherRepo);
    await publishedBase(globex, otherTenant);
    await bound(web.tenantId, async (c) => {
      expect(await findNearestPublishedAncestor(c, web, [b, a])).toEqual({
        commitSha: b,
        layerId: layerB.id,
      });
      expect(await findNearestPublishedAncestor(c, web, [x, a])).toEqual({
        commitSha: a,
        layerId: layerA.id,
      });
      expect(await findNearestPublishedAncestor(c, web, [])).toBeNull();
      expect(await findNearestPublishedAncestor(c, web, [otherRepo, otherTenant, x])).toBeNull();
    });
    const many = [...Array.from({ length: 19 }, sha), a];
    const statements = await statementsOf(() =>
      bound(web.tenantId, async (c) => {
        expect((await findNearestPublishedAncestor(c, web, many))?.layerId).toBe(layerA.id);
      }),
    );
    expect(statements).toHaveLength(1);
  });
});

describe('ref heads', () => {
  it('inserts a ref on first use and moves it on the next, each ref on its own row', async () => {
    const c1 = await publishedBase(web);
    const c2 = await publishedDelta(web, c1.id);
    const f1 = await publishedDelta(web, c2.id);
    await bound(
      web.tenantId,
      async (c) => {
        const main = { ...web, refName: 'refs/heads/main', isDefaultBranch: true };
        expect(await moveRefHead(c, { ...main, layerId: c1.id })).toEqual({
          ...web,
          refName: 'refs/heads/main',
          commitSha: c1.commitSha,
          layerId: c1.id,
          isDefaultBranch: true,
        });
        await moveRefHead(c, { ...main, layerId: c2.id });
        await moveRefHead(c, {
          ...web,
          refName: 'refs/heads/feature',
          layerId: f1.id,
          isDefaultBranch: false,
        });
      },
      commit,
    );
    await bound(web.tenantId, async (c) => {
      expect(await readRefHead(c, web, 'refs/heads/main')).toMatchObject({
        commitSha: c2.commitSha,
        layerId: c2.id,
        isDefaultBranch: true,
      });
      expect(await readRefHead(c, web, 'refs/heads/feature')).toMatchObject({
        commitSha: f1.commitSha,
        layerId: f1.id,
        isDefaultBranch: false,
      });
      expect(await readRefHead(c, web, 'refs/heads/nope')).toBeNull();
      expect(await readRefHead(c, api, 'refs/heads/main')).toBeNull();
      expect(await readRefHead(c, globex, 'refs/heads/main')).toBeNull();
      expect((await listRefHeadsNamingLayer(c, web, c2.id)).map((r) => r.refName)).toEqual([
        'refs/heads/main',
      ]);
      expect(await listRefHeadsNamingLayer(c, web, c1.id)).toEqual([]);
      expect(await listRefHeadsNamingLayer(c, api, c2.id)).toEqual([]);
      expect(await listRefHeadsNamingLayer(c, web, randomUUID())).toEqual([]);
    });
  });

  it('lists every ref naming a layer, ordered by name', async () => {
    const layer = await publishedBase(web);
    await bound(
      web.tenantId,
      async (c) => {
        for (const refName of ['refs/heads/zeta', 'refs/heads/alpha', 'refs/tags/v1']) {
          await moveRefHead(c, { ...web, refName, layerId: layer.id, isDefaultBranch: false });
        }
      },
      commit,
    );
    const refs = await bound(web.tenantId, (c) => listRefHeadsNamingLayer(c, web, layer.id));
    expect(refs.map((r) => r.refName)).toEqual([
      'refs/heads/alpha',
      'refs/heads/zeta',
      'refs/tags/v1',
    ]);
  });

  it('refuses a staged, retired or other repository’s layer, writing no ref row', async () => {
    const staged = await stagedLayer(web);
    const foreign = await publishedBase(api);
    const retired = await publishedBase(web);
    await bound(web.tenantId, (c) => markSuperseded(c, web, retired.id), commit);
    await bound(web.tenantId, async (c) => {
      for (const layerId of [staged.id, foreign.id, retired.id]) {
        await expect(
          moveRefHead(c, { ...web, refName: 'refs/heads/x', layerId, isDefaultBranch: false }),
        ).rejects.toBeInstanceOf(UnknownLayerError);
      }
      expect(await readRefHead(c, web, 'refs/heads/x')).toBeNull();
    });
  });
});

describe('listReferencedBlobHashes', () => {
  it('pages every distinct referenced hash of the tenant, staged, published and retired, once each', async () => {
    const { db: own, fx: f, scope, other } = await isolatedTenant();
    try {
      const hashes = Array.from({ length: 7 }, sha).sort();
      const [h0, h1, h2, h3, h4, h5, h6] = hashes as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      await withApp(own.appUrl, f.readerId, scope.tenantId, async (c) => {
        const base = await insertLayer(c, { ...scope, commitSha: sha(), kind: 'base' });
        await appendLayerPaths(c, scope, base.id, [
          { path: 'a', gitBlobHash: h0 },
          { path: 'b', gitBlobHash: h1 },
          { path: 'c', gitBlobHash: h1 },
          { path: 'gone', gitBlobHash: null },
        ]);
        await markPublished(c, scope, base.id);
        const retired = await insertLayer(c, { ...scope, commitSha: sha(), kind: 'base' });
        await appendLayerPaths(c, scope, retired.id, [{ path: 'r', gitBlobHash: h2 }]);
        await markPublished(c, scope, retired.id);
        await markSuperseded(c, scope, retired.id);
        const staged = await insertLayer(c, { ...scope, commitSha: sha(), kind: 'base' });
        await appendLayerPaths(
          c,
          scope,
          staged.id,
          [h3, h4, h5, h6].map((h, i) => ({ path: `s${String(i)}`, gitBlobHash: h })),
        );
      });
      await withApp(own.appUrl, f.operatorId, other.tenantId, async (c) => {
        const foreign = await insertLayer(c, { ...other, commitSha: sha(), kind: 'base' });
        await appendLayerPaths(c, other, foreign.id, [{ path: 'f', gitBlobHash: sha() }]);
      });
      const drained = await withApp(
        own.appUrl,
        f.readerId,
        scope.tenantId,
        async (c) => {
          const pages: string[][] = [];
          let after: string | null = null;
          for (;;) {
            const page = await listReferencedBlobHashes(c, scope.tenantId, { after, limit: 3 });
            pages.push([...page.hashes]);
            if (page.next === null) break;
            after = page.next;
          }
          return pages;
        },
        false,
      );
      expect(drained.flat()).toEqual(hashes);
      expect(drained.map((p) => p.length)).toEqual([3, 3, 1]);
      expect([h0, h1, h2]).toEqual(drained[0]);
    } finally {
      await own.drop();
    }
  });
});

describe('listStagedLayersStagedBefore and deleteLayerById', () => {
  it('pages stale staged layers only, and draining them converges', async () => {
    const { db: own, fx: f, scope } = await isolatedTenant();
    try {
      const staged: string[] = [];
      await withApp(own.appUrl, f.readerId, scope.tenantId, async (c) => {
        for (let i = 0; i < 5; i += 1) {
          staged.push((await insertLayer(c, { ...scope, commitSha: sha(), kind: 'base' })).id);
        }
        const published = await insertLayer(c, { ...scope, commitSha: sha(), kind: 'base' });
        await markPublished(c, scope, published.id);
      });
      // Age the five staged layers and the published one; one fresh staged layer stays young.
      await withClient(own.ownerUrl, (c) =>
        c.query(
          `UPDATE codegraph.commit_layers SET staged_at = staged_at - interval '3 hours',
                  published_at = CASE WHEN state = 'published' THEN published_at END
            WHERE tenant_id = $1`,
          [scope.tenantId],
        ),
      );
      const fresh = await withApp(own.appUrl, f.readerId, scope.tenantId, (c) =>
        insertLayer(c, { ...scope, commitSha: sha(), kind: 'base' }),
      );
      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const seen: string[] = [];
      for (;;) {
        const page = await withApp(own.appUrl, f.readerId, scope.tenantId, async (c) => {
          const { layers } = await listStagedLayersStagedBefore(c, scope.tenantId, cutoff, {
            limit: 2,
          });
          for (const layer of layers) {
            expect(layer.state).toBe('staged');
            expect(await deleteLayerById(c, scope, layer.id)).toBe(true);
          }
          return layers.map((l) => l.id);
        });
        if (page.length === 0) break;
        seen.push(...page);
      }
      expect(seen.sort()).toEqual([...staged].sort());
      const left = await withApp(
        own.appUrl,
        f.readerId,
        scope.tenantId,
        (c) => readLayerById(c, scope, fresh.id),
        false,
      );
      expect(left?.id).toBe(fresh.id);
    } finally {
      await own.drop();
    }
  });

  it('removes a layer with its paths, answers false when absent, and refuses one a chain carries', async () => {
    const base = await publishedBase(web, sha(), [{ path: 'a.ts', gitBlobHash: sha() }]);
    const delta = await publishedDelta(web, base.id, sha(), [{ path: 'b.ts', gitBlobHash: sha() }]);
    await bound(web.tenantId, async (c) => {
      await expect(deleteLayerById(c, web, base.id)).rejects.toBeInstanceOf(
        LayerStillReferencedError,
      );
      expect(await readLayerPathsByLayerIds(c, web, [base.id])).toHaveLength(1);
      expect(await deleteLayerById(c, web, delta.id)).toBe(true);
      expect(await readLayerPathsByLayerIds(c, web, [delta.id])).toEqual([]);
      expect(await deleteLayerById(c, web, delta.id)).toBe(false);
      expect(await deleteLayerById(c, api, base.id)).toBe(false);
      expect(await deleteLayerById(c, web, randomUUID())).toBe(false);
      expect(await deleteLayerById(c, web, base.id)).toBe(true);
    });
  });

  it('leaves a layer a ref head names to the schema to refuse', async () => {
    const layer = await publishedBase(web);
    await bound(web.tenantId, async (c) => {
      await moveRefHead(c, {
        ...web,
        refName: 'refs/heads/main2',
        layerId: layer.id,
        isDefaultBranch: false,
      });
      await expect(deleteLayerById(c, web, layer.id)).rejects.toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
      });
    });
  });
});

describe('a binding that admits nothing', () => {
  it('reads nothing, inserts nothing, and updates nothing — through the typed refusals', async () => {
    const layer = await publishedBase(web, sha(), [{ path: 'a.ts', gitBlobHash: sha() }]);
    const staged = await stagedLayer(web);
    await bound(
      web.tenantId,
      (c) =>
        moveRefHead(c, {
          ...web,
          refName: 'refs/heads/main3',
          layerId: layer.id,
          isDefaultBranch: false,
        }),
      commit,
    );
    // No binding at all, and a bound client with no grant on tenant A.
    for (const binding of [null, fx.operatorId] as const) {
      await bound(
        binding === null ? null : web.tenantId,
        async (c) => {
          expect(await readLayerById(c, web, layer.id)).toBeNull();
          expect(await readLayerPathsByLayerIds(c, web, [layer.id])).toEqual([]);
          expect(await readRefHead(c, web, 'refs/heads/main3')).toBeNull();
          expect(await readCurrentPublishedLayer(c, web, layer.commitSha)).toBeNull();
          expect(await findNearestPublishedAncestor(c, web, [layer.commitSha])).toBeNull();
          expect(await listRefHeadsNamingLayer(c, web, layer.id)).toEqual([]);
          expect((await listReferencedBlobHashes(c, web.tenantId)).hashes).toEqual([]);
          expect(
            (await listStagedLayersStagedBefore(c, web.tenantId, new Date(Date.now() + 1e6)))
              .layers,
          ).toEqual([]);
          await expect(markPublished(c, web, staged.id)).rejects.toBeInstanceOf(
            LayerNotStagedError,
          );
          expect(await deleteLayerById(c, web, layer.id)).toBe(false);
          await c.query('SAVEPOINT s');
          await expect(
            insertLayer(c, { ...web, commitSha: sha(), kind: 'base' }),
          ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
          await c.query('ROLLBACK TO SAVEPOINT s');
        },
        { clientId: fx.operatorId },
      );
    }
    await bound(web.tenantId, async (c) => {
      expect((await readLayerById(c, web, layer.id))?.state).toBe('published');
      expect((await readLayerById(c, web, staged.id))?.state).toBe('staged');
      expect(await readLayerPathsByLayerIds(c, web, [layer.id])).toHaveLength(1);
    });
  });
});

describe('the tenant locks', () => {
  async function holder(tenantId: string) {
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '200ms'");
    return {
      c,
      shared: () => lockTenantShared(c, tenantId),
      exclusive: () => lockTenantExclusive(c, tenantId),
      async attempt(fn: () => Promise<void>): Promise<string | null> {
        await c.query('SAVEPOINT attempt');
        try {
          await fn();
          await c.query('RELEASE SAVEPOINT attempt');
          return null;
        } catch (error) {
          await c.query('ROLLBACK TO SAVEPOINT attempt');
          return (error as { code?: string }).code ?? 'unknown';
        }
      },
      async end() {
        await c.query('ROLLBACK');
        c.release();
      },
    };
  }

  it('lets shared takers share, makes exclusive contend with both, and keys by tenant', async () => {
    const tenant = randomUUID();
    const a = await holder(tenant);
    const b = await holder(tenant);
    const other = await holder(randomUUID());
    try {
      expect(await a.attempt(a.shared)).toBeNull();
      expect(await b.attempt(b.shared)).toBeNull();
      expect(await other.attempt(other.exclusive)).toBeNull();
      await b.end();
      const c = await holder(tenant);
      expect(await c.attempt(c.exclusive)).toBe(LOCK_NOT_AVAILABLE);
      await a.end();
      // Released with the transaction: the blocked taker acquires now.
      expect(await c.attempt(c.exclusive)).toBeNull();
      const d = await holder(tenant);
      expect(await d.attempt(d.shared)).toBe(LOCK_NOT_AVAILABLE);
      expect(await d.attempt(d.exclusive)).toBe(LOCK_NOT_AVAILABLE);
      await d.end();
      await c.end();
    } finally {
      await other.end();
    }
  });
});

describe('parameters', () => {
  it('round-trip quotes and backslashes through a layer, its paths and a ref head', async () => {
    const tricky = `it's "quoted" \\ back\\slash; DROP TABLE x; --`;
    const layer = await publishedBase(web, sha(), [{ path: tricky, gitBlobHash: sha() }]);
    await bound(
      web.tenantId,
      (c) => moveRefHead(c, { ...web, refName: tricky, layerId: layer.id, isDefaultBranch: false }),
      commit,
    );
    await bound(web.tenantId, async (c) => {
      expect((await readLayerPathsByLayerIds(c, web, [layer.id]))[0]?.path).toBe(tricky);
      expect((await readRefHead(c, web, tricky))?.refName).toBe(tricky);
      expect(
        await findNearestPublishedAncestor(c, web, [`'; SELECT 1; --`, layer.commitSha]),
      ).toEqual({ commitSha: layer.commitSha, layerId: layer.id });
      expect(await listStagedLayersStagedBefore(c, web.tenantId, new Date(0))).toEqual({
        layers: [],
      });
    });
  });
});

/** A database of its own, so a tenant-wide page counts only this test's rows. */
async function isolatedTenant() {
  const own = await freshDatabase();
  const f = await buildTenancyFixture(own);
  await withClient(own.ownerUrl, (c) =>
    c.query('INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
      f.operatorId,
      f.tenantB.id,
    ]),
  );
  const [a] = f.tenantA.repositories;
  const [b] = f.tenantB.repositories;
  if (a === undefined || b === undefined) throw new Error('fixture');
  return {
    db: own,
    fx: f,
    scope: { tenantId: f.tenantA.id, repositoryId: a.id },
    other: { tenantId: f.tenantB.id, repositoryId: b.id },
  };
}

async function withApp<T>(
  url: string,
  clientId: string,
  tenantId: string,
  fn: (c: pg.Client) => Promise<T>,
  commitIt = true,
): Promise<T> {
  return withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query(BIND_TENANT_SQL, [clientId, tenantId]);
    try {
      const result = await fn(c);
      await c.query(commitIt ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}
