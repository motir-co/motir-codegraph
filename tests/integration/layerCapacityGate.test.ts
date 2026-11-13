import { describe, expect, it } from 'vitest';

import {
  describePaired,
  measurePaired,
  readingsOf,
  RESOLVE_OVERHEAD_LIMIT,
  RESOLVE_SUITE_BOUND_MS,
  resolutionMisses,
  type PairedReadings,
} from './layerCapacity.fixture.js';

// The resolution gate's judgement (MOTIR-11228), without a database: the
// paired protocol's bookkeeping and the rules that fail the suite. The readings
// here are the shapes the gate exists to tell apart — a slow runner that slows
// both sides of the pair, and a resolution that really got slower.

function paired(baselineMs: number[], measuredMs: number[]): PairedReadings {
  const ratios = measuredMs.map((ms, i) => ms / (baselineMs[i] as number));
  const ordered = [...ratios].sort((a, b) => a - b);
  return {
    baseline: readingsOf(0, baselineMs),
    measured: readingsOf(0, measuredMs),
    ratios,
    medianRatio: ordered[Math.floor(ordered.length / 2)] as number,
  };
}

describe('readingsOf', () => {
  it('keeps the readings in pass order and takes the middle one of an odd count', () => {
    expect(readingsOf(9, [30, 10, 20])).toEqual({
      warmUpMs: 9,
      ms: [30, 10, 20],
      median: 20,
      min: 10,
      max: 30,
    });
  });

  it('takes the mean of the middle two of an even count', () => {
    expect(readingsOf(0, [40, 10, 30, 20]).median).toBe(25);
  });
});

describe('measurePaired', () => {
  it('times both calls every pass, alternates their order, and discards the warm-up', async () => {
    const order: string[] = [];
    const verified: number[] = [];
    let clock = 0;
    const realNow = performance.now.bind(performance);
    performance.now = () => clock;
    try {
      const p = await measurePaired(
        (pass) => Promise.resolve(pass),
        (pass) => {
          order.push(`b${String(pass)}`);
          clock += 10;
          return Promise.resolve('baseline');
        },
        (pass) => {
          order.push(`m${String(pass)}`);
          clock += pass === 0 ? 1_000 : 20 + pass;
          return Promise.resolve('measured');
        },
        (pass, b, r, prepared) => {
          expect([b, r, prepared]).toEqual(['baseline', 'measured', pass]);
          verified.push(pass);
          return Promise.resolve();
        },
        3,
      );
      expect(order).toEqual(['b0', 'm0', 'm1', 'b1', 'b2', 'm2', 'm3', 'b3']);
      expect(verified).toEqual([0, 1, 2, 3]);
      expect(p.measured.warmUpMs).toBe(1_000);
      expect(p.measured.ms).toEqual([21, 22, 23]);
      expect(p.baseline.ms).toEqual([10, 10, 10]);
      expect(p.ratios).toEqual([2.1, 2.2, 2.3]);
      expect(p.medianRatio).toBe(2.2);
    } finally {
      performance.now = realNow;
    }
  });
});

describe('resolutionMisses', () => {
  it('passes a slow runner that slows the baseline as much as the resolution', () => {
    // The old 150 ms bound failed this reading (MOTIR-11228's 172.8 ms run).
    const slow = paired([45, 48, 50, 44, 47, 46, 49], [170, 175, 172, 168, 173, 171, 176]);
    expect(slow.measured.median).toBeGreaterThan(150);
    expect(resolutionMisses(slow)).toEqual([]);
  });

  it('fails a resolution that got slower over the same baseline', () => {
    // A resolution doing its work twice: 10.27× locally, under the backstop.
    const regressed = paired([21, 22, 22, 20, 24, 22, 24], [210, 215, 212, 208, 220, 214, 230]);
    expect(regressed.measured.median).toBeLessThan(RESOLVE_SUITE_BOUND_MS);
    expect(resolutionMisses(regressed)).toEqual([
      `median 9.73× its same-run baseline, over the ${String(RESOLVE_OVERHEAD_LIMIT)}× limit`,
    ]);
  });

  it('fails on the absolute backstop when the baseline slowed as much as the resolution', () => {
    const both = paired([200, 210, 205], [600, 630, 615]);
    expect(both.medianRatio).toBeLessThanOrEqual(RESOLVE_OVERHEAD_LIMIT);
    expect(resolutionMisses(both)).toEqual([
      `median 615.0 ms, over the ${String(RESOLVE_SUITE_BOUND_MS)} ms absolute backstop`,
    ]);
  });

  it('names every rule a reading breaks, against the limits it is given', () => {
    const p = paired([10, 10, 10], [80, 80, 80]);
    expect(resolutionMisses(p, { overhead: 2, boundMs: 50 })).toEqual([
      'median 8.00× its same-run baseline, over the 2× limit',
      'median 80.0 ms, over the 50 ms absolute backstop',
    ]);
  });
});

describe('describePaired', () => {
  it('prints both readings, the ratios, the limit, the backstop and the story target', () => {
    const text = describePaired('resolution', paired([10, 20, 10], [40, 50, 30]));
    expect(text).toContain('resolution: median 40.0 ms (target 150 ms)');
    expect(text).toContain('resolution baseline (same-run 20000-row read): median 10.0 ms');
    expect(text).toContain(
      `median 3.00× (limit ${String(RESOLVE_OVERHEAD_LIMIT)}×); ratios 4.00, 2.50, 3.00; absolute backstop ${String(RESOLVE_SUITE_BOUND_MS)} ms`,
    );
  });
});
