import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { runScript, scriptNodeArgs, type CommandResult } from '../helpers/processes.js';

// The commit-layer story's eight-step recipe, run by the fixture command
// `pnpm layer:journey` over a database this file creates unmigrated (step 1
// migrates it). Each step is asserted twice: against the observation lines the
// command printed, and with this file's own queries against the three tables.
//
// Step 8 deletes R1, so the rows steps 2–7 leave are read from a first run
// stopped after step 7 (`--through 7`); step 8 is read from a second, full run
// over the same database, which seeds a tenant of its own.

const THRESHOLD = 2;
const CEILING = 5;

let db: FreshDatabase;
let partial: CommandResult;
let full: CommandResult;
type Seen = Map<number, Map<string, string[]>>;
/** step → key → every value printed for it, in order: steps 1–7 of the first run, 8 of the second. */
const seen: Seen = new Map();
const seenFull: Seen = new Map();

function parse(stdout: string, into: Seen): void {
  for (const line of stdout.split('\n')) {
    const match = /^step (\d): ([^=]+)=(.*)$/.exec(line);
    if (match === null) continue;
    const [, step, key, value] = match as unknown as [string, string, string, string];
    const byKey = into.get(Number(step)) ?? new Map<string, string[]>();
    byKey.set(key, [...(byKey.get(key) ?? []), value]);
    into.set(Number(step), byKey);
  }
}

function values(step: number, key: string): string[] {
  return (step === 8 ? seenFull : seen).get(step)?.get(key) ?? [];
}

function one(step: number, key: string): string {
  const all = values(step, key);
  expect(all, `step ${String(step)} printed ${key} once`).toHaveLength(1);
  return all[0] as string;
}

const num = (step: number, key: string) => Number(one(step, key));

async function rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return withClient(db.ownerUrl, (c) => queryRows<T>(c, sql, params));
}

async function layer(id: string) {
  const [row] = await rows<{
    kind: string;
    state: string;
    depth: number;
    parent_layer_id: string | null;
    commit_sha: string;
    n_chain: number;
  }>(
    `SELECT kind, state, depth, parent_layer_id, commit_sha, cardinality(chain) AS n_chain
     FROM codegraph.commit_layers WHERE id = $1`,
    [id],
  );
  return row;
}

async function pathsOf(layerId: string) {
  return rows<{ path: string; git_blob_hash: string | null }>(
    'SELECT path, git_blob_hash FROM codegraph.layer_paths WHERE layer_id = $1 ORDER BY path COLLATE "C"',
    [layerId],
  );
}

beforeAll(async () => {
  db = await freshDatabase({ migrate: false });
  const env = {
    DATABASE_URL: db.ownerUrl,
    DATABASE_APP_URL: db.appUrl,
    COMPACTION_THRESHOLD: String(THRESHOLD),
    HARD_CEILING: String(CEILING),
  };
  partial = await runScript('layer:journey', env, ['--through', '7']);
  parse(partial.stdout, seen);
  full = await runScript('layer:journey', env);
  parse(full.stdout, seenFull);
}, 120_000);

afterAll(async () => {
  await db.drop();
});

describe('the command', () => {
  it('is declared as layer:journey, runs node, and ran every step to a clean exit', () => {
    expect(scriptNodeArgs('layer:journey')).toContain('src/cli/layer-journey.ts');
    for (const run of [partial, full]) {
      // Node announces a missing .env under --env-file-if-exists (CI has none); nothing else may reach stderr.
      const stderr = run.stderr
        .split('\n')
        .filter((line) => line !== '' && !/^\.env not found\. Continuing without it/.test(line));
      expect(stderr).toEqual([]);
      expect(run.code).toBe(0);
    }
    expect([...seen.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...seenFull.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const byKey of [...seen.values(), ...seenFull.values()]) {
      expect(byKey.size).toBeGreaterThan(0);
    }
    expect(partial.stdout).toContain('journey: steps 1-7 held');
    expect(full.stdout).toContain('journey: steps 1-8 held');
    // The second run seeded a tenant of its own rather than colliding with the first.
    expect(seenFull.get(2)?.get('tenant')).not.toEqual(seen.get(2)?.get('tenant'));
    expect(seenFull.get(1)?.get('applied-count')).toEqual(['0']);
  });

  it('refuses a step number outside the recipe', async () => {
    const refused = await runScript(
      'layer:journey',
      { DATABASE_URL: db.ownerUrl, DATABASE_APP_URL: db.appUrl },
      ['--through', '9'],
    );
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('--through must be a step from 1 to 8');
  });

  it('refuses to start without either login, naming it', async () => {
    const noOwner = await runScript('layer:journey', {
      DATABASE_URL: '',
      DATABASE_APP_URL: db.appUrl,
    });
    expect(noOwner.code).not.toBe(0);
    expect(noOwner.stderr).toContain('DATABASE_URL is not set');
    const noApp = await runScript('layer:journey', {
      DATABASE_URL: db.ownerUrl,
      DATABASE_APP_URL: '',
    });
    expect(noApp.code).not.toBe(0);
    expect(noApp.stderr).toContain('DATABASE_APP_URL is not set');
  });
});

describe('step 1: migrate, then migrate again', () => {
  it('applied every migration in filename order, the layer migration among them, and a re-run applied nothing', async () => {
    const applied = values(1, 'applied');
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toEqual([...applied].sort());
    const recorded = (
      await rows<{ name: string }>('SELECT name FROM codegraph.schema_migrations ORDER BY name')
    ).map((r) => r.name);
    expect(applied).toEqual(recorded);
    const layerMigration = one(1, 'layer-migration');
    expect(recorded).toContain(layerMigration);
    expect(num(1, 'rerun-applied')).toBe(0);
    expect(num(1, 'recorded-after-rerun')).toBe(recorded.length);
  });

  it('found the three tables in the catalogue, empty', async () => {
    for (const table of ['commit_layers', 'layer_paths', 'ref_heads']) {
      expect(num(1, `rows-${table}`)).toBe(0);
      const [present] = await rows<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [`codegraph.${table}`],
      );
      expect(present?.present).toBe(true);
    }
  });
});

describe('step 2: C1 on the default branch', () => {
  it('wrote one published base at depth 0 holding the whole tree, no tombstone, and resolved it whole', async () => {
    expect(one(2, 'kind')).toBe('base');
    expect(one(2, 'parent')).toBe('none');
    expect(num(2, 'depth')).toBe(0);
    expect(num(2, 'chain')).toBe(1);
    expect(num(2, 'tombstones')).toBe(0);
    expect(num(2, 'stored')).toBe(num(2, 'paths'));
    expect(num(2, 'resolved')).toBe(num(2, 'paths'));
    const id = one(2, 'layer');
    expect(await layer(id)).toMatchObject({
      kind: 'base',
      state: 'published',
      depth: 0,
      commit_sha: one(2, 'commit'),
    });
    const paths = await pathsOf(id);
    expect(paths).toHaveLength(num(2, 'paths'));
    expect(paths.every((p) => p.git_blob_hash !== null)).toBe(true);
    const ofC1 = await rows('SELECT 1 FROM codegraph.commit_layers WHERE commit_sha = $1', [
      one(2, 'commit'),
    ]);
    expect(ofC1).toHaveLength(1);
  });
});

describe('step 3: C2 over C1', () => {
  it('wrote a delta over C1 of exactly the three changed paths, the added one, and one tombstone', async () => {
    const id = one(3, 'layer');
    expect(await layer(id)).toMatchObject({
      kind: 'delta',
      depth: 1,
      parent_layer_id: one(2, 'layer'),
    });
    const paths = await pathsOf(id);
    expect(paths.filter((p) => p.git_blob_hash !== null).map((p) => p.path)).toEqual(
      [...one(3, 'changed').split(','), one(3, 'added')].sort(),
    );
    expect(paths.filter((p) => p.git_blob_hash === null).map((p) => p.path)).toEqual([
      one(3, 'deleted'),
    ]);
    expect(num(3, 'entries')).toBe(4);
    expect(one(3, 'tombstones')).toBe(one(3, 'deleted'));
    // One more path than C1, one fewer: the same size.
    expect(num(3, 'resolved')).toBe(num(2, 'resolved'));
  });
});

describe('step 4: C2 re-indexed with a wrong changed-path list', () => {
  it('answered the layer C2 already carries and wrote no second one', async () => {
    expect(one(4, 'answered-layer')).toBe(one(3, 'layer'));
    expect(one(4, 'state')).toBe('published');
    expect(num(4, 'entries')).toBe(4);
    expect(num(4, 'tombstones')).toBe(1);
    expect(one(4, 'retired')).toBe('none');
    expect(one(4, 'resolved-unchanged')).toBe('true');
    const published = await rows(
      "SELECT 1 FROM codegraph.commit_layers WHERE commit_sha = $1 AND state = 'published'",
      [one(3, 'commit')],
    );
    expect(published).toHaveLength(1);
    expect(await pathsOf(one(3, 'layer'))).toHaveLength(5);
  });
});

describe('step 5: F1 on a feature branch over C2', () => {
  it('wrote a delta of its two paths and moved only the feature ref', async () => {
    const id = one(5, 'layer');
    expect(await layer(id)).toMatchObject({ kind: 'delta', parent_layer_id: one(3, 'layer') });
    expect((await pathsOf(id)).map((p) => p.path)).toEqual(one(5, 'entries').split(','));
    expect(one(5, 'entries').split(',')).toHaveLength(2);
    const heads = await rows<{ ref_name: string; commit_sha: string }>(
      'SELECT ref_name, commit_sha FROM codegraph.ref_heads WHERE repository_id = $1 ORDER BY ref_name',
      [one(2, 'repository-r1')],
    );
    // Read after step 7, which moved the default head on; the feature head never moved again.
    expect(heads.find((h) => h.ref_name === one(5, 'ref'))?.commit_sha).toBe(one(5, 'commit'));
    expect(one(5, 'default-head')).toBe(one(3, 'commit'));
    expect(one(5, 'feature-head')).toBe(one(5, 'commit'));
    expect(one(5, 'f1-resolved-own-tree')).toBe('true');
    expect(one(5, 'c2-resolved-unchanged')).toBe('true');
  });
});

describe('step 6: C3 opened and left, discarded past the window, released', () => {
  it('left a staged layer that answered not indexed, then discarded it and released its stored blob', async () => {
    expect(num(6, 'staged-paths')).toBe(2);
    expect(one(6, 'resolution')).toBe('not_indexed');
    expect(one(6, 'default-head')).toBe(one(3, 'commit'));
    expect(one(6, 'discarded')).toBe(one(6, 'staged-layer'));
    expect(num(6, 'c3-hashes-still-referenced')).toBe(0);
    expect(one(6, 'released-blobs').split(',')).toHaveLength(1);
    expect(one(6, 'c2-resolved-unchanged')).toBe('true');
    expect(await layer(one(6, 'staged-layer'))).toBeUndefined();
    expect(await pathsOf(one(6, 'staged-layer'))).toEqual([]);
    expect(
      await rows('SELECT 1 FROM codegraph.blob WHERE git_blob_hash = $1', [
        one(6, 'released-blobs'),
      ]),
    ).toEqual([]);
  });
});

describe('step 7: past the threshold, compacted, then a base at the ceiling', () => {
  it('ran with the configured pair, compacted to an identical map, and never exceeded the ceiling', async () => {
    expect(num(7, 'threshold')).toBe(THRESHOLD);
    expect(num(7, 'ceiling')).toBe(CEILING);
    expect(num(7, 'depth-before')).toBeGreaterThan(THRESHOLD);
    expect(one(7, 'map-identical')).toBe('true');
    expect(num(7, 'base-depth')).toBe(0);
    expect(num(7, 'base-chain')).toBe(1);
    expect(one(7, 'default-head-layer')).toBe(one(7, 'base-layer'));
    expect(num(7, 'ceiling-parent-chain')).toBe(CEILING);
    expect(one(7, 'over-ceiling-kind')).toBe('base');
    expect(num(7, 'over-ceiling-depth')).toBe(0);
    expect(num(7, 'longest-chain')).toBeLessThanOrEqual(CEILING);
    const r1 = one(2, 'repository-r1');
    const [longest] = await rows<{ n: number }>(
      'SELECT max(cardinality(chain))::int AS n FROM codegraph.commit_layers WHERE repository_id = $1',
      [r1],
    );
    expect(longest?.n).toBeLessThanOrEqual(CEILING);
    expect(await layer(one(7, 'base-layer'))).toMatchObject({
      kind: 'base',
      depth: 0,
      state: 'published',
      commit_sha: one(7, 'compacted-commit'),
    });
    const [retired] = await rows<{ superseded: boolean }>(
      `SELECT superseded_at IS NOT NULL AS superseded FROM codegraph.commit_layers
       WHERE commit_sha = $1 AND repository_id = $2 AND id <> $3`,
      [one(7, 'compacted-commit'), r1, one(7, 'base-layer')],
    );
    expect(retired?.superseded).toBe(true);
    const [over] = await rows<{ kind: string; depth: number }>(
      'SELECT kind, depth FROM codegraph.commit_layers WHERE commit_sha = $1 AND repository_id = $2',
      [one(7, 'over-ceiling-commit'), r1],
    );
    expect(over).toEqual({ kind: 'base', depth: 0 });
  });
});

describe('step 8: the same tree under R2, R1 deleted, released', () => {
  it('took R1’s rows, kept the shared blobs with contents and facts, and released only R1’s own', async () => {
    const r1 = seenFull.get(2)?.get('repository-r1')?.[0] as string;
    for (const table of ['commit_layers', 'layer_paths', 'ref_heads']) {
      expect(num(8, `r1-${table}-left`)).toBe(0);
      expect(await rows(`SELECT 1 FROM codegraph.${table} WHERE repository_id = $1`, [r1])).toEqual(
        [],
      );
    }
    expect(num(8, 'r2-newly-stored')).toBe(0);
    expect(num(8, 'shared-kept-with-contents-and-facts')).toBe(num(8, 'shared-blobs'));
    expect(num(8, 'only-r1-blobs')).toBeGreaterThan(0);
    expect(num(8, 'only-r1-gone-with-contents-and-facts')).toBe(num(8, 'only-r1-blobs'));
    expect(num(8, 'released-blobs')).toBe(num(8, 'only-r1-blobs'));
    expect(one(8, 'second-release')).toBe('0 layers, 0 blobs');

    // The tenant's blobs are now exactly R2's tree, each with its contents.
    const tenant = seenFull.get(2)?.get('tenant')?.[0] as string;
    const r2Hashes = await rows<{ h: string }>(
      'SELECT DISTINCT git_blob_hash AS h FROM codegraph.layer_paths WHERE tenant_id = $1 ORDER BY 1',
      [tenant],
    );
    const blobs = await rows<{ h: string; contents: boolean }>(
      `SELECT b.git_blob_hash AS h, EXISTS (SELECT 1 FROM codegraph.blob_contents x
         WHERE x.tenant_id = b.tenant_id AND x.git_blob_hash = b.git_blob_hash) AS contents
       FROM codegraph.blob b WHERE b.tenant_id = $1 ORDER BY 1`,
      [tenant],
    );
    expect(blobs).toEqual(r2Hashes.map(({ h }) => ({ h, contents: true })));
    expect(blobs).toHaveLength(num(8, 'shared-blobs'));
  });
});
