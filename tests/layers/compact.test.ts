import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readLayerSettings } from '../../src/config.js';
import { insertBlobIfAbsent } from '../../src/db/blobs.js';
import {
  appendLayerPaths,
  insertLayer,
  lockTenantExclusive,
  markPublished,
  markSuperseded,
  moveRefHead,
  readCurrentPublishedLayer,
  readLayerById,
  readRefHead,
  type LayerRow,
  type LayerScope,
  type PathEntry,
} from '../../src/db/layers.js';
import {
  compactLayer,
  COMPACTION_BATCH_SIZE,
  isCompactionDue,
  type CompactRequest,
} from '../../src/layers/compact.js';
import { resolveCommit, type Resolution } from '../../src/layers/resolution.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

const settings = readLayerSettings({});

let db: FreshDatabase;
let fx: TenancyFixture;
let pool: pg.Pool;
let log: QueryLog;
let web: LayerScope;
let globex: LayerScope;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  pool = new pg.Pool({ connectionString: db.appUrl, max: 8 });
  log = recordQueries(pool);
  const [a1] = fx.tenantA.repositories;
  const [b1] = fx.tenantB.repositories;
  if (a1 === undefined || b1 === undefined) throw new Error('fixture');
  web = { tenantId: fx.tenantA.id, repositoryId: a1.id };
  globex = { tenantId: fx.tenantB.id, repositoryId: b1.id };
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

function published(
  scope: LayerScope,
  parent: string | null,
  entries: PathEntry[],
  commitSha = sha(),
): Promise<LayerRow> {
  return bound(
    scope.tenantId,
    async (c) => {
      const layer =
        parent === null
          ? await insertLayer(c, { ...scope, commitSha, kind: 'base' })
          : await insertLayer(c, { ...scope, commitSha, kind: 'delta', parentLayerId: parent });
      for (let i = 0; i < entries.length; i += 500) {
        await appendLayerPaths(c, scope, layer.id, entries.slice(i, i + 500));
      }
      return markPublished(c, scope, layer.id);
    },
    true,
  );
}

/**
 * A chain `depth` deep over a base of `basePaths` paths; each delta changes
 * one path, adds one and tombstones one (the last base path, then the
 * previous delta's addition). Every hash gets a blob row.
 */
async function chain(
  scope: LayerScope,
  depth: number,
  basePaths = 25,
): Promise<{ top: LayerRow; layers: LayerRow[]; hashes: string[] }> {
  const hashes: string[] = [];
  const h = (): string => {
    const value = sha();
    hashes.push(value);
    return value;
  };
  const base = Array.from({ length: basePaths }, (_, i) => ({
    path: `src/f${String(i).padStart(4, '0')}.ts`,
    gitBlobHash: h(),
  }));
  const layers = [await published(scope, null, base)];
  for (let d = 1; d <= depth; d += 1) {
    const parent = layers[layers.length - 1] as LayerRow;
    layers.push(
      await published(scope, parent.id, [
        { path: `src/f${String(d).padStart(4, '0')}.ts`, gitBlobHash: h() },
        { path: `added/d${String(d)}.ts`, gitBlobHash: h() },
        {
          path:
            d === 1
              ? `src/f${String(basePaths - 1).padStart(4, '0')}.ts`
              : `added/d${String(d - 1)}.ts`,
          gitBlobHash: null,
        },
      ]),
    );
  }
  await bound(
    scope.tenantId,
    async (c) => {
      for (const gitBlobHash of hashes) {
        await insertBlobIfAbsent(c, {
          tenantId: scope.tenantId,
          gitBlobHash,
          sizeBytes: 1,
          outcome: 'unsupported',
          lossy: false,
        });
      }
    },
    true,
  );
  return { top: layers[layers.length - 1] as LayerRow, layers, hashes };
}

function request(scope: LayerScope, commitSha: string, extra: Partial<CompactRequest> = {}) {
  return {
    tenantId: scope.tenantId,
    clientId: clientFor(scope.tenantId),
    repositoryId: scope.repositoryId,
    commitSha,
    settings,
    ...extra,
  };
}

async function resolve(scope: LayerScope, commitSha: string): Promise<Resolution> {
  return bound(scope.tenantId, (c) =>
    resolveCommit(c, scope.tenantId, scope.repositoryId, commitSha),
  );
}

/** The paths on which two maps differ, printed instead of a count. */
function differences(a: Resolution, b: Resolution): string[] {
  if (a.state !== 'indexed' || b.state !== 'indexed') return [`${a.state} vs ${b.state}`];
  const out: string[] = [];
  for (const path of new Set([...a.paths.keys(), ...b.paths.keys()])) {
    if (a.paths.get(path) !== b.paths.get(path)) {
      out.push(`${path}: ${String(a.paths.get(path))} → ${String(b.paths.get(path))}`);
    }
  }
  return out;
}

/**
 * A pool that awaits `afterBatch(n)` after the n-th committed copy batch, on
 * the connection's own time, so a test can act between two batches.
 */
function between(afterBatch: (n: number) => Promise<void>): pg.Pool {
  const wrapped = Object.create(pool) as pg.Pool;
  let batches = 0;
  wrapped.connect = (async () => {
    const c = await pool.connect();
    const query = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
    let appended = false;
    (c as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
      if (text.startsWith('INSERT INTO codegraph.layer_paths')) appended = true;
      const result = await query(text, params);
      if (text === 'COMMIT' && appended) {
        appended = false;
        batches += 1;
        await afterBatch(batches);
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
  return wrapped;
}

async function snapshot(tenantId: string): Promise<unknown[]> {
  return withClient(db.ownerUrl, (c) =>
    queryRows(
      c,
      `SELECT git_blob_hash, outcome FROM codegraph.blob WHERE tenant_id = $1
        ORDER BY git_blob_hash`,
      [tenantId],
    ),
  );
}

describe('the due rule', () => {
  it('is strictly greater than the threshold', () => {
    expect(isCompactionDue(9, 8)).toBe(true);
    expect(isCompactionDue(8, 8)).toBe(false);
    expect(isCompactionDue(0, 8)).toBe(false);
  });

  it('answers not-due at or below the threshold and not-indexed without a current layer, writing nothing', async () => {
    const { top: atThreshold } = await chain(web, settings.compactionThreshold, 5);
    const base = await published(web, null, [{ path: 'a', gitBlobHash: sha() }]);
    const count = async () =>
      withClient(db.ownerUrl, async (c) => {
        const [row] = await queryRows<{ n: number }>(
          c,
          'SELECT (SELECT count(*) FROM codegraph.commit_layers) + (SELECT count(*) FROM codegraph.layer_paths) AS n',
        );
        return row?.n;
      });
    const before = await count();
    expect(await compactLayer(pool, request(web, atThreshold.commitSha))).toEqual({
      outcome: 'not_due',
      depth: settings.compactionThreshold,
      threshold: settings.compactionThreshold,
    });
    expect(await compactLayer(pool, request(web, base.commitSha))).toEqual({
      outcome: 'not_due',
      depth: 0,
      threshold: settings.compactionThreshold,
    });
    const stagedOnly = sha();
    await bound(
      web.tenantId,
      (c) => insertLayer(c, { ...web, commitSha: stagedOnly, kind: 'base' }),
      true,
    );
    const retiredOnly = await published(web, null, [], sha());
    await bound(web.tenantId, (c) => markSuperseded(c, web, retiredOnly.id), true);
    const afterSetup = await count();
    for (const commitSha of [sha(), stagedOnly, retiredOnly.commitSha]) {
      expect(await compactLayer(pool, request(web, commitSha))).toEqual({
        outcome: 'not_indexed',
      });
    }
    expect(await count()).toBe(afterSetup);
    expect(Number(afterSetup) - Number(before)).toBe(2);
  });
});

describe('compactLayer — the copy and the switch', () => {
  it('copies the whole map in bounded transactions, then switches: one current base, refs repointed, the replaced layer retired', async () => {
    const { top, layers } = await chain(web, settings.compactionThreshold + 1, 23);
    const descendant = await published(web, top.id, [{ path: 'desc.ts', gitBlobHash: sha() }]);
    await bound(
      web.tenantId,
      async (c) => {
        await moveRefHead(c, {
          ...web,
          refName: 'refs/heads/main',
          layerId: top.id,
          isDefaultBranch: true,
        });
        await moveRefHead(c, {
          ...web,
          refName: 'refs/tags/v1',
          layerId: top.id,
          isDefaultBranch: false,
        });
        await moveRefHead(c, {
          ...web,
          refName: 'refs/heads/old',
          layerId: (layers[2] as LayerRow).id,
          isDefaultBranch: false,
        });
      },
      true,
    );
    const before = await resolve(web, top.commitSha);
    const descendantBefore = await resolve(web, descendant.commitSha);
    const topBefore = await bound(web.tenantId, (c) => readLayerById(c, web, top.id));

    const seen: string[][] = [];
    log.clear();
    const result = await compactLayer(
      between(async () => {
        seen.push(differences(before, await resolve(web, top.commitSha)));
      }),
      request(web, top.commitSha, { batchSize: 7 }),
    );
    const size = before.state === 'indexed' ? before.paths.size : 0;
    expect(result).toMatchObject({
      outcome: 'compacted',
      replacedLayerId: top.id,
      pathsWritten: size,
    });
    if (result.outcome !== 'compacted') throw new Error('not compacted');
    expect(seen).toEqual(Array.from({ length: Math.ceil(size / 7) }, () => []));

    // No transaction wrote more than one batch, or stayed open across two.
    const texts = log.texts();
    let open = 0;
    for (const t of texts) {
      if (t === 'BEGIN') open = 0;
      if (t.startsWith('INSERT INTO codegraph.layer_paths')) open += 1;
      expect(open).toBeLessThanOrEqual(1);
    }
    const insertLayerAt = texts.findIndex((t) =>
      t.startsWith('INSERT INTO codegraph.commit_layers'),
    );
    const firstAppendAt = texts.findIndex((t) => t.startsWith('INSERT INTO codegraph.layer_paths'));
    expect(insertLayerAt).toBeGreaterThan(-1);
    expect(insertLayerAt).toBeLessThan(firstAppendAt);

    const after = await resolve(web, top.commitSha);
    expect(differences(before, after)).toEqual([]);
    expect(after.state === 'indexed' && after.layerId).toBe(result.baseLayerId);
    const base = await bound(web.tenantId, (c) => readLayerById(c, web, result.baseLayerId));
    expect(base).toMatchObject({ kind: 'base', depth: 0, state: 'published', parentLayerId: null });
    const rows = await withClient(db.ownerUrl, (c) =>
      queryRows<{ path: string; git_blob_hash: string | null }>(
        c,
        'SELECT path, git_blob_hash FROM codegraph.layer_paths WHERE layer_id = $1',
        [result.baseLayerId],
      ),
    );
    expect(rows.every((r) => r.git_blob_hash !== null)).toBe(true);
    expect(new Map(rows.map((r) => [r.path, r.git_blob_hash]))).toEqual(
      before.state === 'indexed' ? before.paths : null,
    );

    expect(await bound(web.tenantId, (c) => readLayerById(c, web, top.id))).toEqual({
      ...topBefore,
      supersededAt: result.supersededAt,
    });
    const currents = await withClient(db.ownerUrl, (c) =>
      queryRows(
        c,
        `SELECT id FROM codegraph.commit_layers
          WHERE commit_sha = $1 AND state = 'published' AND superseded_at IS NULL`,
        [top.commitSha],
      ),
    );
    expect(currents).toEqual([{ id: result.baseLayerId }]);
    expect(await resolve(web, descendant.commitSha)).toEqual(descendantBefore);

    await bound(web.tenantId, async (c) => {
      expect(await readRefHead(c, web, 'refs/heads/main')).toMatchObject({
        layerId: result.baseLayerId,
        commitSha: top.commitSha,
        isDefaultBranch: true,
      });
      expect(await readRefHead(c, web, 'refs/tags/v1')).toMatchObject({
        layerId: result.baseLayerId,
        isDefaultBranch: false,
      });
      expect(await readRefHead(c, web, 'refs/heads/old')).toMatchObject({
        layerId: (layers[2] as LayerRow).id,
      });
    });
    expect(COMPACTION_BATCH_SIZE).toBe(1_000);
  });

  it('answers no-longer-current when another layer became current, changing nothing and leaving the base staged', async () => {
    const { top } = await chain(web, settings.compactionThreshold + 1, 6);
    let racer: LayerRow | undefined;
    const result = await compactLayer(
      between(async (n) => {
        if (n !== 1) return;
        racer = await bound(
          web.tenantId,
          async (c) => {
            await markSuperseded(c, web, top.id);
            const l = await insertLayer(c, { ...web, commitSha: top.commitSha, kind: 'base' });
            return markPublished(c, web, l.id);
          },
          true,
        );
      }),
      request(web, top.commitSha, { batchSize: 100 }),
    );
    expect(result).toMatchObject({
      outcome: 'no_longer_current',
      copiedLayerId: top.id,
      currentLayerId: racer?.id,
    });
    if (result.outcome !== 'no_longer_current') throw new Error('switched');
    expect(
      await bound(web.tenantId, (c) => readLayerById(c, web, result.baseLayerId)),
    ).toMatchObject({ state: 'staged' });
    const paths = await withClient(db.ownerUrl, (c) =>
      queryRows(c, 'SELECT 1 FROM codegraph.layer_paths WHERE layer_id = $1', [result.baseLayerId]),
    );
    expect(paths.length).toBeGreaterThan(0);

    // A re-read that finds no current layer at all refuses the same way.
    const { top: second } = await chain(web, settings.compactionThreshold + 1, 6);
    const gone = await compactLayer(
      between(async (n) => {
        if (n === 1) await bound(web.tenantId, (c) => markSuperseded(c, web, second.id), true);
      }),
      request(web, second.commitSha, { batchSize: 100 }),
    );
    expect(gone).toMatchObject({ outcome: 'no_longer_current', currentLayerId: null });
    expect(
      await bound(web.tenantId, (c) => readCurrentPublishedLayer(c, web, second.commitSha)),
    ).toBeNull();
  });
});

describe('compactLayer — blobs, the lock and tenancy', () => {
  it('releases nothing, and a release between two batches cannot take a blob the map names', async () => {
    const { top, hashes } = await chain(web, settings.compactionThreshold + 1, 12);
    const orphan = sha();
    await bound(
      web.tenantId,
      (c) =>
        insertBlobIfAbsent(c, {
          tenantId: web.tenantId,
          gitBlobHash: orphan,
          sizeBytes: 1,
          outcome: 'binary',
        }),
      true,
    );
    const before = await resolve(web, top.commitSha);
    const result = await compactLayer(
      between(async (n) => {
        if (n !== 1) return;
        // A release: under the exclusive lock, every blob no layer path names goes.
        await withClient(db.ownerUrl, async (c) => {
          await c.query('BEGIN');
          await lockTenantExclusive(c, web.tenantId);
          await c.query(
            `DELETE FROM codegraph.blob b WHERE b.tenant_id = $1 AND NOT EXISTS (
               SELECT 1 FROM codegraph.layer_paths p
                WHERE p.tenant_id = b.tenant_id AND p.git_blob_hash = b.git_blob_hash)`,
            [web.tenantId],
          );
          await c.query('COMMIT');
        });
      }),
      request(web, top.commitSha, { batchSize: 5 }),
    );
    expect(result.outcome).toBe('compacted');
    const stored = new Set(
      ((await snapshot(web.tenantId)) as { git_blob_hash: string }[]).map((r) => r.git_blob_hash),
    );
    expect(stored.has(orphan)).toBe(false);
    const after = await resolve(web, top.commitSha);
    expect(differences(before, after)).toEqual([]);
    for (const hash of after.state === 'indexed' ? after.paths.values() : []) {
      expect(stored.has(hash)).toBe(true);
    }
    expect(hashes.length).toBeGreaterThan(0);

    // A compaction with no release beside it leaves every blob row as it was.
    const { top: quiet } = await chain(web, settings.compactionThreshold + 1, 8);
    const blobsBefore = await snapshot(web.tenantId);
    expect((await compactLayer(pool, request(web, quiet.commitSha))).outcome).toBe('compacted');
    expect(await snapshot(web.tenantId)).toEqual(blobsBefore);
  });

  it('takes the tenant lock shared in each batch: a batch waits for an exclusive holder to end', async () => {
    const { top } = await chain(web, settings.compactionThreshold + 1, 4);
    const order: string[] = [];
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(BIND_TENANT_SQL, [fx.readerId, web.tenantId]);
      await lockTenantExclusive(holder, web.tenantId);
      const running = compactLayer(
        between((n) => {
          order.push(`batch ${String(n)} committed`);
          return Promise.resolve();
        }),
        request(web, top.commitSha),
      ).then((r) => {
        order.push('compaction done');
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push('holder commits');
      await holder.query('COMMIT');
      expect((await running).outcome).toBe('compacted');
    } finally {
      await holder.end();
    }
    expect(order).toEqual(['holder commits', 'batch 1 committed', 'compaction done']);
  });

  it("leaves another tenant's rows untouched and compacts nothing for an unbound session", async () => {
    const { top } = await chain(web, settings.compactionThreshold + 1, 6);
    // Tenant B holds the same commit sha, at the same depth.
    const theirBase = await published(globex, null, [{ path: 'theirs', gitBlobHash: sha() }]);
    let parent = theirBase;
    for (let d = 1; d <= settings.compactionThreshold; d += 1) {
      parent = await published(globex, parent.id, [{ path: `t${String(d)}`, gitBlobHash: sha() }]);
    }
    const theirTop = await published(globex, parent.id, [], top.commitSha);
    const theirMap = await resolve(globex, top.commitSha);
    const theirRows = () =>
      withClient(db.ownerUrl, (c) =>
        queryRows(
          c,
          `SELECT id, state, superseded_at FROM codegraph.commit_layers
            WHERE tenant_id = $1 ORDER BY id`,
          [globex.tenantId],
        ),
      );
    const rowsBefore = await theirRows();

    // The reader holds no grant on tenant B: its bound view is empty.
    expect(
      await compactLayer(pool, {
        ...request(globex, top.commitSha),
        clientId: fx.readerId,
      }),
    ).toEqual({ outcome: 'not_indexed' });

    expect((await compactLayer(pool, request(web, top.commitSha))).outcome).toBe('compacted');
    expect(await theirRows()).toEqual(rowsBefore);
    expect(await resolve(globex, top.commitSha)).toEqual(theirMap);
    expect(theirMap.state === 'indexed' && theirMap.layerId).toBe(theirTop.id);
  });

  it('refuses a batch size that is not a positive integer', async () => {
    await expect(compactLayer(pool, request(web, sha(), { batchSize: 0 }))).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
