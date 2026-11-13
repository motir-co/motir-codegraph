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

/**
 * How the resolution target is judged on a shared runner (MOTIR-11228). The
 * SAME code read 112–173 ms on GitHub's shared runners and 51–63 ms on a quiet
 * 4-core machine, so a wall-clock bound with 25–35 % headroom failed on a slow
 * runner rather than on slow resolution. The gate therefore asserts what the
 * resolution statement itself controls: its cost over a same-run baseline that
 * reads the same 20,000 rows of ONE layer, timed pass by pass beside it on the
 * same connection, so a slow runner slows both sides.
 *
 * - RESOLVE_OVERHEAD_LIMIT: the median of the per-pass ratios may not exceed
 *   it. Measured locally: 3.65× quiet; 2.28× and 1.93× with the cores 2× and 4×
 *   oversubscribed (where the old bound read 156.6 ms and would have failed);
 *   8.67× for a resolution doing its work twice, which this limit fails and the
 *   old 150 ms bound passed at 109.8 ms.
 * - RESOLVE_SUITE_BOUND_MS: a loose absolute backstop on the median, twice the
 *   target, for a regression that slows the baseline read as much as the
 *   resolution (a lost primary key, a bloated table). It sits 73 % above the
 *   slowest reading CI has produced.
 * - RESOLVE_TARGET_MS stays the story's number and is printed beside every
 *   reading; on its own it no longer fails the suite.
 */
export const RESOLVE_OVERHEAD_LIMIT = 6;
export const RESOLVE_SUITE_BOUND_MS = 2 * RESOLVE_TARGET_MS;
/** The resolution gate's measured passes: odd, so the median is one reading. */
export const RESOLVE_REPETITIONS = 7;

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

/** Readings from the warm-up pass and the measured passes, in pass order. */
export function readingsOf(warmUpMs: number, ms: readonly number[]): Readings {
  const ordered = [...ms].sort((a, b) => a - b);
  return {
    warmUpMs,
    ms,
    median: median(ordered),
    min: ordered[0] as number,
    max: ordered[ordered.length - 1] as number,
  };
}

/** The middle of `sorted` (ascending), the mean of the middle two when even. */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The fixed protocol: one discarded warm-up pass, then `repetitions` measured
 * passes. `setup(pass)` runs OUTSIDE the window (pass 0 is the warm-up);
 * `measured(pass, prepared)` is the only thing inside it; `verify` runs after
 * the window closes. Never adaptive: no retry, no extra pass.
 */
export async function measure<P, R>(
  setup: (pass: number) => Promise<P>,
  measured: (pass: number, prepared: P) => Promise<R>,
  verify: (pass: number, result: R, prepared: P) => Promise<void>,
  repetitions = REPETITIONS,
): Promise<Readings> {
  const all: number[] = [];
  for (let pass = 0; pass <= repetitions; pass += 1) {
    const prepared = await setup(pass);
    const opened = performance.now();
    const result = await measured(pass, prepared);
    const ms = performance.now() - opened;
    await verify(pass, result, prepared);
    all.push(ms);
  }
  const [warmUpMs, ...ms] = all as [number, ...number[]];
  return readingsOf(warmUpMs, ms);
}

/** A measured call and its same-run baseline, read pass by pass on one runner. */
export interface PairedReadings {
  readonly baseline: Readings;
  readonly measured: Readings;
  /** measured ÷ baseline, per measured pass, in pass order. */
  readonly ratios: readonly number[];
  readonly medianRatio: number;
}

/**
 * The paired protocol: `measure`'s fixed protocol, with a BASELINE call timed
 * in the same pass as the measured one, so both readings come from the same
 * runner in the same moment. The order alternates (baseline first on even
 * passes, measured first on odd ones) so drift inside a pass loads neither
 * side. Each pass's ratio is measured ÷ baseline; the warm-up's is discarded
 * with its readings. Never adaptive: no retry, no extra pass.
 */
export async function measurePaired<P, B, R>(
  setup: (pass: number) => Promise<P>,
  baseline: (pass: number, prepared: P) => Promise<B>,
  measured: (pass: number, prepared: P) => Promise<R>,
  verify: (pass: number, baselineResult: B, result: R, prepared: P) => Promise<void>,
  repetitions = REPETITIONS,
): Promise<PairedReadings> {
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const opened = performance.now();
    const result = await fn();
    return [result, performance.now() - opened];
  };
  const baselineMs: number[] = [];
  const measuredMs: number[] = [];
  for (let pass = 0; pass <= repetitions; pass += 1) {
    const prepared = await setup(pass);
    let b: [B, number];
    let r: [R, number];
    if (pass % 2 === 0) {
      b = await timed(() => baseline(pass, prepared));
      r = await timed(() => measured(pass, prepared));
    } else {
      r = await timed(() => measured(pass, prepared));
      b = await timed(() => baseline(pass, prepared));
    }
    await verify(pass, b[0], r[0], prepared);
    baselineMs.push(b[1]);
    measuredMs.push(r[1]);
  }
  const [baselineWarmUp, ...baselineRest] = baselineMs as [number, ...number[]];
  const [measuredWarmUp, ...measuredRest] = measuredMs as [number, ...number[]];
  const ratios = measuredRest.map((ms, i) => ms / (baselineRest[i] as number));
  return {
    baseline: readingsOf(baselineWarmUp, baselineRest),
    measured: readingsOf(measuredWarmUp, measuredRest),
    ratios,
    medianRatio: median([...ratios].sort((a, b) => a - b)),
  };
}

export function describeReadings(name: string, target: number, r: Readings): string {
  const f = (n: number) => n.toFixed(1);
  return (
    `${name}: median ${f(r.median)} ms (target ${String(target)} ms); ` +
    `readings ${r.ms.map(f).join(', ')} ms; min ${f(r.min)} max ${f(r.max)}; warm-up ${f(r.warmUpMs)} ms`
  );
}

export function describePaired(name: string, p: PairedReadings): string {
  const f = (n: number) => n.toFixed(2);
  return (
    `${describeReadings(name, RESOLVE_TARGET_MS, p.measured)}\n` +
    `${name} baseline (same-run ${String(MAP_PATHS)}-row read): median ${p.baseline.median.toFixed(1)} ms; ` +
    `readings ${p.baseline.ms.map((n) => n.toFixed(1)).join(', ')} ms; warm-up ${p.baseline.warmUpMs.toFixed(1)} ms\n` +
    `${name} over its baseline: median ${f(p.medianRatio)}× (limit ${String(RESOLVE_OVERHEAD_LIMIT)}×); ` +
    `ratios ${p.ratios.map(f).join(', ')}; absolute backstop ${String(RESOLVE_SUITE_BOUND_MS)} ms`
  );
}

/**
 * Why a paired resolution reading fails the gate, one entry per rule it
 * breaks; empty when it passes. The ratio rule is the gate; the absolute
 * backstop catches a regression that slows the baseline too.
 */
export function resolutionMisses(
  p: PairedReadings,
  limits: { readonly overhead: number; readonly boundMs: number } = {
    overhead: RESOLVE_OVERHEAD_LIMIT,
    boundMs: RESOLVE_SUITE_BOUND_MS,
  },
): string[] {
  const misses: string[] = [];
  if (p.medianRatio > limits.overhead) {
    misses.push(
      `median ${p.medianRatio.toFixed(2)}× its same-run baseline, over the ${String(limits.overhead)}× limit`,
    );
  }
  if (p.measured.median > limits.boundMs) {
    misses.push(
      `median ${p.measured.median.toFixed(1)} ms, over the ${String(limits.boundMs)} ms absolute backstop`,
    );
  }
  return misses;
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
