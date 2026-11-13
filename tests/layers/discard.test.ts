import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readLayerSettings } from '../../src/config.js';
import {
  appendLayerPaths,
  insertLayer,
  listReferencedBlobHashes,
  lockTenantExclusive,
  markPublished,
  type LayerRow,
  type LayerScope,
  type PathEntry,
} from '../../src/db/layers.js';
import {
  DISCARD_BATCH_SIZE,
  discardStaleLayers,
  TenantNotBoundError,
  type DiscardRequest,
} from '../../src/layers/discard.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

const HOUR = 60 * 60 * 1000;
// Built by the test, never read from the environment: a one-hour window.
const settings = { ...readLayerSettings({}), stagedLayerStaleness: HOUR };

let db: FreshDatabase;
let fx: TenancyFixture;
let pool: pg.Pool;
let log: QueryLog;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  log = recordQueries(pool);
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

/** A fresh repository of its own for each case, so sweeps do not see each other's rows. */
async function freshRepo(tenantId = fx.tenantA.id): Promise<LayerScope> {
  const id = await withClient(db.appUrl, async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.client_id', $1, true)", [fx.operatorId]);
    const [row] = await queryRows<{ id: string }>(
      c,
      'SELECT codegraph.codegraph_register_repository($1, $2) AS id',
      [tenantId, `repo-${sha().slice(0, 8)}`],
    );
    await c.query('COMMIT');
    return (row as { id: string }).id;
  });
  return { tenantId, repositoryId: id };
}

async function bound<T>(
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
  commit = false,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(BIND_TENANT_SQL, [clientFor(tenantId), tenantId]);
    const result = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

/** A staged base with `entries`, its staged time moved `ageMs` into the past. */
async function staged(scope: LayerScope, entries: PathEntry[], ageMs: number): Promise<LayerRow> {
  const layer = await bound(
    scope.tenantId,
    async (c) => {
      const l = await insertLayer(c, { ...scope, commitSha: sha(), kind: 'base' });
      await appendLayerPaths(c, scope, l.id, entries);
      return l;
    },
    true,
  );
  await withClient(db.ownerUrl, (c) =>
    c.query(
      "UPDATE codegraph.commit_layers SET staged_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1",
      [layer.id, String(ageMs)],
    ),
  );
  return layer;
}

async function publishedOld(scope: LayerScope, entries: PathEntry[]): Promise<LayerRow> {
  const layer = await staged(scope, entries, 3 * HOUR);
  return bound(scope.tenantId, (c) => markPublished(c, scope, layer.id), true);
}

function sweep(scope: LayerScope, extra: Partial<DiscardRequest> = {}) {
  return discardStaleLayers(pool, {
    clientId: clientFor(scope.tenantId),
    tenantId: scope.tenantId,
    settings,
    repositoryId: scope.repositoryId,
    ...extra,
  });
}

async function exists(layerId: string): Promise<{ layer: boolean; paths: number }> {
  return withClient(db.ownerUrl, async (c) => {
    const [row] = await queryRows<{ layer: boolean; paths: number }>(
      c,
      `SELECT EXISTS (SELECT 1 FROM codegraph.commit_layers WHERE id = $1) AS layer,
              (SELECT count(*)::int FROM codegraph.layer_paths WHERE layer_id = $1) AS paths`,
      [layerId],
    );
    return row as { layer: boolean; paths: number };
  });
}

async function referenced(tenantId: string): Promise<Set<string>> {
  const all = new Set<string>();
  let after: string | null = null;
  do {
    const page = await bound(tenantId, (c) => listReferencedBlobHashes(c, tenantId, { after }));
    for (const h of page.hashes) all.add(h);
    after = page.next;
  } while (after !== null);
  return all;
}

describe('discardStaleLayers', () => {
  it('removes only stale staged layers, with their paths, and releases their pins', async () => {
    const scope = await freshRepo();
    const [onlyStale, shared, young] = [sha(), sha(), sha()];
    const stale = await staged(
      scope,
      [
        { path: 'a', gitBlobHash: onlyStale },
        { path: 'b', gitBlobHash: shared },
        { path: 'gone', gitBlobHash: null },
      ],
      2 * HOUR,
    );
    const fresh = await staged(scope, [{ path: 'y', gitBlobHash: young }], HOUR / 2);
    const old = await publishedOld(scope, [{ path: 'b', gitBlobHash: shared }]);
    const before = await referenced(scope.tenantId);
    expect(before.has(onlyStale)).toBe(true);

    const now = new Date();
    const result = await sweep(scope, { now });
    expect(result).toEqual({
      cutoff: new Date(now.getTime() - HOUR),
      layerIds: [stale.id],
      pathCount: 3,
    });
    expect(await exists(stale.id)).toEqual({ layer: false, paths: 0 });
    expect(await exists(fresh.id)).toEqual({ layer: true, paths: 1 });
    expect(await exists(old.id)).toEqual({ layer: true, paths: 1 });
    const after = await referenced(scope.tenantId);
    expect(after.has(onlyStale)).toBe(false);
    expect(after.has(shared)).toBe(true);
    expect(after.has(young)).toBe(true);

    // A second run with the same clock removes nothing.
    expect(await sweep(scope, { now })).toEqual({
      cutoff: result.cutoff,
      layerIds: [],
      pathCount: 0,
    });
    // Moving the clock (rather than waiting) makes the young layer stale too.
    expect((await sweep(scope, { now: new Date(now.getTime() + HOUR) })).layerIds).toEqual([
      fresh.id,
    ]);
  });

  it('finishes in bounded batches: three batches of stale layers in one call, none larger than the bound', async () => {
    const scope = await freshRepo();
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      ids.push((await staged(scope, [{ path: `p${String(i)}`, gitBlobHash: sha() }], 2 * HOUR)).id);
    }
    log.clear();
    const result = await sweep(scope, { batchSize: 3 });
    expect(new Set(result.layerIds)).toEqual(new Set(ids));
    expect(result.pathCount).toBe(9);
    // Each batch transaction carries one guarded delete of at most three layers.
    const texts = log.texts();
    const deletes = texts.filter((t) => t.startsWith('WITH doomed AS'));
    expect(deletes).toHaveLength(3);
    let inTx = 0;
    for (const t of texts) {
      if (t === 'BEGIN') inTx = 0;
      if (t.startsWith('WITH doomed AS')) inTx += 1;
      expect(inTx).toBeLessThanOrEqual(1);
    }
    expect(DISCARD_BATCH_SIZE).toBe(500);
  });

  it('never removes a layer a ref head names, and its cursor moves past it so the run ends', async () => {
    const scope = await freshRepo();
    const named = await staged(scope, [{ path: 'n', gitBlobHash: sha() }], 5 * HOUR);
    const other = await staged(scope, [{ path: 'o', gitBlobHash: sha() }], 4 * HOUR);
    // Only the owner can point a ref head at a staged layer; the guard holds regardless.
    await withClient(db.ownerUrl, (c) =>
      c.query(
        `INSERT INTO codegraph.ref_heads (tenant_id, repository_id, ref_name, commit_sha, layer_id)
         VALUES ($1, $2, 'refs/heads/odd', $3, $4)`,
        [scope.tenantId, scope.repositoryId, named.commitSha, named.id],
      ),
    );
    const result = await sweep(scope, { batchSize: 1 });
    expect(result.layerIds).toEqual([other.id]);
    expect(await exists(named.id)).toEqual({ layer: true, paths: 1 });
  });

  it('leaves a candidate that published between the read and the delete, and does not offer it again', async () => {
    const scope = await freshRepo();
    const racer = await staged(scope, [{ path: 'r', gitBlobHash: sha() }], 2 * HOUR);
    const plain = await staged(scope, [{ path: 's', gitBlobHash: sha() }], 2 * HOUR - 1000);
    const racing = Object.create(pool) as pg.Pool;
    let published = false;
    racing.connect = (async () => {
      const c = await pool.connect();
      const query = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
      (c as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
        const result = await query(text, params);
        if (text.includes('AS "stagedAt"') && !published) {
          published = true;
          await bound(scope.tenantId, (o) => markPublished(o, scope, racer.id), true);
        }
        return result;
      };
      const release = c.release.bind(c);
      c.release = (err?: Error | boolean) => {
        (c as unknown as { query: unknown }).query = query;
        release(err);
      };
      return c;
    }) as pg.Pool['connect'];
    log.clear();
    const result = await discardStaleLayers(racing, {
      clientId: fx.readerId,
      tenantId: scope.tenantId,
      settings,
      repositoryId: scope.repositoryId,
      batchSize: 1,
    });
    expect(result.layerIds).toEqual([plain.id]);
    expect(await exists(racer.id)).toEqual({ layer: true, paths: 1 });
  });

  it('takes the tenant lock shared in the deleting transaction: it waits for an exclusive holder', async () => {
    const scope = await freshRepo();
    const layer = await staged(scope, [{ path: 'l', gitBlobHash: sha() }], 2 * HOUR);
    const order: string[] = [];
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(BIND_TENANT_SQL, [fx.readerId, scope.tenantId]);
      await lockTenantExclusive(holder, scope.tenantId);
      const running = sweep(scope).then((r) => {
        order.push('sweep done');
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await exists(layer.id)).toEqual({ layer: true, paths: 1 });
      order.push('holder commits');
      await holder.query('COMMIT');
      expect((await running).layerIds).toEqual([layer.id]);
    } finally {
      await holder.end();
    }
    expect(order).toEqual(['holder commits', 'sweep done']);
  });

  it('scopes to the bound tenant, filters by repository, and leaves ref heads and blobs unchanged', async () => {
    const a1 = await freshRepo();
    const a2 = await freshRepo();
    const b = await freshRepo(fx.tenantB.id);
    const inA1 = await staged(a1, [{ path: 'x', gitBlobHash: sha() }], 2 * HOUR);
    const inA2 = await staged(a2, [{ path: 'x', gitBlobHash: sha() }], 2 * HOUR);
    const inB = await staged(b, [{ path: 'x', gitBlobHash: sha() }], 2 * HOUR);
    const snapshot = () =>
      withClient(db.ownerUrl, (c) =>
        queryRows(
          c,
          `SELECT (SELECT count(*) FROM codegraph.blob) AS blobs,
                  (SELECT coalesce(json_agg(r ORDER BY r.ref_name), '[]') FROM codegraph.ref_heads r) AS refs`,
        ),
      );
    const before = await snapshot();

    // Bound to tenant B: none of A's rows go.
    const asB = await discardStaleLayers(pool, {
      clientId: fx.operatorId,
      tenantId: fx.tenantB.id,
      settings,
    });
    expect(asB.layerIds).toEqual([inB.id]);
    expect((await exists(inA1.id)).layer).toBe(true);

    // Filtered to a1: a2 stays.
    expect((await sweep(a1)).layerIds).toEqual([inA1.id]);
    expect((await exists(inA2.id)).layer).toBe(true);

    // Unfiltered: every repository of the tenant.
    const all = await discardStaleLayers(pool, {
      clientId: fx.readerId,
      tenantId: fx.tenantA.id,
      settings,
    });
    expect(all.layerIds).toContain(inA2.id);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a session with no live grant on the tenant before reading anything', async () => {
    const b = await freshRepo(fx.tenantB.id);
    const layer = await staged(b, [{ path: 'x', gitBlobHash: sha() }], 2 * HOUR);
    log.clear();
    const attempt = discardStaleLayers(pool, {
      clientId: fx.readerId,
      tenantId: fx.tenantB.id,
      settings,
    });
    await expect(attempt).rejects.toBeInstanceOf(TenantNotBoundError);
    await expect(attempt).rejects.toMatchObject({
      tenantId: fx.tenantB.id,
      clientId: fx.readerId,
    });
    expect(log.texts().some((t) => t.includes('AS "stagedAt"'))).toBe(false);
    expect((await exists(layer.id)).layer).toBe(true);
  });

  it('refuses a batch size that is not a positive integer before any statement', async () => {
    const scope = await freshRepo();
    log.clear();
    for (const batchSize of [0, -1, 1.5]) {
      await expect(sweep(scope, { batchSize })).rejects.toBeInstanceOf(RangeError);
    }
    expect(log.texts()).toEqual([]);
  });
});
