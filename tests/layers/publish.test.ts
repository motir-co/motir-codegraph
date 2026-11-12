import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertBlobIfAbsent, type NewBlob } from '../../src/db/blobs.js';
import {
  appendLayerPaths,
  insertLayer,
  markPublished,
  readCurrentPublishedLayer,
  readLayerById,
  readRefHead,
  type LayerRow,
  type LayerScope,
  type PathEntry,
} from '../../src/db/layers.js';
import {
  EXISTENCE_BATCH_SIZE,
  LayerNotPublishableError,
  publishLayer,
  PublishUnboundError,
  UnstoredBlobsError,
  type PublishInput,
} from '../../src/layers/publish.js';
import { resolveCommit } from '../../src/layers/resolution.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

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
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  log = recordQueries(pool);
  const [a1, a2] = fx.tenantA.repositories;
  const [b1] = fx.tenantB.repositories;
  if (a1 === undefined || a2 === undefined || b1 === undefined) throw new Error('fixture');
  web = { tenantId: fx.tenantA.id, repositoryId: a1.id };
  api = { tenantId: fx.tenantA.id, repositoryId: a2.id };
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

/** Stores blob rows for the tenant: `unsupported` unless an outcome is given. */
async function store(
  tenantId: string,
  hashes: string[],
  outcome: Partial<NewBlob> = {},
): Promise<void> {
  await bound(
    tenantId,
    async (c) => {
      for (const gitBlobHash of hashes) {
        await insertBlobIfAbsent(c, {
          tenantId,
          gitBlobHash,
          sizeBytes: 10,
          outcome: 'unsupported',
          lossy: false,
          ...outcome,
        });
      }
    },
    true,
  );
}

/** A staged layer (a base, or a delta over `parent`) with `entries`, committed. */
function staged(
  scope: LayerScope,
  entries: PathEntry[],
  parent: string | null = null,
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
      return layer;
    },
    true,
  );
}

function request(
  scope: LayerScope,
  layerId: string,
  ref: PublishInput['ref'] = { name: 'refs/heads/main', isDefaultBranch: true },
): PublishInput {
  return {
    tenantId: scope.tenantId,
    clientId: clientFor(scope.tenantId),
    repositoryId: scope.repositoryId,
    layerId,
    ref,
  };
}

async function layer(scope: LayerScope, id: string): Promise<LayerRow | null> {
  return bound(scope.tenantId, (c) => readLayerById(c, scope, id));
}

async function refs(scope: LayerScope): Promise<Record<string, unknown>[]> {
  return withClient(db.ownerUrl, (c) =>
    queryRows(
      c,
      `SELECT ref_name, commit_sha, layer_id, is_default_branch FROM codegraph.ref_heads
        WHERE repository_id = $1 ORDER BY ref_name`,
      [scope.repositoryId],
    ),
  );
}

/** A pool whose connections run `rewrite` over every query first. */
function intercept(rewrite: (text: string) => void): pg.Pool {
  const wrapped = Object.create(pool) as pg.Pool;
  wrapped.connect = (async () => {
    const c = await pool.connect();
    const query = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
    (c as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
      rewrite(text);
      return query(text, params);
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

describe('publishLayer — success', () => {
  it('flips a staged layer whose blobs are all stored and writes its ref head in one call', async () => {
    const [h1, h2] = [sha(), sha()];
    await store(web.tenantId, [h1, h2]);
    const l = await staged(web, [
      { path: 'a', gitBlobHash: h1 },
      { path: 'b', gitBlobHash: h2 },
      { path: 'gone', gitBlobHash: null },
    ]);
    const published = await publishLayer(pool, request(web, l.id));
    expect(published).toMatchObject({
      layerId: l.id,
      commitSha: l.commitSha,
      retired: null,
      refHead: {
        refName: 'refs/heads/main',
        commitSha: l.commitSha,
        layerId: l.id,
        isDefaultBranch: true,
      },
    });
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(await layer(web, l.id)).toMatchObject({
      state: 'published',
      publishedAt: published.publishedAt,
    });
    // The next publish moves the row it inserted.
    const next = await staged(web, [{ path: 'a', gitBlobHash: h1 }], l.id);
    await publishLayer(pool, request(web, next.id));
    expect(await bound(web.tenantId, (c) => readRefHead(c, web, 'refs/heads/main'))).toMatchObject({
      layerId: next.id,
      commitSha: next.commitSha,
    });
  });

  it('counts a binary and a size-refused blob as stored, reading blob rows and never contents', async () => {
    const [binary, refused] = [sha(), sha()];
    await store(web.tenantId, [binary], { outcome: 'binary', lossy: null });
    await store(web.tenantId, [refused], {
      outcome: 'refused',
      lossy: null,
      refusedCapBytes: 1_048_576,
    });
    const l = await staged(web, [
      { path: 'logo.png', gitBlobHash: binary },
      { path: 'huge.json', gitBlobHash: refused },
    ]);
    log.clear();
    await publishLayer(pool, request(web, l.id, null));
    expect((await layer(web, l.id))?.state).toBe('published');
    expect(log.texts().some((t) => t.includes('blob_contents'))).toBe(false);
  });

  it('moves only the given ref on a non-default publish; one commit under two refs names one layer', async () => {
    const h = sha();
    await store(web.tenantId, [h]);
    const main = await staged(web, [{ path: 'a', gitBlobHash: h }]);
    await publishLayer(pool, request(web, main.id));
    const feature = await staged(web, [{ path: 'b', gitBlobHash: h }], main.id);
    await publishLayer(
      pool,
      request(web, feature.id, { name: 'refs/heads/feature', isDefaultBranch: false }),
    );
    const again = await publishLayer(
      pool,
      request(web, feature.id, { name: 'refs/heads/also', isDefaultBranch: false }),
    );
    expect(again).toMatchObject({ layerId: feature.id, retired: null });
    const rows = await refs(web);
    expect(rows).toContainEqual({
      ref_name: 'refs/heads/main',
      commit_sha: main.commitSha,
      layer_id: main.id,
      is_default_branch: true,
    });
    expect(rows.filter((r) => r.layer_id === feature.id).map((r) => r.ref_name)).toEqual([
      'refs/heads/also',
      'refs/heads/feature',
    ]);
  });

  it('checks existence once per batch of hashes, over a layer far larger than one batch', async () => {
    const entries: PathEntry[] = [];
    for (let i = 0; i < 1_200; i += 1) entries.push({ path: `f${String(i)}`, gitBlobHash: sha() });
    // Two paths share one blob: checked once.
    entries.push({ path: 'zz-dup', gitBlobHash: (entries[0] as PathEntry).gitBlobHash });
    await store(
      web.tenantId,
      entries.map((e) => e.gitBlobHash as string),
    );
    const l = await bound(
      web.tenantId,
      async (c) => {
        const row = await insertLayer(c, { ...web, commitSha: sha(), kind: 'base' });
        for (let i = 0; i < entries.length; i += 500) {
          await appendLayerPaths(c, web, row.id, entries.slice(i, i + 500));
        }
        return row;
      },
      true,
    );
    expect(EXISTENCE_BATCH_SIZE).toBe(500);
    log.clear();
    await publishLayer(pool, request(web, l.id, null));
    const existence = log.texts().filter((t) => t.includes('codegraph.blob b'));
    expect(existence).toHaveLength(3);
    log.clear();
    const small = await staged(web, entries.slice(0, 10));
    await publishLayer(pool, request(web, small.id, null), { batchSize: 4 });
    expect(log.texts().filter((t) => t.includes('codegraph.blob b'))).toHaveLength(3);
  });
});

describe('publishLayer — refusals', () => {
  it('refuses while a blob is unstored, naming the lowest missing path, and changes nothing', async () => {
    const [stored, m1, m2] = [sha(), sha(), sha()];
    await store(web.tenantId, [stored]);
    const before = await staged(web, [{ path: 'x', gitBlobHash: stored }]);
    await publishLayer(pool, request(web, before.id));
    const l = await staged(
      web,
      [
        { path: 'a', gitBlobHash: stored },
        { path: 'c', gitBlobHash: m2 },
        { path: 'b', gitBlobHash: m1 },
        { path: 'd', gitBlobHash: m1 },
      ],
      before.id,
    );
    const refsBefore = await refs(web);
    const attempt = publishLayer(pool, request(web, l.id), { batchSize: 2 });
    await expect(attempt).rejects.toBeInstanceOf(UnstoredBlobsError);
    await expect(attempt).rejects.toMatchObject({ path: 'b', gitBlobHash: m1, missingCount: 2 });
    expect(await layer(web, l.id)).toMatchObject({ state: 'staged', publishedAt: null });
    const paths = await withClient(db.ownerUrl, (c) =>
      queryRows(c, 'SELECT 1 FROM codegraph.layer_paths WHERE layer_id = $1', [l.id]),
    );
    expect(paths).toHaveLength(4);
    expect(await refs(web)).toEqual(refsBefore);
    // Once the blobs are stored the same staged layer publishes.
    await store(web.tenantId, [m1, m2]);
    await expect(publishLayer(pool, request(web, l.id))).resolves.toMatchObject({
      layerId: l.id,
    });
  });

  it('commits the flip and the ref head together or not at all', async () => {
    const h = sha();
    await store(web.tenantId, [h]);
    const prior = await staged(web, [{ path: 'a', gitBlobHash: h }]);
    await publishLayer(
      pool,
      request(web, prior.id, { name: 'refs/heads/x', isDefaultBranch: false }),
    );
    const refsBefore = await refs(web);

    const refFails = await staged(web, [{ path: 'b', gitBlobHash: h }], prior.id);
    const failRef = intercept((t) => {
      if (t.startsWith('INSERT INTO codegraph.ref_heads')) throw new Error('ref write failed');
    });
    await expect(
      publishLayer(
        failRef,
        request(web, refFails.id, { name: 'refs/heads/x', isDefaultBranch: false }),
      ),
    ).rejects.toThrow('ref write failed');
    expect((await layer(web, refFails.id))?.state).toBe('staged');
    expect(await refs(web)).toEqual(refsBefore);

    const flipFails = await staged(web, [{ path: 'c', gitBlobHash: h }], prior.id);
    const failFlip = intercept((t) => {
      if (t.includes("SET state = 'published'")) throw new Error('flip failed');
    });
    await expect(
      publishLayer(
        failFlip,
        request(web, flipFails.id, { name: 'refs/heads/x', isDefaultBranch: false }),
      ),
    ).rejects.toThrow('flip failed');
    expect((await layer(web, flipFails.id))?.state).toBe('staged');
    expect(await refs(web)).toEqual(refsBefore);
  });

  it('refuses a retired layer, answers the current one idempotently, and refuses foreign ids', async () => {
    const h = sha();
    await store(web.tenantId, [h]);
    const commitSha = sha();
    const first = await staged(web, [{ path: 'a', gitBlobHash: h }], null, commitSha);
    const firstPublished = await publishLayer(pool, request(web, first.id, null));
    const second = await staged(web, [{ path: 'a', gitBlobHash: h }], null, commitSha);
    await publishLayer(pool, request(web, second.id, null));

    const retired = publishLayer(pool, request(web, first.id));
    await expect(retired).rejects.toBeInstanceOf(LayerNotPublishableError);
    await expect(retired).rejects.toMatchObject({ reason: 'superseded' });
    expect(await layer(web, first.id)).toMatchObject({
      state: 'published',
      publishedAt: firstPublished.publishedAt,
    });

    const before = await layer(web, second.id);
    const idempotent = await publishLayer(pool, request(web, second.id, null));
    expect(idempotent).toMatchObject({
      layerId: second.id,
      commitSha,
      publishedAt: before?.publishedAt,
      refHead: null,
      retired: null,
    });
    expect(await layer(web, second.id)).toEqual(before);

    for (const [scope, id] of [
      [api, second.id],
      [globex, second.id],
      [web, '00000000-0000-4000-8000-000000000000'],
    ] as const) {
      await expect(publishLayer(pool, request(scope, id))).rejects.toMatchObject({
        reason: 'not_found',
      });
    }
  });

  it('refuses an unbound transaction', async () => {
    const h = sha();
    await store(web.tenantId, [h]);
    const l = await staged(web, [{ path: 'a', gitBlobHash: h }]);
    // The reader holds no grant on tenant B, so its binding admits nothing.
    const attempt = publishLayer(pool, {
      ...request(web, l.id),
      tenantId: globex.tenantId,
      repositoryId: globex.repositoryId,
    });
    await expect(attempt).rejects.toBeInstanceOf(PublishUnboundError);
    await expect(attempt).rejects.toMatchObject({
      tenantId: globex.tenantId,
      clientId: fx.readerId,
    });
    expect((await layer(web, l.id))?.state).toBe('staged');
  });

  it('refuses a layer another call flipped concurrently, as not staged', async () => {
    const h = sha();
    await store(web.tenantId, [h]);
    const l = await staged(web, [{ path: 'a', gitBlobHash: h }]);
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(BIND_TENANT_SQL, [fx.readerId, web.tenantId]);
      await markPublished(other, web, l.id);
      const racing = publishLayer(pool, request(web, l.id, null));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await other.query('COMMIT');
      await expect(racing).rejects.toMatchObject({ reason: 'not_staged' });
    } finally {
      other.release();
    }
  });

  it('refuses a batch size that is not a positive integer', async () => {
    await expect(publishLayer(pool, request(web, sha()), { batchSize: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('publishLayer — readers and retirement', () => {
  it('keeps the layer unreadable until the publish commits, and a rolled-back publish changes nothing', async () => {
    const h = sha();
    await store(web.tenantId, [h]);
    const previous = await staged(web, [{ path: 'a', gitBlobHash: h }]);
    await publishLayer(pool, request(web, previous.id));
    const l = await staged(web, [{ path: 'b', gitBlobHash: h }], previous.id);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = Object.create(pool) as pg.Pool;
    paused.connect = (async () => {
      const c = await pool.connect();
      const query = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
      (c as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
        if (text === 'COMMIT') await gate;
        return query(text, params);
      };
      const done = c.release.bind(c);
      c.release = (err?: Error | boolean) => {
        (c as unknown as { query: unknown }).query = query;
        done(err);
      };
      return c;
    }) as pg.Pool['connect'];
    const publishing = publishLayer(paused, request(web, l.id));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await bound(web.tenantId, async (c) => {
      expect(await resolveCommit(c, web.tenantId, web.repositoryId, l.commitSha)).toEqual({
        state: 'not_indexed',
      });
      expect(await readCurrentPublishedLayer(c, web, l.commitSha)).toBeNull();
      expect(await readRefHead(c, web, 'refs/heads/main')).toMatchObject({ layerId: previous.id });
    });
    release();
    await publishing;
    await bound(web.tenantId, async (c) => {
      expect((await resolveCommit(c, web.tenantId, web.repositoryId, l.commitSha)).state).toBe(
        'indexed',
      );
      expect(await readRefHead(c, web, 'refs/heads/main')).toMatchObject({ layerId: l.id });
    });
  });

  it('retires the commit’s current layer in the same transaction, keeping every row a descendant reads', async () => {
    const [h1, h2, h3] = [sha(), sha(), sha()];
    await store(web.tenantId, [h1, h2, h3]);
    const commitSha = sha();
    const old = await staged(
      web,
      [
        { path: 'a', gitBlobHash: h1 },
        { path: 'b', gitBlobHash: h2 },
      ],
      null,
      commitSha,
    );
    const oldPublished = await publishLayer(pool, request(web, old.id));
    const descendant = await staged(web, [{ path: 'c', gitBlobHash: h3 }], old.id);
    await publishLayer(pool, request(web, descendant.id, null));
    const descendantMap = await bound(web.tenantId, (c) =>
      resolveCommit(c, web.tenantId, web.repositoryId, descendant.commitSha),
    );

    const compacted = await staged(
      web,
      [
        { path: 'a', gitBlobHash: h1 },
        { path: 'b', gitBlobHash: h2 },
      ],
      null,
      commitSha,
    );
    const published = await publishLayer(pool, request(web, compacted.id));
    expect(published.retired?.layerId).toBe(old.id);
    expect(published.retired?.supersededAt).toBeInstanceOf(Date);
    expect(await layer(web, old.id)).toMatchObject({
      state: 'published',
      publishedAt: oldPublished.publishedAt,
      supersededAt: published.retired?.supersededAt,
    });
    const oldPaths = await withClient(db.ownerUrl, (c) =>
      queryRows(c, 'SELECT path FROM codegraph.layer_paths WHERE layer_id = $1 ORDER BY path', [
        old.id,
      ]),
    );
    expect(oldPaths).toEqual([{ path: 'a' }, { path: 'b' }]);
    const current = await withClient(db.ownerUrl, (c) =>
      queryRows(
        c,
        `SELECT id FROM codegraph.commit_layers
          WHERE commit_sha = $1 AND state = 'published' AND superseded_at IS NULL`,
        [commitSha],
      ),
    );
    expect(current).toEqual([{ id: compacted.id }]);
    await bound(web.tenantId, async (c) => {
      expect(await readRefHead(c, web, 'refs/heads/main')).toMatchObject({
        layerId: compacted.id,
      });
      expect(await resolveCommit(c, web.tenantId, web.repositoryId, descendant.commitSha)).toEqual(
        descendantMap,
      );
    });
  });

  it('two jobs staging one commit at once: the second publish moves the first job’s ref head too, so none names a retired layer', async () => {
    const [h0, h1, h2] = [sha(), sha(), sha()];
    await store(web.tenantId, [h0, h1, h2]);
    const parent = await staged(web, [{ path: 'x', gitBlobHash: h0 }]);
    await publishLayer(pool, request(web, parent.id, null));
    const commitSha = sha();
    // Both jobs stage before either publishes: a push to main with a known
    // ancestor (a delta) and a new branch whose job knew none (a base).
    const delta = await staged(web, [{ path: 'y', gitBlobHash: h1 }], parent.id, commitSha);
    const base = await staged(
      web,
      [
        { path: 'x', gitBlobHash: h0 },
        { path: 'y', gitBlobHash: h1 },
        { path: 'z', gitBlobHash: h2 },
      ],
      null,
      commitSha,
    );
    await publishLayer(pool, request(web, delta.id));
    await publishLayer(
      pool,
      request(web, delta.id, { name: 'refs/heads/side', isDefaultBranch: false }),
    );
    const published = await publishLayer(
      pool,
      request(web, base.id, { name: 'refs/heads/f', isDefaultBranch: false }),
    );
    expect(published.retired?.layerId).toBe(delta.id);
    const named = (await refs(web)).filter((r) => r.commit_sha === commitSha);
    expect(named.map((r) => [r.ref_name, r.layer_id])).toEqual([
      ['refs/heads/f', base.id],
      ['refs/heads/main', base.id],
      ['refs/heads/side', base.id],
    ]);
    expect(named.find((r) => r.ref_name === 'refs/heads/main')?.is_default_branch).toBe(true);
  });
});
