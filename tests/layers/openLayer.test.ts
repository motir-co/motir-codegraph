import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readLayerSettings } from '../../src/config.js';
import {
  appendLayerPaths,
  findNearestPublishedAncestor,
  insertLayer,
  listStagedLayersOfCommit,
  lockTenantExclusive,
  markPublished,
  moveRefHead,
  readRefHead,
  type LayerRow,
  type LayerScope,
  type PathEntry,
} from '../../src/db/layers.js';
import {
  compareBytewise,
  LayerInputRefused,
  openLayer,
  stageLayer,
  STAGE_BATCH_SIZE,
  type OpenLayerInput,
} from '../../src/layers/openLayer.js';
import { RESOLVE_COMMIT_SQL, resolveCommit } from '../../src/layers/resolution.js';
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
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
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

const blob = (n: number): string => n.toString(16).padStart(40, '0');

function clientFor(tenantId: string): string {
  return tenantId === fx.tenantA.id ? fx.readerId : fx.operatorId;
}

function input(
  scope: LayerScope,
  paths: Record<string, string> | Map<string, string>,
  extra: Partial<OpenLayerInput> = {},
): OpenLayerInput {
  return {
    clientId: clientFor(scope.tenantId),
    tenantId: scope.tenantId,
    repositoryId: scope.repositoryId,
    commitSha: sha(),
    refName: 'refs/heads/main',
    isDefaultBranch: true,
    candidateAncestors: [],
    paths: paths instanceof Map ? paths : new Map(Object.entries(paths)),
    settings,
    ...extra,
  };
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

/** Publishes a layer straight through the repository (a base when `parent` is null). */
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
      await appendLayerPaths(c, scope, layer.id, entries);
      return markPublished(c, scope, layer.id);
    },
    true,
  );
}

function publish(scope: LayerScope, layerId: string): Promise<LayerRow> {
  return bound(scope.tenantId, (c) => markPublished(c, scope, layerId), true);
}

/** Every layer row and path row of a commit, seen as the owner (every tenant). */
async function rowsOf(commitSha: string): Promise<{ layers: number; paths: number }> {
  return withClient(db.ownerUrl, async (c) => {
    const [row] = await queryRows<{ layers: number; paths: number }>(
      c,
      `SELECT (SELECT count(*)::int FROM codegraph.commit_layers WHERE commit_sha = $1) AS layers,
              (SELECT count(*)::int FROM codegraph.layer_paths p
                 JOIN codegraph.commit_layers l ON l.id = p.layer_id
                WHERE l.commit_sha = $1) AS paths`,
      [commitSha],
    );
    return row as { layers: number; paths: number };
  });
}

async function storedEntries(layerId: string): Promise<PathEntry[]> {
  return withClient(db.ownerUrl, (c) =>
    queryRows<PathEntry>(
      c,
      `SELECT path, git_blob_hash AS "gitBlobHash" FROM codegraph.layer_paths
        WHERE layer_id = $1 ORDER BY path COLLATE "C"`,
      [layerId],
    ),
  );
}

/**
 * A pool whose connections pass every (text, params) query through `rewrite`
 * first, so a test can make two reads disagree or a write fail on the real
 * database.
 */
function intercept(
  rewrite: (
    text: string,
    params: unknown[] | undefined,
  ) => { text: string; params: unknown[] | undefined },
): pg.Pool {
  const wrapped = Object.create(pool) as pg.Pool;
  wrapped.connect = (async () => {
    const c = await pool.connect();
    const query = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
    // Async, so a rewrite that throws becomes a rejected query like a real failure.
    const patched = async (text: string, params?: unknown[]): Promise<unknown> => {
      const next = rewrite(text, params);
      return query(next.text, next.params);
    };
    (c as unknown as { query: unknown }).query = patched;
    const release = c.release.bind(c);
    c.release = (err?: Error | boolean) => {
      (c as unknown as { query: unknown }).query = query;
      release(err);
    };
    return c;
  }) as pg.Pool['connect'];
  return wrapped;
}

describe('openLayer — a base', () => {
  it('writes one staged base holding exactly the map, in byte-wise path order, readable by nothing', async () => {
    // UTF-16 order puts the emoji first; byte order puts the fullwidth z first.
    const paths = { 'src/😀.ts': blob(1), 'src/ｚ.ts': blob(2), 'README.md': blob(3) };
    const opened = await openLayer(pool, input(web, paths));
    expect(opened).toMatchObject({
      kind: 'base',
      depth: 0,
      parentLayerId: null,
      chain: [opened.layerId],
      state: 'staged',
      ancestorCommit: null,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
    });
    const expected = [
      { path: 'README.md', gitBlobHash: blob(3) },
      { path: 'src/ｚ.ts', gitBlobHash: blob(2) },
      { path: 'src/😀.ts', gitBlobHash: blob(1) },
    ];
    expect(opened.entries).toEqual(expected);
    expect(await storedEntries(opened.layerId)).toEqual(expected);
    expect(compareBytewise('src/ｚ.ts', 'src/😀.ts')).toBeLessThan(0);

    const commitSha = await withClient(db.ownerUrl, async (c) => {
      const [row] = await queryRows<{ commit_sha: string }>(
        c,
        'SELECT commit_sha FROM codegraph.commit_layers WHERE id = $1',
        [opened.layerId],
      );
      return (row as { commit_sha: string }).commit_sha;
    });
    await bound(web.tenantId, async (c) => {
      expect(await resolveCommit(c, web.tenantId, web.repositoryId, commitSha)).toEqual({
        state: 'not_indexed',
      });
      expect(await findNearestPublishedAncestor(c, web, [commitSha])).toBeNull();
    });
  });

  it('writes a base with no path rows for an empty map, and pins unstored blobs without reading the blob table', async () => {
    log.clear();
    const empty = await openLayer(pool, input(web, {}));
    expect(empty).toMatchObject({ kind: 'base', entries: [] });
    expect(await storedEntries(empty.layerId)).toEqual([]);
    const unstored = await openLayer(pool, input(web, { 'a.bin': 'f'.repeat(64) }));
    expect(await storedEntries(unstored.layerId)).toEqual([
      { path: 'a.bin', gitBlobHash: 'f'.repeat(64) },
    ]);
    expect(log.texts().filter((t) => /codegraph\.(blobs|blob_contents|facts)\b/.test(t))).toEqual(
      [],
    );
  });

  it('falls back to a base when the ancestor lookup answers a commit that does not resolve', async () => {
    const ancestor = await published(web, null, [{ path: 'a', gitBlobHash: blob(1) }]);
    // Make the two reads disagree: the resolution is asked about a commit with no layer.
    const disagreeing = intercept((text, params) =>
      text === RESOLVE_COMMIT_SQL && params !== undefined
        ? { text, params: [params[0], params[1], sha()] }
        : { text, params },
    );
    const opened = await openLayer(
      disagreeing,
      input(web, { a: blob(1), b: blob(2) }, { candidateAncestors: [ancestor.commitSha] }),
    );
    expect(opened).toMatchObject({ kind: 'base', depth: 0, ancestorCommit: null });
    expect(opened.entries).toEqual([
      { path: 'a', gitBlobHash: blob(1) },
      { path: 'b', gitBlobHash: blob(2) },
    ]);
  });
});

describe('openLayer — a delta', () => {
  it('holds exactly the changed and added paths plus one tombstone per deleted path', async () => {
    const ancestor = await published(web, null, [
      { path: 'a', gitBlobHash: blob(1) },
      { path: 'b', gitBlobHash: blob(2) },
      { path: 'c', gitBlobHash: blob(3) },
      { path: 'd', gitBlobHash: blob(4) },
      { path: 'e', gitBlobHash: blob(5) },
    ]);
    const opened = await openLayer(
      pool,
      input(
        web,
        { a: blob(11), b: blob(12), c: blob(13), d: blob(4), f: blob(6) },
        { candidateAncestors: [sha(), ancestor.commitSha] },
      ),
    );
    expect(opened).toMatchObject({
      kind: 'delta',
      parentLayerId: ancestor.id,
      depth: 1,
      chain: [opened.layerId, ancestor.id],
      ancestorCommit: ancestor.commitSha,
      state: 'staged',
    });
    const expected = [
      { path: 'a', gitBlobHash: blob(11) },
      { path: 'b', gitBlobHash: blob(12) },
      { path: 'c', gitBlobHash: blob(13) },
      { path: 'e', gitBlobHash: null },
      { path: 'f', gitBlobHash: blob(6) },
    ];
    expect(opened.entries).toEqual(expected);
    expect(await storedEntries(opened.layerId)).toEqual(expected);
  });

  it("compares against the ancestor's resolved map, so a re-added tombstoned path is an ordinary entry", async () => {
    const base = await published(web, null, [
      { path: 'x', gitBlobHash: blob(1) },
      { path: 'y', gitBlobHash: blob(2) },
      { path: 'z', gitBlobHash: blob(3) },
    ]);
    const tombstoned = await published(web, base.id, [{ path: 'y', gitBlobHash: null }]);
    const opened = await openLayer(
      pool,
      input(
        web,
        { x: blob(1), y: blob(2), z: blob(3) },
        { candidateAncestors: [tombstoned.commitSha] },
      ),
    );
    // z is unchanged against the value in force, though the nearest layer never mentioned it.
    expect(opened.entries).toEqual([{ path: 'y', gitBlobHash: blob(2) }]);
    expect(opened.depth).toBe(2);
    expect(opened.chain).toEqual([opened.layerId, tombstoned.id, base.id]);
  });

  it('writes a base over a parent whose chain is at the configured ceiling, and a delta one below it', async () => {
    expect(settings.hardCeiling).toBe(32);
    const layers: LayerRow[] = [await published(web, null, [{ path: 'p', gitBlobHash: blob(0) }])];
    for (let depth = 1; depth < settings.hardCeiling; depth += 1) {
      const parent = layers[layers.length - 1] as LayerRow;
      layers.push(
        await published(web, parent.id, [{ path: `p${String(depth)}`, gitBlobHash: blob(depth) }]),
      );
    }
    const atCeiling = layers[settings.hardCeiling - 1] as LayerRow;
    const below = layers[settings.hardCeiling - 2] as LayerRow;
    expect(atCeiling.chain).toHaveLength(settings.hardCeiling);

    const over = await openLayer(
      pool,
      input(web, { p: blob(0), extra: blob(99) }, { candidateAncestors: [atCeiling.commitSha] }),
    );
    expect(over).toMatchObject({ kind: 'base', depth: 0, parentLayerId: null });
    expect(over.entries).toEqual([
      { path: 'extra', gitBlobHash: blob(99) },
      { path: 'p', gitBlobHash: blob(0) },
    ]);

    const under = await openLayer(
      pool,
      input(web, { p: blob(0), extra: blob(99) }, { candidateAncestors: [below.commitSha] }),
    );
    expect(under).toMatchObject({
      kind: 'delta',
      depth: below.depth + 1,
      parentLayerId: below.id,
    });
    expect(under.chain).toEqual([under.layerId, ...below.chain]);
    expect(under.chain).toHaveLength(settings.hardCeiling);
    // Every path of the ancestor except p is deleted; extra is new.
    expect(under.entries.filter((e) => e.gitBlobHash !== null)).toEqual([
      { path: 'extra', gitBlobHash: blob(99) },
    ]);
    expect(under.entries.filter((e) => e.gitBlobHash === null)).toHaveLength(
      settings.hardCeiling - 2,
    );
  });

  it('writes a non-default commit as a delta of its own changes and moves no ref head', async () => {
    const main = await published(web, null, [{ path: 'a', gitBlobHash: blob(1) }]);
    await bound(
      web.tenantId,
      (c) =>
        moveRefHead(c, {
          ...web,
          refName: 'refs/heads/main',
          layerId: main.id,
          isDefaultBranch: true,
        }),
      true,
    );
    const feature = input(
      web,
      { a: blob(1), b: blob(2) },
      {
        refName: 'refs/heads/feature',
        isDefaultBranch: false,
        candidateAncestors: [main.commitSha],
      },
    );
    const opened = await openLayer(pool, feature);
    expect(opened).toMatchObject({
      kind: 'delta',
      refName: 'refs/heads/feature',
      isDefaultBranch: false,
    });
    expect(opened.entries).toEqual([{ path: 'b', gitBlobHash: blob(2) }]);
    await bound(web.tenantId, async (c) => {
      expect(await readRefHead(c, web, 'refs/heads/feature')).toBeNull();
      expect(await readRefHead(c, web, 'refs/heads/main')).toMatchObject({
        commitSha: main.commitSha,
        layerId: main.id,
      });
    });
    // The same commit, map and candidates under another ref: the same entries.
    const again = await openLayer(pool, {
      ...feature,
      refName: 'refs/heads/other',
      isDefaultBranch: true,
    });
    expect(again.entries).toEqual(opened.entries);
    expect(again.refName).toBe('refs/heads/other');
  });
});

describe('openLayer — re-opening a commit', () => {
  it('answers a published layer as stored and writes nothing', async () => {
    const ancestor = await published(web, null, [
      { path: 'a', gitBlobHash: blob(1) },
      { path: 'gone', gitBlobHash: blob(2) },
    ]);
    const first = input(web, { a: blob(3) }, { candidateAncestors: [ancestor.commitSha] });
    const opened = await openLayer(pool, first);
    await publish(web, opened.layerId);
    const before = await rowsOf(first.commitSha);
    const reopened = await openLayer(pool, {
      ...first,
      paths: new Map([['other', blob(9)]]),
      candidateAncestors: [],
    });
    expect(reopened).toEqual({ ...opened, state: 'published' });
    expect(await rowsOf(first.commitSha)).toEqual(before);

    const base = input(web, { k: blob(1) });
    const baseOpened = await openLayer(pool, base);
    await publish(web, baseOpened.layerId);
    expect(await openLayer(pool, base)).toMatchObject({
      layerId: baseOpened.layerId,
      ancestorCommit: null,
      state: 'published',
    });
  });

  it('replaces a staged layer with exactly one fresh staged layer', async () => {
    const first = input(web, { a: blob(1), b: blob(2) });
    const stale = await openLayer(pool, first);
    const fresh = await openLayer(pool, { ...first, paths: new Map([['a', blob(1)]]) });
    expect(fresh.layerId).not.toBe(stale.layerId);
    const staged = await bound(web.tenantId, (c) =>
      listStagedLayersOfCommit(c, web, first.commitSha),
    );
    expect(staged.map((l) => l.id)).toEqual([fresh.layerId]);
    expect(await rowsOf(first.commitSha)).toEqual({ layers: 1, paths: 1 });
    expect(await storedEntries(stale.layerId)).toEqual([]);
  });

  it('answers the same entries for the same map, whatever else the caller supplies', async () => {
    const ancestor = await published(web, null, [{ path: 'a', gitBlobHash: blob(1) }]);
    const once = input(
      web,
      { a: blob(2), b: blob(3) },
      { candidateAncestors: [ancestor.commitSha] },
    );
    const first = await openLayer(pool, once);
    const second = await openLayer(pool, {
      ...once,
      refName: 'refs/tags/v1',
      isDefaultBranch: false,
      candidateAncestors: [sha(), ancestor.commitSha, sha()],
    });
    expect(second.entries).toEqual(first.entries);
  });
});

describe('openLayer — the transaction and the lock', () => {
  it('leaves no layer and no path row when a write after the layer row fails', async () => {
    const failing = intercept((text, params) => {
      if (text.startsWith('INSERT INTO codegraph.layer_paths')) throw new Error('injected failure');
      return { text, params };
    });
    const doomed = input(web, { a: blob(1) });
    await expect(openLayer(failing, doomed)).rejects.toThrow('injected failure');
    expect(await rowsOf(doomed.commitSha)).toEqual({ layers: 0, paths: 0 });
  });

  it('takes the tenant lock shared before its first read, blocking behind an exclusive holder', async () => {
    log.clear();
    const traced = input(web, { a: blob(1) });
    await openLayer(pool, traced);
    const texts = log.texts();
    const lockAt = texts.findIndex((t) => t.includes('pg_advisory_xact_lock_shared'));
    expect(texts.slice(0, lockAt)).toEqual(['BEGIN', BIND_TENANT_SQL]);

    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(BIND_TENANT_SQL, [fx.readerId, web.tenantId]);
      await lockTenantExclusive(holder, web.tenantId);
      const blocked = input(web, { a: blob(1) });
      let settled = false;
      const pending = openLayer(pool, blocked).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      expect(await rowsOf(blocked.commitSha)).toEqual({ layers: 0, paths: 0 });
      await holder.query('COMMIT');
      const opened = await pending;
      expect(opened.state).toBe('staged');
      expect(await rowsOf(blocked.commitSha)).toEqual({ layers: 1, paths: 1 });
    } finally {
      await holder.end();
    }
  });
});

describe('openLayer — tenancy and input', () => {
  it("never takes another tenant's layer for the same commit as its ancestor, nor writes into it", async () => {
    const commitSha = sha();
    const theirs = await published(globex, null, [{ path: 'a', gitBlobHash: blob(1) }], commitSha);
    const opened = await openLayer(
      pool,
      input(web, { a: blob(1) }, { candidateAncestors: [commitSha] }),
    );
    expect(opened).toMatchObject({ kind: 'base', ancestorCommit: null });
    const tenants = await withClient(db.ownerUrl, (c) =>
      queryRows<{ tenant_id: string; repository_id: string }>(
        c,
        'SELECT tenant_id, repository_id FROM codegraph.commit_layers WHERE id = $1',
        [opened.layerId],
      ),
    );
    expect(tenants).toEqual([{ tenant_id: web.tenantId, repository_id: web.repositoryId }]);
    const theirRows = await withClient(db.ownerUrl, (c) =>
      queryRows(c, 'SELECT 1 FROM codegraph.commit_layers WHERE tenant_id = $1', [globex.tenantId]),
    );
    expect(theirRows).toHaveLength(1);
    expect(await storedEntries(theirs.id)).toEqual([{ path: 'a', gitBlobHash: blob(1) }]);
  });

  it.each([
    ['', blob(1)],
    ['/etc/passwd', blob(1)],
    ['a/../b', blob(1)],
    ['..', blob(1)],
    ['ok.ts', blob(0xabc).toUpperCase()],
    ['ok.ts', 'abc'],
    ['ok.ts', `${blob(1)}0`],
  ])('refuses path %j with hash %j and writes nothing', async (path, hash) => {
    const refused = input(
      web,
      new Map([
        ['fine.ts', blob(7)],
        [path, hash],
      ]),
    );
    const attempt = openLayer(pool, refused);
    await expect(attempt).rejects.toBeInstanceOf(LayerInputRefused);
    await expect(attempt).rejects.toMatchObject({ path, value: hash });
    expect(await rowsOf(refused.commitSha)).toEqual({ layers: 0, paths: 0 });
  });
});

describe('stageLayer and the batch size', () => {
  it('writes path rows in statements of at most the batch size', async () => {
    const paths = new Map<string, string>();
    for (let i = 0; i < 2_500; i += 1) paths.set(`f/${String(i).padStart(5, '0')}`, blob(i));
    log.clear();
    const opened = await openLayer(pool, input(web, paths));
    const appends = log.texts().filter((t) => t.startsWith('INSERT INTO codegraph.layer_paths'));
    expect(STAGE_BATCH_SIZE).toBe(1_000);
    expect(appends).toHaveLength(3);
    expect(await storedEntries(opened.layerId)).toHaveLength(2_500);

    log.clear();
    await openLayer(pool, input(web, new Map([...paths].slice(0, 20))), { batchSize: 7 });
    expect(
      log.texts().filter((t) => t.startsWith('INSERT INTO codegraph.layer_paths')),
    ).toHaveLength(3);
  });

  it('refuses a batch size that is not a positive integer before writing', async () => {
    await expect(
      bound(web.tenantId, (c) =>
        stageLayer(c, { ...web, commitSha: sha(), kind: 'base' }, [], { batchSize: 0 }),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
