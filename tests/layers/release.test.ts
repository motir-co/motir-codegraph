import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lockTenantShared, type LayerScope } from '../../src/db/layers.js';
import { stageLayer } from '../../src/layers/openLayer.js';
import {
  RELEASE_BATCH_SIZE,
  releaseTenant,
  ReleaseTenantUnboundError,
  type ReleaseRequest,
} from '../../src/layers/release.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { layerSeeder, sha, type LayerSeeder } from '../helpers/layerSeed.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;
let pool: pg.Pool;
let log: QueryLog;
let seed: LayerSeeder;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  log = recordQueries(pool);
  seed = layerSeeder(db, fx, pool);
  await seed.grantOperator(fx.tenantB.id);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

function release(tenantId: string, extra: Partial<ReleaseRequest> = {}, on: pg.Pool = pool) {
  return releaseTenant(on, { clientId: seed.clientFor(tenantId), tenantId, ...extra });
}

async function freshScope(): Promise<LayerScope> {
  return seed.freshRepo(await seed.freshTenant());
}

/** Statements logged since the last clear that delete rows. */
function deletes(): string[] {
  return log.texts().filter((t) => /\bDELETE\b/.test(t));
}

/**
 * A pool whose connections call `hook(text, n)` before and after each
 * statement, `n` counting the statements of that text seen so far; a hook that
 * throws before a statement fails it.
 */
function hooked(
  hook: (moment: 'before' | 'after', text: string, n: number) => Promise<void>,
): pg.Pool {
  const wrapped = Object.create(pool) as pg.Pool;
  const seen = new Map<string, number>();
  wrapped.connect = (async () => {
    const c = await pool.connect();
    const query = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
    (c as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
      const n = (seen.get(text) ?? 0) + 1;
      seen.set(text, n);
      await hook('before', text, n);
      const result = await query(text, params);
      await hook('after', text, n);
      return result;
    };
    const releaseClient = c.release.bind(c);
    c.release = (err?: Error | boolean) => {
      (c as unknown as { query: unknown }).query = query;
      releaseClient(err);
    };
    return c;
  }) as pg.Pool['connect'];
  return wrapped;
}

async function blobCount(tenantId: string): Promise<number> {
  return withClient(db.ownerUrl, async (c) => {
    const [row] = await queryRows<{ n: number }>(
      c,
      'SELECT count(*)::int AS n FROM codegraph.blob WHERE tenant_id = $1',
      [tenantId],
    );
    return (row as { n: number }).n;
  });
}

describe('releaseTenant', () => {
  it('runs the layer pass, then the blob pass, and the second call after the descendant goes releases the retired head', async () => {
    const scope = await freshScope();
    const [hA, hB0, hB1, hB2, hN1, hN2] = [sha(), sha(), sha(), sha(), sha(), sha()];
    await seed.blobs(scope.tenantId, [hA, hB0, hB1, hB2, hN1]);
    const base = await seed.published(scope, null, [
      { path: 'a', gitBlobHash: hA },
      { path: 'b', gitBlobHash: hB0 },
    ]);
    const d1 = await seed.published(scope, base, [{ path: 'b', gitBlobHash: hB1 }]);
    const d2 = await seed.published(scope, d1, [{ path: 'b', gitBlobHash: hB2 }]);

    // d1's commit gets a new base; d2's live chain still names d1, and its blobs stay pinned.
    await seed.replace(scope, d1, [
      { path: 'a', gitBlobHash: hA },
      { path: 'b', gitBlobHash: hN1 },
    ]);
    const first = await release(scope.tenantId);
    expect(first).toEqual({ layerIds: [], blobHashes: [], layerBatches: 1, blobBatches: 1 });

    await seed.blobs(scope.tenantId, [hN2]);
    // d2's commit gets one too: the second call takes both retired layers, then
    // the blobs only their paths named, with their contents and facts.
    await seed.replace(scope, d2, [
      { path: 'a', gitBlobHash: hA },
      { path: 'b', gitBlobHash: hN2 },
    ]);
    log.clear();
    const second = await release(scope.tenantId);
    expect(second).toEqual({
      layerIds: [d2.id, d1.id],
      blobHashes: [hB1, hB2].sort(),
      layerBatches: 1,
      blobBatches: 1,
    });
    const order = deletes();
    expect(order).toHaveLength(2);
    expect(order[0]).toContain('codegraph.commit_layers');
    expect(order[1]).toContain('codegraph.blob');
    expect(await seed.presence(scope.tenantId, hB1)).toEqual({
      blob: false,
      contents: false,
      facts: 0,
    });
    for (const kept of [hA, hB0, hN1, hN2]) {
      expect(await seed.presence(scope.tenantId, kept)).toEqual({
        blob: true,
        contents: true,
        facts: 1,
      });
    }

    // Nothing builds SQL from a value: no id or hash appears in any statement text.
    const texts = log.texts().join('\n');
    for (const value of [scope.tenantId, d1.id, d2.id, hB1, hB2]) {
      expect(texts).not.toContain(value);
    }
  });

  it('takes 1,200 candidates at 500 a batch in three transactions, each visible to another connection once it commits', async () => {
    const tenantId = await seed.freshTenant();
    await seed.bareBlobs(tenantId, 1_200);
    const remaining: number[] = [];
    let deleted = false;
    const observed = hooked(async (moment, text) => {
      if (moment === 'after' && text.startsWith('DELETE FROM codegraph.blob')) deleted = true;
      if (moment === 'after' && text === 'COMMIT' && deleted) {
        deleted = false;
        remaining.push(await blobCount(tenantId));
      }
    });
    const report = await release(tenantId, {}, observed);
    expect(RELEASE_BATCH_SIZE).toBe(500);
    expect(report.blobBatches).toBe(3);
    expect(report.blobHashes).toHaveLength(1_200);
    expect(remaining).toEqual([700, 200, 0]);
  });

  it('rolls a failing batch back, keeps its predecessors, and resumes; a call after a complete sweep issues no delete', async () => {
    const tenantId = await seed.freshTenant();
    const hashes = await seed.bareBlobs(tenantId, 1_200);
    const failing = hooked(async (moment, text, n) => {
      if (moment === 'before' && text.startsWith('DELETE FROM codegraph.blob') && n === 2) {
        throw new Error('injected failure in the second batch');
      }
      return Promise.resolve();
    });
    await expect(release(tenantId, {}, failing)).rejects.toThrow('injected failure');
    expect(await blobCount(tenantId)).toBe(700);

    const resumed = await release(tenantId);
    expect(resumed.blobHashes).toEqual(hashes.slice(500));
    expect(resumed.blobBatches).toBe(2);
    expect(await blobCount(tenantId)).toBe(0);

    log.clear();
    expect(await release(tenantId)).toEqual({
      layerIds: [],
      blobHashes: [],
      layerBatches: 1,
      blobBatches: 1,
    });
    expect(deletes()).toEqual([]);
  });

  it('bounds the layer pass too: five retired layers at two a batch take three transactions', async () => {
    const scope = await freshScope();
    const retired = [];
    for (let i = 0; i < 5; i += 1) {
      const layer = await seed.published(scope, null, [{ path: 'p', gitBlobHash: sha() }]);
      await seed.replace(scope, layer, [{ path: 'q', gitBlobHash: null }]);
      retired.push(layer.id);
    }
    const report = await release(scope.tenantId, { batchSize: 2 });
    expect(report.layerIds).toEqual(retired.sort());
    expect(report.layerBatches).toBe(3);
  });

  it('refuses an unbound session before reading a candidate, and leaves every row of both tenants', async () => {
    const a: LayerScope = {
      tenantId: fx.tenantA.id,
      repositoryId: (fx.tenantA.repositories[0] as { id: string }).id,
    };
    const layer = await seed.published(a, null, [{ path: 'p', gitBlobHash: sha() }]);
    await seed.replace(a, layer, [{ path: 'p', gitBlobHash: null }]);
    await seed.blobs(a.tenantId, [sha()]);
    const before = [await seed.snapshot(fx.tenantA.id), await seed.snapshot(fx.tenantB.id)];

    log.clear();
    const unknownClient = randomUUID();
    const noTenant = releaseTenant(pool, { clientId: unknownClient, tenantId: fx.tenantA.id });
    await expect(noTenant).rejects.toBeInstanceOf(ReleaseTenantUnboundError);
    await expect(noTenant).rejects.toMatchObject({
      tenantId: fx.tenantA.id,
      clientId: unknownClient,
    });
    // The reader holds no grant on B.
    const ungranted = releaseTenant(pool, { clientId: fx.readerId, tenantId: fx.tenantB.id });
    await expect(ungranted).rejects.toMatchObject({
      name: 'ReleaseTenantUnboundError',
      tenantId: fx.tenantB.id,
      clientId: fx.readerId,
    });
    expect(log.texts().filter((t) => /commit_layers|codegraph\.blob\b/.test(t))).toEqual([]);
    expect([await seed.snapshot(fx.tenantA.id), await seed.snapshot(fx.tenantB.id)]).toEqual(
      before,
    );
  });

  it('releases only the bound tenant: the second tenant’s layers and blobs are untouched', async () => {
    const a: LayerScope = {
      tenantId: fx.tenantA.id,
      repositoryId: (fx.tenantA.repositories[1] as { id: string }).id,
    };
    const b: LayerScope = {
      tenantId: fx.tenantB.id,
      repositoryId: (fx.tenantB.repositories[0] as { id: string }).id,
    };
    for (const scope of [a, b]) {
      const layer = await seed.published(scope, null, [{ path: 'p', gitBlobHash: sha() }]);
      await seed.replace(scope, layer, [{ path: 'p', gitBlobHash: null }]);
      await seed.blobs(scope.tenantId, [sha()]);
    }
    const ofB = await seed.snapshot(b.tenantId);
    const report = await release(a.tenantId);
    expect(report.layerIds.length).toBeGreaterThan(0);
    expect(report.blobHashes.length).toBeGreaterThan(0);
    for (const id of report.layerIds) expect(ofB.layers).not.toContain(id);
    for (const h of report.blobHashes) expect(ofB.blobs).not.toContain(h);
    expect(await seed.snapshot(b.tenantId)).toEqual(ofB);
  });

  it('narrows the layer pass to one repository and keeps the blob pass tenant-wide', async () => {
    const one = await freshScope();
    const two = await seed.freshRepo(one.tenantId);
    const ids: Record<string, string> = {};
    for (const [name, scope] of [
      ['one', one],
      ['two', two],
    ] as const) {
      const layer = await seed.published(scope, null, [{ path: 'p', gitBlobHash: sha() }]);
      await seed.replace(scope, layer, [{ path: 'p', gitBlobHash: null }]);
      ids[name] = layer.id;
    }
    const free = sha();
    await seed.blobs(one.tenantId, [free]);
    const report = await release(one.tenantId, { repositoryId: one.repositoryId });
    expect(report.layerIds).toEqual([ids.one]);
    expect(report.blobHashes).toEqual([free]);
    expect((await seed.snapshot(one.tenantId)).layers).toContain(ids.two);
  });

  it('after a repository delete, releases the blobs only it used, with contents and facts, and keeps the shared one', async () => {
    const first = await freshScope();
    const second = await seed.freshRepo(first.tenantId);
    const [shared, only] = [sha(), sha()];
    await seed.blobs(first.tenantId, [shared, only]);
    await seed.published(first, null, [
      { path: 'shared.ts', gitBlobHash: shared },
      { path: 'only.ts', gitBlobHash: only },
    ]);
    const kept = await seed.published(second, null, [{ path: 'shared.ts', gitBlobHash: shared }]);
    await seed.refHead(second, 'refs/heads/main', kept);

    await seed.deleteRepo(first);
    const report = await release(first.tenantId);
    expect(report).toEqual({ layerIds: [], blobHashes: [only], layerBatches: 1, blobBatches: 1 });
    expect(await seed.presence(first.tenantId, only)).toEqual({
      blob: false,
      contents: false,
      facts: 0,
    });
    expect(await seed.presence(first.tenantId, shared)).toEqual({
      blob: true,
      contents: true,
      facts: 1,
    });
  });

  it('waits for a staging writer under the shared lock, then spares the blob it pinned and its staged layer', async () => {
    const scope = await freshScope();
    const [pinned, free] = [sha(), sha()];
    await seed.blobs(scope.tenantId, [pinned, free]);

    const writer = await pool.connect();
    let stagedId: string;
    let sweep: ReturnType<typeof release>;
    try {
      await writer.query('BEGIN');
      await writer.query(BIND_TENANT_SQL, [seed.clientFor(scope.tenantId), scope.tenantId]);
      await lockTenantShared(writer, scope.tenantId);
      const row = await stageLayer(writer, { ...scope, commitSha: sha(), kind: 'base' }, [
        { path: 'pinned.ts', gitBlobHash: pinned },
      ]);
      stagedId = row.id;

      sweep = release(scope.tenantId);
      // The sweep's first batch is waiting on the exclusive lock the writer's shared one blocks.
      await withClient(db.ownerUrl, async (c) => {
        for (let i = 0; i < 200; i += 1) {
          const [w] = await queryRows<{ n: number }>(
            c,
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
          );
          if ((w as { n: number }).n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('the sweep never waited on the tenant lock');
      });
      await writer.query('COMMIT');
    } finally {
      writer.release();
    }

    const report = await sweep;
    expect(report.blobHashes).toEqual([free]);
    expect(report.layerIds).toEqual([]);
    expect(await seed.presence(scope.tenantId, pinned)).toMatchObject({ blob: true });
    expect((await seed.snapshot(scope.tenantId)).layers).toEqual([stagedId]);
  });

  it('answers an empty report with no delete for an empty tenant and for one holding only staged layers', async () => {
    const empty = await seed.freshTenant();
    const onlyStaged = await freshScope();
    const hash = sha();
    await seed.blobs(onlyStaged.tenantId, [hash]);
    const layer = await seed.staged(onlyStaged, null, [{ path: 'p', gitBlobHash: hash }]);
    const before = await seed.snapshot(onlyStaged.tenantId);

    log.clear();
    const nothing = { layerIds: [], blobHashes: [], layerBatches: 1, blobBatches: 1 };
    expect(await release(empty)).toEqual(nothing);
    expect(await release(onlyStaged.tenantId)).toEqual(nothing);
    expect(deletes()).toEqual([]);
    expect(await seed.snapshot(onlyStaged.tenantId)).toEqual(before);
    expect(before.layers).toEqual([layer.id]);
  });

  it('refuses a batch size that is not a positive integer before any statement', async () => {
    log.clear();
    await expect(release(fx.tenantA.id, { batchSize: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(release(fx.tenantA.id, { batchSize: 2.5 })).rejects.toBeInstanceOf(RangeError);
    expect(log.texts()).toEqual([]);
  });
});
