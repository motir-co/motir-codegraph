import { performance } from 'node:perf_hooks';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readLayerSettings } from '../../src/config.js';
import { readCurrentPublishedLayer, type LayerScope } from '../../src/db/layers.js';
import {
  COMPACTION_BATCH_SIZE,
  compactLayer,
  type CompactionResult,
} from '../../src/layers/compact.js';
import { openLayer, type OpenedLayer } from '../../src/layers/openLayer.js';
import { publishLayer } from '../../src/layers/publish.js';
import { RESOLVE_COMMIT_SQL, resolveCommit, type Resolution } from '../../src/layers/resolution.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { queryRows, withClient } from '../helpers/db.js';
import { foundation, type Foundation } from './foundation.fixture.js';
import {
  changePaths,
  COMPACT_TARGET_MS,
  commitSha,
  DELTA_PATHS,
  DELTA_TARGET_MS,
  describeReadings,
  generateMap,
  layerIndexes,
  LINEAGE_CHANGED_PATHS,
  MAP_PATHS,
  measure,
  planOf,
  recordWithParams,
  RESOLVE_TARGET_MS,
  type Readings,
} from './layerCapacity.fixture.js';

// MOTIR-11003's three capacity targets, measured on the CI Postgres against
// one 20,000-path lineage seeded once through the shipped calls: a 50-path
// delta opened and published over the base within 2 s; the commit whose chain
// sits at the configured hard ceiling resolved within 150 ms; a commit past the
// compaction threshold compacted within 60 s with every write bounded. Each
// window covers exactly the shipped call; seeding happens before it and is
// printed on its own line. The median of three measured repetitions after one
// discarded warm-up is asserted, never retried and never against another number.

const settings = readLayerSettings(); // the configuration in force decides the depths

let f: Foundation;
let pool: pg.Pool;
let scope: LayerScope;
let clientId: string;
const base = { sha: commitSha('base'), map: new Map<string, string>() };
/** The lineage over the base, nearest the base first: depth 1 … ceiling − 1. */
const lineage: { sha: string; map: Map<string, string>; depth: number }[] = [];

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Blob rows for `hashes`, written as the owner: publish checks only that a row exists. */
async function storeBlobRows(hashes: Iterable<string>): Promise<void> {
  await withClient(f.db.ownerUrl, (c) =>
    c.query(
      `INSERT INTO codegraph.blob (tenant_id, git_blob_hash, size_bytes, outcome, lossy)
       SELECT $1, h, 1, 'unsupported', false FROM unnest($2::text[]) AS h
       ON CONFLICT DO NOTHING`,
      [scope.tenantId, [...new Set(hashes)]],
    ),
  );
}

async function open(sha: string, map: Map<string, string>, candidates: string[], on = pool) {
  return openLayer(on, {
    clientId,
    ...scope,
    commitSha: sha,
    refName: 'refs/heads/main',
    isDefaultBranch: true,
    candidateAncestors: candidates,
    paths: map,
    settings,
  });
}

async function publish(layer: OpenedLayer) {
  return publishLayer(pool, {
    clientId,
    ...scope,
    layerId: layer.layerId,
    ref: { name: 'refs/heads/main', isDefaultBranch: true },
  });
}

async function bound<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(BIND_TENANT_SQL, [clientId, scope.tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

async function resolvedMap(sha: string): Promise<Map<string, string>> {
  const r = await bound((c) => resolveCommit(c, scope.tenantId, scope.repositoryId, sha));
  if (r.state !== 'indexed') throw new Error(`${sha} is not indexed`);
  return r.paths;
}

/** What a miss reports: the readings, the resolution statement's plan, and the indexes. */
async function missReport(name: string, target: number, r: Readings, sha: string) {
  const plan = await bound((c) =>
    planOf(c, RESOLVE_COMMIT_SQL, [scope.tenantId, scope.repositoryId, sha]),
  );
  const indexes = await withClient(f.db.ownerUrl, (c) => layerIndexes(c));
  return `${describeReadings(name, target, r)}\n\nplan of the resolution statement:\n${plan}\n\nindexes:\n${indexes}`;
}

beforeAll(async () => {
  f = await foundation();
  pool = new pg.Pool({ connectionString: f.db.appUrl, max: 6 });
  clientId = f.fx.readerId;
  const repository = f.fx.tenantA.repositories[0];
  if (repository === undefined) throw new Error('fixture has no repository');
  scope = { tenantId: f.fx.tenantA.id, repositoryId: repository.id };

  const seeding = performance.now();
  base.map = generateMap();
  await storeBlobRows(base.map.values());
  await publish(await open(base.sha, base.map, []));
  let previous = { sha: base.sha, map: base.map };
  for (let depth = 1; depth <= settings.hardCeiling - 1; depth += 1) {
    const sha = commitSha(`lineage ${String(depth)}`);
    const { tree, changed } = changePaths(
      previous.map,
      LINEAGE_CHANGED_PATHS,
      `lineage ${String(depth)}`,
      depth * LINEAGE_CHANGED_PATHS,
    );
    await storeBlobRows(changed.values());
    const opened = await open(sha, tree, [previous.sha]);
    if (opened.depth !== depth)
      throw new Error(`lineage commit ${String(depth)} sits at ${String(opened.depth)}`);
    await publish(opened);
    lineage.push({ sha, map: tree, depth });
    previous = { sha, map: tree };
  }
  console.log(
    `seeding (outside every window): a ${String(MAP_PATHS)}-path base and ${String(lineage.length)} deltas ` +
      `to the hard ceiling ${String(settings.hardCeiling)} in ${(performance.now() - seeding).toFixed(0)} ms`,
  );
}, 600_000);

afterAll(async () => {
  await pool.end();
  await f.db.drop();
});

describe('commit-layer capacity', () => {
  it(`writes and publishes a ${String(DELTA_PATHS)}-path delta over the ${String(MAP_PATHS)}-path base within ${String(DELTA_TARGET_MS)} ms`, async () => {
    // The parent base already answers its whole map before any window opens.
    expect((await resolvedMap(base.sha)).size).toBe(MAP_PATHS);
    const readings = await measure(
      async (pass) => {
        const { tree, changed } = changePaths(
          base.map,
          DELTA_PATHS,
          `delta ${String(pass)}`,
          5_000 + pass * DELTA_PATHS,
        );
        await storeBlobRows(changed.values()); // the blob library's cost, outside the window
        return { sha: commitSha(`delta ${String(pass)}`), tree };
      },
      async (_pass, p) => {
        const opened = await open(p.sha, p.tree, [base.sha]);
        await publish(opened);
        return opened;
      },
      async (_pass, opened, p) => {
        expect(opened).toMatchObject({ kind: 'delta', ancestorCommit: base.sha });
        expect(opened.entries).toHaveLength(DELTA_PATHS);
        const resolved = await resolvedMap(p.sha);
        expect(resolved.size).toBe(MAP_PATHS);
        expect(sameMap(resolved, p.tree)).toBe(true);
      },
    );
    console.log(describeReadings('delta write + publish', DELTA_TARGET_MS, readings));
    if (readings.median > DELTA_TARGET_MS) {
      throw new Error(
        await missReport('delta write + publish', DELTA_TARGET_MS, readings, base.sha),
      );
    }
  }, 300_000);

  it(`resolves the ${String(MAP_PATHS)}-path commit at the hard ceiling within ${String(RESOLVE_TARGET_MS)} ms`, async () => {
    const top = lineage[lineage.length - 1];
    if (top === undefined) throw new Error('no lineage');
    const layer = await bound((c) => readCurrentPublishedLayer(c, scope, top.sha));
    expect(layer?.depth).toBe(settings.hardCeiling - 1);
    expect(layer?.chain).toHaveLength(settings.hardCeiling);

    const readings = await measure(
      async () => {
        const c = await pool.connect();
        await c.query('BEGIN');
        await c.query(BIND_TENANT_SQL, [clientId, scope.tenantId]);
        return c;
      },
      (_pass, c) => resolveCommit(c, scope.tenantId, scope.repositoryId, top.sha),
      async (_pass, resolution: Resolution, c) => {
        await c.query('ROLLBACK');
        c.release();
        expect(resolution.state).toBe('indexed');
        const paths = (resolution as { paths: Map<string, string> }).paths;
        expect(paths.size).toBe(MAP_PATHS);
        expect(sameMap(paths, top.map)).toBe(true);
      },
    );
    console.log(describeReadings('resolution at the ceiling', RESOLVE_TARGET_MS, readings));
    if (readings.median > RESOLVE_TARGET_MS) {
      throw new Error(
        await missReport('resolution at the ceiling', RESOLVE_TARGET_MS, readings, top.sha),
      );
    }
  }, 120_000);

  it(`compacts a ${String(MAP_PATHS)}-path chain past the threshold within ${String(COMPACT_TARGET_MS)} ms, every write bounded`, async () => {
    // Four passes, four different commits past the threshold: the deepest first.
    const due = lineage.filter((l) => l.depth > settings.compactionThreshold).reverse();
    expect(due.length).toBeGreaterThanOrEqual(4);
    const recorder = recordWithParams(pool);
    const readStatCommits = () =>
      withClient(f.db.ownerUrl, async (c) => {
        const [row] = await queryRows<{ n: string }>(
          c,
          'SELECT xact_commit AS n FROM pg_stat_database WHERE datname = current_database()',
        );
        return Number(row?.n);
      });
    const readings = await measure(
      async (pass) => {
        const target = due[pass] as (typeof due)[number];
        const before = await resolvedMap(target.sha);
        const commitsBefore = await readStatCommits();
        recorder.statements.length = 0;
        recorder.start();
        return { target, before, commitsBefore };
      },
      (_pass, p): Promise<CompactionResult> =>
        compactLayer(recorder.pool, {
          tenantId: scope.tenantId,
          clientId,
          repositoryId: scope.repositoryId,
          commitSha: p.target.sha,
          settings,
        }),
      async (pass, result, p) => {
        recorder.stop();
        expect(result.outcome).toBe('compacted');
        expect(sameMap(await resolvedMap(p.target.sha), p.before)).toBe(true);
        const inserts = recorder.statements.filter((s) =>
          s.text.startsWith('INSERT INTO codegraph.layer_paths'),
        );
        const sizes = inserts.map((s) => (s.params[3] as unknown[]).length);
        const commits = recorder.statements.filter((s) => s.text === 'COMMIT').length;
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(MAP_PATHS);
        for (const size of sizes) expect(size).toBeLessThanOrEqual(COMPACTION_BATCH_SIZE);
        // The base row, one transaction per batch, and the switch.
        expect(commits).toBe(inserts.length + 2);
        const statCommits = (await readStatCommits()) - p.commitsBefore;
        console.log(
          `compaction pass ${String(pass)}: ${String(inserts.length)} batch statements, largest ${String(Math.max(...sizes))} ` +
            `rows (bound ${String(COMPACTION_BATCH_SIZE)}); ${String(commits)} commits recorded, ` +
            `pg_stat_database.xact_commit +${String(statCommits)} so far (the statistics flush lags; the recorded commits are what is asserted)`,
        );
      },
    );
    console.log(describeReadings('compaction', COMPACT_TARGET_MS, readings));
    if (readings.median > COMPACT_TARGET_MS) {
      throw new Error(
        await missReport(
          'compaction',
          COMPACT_TARGET_MS,
          readings,
          (due[1] as { sha: string }).sha,
        ),
      );
    }
  }, 600_000);
});
