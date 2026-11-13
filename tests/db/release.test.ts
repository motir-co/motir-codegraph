import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LayerScope } from '../../src/db/layers.js';
import {
  deleteSupersededLayers,
  listSupersededLayerIds,
  listUnreferencedBlobHashes,
  readBoundTenant,
} from '../../src/db/release.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { layerSeeder, sha, type LayerSeeder } from '../helpers/layerSeed.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;
let pool: pg.Pool;
let seed: LayerSeeder;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  seed = layerSeeder(db, fx, pool);
  // Seeding tenant B needs the operator granted on it; tenant A stays the reader's only.
  await seed.grantOperator(fx.tenantB.id);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

async function freshScope(): Promise<LayerScope> {
  return seed.freshRepo(await seed.freshTenant());
}

const listLayers = (scope: LayerScope, limit = 100) =>
  seed.bound(scope.tenantId, (c) => listSupersededLayerIds(c, scope.tenantId, limit), false);

const listBlobs = (tenantId: string, limit = 100) =>
  seed.bound(tenantId, (c) => listUnreferencedBlobHashes(c, tenantId, limit), false);

const sorted = (ids: string[]) => [...ids].sort();

describe('listSupersededLayerIds', () => {
  it('answers nothing while a base and two deltas over it are all current: each chain names its own layer', async () => {
    const scope = await freshScope();
    const base = await seed.published(scope, null, [{ path: 'a', gitBlobHash: sha() }]);
    const d1 = await seed.published(scope, base, [{ path: 'b', gitBlobHash: sha() }]);
    await seed.published(scope, d1, [{ path: 'c', gitBlobHash: sha() }]);
    expect(await listLayers(scope)).toEqual([]);
  });

  it('leaves a retired head a descendant still names, then answers it with its retired descendant once that goes too', async () => {
    const scope = await freshScope();
    const base = await seed.published(scope, null, [{ path: 'a', gitBlobHash: sha() }]);
    const d1 = await seed.published(scope, base, [{ path: 'b', gitBlobHash: sha() }]);
    const d2 = await seed.published(scope, d1, [{ path: 'c', gitBlobHash: sha() }]);

    // d1's commit is compacted: d1 is retired, but d2's live chain still names it.
    await seed.replace(scope, d1, [{ path: 'a', gitBlobHash: sha() }]);
    expect(await listLayers(scope)).toEqual([]);

    // d2's commit is compacted too: no live chain names either any more.
    await seed.replace(scope, d2, [{ path: 'a', gitBlobHash: sha() }]);
    // Deepest first, so a batch never takes a parent before its child.
    const expected = [d2.id, d1.id];
    expect(await listLayers(scope)).toEqual(expected);
    expect(await listLayers(scope, 1)).toEqual(expected.slice(0, 1));

    // A layer of another repository of the same tenant is reachable only by its own chains.
    const other = await seed.freshRepo(scope.tenantId);
    await seed.published(other, null, [{ path: 'z', gitBlobHash: sha() }]);
    const narrowed = await seed.bound(
      scope.tenantId,
      (c) => listSupersededLayerIds(c, scope.tenantId, 100, { repositoryId: other.repositoryId }),
      false,
    );
    expect(narrowed).toEqual([]);
  });

  it('never answers a layer a staged chain or a ref head names, nor a staged layer itself', async () => {
    const scope = await freshScope();
    const named = await seed.published(scope, null, [{ path: 'a', gitBlobHash: sha() }]);
    const stagedOver = await seed.staged(scope, named, [{ path: 'b', gitBlobHash: sha() }]);
    await seed.replace(scope, named, [{ path: 'a', gitBlobHash: sha() }]);

    const headed = await seed.published(scope, null, [{ path: 'c', gitBlobHash: sha() }]);
    await seed.refHead(scope, 'refs/heads/keep', headed);
    await seed.replace(scope, headed, [{ path: 'c', gitBlobHash: sha() }]);

    await seed.staged(scope, null, [{ path: 'd', gitBlobHash: sha() }]);

    const answered = await listLayers(scope);
    expect(answered).not.toContain(named.id);
    expect(answered).not.toContain(stagedOver.id);
    expect(answered).not.toContain(headed.id);
    expect(answered).toEqual([]);
    expect(
      await seed.bound(
        scope.tenantId,
        (c) => deleteSupersededLayers(c, scope.tenantId, 100),
        false,
      ),
    ).toEqual([]);
  });

  it('refuses a limit that is not a positive integer', async () => {
    const scope = await freshScope();
    await expect(listLayers(scope, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(listBlobs(scope.tenantId, 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('deleteSupersededLayers', () => {
  it('deletes what the rule answers, deepest first, with its path rows, bounded by the limit', async () => {
    const scope = await freshScope();
    const base = await seed.published(scope, null, [
      { path: 'a', gitBlobHash: sha() },
      { path: 'b', gitBlobHash: sha() },
    ]);
    const d1 = await seed.published(scope, base, [{ path: 'a', gitBlobHash: null }]);
    await seed.replace(scope, d1, [{ path: 'b', gitBlobHash: sha() }]);
    await seed.replace(scope, base, [
      { path: 'a', gitBlobHash: sha() },
      { path: 'b', gitBlobHash: sha() },
    ]);
    const doomed = [d1.id, base.id]; // deepest first: the child before the parent it names
    const before = await seed.snapshot(scope.tenantId);

    const first = await seed.bound(scope.tenantId, (c) =>
      deleteSupersededLayers(c, scope.tenantId, 1),
    );
    expect(first).toEqual(doomed.slice(0, 1));
    const rest = await seed.bound(scope.tenantId, (c) =>
      deleteSupersededLayers(c, scope.tenantId, 100),
    );
    expect(rest).toEqual(doomed.slice(1));

    const after = await seed.snapshot(scope.tenantId);
    expect(after.layers).toEqual(before.layers.filter((id) => !doomed.includes(id)));
    expect(after.paths).toBe(before.paths - 3); // two base paths and one tombstone
    expect(
      await seed.bound(scope.tenantId, (c) => deleteSupersededLayers(c, scope.tenantId, 100)),
    ).toEqual([]);
  });
});

describe('listUnreferencedBlobHashes', () => {
  it('counts staged, retired and current paths and every repository of the tenant; a tombstone matches nothing', async () => {
    const scope = await freshScope();
    const second = await seed.freshRepo(scope.tenantId);
    const [hStaged, hRetired, hCurrent, hSecond, hFree1, hFree2] = Array.from({ length: 6 }, sha);
    await seed.blobs(scope.tenantId, [
      hStaged,
      hRetired,
      hCurrent,
      hSecond,
      hFree1,
      hFree2,
    ] as string[]);

    await seed.staged(scope, null, [{ path: 's', gitBlobHash: hStaged as string }]);
    const retired = await seed.published(scope, null, [
      { path: 'r', gitBlobHash: hRetired as string },
    ]);
    await seed.replace(scope, retired, [
      { path: 'c', gitBlobHash: hCurrent as string },
      { path: 'gone', gitBlobHash: null },
    ]);
    await seed.published(second, null, [{ path: 'x', gitBlobHash: hSecond as string }]);

    const free = sorted([hFree1, hFree2] as string[]);
    expect(await listBlobs(scope.tenantId)).toEqual(free);
    expect(await listBlobs(scope.tenantId, 1)).toEqual(free.slice(0, 1));

    // Once the retired layer is released, the hash only it named is answered.
    await seed.bound(scope.tenantId, (c) => deleteSupersededLayers(c, scope.tenantId, 100));
    expect(await listBlobs(scope.tenantId)).toEqual(sorted([...free, hRetired as string]));
  });
});

describe('isolation', () => {
  it('answers only the bound tenant, even asked for another, while the other holds candidates', async () => {
    const a: LayerScope = {
      tenantId: fx.tenantA.id,
      repositoryId: (fx.tenantA.repositories[0] as { id: string }).id,
    };
    const b: LayerScope = {
      tenantId: fx.tenantB.id,
      repositoryId: (fx.tenantB.repositories[0] as { id: string }).id,
    };
    const seedOne = async (scope: LayerScope) => {
      const hash = sha();
      await seed.blobs(scope.tenantId, [hash]);
      const layer = await seed.published(scope, null, [{ path: 'p', gitBlobHash: sha() }]);
      await seed.replace(scope, layer, [{ path: 'p', gitBlobHash: sha() }]);
      return { hash, layerId: layer.id };
    };
    const ofA = await seedOne(a);
    const ofB = await seedOne(b);

    expect(await listLayers(a)).toEqual([ofA.layerId]);
    expect(await listBlobs(a.tenantId)).toEqual([ofA.hash]);
    // Bound to A, asking for B: the policy admits none of B's rows.
    const crossed = await seed.bound(
      a.tenantId,
      async (c) => ({
        layers: await listSupersededLayerIds(c, b.tenantId, 100),
        blobs: await listUnreferencedBlobHashes(c, b.tenantId, 100),
        deleted: await deleteSupersededLayers(c, b.tenantId, 100),
      }),
      false,
    );
    expect(crossed).toEqual({ layers: [], blobs: [], deleted: [] });
    // While B, seen as B, holds exactly the candidates A could not see.
    expect(await listLayers(b)).toEqual([ofB.layerId]);
    expect(await listBlobs(b.tenantId)).toEqual([ofB.hash]);
  });
});

describe('readBoundTenant', () => {
  it('answers the bound tenant, and null for a session bound to none', async () => {
    expect(await seed.bound(fx.tenantA.id, (c) => readBoundTenant(c), false)).toBe(fx.tenantA.id);
    const c = await pool.connect();
    try {
      expect(await readBoundTenant(c)).toBeNull();
    } finally {
      c.release();
    }
  });
});
