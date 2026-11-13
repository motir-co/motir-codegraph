/**
 * The measurement protocol the commit-layer capacity gate uses
 * (tests/integration/layerCapacity.fixture.ts `measure`): one discarded
 * warm-up pass, then REPETITIONS measured passes, reported as the median with
 * min, max and every reading. A copy rather than an import, because the build
 * compiles only `src/**`, so a `src/` module cannot reach a `tests/` file.
 *
 * Never adaptive: no retry, no extra pass, no pass dropped. `setup` runs
 * outside the window, `measured` is the window and answers the window's own
 * length (so a window may open on an event inside the call, such as a 202),
 * and `verify` runs after it closes.
 */

/** Measured passes after the one discarded warm-up. */
export const REPETITIONS = 3;

export interface Readings {
  readonly warmUpMs: number;
  readonly ms: readonly number[];
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/** Median, min and max of the measured passes; the warm-up is reported, never counted. */
export function readingsOf(warmUpMs: number, ms: readonly number[]): Readings {
  if (ms.length === 0) throw new Error('no measured pass');
  const ordered = [...ms].sort((a, b) => a - b);
  return {
    warmUpMs,
    ms: [...ms],
    median: ordered[Math.floor(ordered.length / 2)] as number,
    min: ordered[0] as number,
    max: ordered[ordered.length - 1] as number,
  };
}

export async function measure<P, R>(
  setup: (pass: number) => Promise<P>,
  measured: (pass: number, prepared: P) => Promise<{ ms: number; result: R }>,
  verify: (pass: number, result: R, prepared: P) => Promise<void>,
  repetitions: number = REPETITIONS,
): Promise<Readings> {
  const all: number[] = [];
  for (let pass = 0; pass <= repetitions; pass += 1) {
    const prepared = await setup(pass);
    const { ms, result } = await measured(pass, prepared);
    await verify(pass, result, prepared);
    all.push(ms);
  }
  const [warmUpMs, ...ms] = all as [number, ...number[]];
  return readingsOf(warmUpMs, ms);
}

/** Seconds with one decimal, for the report. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function describeReadings(name: string, targetMs: number, r: Readings): string {
  return (
    `${name}: median ${seconds(r.median)} (target ${seconds(targetMs)}); ` +
    `readings ${r.ms.map(seconds).join(', ')}; min ${seconds(r.min)} max ${seconds(r.max)}; ` +
    `warm-up ${seconds(r.warmUpMs)}`
  );
}
