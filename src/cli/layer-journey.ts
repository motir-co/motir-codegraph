// `pnpm layer:journey`: the commit-layer story's eight-step verification recipe,
// driven end to end through the shipped library over one database, the way a
// reviewer walks it. Every step prints observation lines of the form
// `step N: key=value`; a step whose expectation does not hold prints
// `step N failed: <state observed>` and ends the run non-zero.
//
// It needs both logins: DATABASE_URL (codegraph_owner) for the migration step
// and the owner's reads, DATABASE_APP_URL (codegraph_app) for every library
// call, bound to the tenant it creates. The three layer knobs come from the
// environment through readLayerSettings(); set COMPACTION_THRESHOLD and
// HARD_CEILING small to keep step 7 short. Each run seeds its own tenant and
// two repositories through the operator functions, so runs never collide.
//
// `--through <N>` stops after step N (default 8), so a reader can look at the
// rows a step left before a later step changes them; step 8 deletes R1.
//
// The sample tree is held in memory and hashed as git hashes a blob; the
// commit shas are fixed labels. Step 6's "killed" job is a layer opened and
// left before its last blob is stored or it is published — the state a dead
// job leaves — and the staleness window is reached through the discard's own
// clock parameter, so nothing sleeps.

import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import pg from 'pg';

import { readLayerSettings, requireEnv, type LayerSettings } from '../config.js';
import { listReferencedBlobHashes, readCurrentPublishedLayer } from '../db/layers.js';
import { migrate } from '../db/migrate.js';
import { bootstrapOperator } from '../db/operator.js';
import { storeBlob } from '../indexing/storeBlob.js';
import { compactLayer } from '../layers/compact.js';
import { discardStaleLayers } from '../layers/discard.js';
import { openLayer, type OpenedLayer } from '../layers/openLayer.js';
import { publishLayer } from '../layers/publish.js';
import { releaseTenant } from '../layers/release.js';
import { resolveCommit } from '../layers/resolution.js';
import { BIND_TENANT_SQL } from '../server/binding.js';

const MAIN = { name: 'refs/heads/main', isDefaultBranch: true } as const;
const FEATURE = { name: 'refs/heads/feature', isDefaultBranch: false } as const;
const LAYER_TABLES = ['commit_layers', 'layer_paths', 'ref_heads'] as const;

/** The sample tree C1 indexes: small text files, path → contents. */
const SAMPLE_TREE: Readonly<Record<string, string>> = {
  'README.md': '# layer journey\n',
  'config.json': '{ "debug": false }\n',
  'docs/guide.md': '# guide\n\nRead the code.\n',
  'lib/main.go': 'package main\n\nfunc main() {}\n',
  'src/index.ts': 'export const answer = 42;\n',
  'src/shapes.py': 'class Shape:\n    sides = 0\n',
  'src/util.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
};

class StepFailed extends Error {
  constructor(
    readonly step: number,
    observed: string,
  ) {
    super(observed);
  }
}

type Tree = Map<string, string>; // path → contents

function gitBlobHash(contents: string): string {
  const bytes = Buffer.from(contents, 'utf8');
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

function hashes(tree: Tree): Map<string, string> {
  return new Map([...tree].map(([path, contents]) => [path, gitBlobHash(contents)]));
}

/** A fixed, printable commit label, as git would show it: forty hex characters. */
function commitSha(label: string, run: string): string {
  return createHash('sha1').update(`${run} ${label}`).digest('hex');
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function print(step: number, key: string, value: string | number | boolean): void {
  console.log(`step ${String(step)}: ${key}=${String(value)}`);
}

function check(step: number, holds: boolean, observed: string): void {
  if (!holds) throw new StepFailed(step, observed);
}

interface Journey {
  readonly owner: pg.Pool;
  readonly app: pg.Pool;
  readonly settings: LayerSettings;
  readonly run: string;
  tenantId: string;
  clientId: string;
  r1: string;
  r2: string;
}

async function ownerRows<T extends pg.QueryResultRow>(
  j: Journey,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await j.owner.query<T>(sql, params)).rows;
}

async function count(j: Journey, sql: string, params: unknown[]): Promise<number> {
  const [row] = await ownerRows<{ n: number }>(j, sql, params);
  return row?.n ?? 0;
}

/** Runs `fn` bound to the journey's tenant, read-only: always rolled back. */
async function bound<T>(j: Journey, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await j.app.connect();
  try {
    await c.query('BEGIN');
    await c.query(BIND_TENANT_SQL, [j.clientId, j.tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

async function resolve(j: Journey, repositoryId: string, sha: string) {
  return bound(j, (c) => resolveCommit(c, j.tenantId, repositoryId, sha));
}

async function resolvedMap(j: Journey, step: number, repositoryId: string, sha: string) {
  const resolution = await resolve(j, repositoryId, sha);
  check(step, resolution.state === 'indexed', `${sha} answered ${resolution.state}`);
  return (resolution as { paths: Map<string, string> }).paths;
}

async function open(
  j: Journey,
  repositoryId: string,
  sha: string,
  tree: Tree,
  candidates: string[],
  ref: { name: string; isDefaultBranch: boolean } = MAIN,
): Promise<OpenedLayer> {
  return openLayer(j.app, {
    clientId: j.clientId,
    tenantId: j.tenantId,
    repositoryId,
    commitSha: sha,
    refName: ref.name,
    isDefaultBranch: ref.isDefaultBranch,
    candidateAncestors: candidates,
    paths: hashes(tree),
    settings: j.settings,
  });
}

/** Stores, through the blob layer's store call, every blob `paths` name; answers how many were new. */
async function store(j: Journey, tree: Tree, paths: Iterable<string>): Promise<number> {
  const c = await j.app.connect();
  try {
    let created = 0;
    for (const path of paths) {
      const contents = tree.get(path) as string;
      const stored = await storeBlob(c, {
        tenantId: j.tenantId,
        clientId: j.clientId,
        gitBlobHash: gitBlobHash(contents),
        path,
        bytes: Buffer.from(contents, 'utf8'),
      });
      if (!stored.alreadyStored) created += 1;
    }
    return created;
  } finally {
    c.release();
  }
}

/** The worker's order for one commit: open, store the missing blobs, publish. */
async function index(
  j: Journey,
  repositoryId: string,
  sha: string,
  tree: Tree,
  candidates: string[],
  ref: { name: string; isDefaultBranch: boolean } = MAIN,
): Promise<{ opened: OpenedLayer; stored: number }> {
  const opened = await open(j, repositoryId, sha, tree, candidates, ref);
  const stored = await store(
    j,
    tree,
    opened.entries.flatMap((e) => (e.gitBlobHash === null ? [] : [e.path])),
  );
  await publishLayer(j.app, {
    tenantId: j.tenantId,
    clientId: j.clientId,
    repositoryId,
    layerId: opened.layerId,
    ref,
  });
  return { opened, stored };
}

async function head(j: Journey, repositoryId: string, refName: string) {
  const [row] = await ownerRows<{ commit_sha: string; layer_id: string }>(
    j,
    'SELECT commit_sha, layer_id FROM codegraph.ref_heads WHERE repository_id = $1 AND ref_name = $2',
    [repositoryId, refName],
  );
  return row ?? null;
}

async function referencedHashes(j: Journey): Promise<Set<string>> {
  return bound(j, async (c) => {
    const all = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page = await listReferencedBlobHashes(c, j.tenantId, { after });
      for (const hash of page.hashes) all.add(hash);
      if (page.next === null) return all;
      after = page.next;
    }
  });
}

/** blob, contents and fact rows of one hash, as the owner reads them. */
async function blobPresence(j: Journey, hash: string) {
  const [row] = await ownerRows<{ blob: number; contents: number; facts: number }>(
    j,
    `SELECT (SELECT count(*)::int FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = $2) AS blob,
            (SELECT count(*)::int FROM codegraph.blob_contents WHERE tenant_id = $1 AND git_blob_hash = $2) AS contents,
            (SELECT count(*)::int FROM codegraph.blob_fact WHERE tenant_id = $1 AND git_blob_hash = $2) AS facts`,
    [j.tenantId, hash],
  );
  return row as { blob: number; contents: number; facts: number };
}

// ── the eight steps ─────────────────────────────────────────────────────────

async function step1(ownerUrl: string, j: Journey): Promise<void> {
  const first = await migrate({ connectionString: ownerUrl });
  for (const name of first.applied) print(1, 'applied', name);
  print(1, 'applied-count', first.applied.length);
  const recorded = (
    await ownerRows<{ name: string }>(
      j,
      'SELECT name FROM codegraph.schema_migrations ORDER BY name',
    )
  ).map((r) => r.name);
  print(1, 'recorded', recorded.length);
  const layerMigration = recorded.find((name) => name.includes('commit_layers'));
  check(
    1,
    layerMigration !== undefined,
    `no recorded migration creates commit_layers: ${recorded.join(',')}`,
  );
  print(1, 'layer-migration', layerMigration as string);
  for (const table of LAYER_TABLES) {
    const [exists] = await ownerRows<{ present: boolean }>(
      j,
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`codegraph.${table}`],
    );
    check(1, exists?.present === true, `codegraph.${table} does not exist`);
    print(
      1,
      `rows-${table}`,
      await count(j, `SELECT count(*)::int AS n FROM codegraph.${table}`, []),
    );
  }
  const again = await migrate({ connectionString: ownerUrl });
  check(1, again.applied.length === 0, `a second migrate applied ${again.applied.join(',')}`);
  print(1, 'rerun-applied', again.applied.length);
  const after = await count(j, 'SELECT count(*)::int AS n FROM codegraph.schema_migrations', []);
  check(
    1,
    after === recorded.length,
    `the recorded set moved from ${String(recorded.length)} to ${String(after)}`,
  );
  print(1, 'recorded-after-rerun', after);
}

/** A tenant, two repositories and a client granted the tenant, through the operator functions. */
async function seed(ownerUrl: string, j: Journey): Promise<void> {
  const [existing] = await ownerRows<{ id: string }>(
    j,
    "SELECT id FROM codegraph.clients WHERE kind = 'operator' ORDER BY id LIMIT 1",
  );
  const operatorId = existing?.id ?? (await bootstrapOperator({ ownerUrl })).clientId;
  const c = await j.app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.client_id', $1, true)", [operatorId]);
    const call = async (sql: string, params: unknown[]): Promise<string> =>
      ((await c.query<{ v: string }>(`SELECT ${sql} AS v`, params)).rows[0] as { v: string }).v;
    j.tenantId = await call('codegraph.codegraph_create_tenant($1)', [`layer journey ${j.run}`]);
    j.r1 = await call('codegraph.codegraph_register_repository($1, $2)', [
      j.tenantId,
      'journey-r1',
    ]);
    j.r2 = await call('codegraph.codegraph_register_repository($1, $2)', [
      j.tenantId,
      'journey-r2',
    ]);
    j.clientId = await call('codegraph.codegraph_create_client($1, $2)', [
      `layer-journey-${j.run}`,
      'client',
    ]);
    await call('codegraph.codegraph_grant_access($1, $2)', [j.clientId, j.tenantId]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

async function runLayerJourney(
  through: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const ownerUrl = requireEnv('DATABASE_URL', env);
  const appUrl = requireEnv('DATABASE_APP_URL', env);
  const settings = readLayerSettings(env);
  const j: Journey = {
    owner: new pg.Pool({ connectionString: ownerUrl, max: 2 }),
    app: new pg.Pool({ connectionString: appUrl, max: 4 }),
    settings,
    run: randomBytes(4).toString('hex'),
    tenantId: '',
    clientId: '',
    r1: '',
    r2: '',
  };
  try {
    await step1(ownerUrl, j);
    await seed(ownerUrl, j);
    const finish = () => {
      console.log(`journey: steps 1-${String(through)} held`);
    };
    const sha = (label: string) => commitSha(label, j.run);

    if (through < 2) {
      finish();
      return;
    }
    // ── 2: C1 on the default branch, no candidate ancestor ──────────────────
    const c1Tree: Tree = new Map(Object.entries(SAMPLE_TREE));
    const c1 = sha('C1');
    print(2, 'tenant', j.tenantId);
    print(2, 'repository-r1', j.r1);
    print(2, 'repository-r2', j.r2);
    print(2, 'client', j.clientId);
    print(2, 'commit', c1);
    const second = await index(j, j.r1, c1, c1Tree, []);
    const l1 = second.opened;
    print(2, 'layer', l1.layerId);
    print(2, 'kind', l1.kind);
    print(2, 'parent', l1.parentLayerId ?? 'none');
    print(2, 'depth', l1.depth);
    print(2, 'chain', l1.chain.length);
    print(2, 'paths', l1.entries.length);
    print(2, 'tombstones', l1.entries.filter((e) => e.gitBlobHash === null).length);
    print(2, 'stored', second.stored);
    const m1 = await resolvedMap(j, 2, j.r1, c1);
    print(2, 'resolved', m1.size);
    check(
      2,
      l1.kind === 'base' && l1.depth === 0,
      `C1 is a ${l1.kind} at depth ${String(l1.depth)}`,
    );
    check(2, sameMap(m1, hashes(c1Tree)), 'C1 does not resolve to the tree it was written from');

    if (through < 3) {
      finish();
      return;
    }
    // ── 3: C2 over C1 — three changed, one added, one deleted ────────────────
    const c2Tree: Tree = new Map(c1Tree);
    const changed = ['config.json', 'src/index.ts', 'src/util.ts'];
    for (const path of changed) c2Tree.set(path, `${c2Tree.get(path) as string}// C2\n`);
    c2Tree.set('src/added.ts', 'export const added = true;\n');
    c2Tree.delete('docs/guide.md');
    const c2 = sha('C2');
    print(3, 'commit', c2);
    print(3, 'changed', changed.join(','));
    print(3, 'added', 'src/added.ts');
    print(3, 'deleted', 'docs/guide.md');
    const l2 = (await index(j, j.r1, c2, c2Tree, [c1])).opened;
    const l2Kept = l2.entries.filter((e) => e.gitBlobHash !== null);
    const l2Tombs = l2.entries.filter((e) => e.gitBlobHash === null);
    print(3, 'layer', l2.layerId);
    print(3, 'kind', l2.kind);
    print(3, 'parent', l2.parentLayerId ?? 'none');
    print(3, 'depth', l2.depth);
    print(3, 'entries', l2Kept.length);
    print(3, 'tombstones', l2Tombs.map((e) => e.path).join(','));
    check(
      3,
      l2.kind === 'delta' && l2.parentLayerId === l1.layerId && l2.depth === 1,
      `C2 is a ${l2.kind} over ${String(l2.parentLayerId)} at depth ${String(l2.depth)}`,
    );
    check(
      3,
      l2Kept.length === 4 && l2Tombs.length === 1,
      `C2 holds ${String(l2Kept.length)} entries and ${String(l2Tombs.length)} tombstones`,
    );
    const m2 = await resolvedMap(j, 3, j.r1, c2);
    print(3, 'resolved', m2.size);
    check(3, sameMap(m2, hashes(c2Tree)), 'C2 does not resolve to the tree the step produced');

    if (through < 4) {
      finish();
      return;
    }
    // ── 4: re-index C2 with a wrong changed-path list ────────────────────────
    // The open call takes the commit's whole tree and no changed-path list, so
    // the wrong list is the caller's and never reaches it: it is printed, not passed.
    print(4, 'supplied-changed-paths', 'README.md,lib/main.go');
    const again = await open(j, j.r1, c2, c2Tree, [c1]);
    const republished = await publishLayer(j.app, {
      tenantId: j.tenantId,
      clientId: j.clientId,
      repositoryId: j.r1,
      layerId: again.layerId,
      ref: MAIN,
    });
    const c2Layers = await count(
      j,
      "SELECT count(*)::int AS n FROM codegraph.commit_layers WHERE repository_id = $1 AND commit_sha = $2 AND state = 'published'",
      [j.r1, c2],
    );
    print(4, 'answered-layer', again.layerId);
    print(4, 'state', again.state);
    print(4, 'published-layers', c2Layers);
    print(4, 'entries', again.entries.filter((e) => e.gitBlobHash !== null).length);
    print(4, 'tombstones', again.entries.filter((e) => e.gitBlobHash === null).length);
    print(4, 'retired', republished.retired?.layerId ?? 'none');
    const m2again = await resolvedMap(j, 4, j.r1, c2);
    print(4, 'resolved-unchanged', sameMap(m2again, m2));
    check(
      4,
      again.layerId === l2.layerId && again.state === 'published' && c2Layers === 1,
      `re-indexing C2 answered ${again.layerId} (${again.state}); ${String(c2Layers)} published layers`,
    );
    check(4, sameMap(m2again, m2), 'C2 resolves differently after the re-index');

    if (through < 5) {
      finish();
      return;
    }
    // ── 5: F1 on a feature branch over C2 ────────────────────────────────────
    const f1Tree: Tree = new Map(c2Tree);
    for (const path of ['README.md', 'lib/main.go'])
      f1Tree.set(path, `${f1Tree.get(path) as string}// F1\n`);
    const f1 = sha('F1');
    print(5, 'commit', f1);
    print(5, 'ref', FEATURE.name);
    const lf = (await index(j, j.r1, f1, f1Tree, [c2, c1], FEATURE)).opened;
    print(5, 'layer', lf.layerId);
    print(5, 'kind', lf.kind);
    print(5, 'entries', lf.entries.map((e) => e.path).join(','));
    const mainHead = await head(j, j.r1, MAIN.name);
    const featureHead = await head(j, j.r1, FEATURE.name);
    print(5, 'default-head', mainHead?.commit_sha ?? 'none');
    print(5, 'feature-head', featureHead?.commit_sha ?? 'none');
    const mf = await resolvedMap(j, 5, j.r1, f1);
    const m2after = await resolvedMap(j, 5, j.r1, c2);
    print(5, 'f1-resolved-own-tree', sameMap(mf, hashes(f1Tree)));
    print(5, 'c2-resolved-unchanged', sameMap(m2after, m2));
    check(
      5,
      lf.kind === 'delta' && lf.entries.length === 2,
      `F1 is a ${lf.kind} of ${String(lf.entries.length)} entries`,
    );
    check(
      5,
      mainHead?.commit_sha === c2 && featureHead?.commit_sha === f1,
      'a ref head moved that should not have',
    );
    check(
      5,
      sameMap(mf, hashes(f1Tree)) && sameMap(m2after, m2),
      'F1 and C2 do not each resolve to their own tree',
    );

    if (through < 6) {
      finish();
      return;
    }
    // ── 6: C3 opened and abandoned; discard past the window; release ─────────
    const c3Tree: Tree = new Map(c2Tree);
    c3Tree.set('src/shapes.py', 'class Shape:\n    sides = 3\n');
    c3Tree.set('src/stored-then-killed.ts', 'export const lost = true;\n');
    const c3 = sha('C3');
    print(6, 'commit', c3);
    const l3 = await open(j, j.r1, c3, c3Tree, [c2, c1]);
    // The job stored one blob, then died before the other and before publishing.
    await store(j, c3Tree, ['src/stored-then-killed.ts']);
    const c3Hashes = l3.entries.flatMap((e) => (e.gitBlobHash === null ? [] : [e.gitBlobHash]));
    const stagedPaths = await count(
      j,
      'SELECT count(*)::int AS n FROM codegraph.layer_paths WHERE layer_id = $1',
      [l3.layerId],
    );
    const c3Resolution = await resolve(j, j.r1, c3);
    print(6, 'staged-layer', l3.layerId);
    print(6, 'staged-paths', stagedPaths);
    print(6, 'resolution', c3Resolution.state);
    print(6, 'default-head', (await head(j, j.r1, MAIN.name))?.commit_sha ?? 'none');
    check(
      6,
      l3.state === 'staged' && c3Resolution.state === 'not_indexed',
      `C3 is ${l3.state} and answers ${c3Resolution.state}`,
    );
    const now = new Date(Date.now() + settings.stagedLayerStaleness + 60_000);
    print(6, 'staleness-ms', settings.stagedLayerStaleness);
    print(6, 'discard-clock', now.toISOString());
    const discarded = await discardStaleLayers(j.app, {
      clientId: j.clientId,
      tenantId: j.tenantId,
      repositoryId: j.r1,
      settings,
      now,
    });
    print(6, 'discarded', discarded.layerIds.join(','));
    const pinned = await referencedHashes(j);
    // C3's delta holds only its two changed paths, so every hash it names is its own.
    const stillPinned = c3Hashes.filter((h) => pinned.has(h));
    print(6, 'c3-hashes-still-referenced', stillPinned.length);
    const released6 = await releaseTenant(j.app, { clientId: j.clientId, tenantId: j.tenantId });
    print(6, 'released-blobs', released6.blobHashes.join(',') || 'none');
    const m2six = await resolvedMap(j, 6, j.r1, c2);
    print(6, 'c2-resolved-unchanged', sameMap(m2six, m2));
    check(
      6,
      discarded.layerIds.includes(l3.layerId),
      `the discard removed ${discarded.layerIds.join(',') || 'nothing'}`,
    );
    check(
      6,
      stillPinned.length === 0,
      `${String(stillPinned.length)} of C3's hashes are still referenced`,
    );
    check(
      6,
      released6.blobHashes.includes(gitBlobHash(c3Tree.get('src/stored-then-killed.ts') as string)),
      'the blob only the killed job stored was not released',
    );
    check(6, sameMap(m2six, m2), 'C2 resolves differently after the discard and release');

    if (through < 7) {
      finish();
      return;
    }
    // ── 7: past the threshold, compact, then up to the ceiling ───────────────
    print(7, 'threshold', settings.compactionThreshold);
    print(7, 'ceiling', settings.hardCeiling);
    let tree: Tree = new Map(c2Tree);
    let previous = [c2, c1];
    let n = 0;
    let newest: OpenedLayer = l2;
    let newestSha = c2;
    const next = async (): Promise<OpenedLayer> => {
      n += 1;
      tree = new Map(tree);
      tree.set('src/counter.ts', `export const n = ${String(n)};\n`);
      newestSha = sha(`D${String(n)}`);
      newest = (await index(j, j.r1, newestSha, tree, previous)).opened;
      previous = [newestSha, ...previous];
      return newest;
    };
    while (newest.depth <= settings.compactionThreshold) await next();
    print(7, 'commits-to-threshold', n);
    print(7, 'compacted-commit', newestSha);
    print(7, 'depth-before', newest.depth);
    const before = await resolvedMap(j, 7, j.r1, newestSha);
    const compacted = await compactLayer(j.app, {
      tenantId: j.tenantId,
      clientId: j.clientId,
      repositoryId: j.r1,
      commitSha: newestSha,
      settings,
    });
    check(7, compacted.outcome === 'compacted', `compaction answered ${compacted.outcome}`);
    const base = (compacted as { baseLayerId: string }).baseLayerId;
    const after = await resolvedMap(j, 7, j.r1, newestSha);
    const current = await bound(j, (c) =>
      readCurrentPublishedLayer(c, { tenantId: j.tenantId, repositoryId: j.r1 }, newestSha),
    );
    const mainAfter = await head(j, j.r1, MAIN.name);
    print(7, 'base-layer', base);
    print(7, 'base-depth', current?.depth ?? -1);
    print(7, 'base-chain', current?.chain.length ?? -1);
    print(7, 'map-identical', sameMap(before, after));
    print(7, 'map-entries', after.size);
    print(7, 'default-head-layer', mainAfter?.layer_id ?? 'none');
    check(7, sameMap(before, after), 'the resolved map changed across the switch');
    check(
      7,
      current?.id === base && current.depth === 0 && current.chain.length === 1,
      'the new base is not the current layer at depth 0',
    );
    check(7, mainAfter?.layer_id === base, 'the default ref head does not name the new base');
    // Over the base, until a parent's chain sits at the ceiling; then one more.
    while (newest.kind === 'base' || newest.depth < settings.hardCeiling - 1) await next();
    const atCeiling = newest;
    print(7, 'ceiling-parent-depth', atCeiling.depth);
    print(7, 'ceiling-parent-chain', atCeiling.chain.length);
    const over = await next();
    print(7, 'over-ceiling-commit', newestSha);
    print(7, 'over-ceiling-kind', over.kind);
    print(7, 'over-ceiling-depth', over.depth);
    const [longest] = await ownerRows<{ n: number }>(
      j,
      'SELECT coalesce(max(cardinality(chain)), 0)::int AS n FROM codegraph.commit_layers WHERE repository_id = $1',
      [j.r1],
    );
    print(7, 'longest-chain', longest?.n ?? 0);
    print(7, 'commits', n);
    check(
      7,
      over.kind === 'base' && over.depth === 0,
      `the commit over the ceiling is a ${over.kind} at depth ${String(over.depth)}`,
    );
    check(
      7,
      (longest?.n ?? 0) <= settings.hardCeiling,
      `a chain of ${String(longest?.n)} exceeds the ceiling`,
    );

    if (through < 8) {
      finish();
      return;
    }
    // ── 8: the C1 tree under R2, delete R1, release ──────────────────────────
    const c1Hashes = new Set(hashes(c1Tree).values());
    const r1Hashes = new Set(
      (
        await ownerRows<{ h: string }>(
          j,
          'SELECT DISTINCT git_blob_hash AS h FROM codegraph.layer_paths WHERE repository_id = $1 AND git_blob_hash IS NOT NULL',
          [j.r1],
        )
      ).map((r) => r.h),
    );
    const onlyR1 = [...r1Hashes].filter((h) => !c1Hashes.has(h)).sort();
    const r2 = await index(j, j.r2, c1, c1Tree, []);
    print(8, 'r2-commit', c1);
    print(8, 'r2-layer', r2.opened.layerId);
    print(8, 'r2-newly-stored', r2.stored);
    const sharedBefore = new Map<string, { blob: number; contents: number; facts: number }>();
    for (const h of c1Hashes) sharedBefore.set(h, await blobPresence(j, h));
    const opClient = await j.app.connect();
    try {
      const [op] = await ownerRows<{ id: string }>(
        j,
        "SELECT id FROM codegraph.clients WHERE kind = 'operator' ORDER BY id LIMIT 1",
      );
      await opClient.query('BEGIN');
      await opClient.query("SELECT set_config('app.client_id', $1, true)", [op?.id]);
      await opClient.query('SELECT codegraph.codegraph_delete_repository_as_operator($1, $2)', [
        j.tenantId,
        j.r1,
      ]);
      await opClient.query('COMMIT');
    } finally {
      opClient.release();
    }
    print(8, 'deleted-repository', j.r1);
    let r1Left = 0;
    for (const table of LAYER_TABLES) {
      const left = await count(
        j,
        `SELECT count(*)::int AS n FROM codegraph.${table} WHERE repository_id = $1`,
        [j.r1],
      );
      print(8, `r1-${table}-left`, left);
      r1Left += left;
    }
    const released8 = await releaseTenant(j.app, { clientId: j.clientId, tenantId: j.tenantId });
    print(8, 'released-blobs', released8.blobHashes.length);
    let sharedKept = 0;
    for (const h of c1Hashes) {
      const now8 = await blobPresence(j, h);
      const was = sharedBefore.get(h);
      if (now8.blob === 1 && now8.contents === 1 && now8.facts === was?.facts) sharedKept += 1;
    }
    let onlyGone = 0;
    for (const h of onlyR1) {
      const p = await blobPresence(j, h);
      if (p.blob === 0 && p.contents === 0 && p.facts === 0) onlyGone += 1;
    }
    print(8, 'shared-blobs', c1Hashes.size);
    print(8, 'shared-kept-with-contents-and-facts', sharedKept);
    print(8, 'only-r1-blobs', onlyR1.length);
    print(8, 'only-r1-gone-with-contents-and-facts', onlyGone);
    check(8, r1Left === 0, `${String(r1Left)} rows of R1 survived its delete`);
    check(
      8,
      sharedKept === c1Hashes.size,
      `${String(c1Hashes.size - sharedKept)} shared blobs lost a row`,
    );
    check(
      8,
      onlyR1.length > 0 && onlyGone === onlyR1.length,
      `${String(onlyR1.length - onlyGone)} of ${String(onlyR1.length)} R1-only blobs survived`,
    );
    const again8 = await releaseTenant(j.app, { clientId: j.clientId, tenantId: j.tenantId });
    print(
      8,
      'second-release',
      `${String(again8.layerIds.length)} layers, ${String(again8.blobHashes.length)} blobs`,
    );
    check(
      8,
      again8.layerIds.length === 0 && again8.blobHashes.length === 0,
      'a second release released more',
    );
    finish();
  } finally {
    await Promise.all([j.owner.end(), j.app.end()]);
  }
}

try {
  const { values } = parseArgs({ options: { through: { type: 'string', default: '8' } } });
  const through = Number(values.through);
  if (!Number.isInteger(through) || through < 1 || through > 8) {
    throw new Error(`--through must be a step from 1 to 8, not ${values.through}.`);
  }
  await runLayerJourney(through);
} catch (error) {
  if (error instanceof StepFailed) {
    console.error(`step ${String(error.step)} failed: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
