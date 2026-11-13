// The commit-layer integration gate: the shipped calls driven in the order a
// worker uses them — open, store the missing blobs, publish — and then resolve,
// compact, discard and release, over the real Postgres the foundation fixture
// builds. Every case crosses a seam between two cards: it compares one shipped
// call's answer with another shipped call's input, never with a value typed
// into the test. No mock: row-level security, the advisory lock, the cascade
// and the single-statement resolution are database behaviour.
//
// The blob rows a publish requires are written as the owner, one per distinct
// hash: publish checks that a blob row exists and nothing about its bytes, and
// the blob library's store call is that story's surface.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLayerSettings } from '../../src/config.js';
import {
  listReferencedBlobHashes,
  readCurrentPublishedLayer,
  readLayerById,
  type LayerScope,
} from '../../src/db/layers.js';
import { compactLayer } from '../../src/layers/compact.js';
import { discardStaleLayers } from '../../src/layers/discard.js';
import { openLayer, type OpenedLayer } from '../../src/layers/openLayer.js';
import { publishLayer, UnstoredBlobsError } from '../../src/layers/publish.js';
import { releaseTenant } from '../../src/layers/release.js';
import { resolveCommit, type Resolution } from '../../src/layers/resolution.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { queryRows, withClient } from '../helpers/db.js';
import { foundation, type Foundation } from './foundation.fixture.js';

// The shipped defaults: this gate re-decides none of the three knobs.
const settings = readLayerSettings({});
const MAIN = { name: 'refs/heads/main', isDefaultBranch: true } as const;

const TREE = fileURLToPath(new URL('../../fixtures/sample-tree/languages/', import.meta.url));

function gitBlobHash(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

/** The sample tree's whole path → git blob hash map, as git would hash it. */
function sampleTree(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of readdirSync(TREE, { recursive: true, encoding: 'utf8' }).sort()) {
    const file = join(TREE, entry);
    if (!statSync(file).isFile()) continue;
    map.set(relative(TREE, file).split(sep).join('/'), gitBlobHash(readFileSync(file)));
  }
  return map;
}

/** A blob hash for content that exists in no file: a commit's edit. */
function edit(label: string): string {
  return gitBlobHash(Buffer.from(`edited: ${label}\n`));
}

function commit(label: string): string {
  return createHash('sha1').update(`commit ${label}`).digest('hex');
}

let f: Foundation;
let pool: pg.Pool;
let tenantId: string;
let clientId: string;
let web: LayerScope;
let api: LayerScope;

beforeEach(async () => {
  f = await foundation();
  pool = new pg.Pool({ connectionString: f.db.appUrl, max: 4 });
  tenantId = f.fx.tenantA.id;
  clientId = f.fx.readerId;
  const [first, second] = f.fx.tenantA.repositories;
  if (first === undefined || second === undefined) throw new Error('fixture has no repositories');
  web = { tenantId, repositoryId: first.id };
  api = { tenantId, repositoryId: second.id };
});

afterEach(async () => {
  await pool.end();
  await f.db.drop();
});

/** Blob rows (and a contents row each) for `hashes`, written as the owner. */
async function store(hashes: Iterable<string>): Promise<void> {
  await withClient(f.db.ownerUrl, async (c) => {
    for (const hash of new Set(hashes)) {
      await c.query(
        `INSERT INTO codegraph.blob (tenant_id, git_blob_hash, size_bytes, outcome, lossy)
         VALUES ($1, $2, 1, 'unsupported', false) ON CONFLICT DO NOTHING`,
        [tenantId, hash],
      );
      await c.query(
        `INSERT INTO codegraph.blob_contents (tenant_id, git_blob_hash, contents)
         VALUES ($1, $2, 'x') ON CONFLICT DO NOTHING`,
        [tenantId, hash],
      );
    }
  });
}

async function open(
  scope: LayerScope,
  sha: string,
  paths: Map<string, string>,
  candidates: string[] = [],
  ref: { name: string; isDefaultBranch: boolean } = MAIN,
): Promise<OpenedLayer> {
  return openLayer(pool, {
    clientId,
    tenantId,
    repositoryId: scope.repositoryId,
    commitSha: sha,
    refName: ref.name,
    isDefaultBranch: ref.isDefaultBranch,
    candidateAncestors: candidates,
    paths,
    settings,
  });
}

async function publish(
  scope: LayerScope,
  layerId: string,
  ref: { name: string; isDefaultBranch: boolean } | null = MAIN,
) {
  return publishLayer(pool, { tenantId, clientId, repositoryId: scope.repositoryId, layerId, ref });
}

/** The worker's order: open, store what is missing, publish. */
async function index(
  scope: LayerScope,
  sha: string,
  paths: Map<string, string>,
  candidates: string[] = [],
  ref: { name: string; isDefaultBranch: boolean } = MAIN,
): Promise<OpenedLayer> {
  const opened = await open(scope, sha, paths, candidates, ref);
  await store(opened.entries.flatMap((e) => (e.gitBlobHash === null ? [] : [e.gitBlobHash])));
  await publish(scope, opened.layerId, ref);
  return opened;
}

async function bound<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(BIND_TENANT_SQL, [clientId, tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const resolve = (scope: LayerScope, sha: string): Promise<Resolution> =>
  bound((c) => resolveCommit(c, tenantId, scope.repositoryId, sha));

async function resolvedMap(scope: LayerScope, sha: string): Promise<Map<string, string>> {
  const resolution = await resolve(scope, sha);
  if (resolution.state !== 'indexed') throw new Error(`${sha} is not indexed`);
  return resolution.paths;
}

const current = (scope: LayerScope, sha: string) =>
  bound((c) => readCurrentPublishedLayer(c, scope, sha));

/** Every hash the release's referenced-blob read lists, paged to the end. */
async function referenced(): Promise<Set<string>> {
  return bound(async (c) => {
    const all = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page = await listReferencedBlobHashes(c, tenantId, { after });
      for (const hash of page.hashes) all.add(hash);
      if (page.next === null) return all;
      after = page.next;
    }
  });
}

async function ownerRows<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return withClient(f.db.ownerUrl, (c) => queryRows<T>(c, sql, params));
}

const sorted = (map: Map<string, string>) => [...map].sort(([a], [b]) => (a < b ? -1 : 1));

describe('write → resolve', () => {
  it('resolves a first commit to exactly the map it was written from, through a base at depth 0', async () => {
    const tree = sampleTree();
    const sha = commit('first');
    await index(web, sha, tree);
    expect(sorted(await resolvedMap(web, sha))).toEqual(sorted(tree));
    expect(await current(web, sha)).toMatchObject({ kind: 'base', depth: 0 });
  });

  it('resolves the third commit of base, delta, delta to its own full map', async () => {
    const tree = sampleTree();
    const paths = [...tree.keys()];
    const [c1, c2, c3] = [commit('c1'), commit('c2'), commit('c3')];
    await index(web, c1, tree);

    const second = new Map(tree);
    const changed = paths.slice(0, 3);
    for (const path of changed) second.set(path, edit(`c2 ${path}`));
    const deleted = paths[3] as string;
    second.delete(deleted);
    await index(web, c2, second, [c1]);

    const third = new Map(second);
    const again = paths[0] as string;
    third.set(again, edit(`c3 ${again}`));
    const opened = await index(web, c3, third, [c2, c1]);
    expect(opened.kind).toBe('delta');

    const first = await resolvedMap(web, c1);
    const resolved = await resolvedMap(web, c3);
    expect(sorted(resolved)).toEqual(sorted(third));
    expect(resolved.has(deleted)).toBe(false);
    expect(resolved.get(again)).toBe(third.get(again));
    expect(resolved.get(again)).not.toBe((await resolvedMap(web, c2)).get(again));
    for (const path of paths.slice(4)) expect(resolved.get(path)).toBe(first.get(path));
  });
});

describe('publish', () => {
  it('leaves a commit opened and never published not indexed, and its predecessor unchanged', async () => {
    const tree = sampleTree();
    const [c1, c2] = [commit('kept'), commit('opened only')];
    await index(web, c1, tree);
    const before = await resolvedMap(web, c1);
    const next = new Map(tree);
    next.set([...tree.keys()][0] as string, edit('never published'));
    await open(web, c2, next, [c1]);
    expect(await resolve(web, c2)).toEqual({ state: 'not_indexed' });
    expect(sorted(await resolvedMap(web, c1))).toEqual(sorted(before));
  });

  it('refuses while one blob is unstored, naming it, and leaves the layer staged and the ref head where it was', async () => {
    const tree = sampleTree();
    const [c1, c2] = [commit('previous'), commit('refused')];
    await index(web, c1, tree);
    const next = new Map(tree);
    const path = [...tree.keys()][2] as string;
    const missing = edit('unstored');
    next.set(path, missing);
    const opened = await open(web, c2, next, [c1]);
    // Store every blob the layer names except one.
    await store(
      opened.entries.flatMap((e) =>
        e.gitBlobHash === null || e.gitBlobHash === missing ? [] : [e.gitBlobHash],
      ),
    );

    const refusal = publish(web, opened.layerId);
    await expect(refusal).rejects.toBeInstanceOf(UnstoredBlobsError);
    await expect(refusal).rejects.toMatchObject({ path, gitBlobHash: missing });

    expect(await resolve(web, c2)).toEqual({ state: 'not_indexed' });
    const [head] = await ownerRows<{ commit_sha: string }>(
      'SELECT commit_sha FROM codegraph.ref_heads WHERE repository_id = $1 AND ref_name = $2',
      [web.repositoryId, MAIN.name],
    );
    expect(head?.commit_sha).toBe(c1);
    expect(await bound((c) => readLayerById(c, web, opened.layerId))).toMatchObject({
      state: 'staged',
    });
    const [paths] = await ownerRows<{ n: number }>(
      'SELECT count(*)::int AS n FROM codegraph.layer_paths WHERE layer_id = $1',
      [opened.layerId],
    );
    expect(paths?.n).toBe(opened.entries.length);
  });

  it('moves only the published ref: a branch names the new commit, the default branch the previous one', async () => {
    const tree = sampleTree();
    const [c1, c2] = [commit('main'), commit('feature')];
    const main = await index(web, c1, tree);
    const next = new Map(tree);
    next.set([...tree.keys()][1] as string, edit('feature'));
    const feature = { name: 'refs/heads/feature', isDefaultBranch: false };
    const branch = await index(web, c2, next, [c1], feature);

    const heads = await ownerRows<{ ref_name: string; commit_sha: string; layer_id: string }>(
      'SELECT ref_name, commit_sha, layer_id FROM codegraph.ref_heads WHERE repository_id = $1 ORDER BY ref_name',
      [web.repositoryId],
    );
    expect(heads).toEqual([
      { ref_name: feature.name, commit_sha: c2, layer_id: branch.layerId },
      { ref_name: MAIN.name, commit_sha: c1, layer_id: main.layerId },
    ]);
  });
});

describe('compaction', () => {
  it('switches a chain past the default threshold to a base, and the commit resolves to the identical map', async () => {
    const tree = sampleTree();
    const paths = [...tree.keys()];
    const shas: string[] = [];
    let map = new Map(tree);
    for (let n = 0; n <= settings.compactionThreshold + 1; n += 1) {
      const sha = commit(`chain ${String(n)}`);
      if (n > 0) {
        map = new Map(map);
        map.set(paths[n % paths.length] as string, edit(`chain ${String(n)}`));
      }
      await index(web, sha, map, [...shas].reverse());
      shas.push(sha);
    }
    const top = shas[shas.length - 1] as string;
    expect((await current(web, top))?.depth).toBeGreaterThan(settings.compactionThreshold);
    const before = await resolvedMap(web, top);

    const result = await compactLayer(pool, {
      tenantId,
      clientId,
      repositoryId: web.repositoryId,
      commitSha: top,
      settings,
    });
    expect(result.outcome).toBe('compacted');
    expect(sorted(await resolvedMap(web, top))).toEqual(sorted(before));
    expect(sorted(before)).toEqual(sorted(map));
    expect(await current(web, top)).toMatchObject({ kind: 'base', depth: 0 });
  });
});

describe('discard → release', () => {
  it('discards a stale staged layer, so its pins leave the referenced read and the release takes their blobs', async () => {
    const tree = sampleTree();
    const [c1, c2] = [commit('published'), commit('abandoned')];
    await index(web, c1, tree);
    const before = await resolvedMap(web, c1);
    const next = new Map(tree);
    const only = [edit('abandoned one'), edit('abandoned two')];
    next.set([...tree.keys()][0] as string, only[0] as string);
    next.set([...tree.keys()][1] as string, only[1] as string);
    const opened = await open(web, c2, next, [c1]);
    await store(only);
    expect([...(await referenced())]).toEqual(expect.arrayContaining(only));

    // Age the staged layer past the window, by the column the schema declares.
    const [column] = await ownerRows<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = 'codegraph' AND table_name = 'commit_layers'
         AND column_name LIKE 'staged%' AND data_type LIKE 'timestamp%'`,
      [],
    );
    await ownerRows(
      `UPDATE codegraph.commit_layers SET ${(column as { name: string }).name} = now() - $2::interval WHERE id = $1`,
      [opened.layerId, `${String(settings.stagedLayerStaleness * 2)} milliseconds`],
    );

    const discarded = await discardStaleLayers(pool, { clientId, tenantId, settings });
    expect(discarded.layerIds).toEqual([opened.layerId]);
    expect(
      await ownerRows('SELECT 1 FROM codegraph.layer_paths WHERE layer_id = $1', [opened.layerId]),
    ).toEqual([]);
    expect(sorted(await resolvedMap(web, c1))).toEqual(sorted(before));
    const pinned = await referenced();
    for (const hash of only) expect(pinned.has(hash)).toBe(false);

    const released = await releaseTenant(pool, { clientId, tenantId });
    expect(released.blobHashes).toEqual([...only].sort());
    expect(sorted(await resolvedMap(web, c1))).toEqual(sorted(before));
  });

  it('keeps every blob a staged layer inside the window pins', async () => {
    const tree = sampleTree();
    const [c1, c2] = [commit('base'), commit('in flight')];
    await index(web, c1, tree);
    const next = new Map(tree);
    next.set([...tree.keys()][0] as string, edit('in flight'));
    const opened = await open(web, c2, next, [c1]);
    const pins = opened.entries.flatMap((e) => (e.gitBlobHash === null ? [] : [e.gitBlobHash]));
    await store(pins);

    await releaseTenant(pool, { clientId, tenantId });
    const present = await ownerRows<{ h: string }>(
      'SELECT git_blob_hash AS h FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = ANY($2::text[])',
      [tenantId, pins],
    );
    expect(present.map((r) => r.h).sort()).toEqual([...new Set(pins)].sort());
  });
});

describe('repository delete → release', () => {
  it('takes the deleted repository’s rows from the three tables, then only the blobs it alone used', async () => {
    const tree = sampleTree();
    const onlyWeb = new Map(tree);
    const onlyHash = edit('web only');
    onlyWeb.set('web-only.ts', onlyHash);
    await index(web, commit('web'), onlyWeb);
    await index(api, commit('api'), tree);

    await withClient(f.db.appUrl, async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.client_id', $1, true)", [f.fx.operatorId]);
      await c.query('SELECT codegraph.codegraph_delete_repository_as_operator($1, $2)', [
        tenantId,
        web.repositoryId,
      ]);
      await c.query('COMMIT');
    });
    for (const table of ['commit_layers', 'layer_paths', 'ref_heads']) {
      expect(
        await ownerRows(`SELECT 1 FROM codegraph.${table} WHERE repository_id = $1`, [
          web.repositoryId,
        ]),
      ).toEqual([]);
    }

    const released = await releaseTenant(pool, { clientId, tenantId });
    expect(released.blobHashes).toEqual([onlyHash]);
    const blobs = await ownerRows<{ h: string; contents: boolean }>(
      `SELECT b.git_blob_hash AS h,
              EXISTS (SELECT 1 FROM codegraph.blob_contents x
                      WHERE x.tenant_id = b.tenant_id AND x.git_blob_hash = b.git_blob_hash) AS contents
       FROM codegraph.blob b WHERE b.tenant_id = $1 ORDER BY 1`,
      [tenantId],
    );
    expect(blobs).toEqual([...new Set(tree.values())].sort().map((h) => ({ h, contents: true })));
    expect(
      await ownerRows('SELECT 1 FROM codegraph.blob_contents WHERE git_blob_hash = $1', [onlyHash]),
    ).toEqual([]);
  });
});
