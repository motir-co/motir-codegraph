import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type pg from 'pg';

/**
 * The commit-layer capacity gate's run-time generators and measurement harness.
 * Nothing here is committed data: every map, lineage and delta is generated in
 * process from a seed label, and no timing baseline is kept between runs.
 */

/** The story's three targets, in milliseconds. Never relaxed for CI. */
export const DELTA_TARGET_MS = 2_000;
export const RESOLVE_TARGET_MS = 150;
export const COMPACT_TARGET_MS = 60_000;

/** The resolved map size every scenario measures at. */
export const MAP_PATHS = 20_000;
/** The changed paths of the timed delta. */
export const DELTA_PATHS = 50;
/** Paths each lineage delta changes, so the resolved map stays MAP_PATHS. */
export const LINEAGE_CHANGED_PATHS = 2;
/** Measured repetitions after the one discarded warm-up pass. */
export const REPETITIONS = 3;

/** A git-shaped blob hash for generated content: sha1 of git's blob header and the content. */
export function blobHash(content: string): string {
  return createHash('sha1')
    .update(`blob ${String(Buffer.byteLength(content))}\0`)
    .update(content)
    .digest('hex');
}

/** A fixed, printable forty-hex commit label. */
export function commitSha(label: string): string {
  return createHash('sha1').update(`capacity commit ${label}`).digest('hex');
}

/**
 * A MAP_PATHS-path tree, path → blob hash, spread over nested directories the
 * way a real repository is, every path and every hash distinct.
 */
export function generateMap(size = MAP_PATHS): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < size; i += 1) {
    const dir = `pkg${String(i % 40).padStart(2, '0')}/mod${String(Math.floor(i / 40) % 25).padStart(2, '0')}`;
    const path = `${dir}/file${String(i).padStart(5, '0')}.ts`;
    map.set(path, blobHash(`export const v${String(i)} = ${String(i)};\n`));
  }
  return map;
}

/**
 * `map` with `count` paths changed to new content labelled `label`, starting
 * at `offset` and wrapping, so successive deltas touch different paths.
 */
export function changePaths(
  map: ReadonlyMap<string, string>,
  count: number,
  label: string,
  offset = 0,
): { readonly tree: Map<string, string>; readonly changed: Map<string, string> } {
  const paths = [...map.keys()];
  const tree = new Map(map);
  const changed = new Map<string, string>();
  for (let k = 0; k < count; k += 1) {
    const path = paths[(offset + k) % paths.length] as string;
    const hash = blobHash(`// ${label} ${path}\n`);
    tree.set(path, hash);
    changed.set(path, hash);
  }
  return { tree, changed };
}

export interface Readings {
  readonly warmUpMs: number;
  readonly ms: readonly number[];
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/**
 * The fixed protocol: one discarded warm-up pass, then REPETITIONS measured
 * passes. `setup(pass)` runs OUTSIDE the window (pass 0 is the warm-up);
 * `measured(pass, prepared)` is the only thing inside it; `verify` runs after
 * the window closes. Never adaptive: no retry, no extra pass.
 */
export async function measure<P, R>(
  setup: (pass: number) => Promise<P>,
  measured: (pass: number, prepared: P) => Promise<R>,
  verify: (pass: number, result: R, prepared: P) => Promise<void>,
): Promise<Readings> {
  const all: number[] = [];
  for (let pass = 0; pass <= REPETITIONS; pass += 1) {
    const prepared = await setup(pass);
    const opened = performance.now();
    const result = await measured(pass, prepared);
    const ms = performance.now() - opened;
    await verify(pass, result, prepared);
    all.push(ms);
  }
  const [warmUpMs, ...ms] = all as [number, ...number[]];
  const ordered = [...ms].sort((a, b) => a - b);
  return {
    warmUpMs,
    ms,
    median: ordered[Math.floor(ordered.length / 2)] as number,
    min: ordered[0] as number,
    max: ordered[ordered.length - 1] as number,
  };
}

export function describeReadings(name: string, target: number, r: Readings): string {
  const f = (n: number) => n.toFixed(1);
  return (
    `${name}: median ${f(r.median)} ms (target ${String(target)} ms); ` +
    `readings ${r.ms.map(f).join(', ')} ms; min ${f(r.min)} max ${f(r.max)}; warm-up ${f(r.warmUpMs)} ms`
  );
}

/** One statement a recorded pool issued, with the arguments it was called with. */
export interface RecordedStatement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * Wraps `pool` so every statement its connections issue is kept with its
 * argument arrays (tests/helpers/queryLog.ts keeps text only), for as long as
 * `recording` is on. Restores each connection's own query on release.
 */
export function recordWithParams(pool: pg.Pool): {
  readonly pool: pg.Pool;
  readonly statements: RecordedStatement[];
  start(): void;
  stop(): void;
} {
  const statements: RecordedStatement[] = [];
  let recording = false;
  const wrapped = Object.create(pool) as pg.Pool;
  wrapped.connect = (async () => {
    const c = await pool.connect();
    const query = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
    (c as unknown as { query: unknown }).query = (text: string, params?: unknown[]) => {
      if (recording) statements.push({ text, params: params ?? [] });
      return query(text, params);
    };
    const release = c.release.bind(c);
    c.release = (err?: Error | boolean) => {
      (c as unknown as { query: unknown }).query = query;
      release(err);
    };
    return c;
  }) as pg.Pool['connect'];
  return {
    pool: wrapped,
    statements,
    start: () => {
      recording = true;
    },
    stop: () => {
      recording = false;
    },
  };
}

/** The plan of `sql` with `params`, run on `db` as it is bound. */
export async function planOf(db: pg.ClientBase, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    params,
  );
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

/** The indexes on the three measured tables, from the catalogue. */
export async function layerIndexes(db: pg.ClientBase): Promise<string> {
  const { rows } = await db.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'codegraph' AND tablename IN ('commit_layers', 'layer_paths', 'ref_heads')
     ORDER BY tablename, indexname`,
  );
  return rows.map((r) => r.indexdef).join('\n');
}
