import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireEnv } from '../../src/config.js';
import {
  describeReadings,
  measure,
  readingsOf,
  REPETITIONS,
  seconds,
} from '../../src/bench/indexing/measure.js';
import {
  armMet,
  FIRST_INDEX_TARGET_MS,
  PUSH_TARGET_MS,
  renderReport,
  runMet,
  type ArmResult,
  type BenchRun,
} from '../../src/bench/indexing/report.js';
import {
  MAX_INDEXING_TX_MS,
  oneLine,
  SAMPLE_INTERVAL_MS,
  startSampler,
} from '../../src/bench/indexing/sampler.js';
import { DEFAULT_WORKER_CONFIG } from '../../src/bench/indexing/stack.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';

// The indexing benchmark's protocol, verdicts and report, and its sampler
// against a real Postgres. The command itself (src/cli/indexing-bench.ts and
// the stack it starts) is run by `pnpm bench:indexing`.

describe('measure', () => {
  it('runs one discarded warm-up then REPETITIONS passes, in order, and reports their median', async () => {
    const calls: string[] = [];
    const windows = [999, 30, 10, 20];
    const readings = await measure(
      (pass) => {
        calls.push(`setup ${String(pass)}`);
        return Promise.resolve(pass);
      },
      (pass, prepared) => {
        calls.push(`measured ${String(pass)}`);
        return Promise.resolve({ ms: windows[prepared] as number, result: pass * 2 });
      },
      (pass, result) => {
        calls.push(`verify ${String(pass)} ${String(result)}`);
        return Promise.resolve();
      },
    );
    expect(REPETITIONS).toBe(3);
    expect(calls).toEqual([
      'setup 0',
      'measured 0',
      'verify 0 0',
      'setup 1',
      'measured 1',
      'verify 1 2',
      'setup 2',
      'measured 2',
      'verify 2 4',
      'setup 3',
      'measured 3',
      'verify 3 6',
    ]);
    expect(readings).toEqual({ warmUpMs: 999, ms: [30, 10, 20], median: 20, min: 10, max: 30 });
  });

  it('stops at the first pass that throws: no retry and no extra pass', async () => {
    let passes = 0;
    await expect(
      measure(
        () => Promise.resolve(null),
        (pass) => {
          passes += 1;
          return pass === 2
            ? Promise.reject(new Error('slow'))
            : Promise.resolve({ ms: 1, result: null });
        },
        () => Promise.resolve(),
      ),
    ).rejects.toThrow('slow');
    expect(passes).toBe(3);
  });

  it('refuses readings with no measured pass, and formats seconds', () => {
    expect(() => readingsOf(1, [])).toThrow(/no measured pass/);
    expect(seconds(12_345)).toBe('12.3 s');
    expect(describeReadings('push', 60_000, readingsOf(5_000, [12_000, 11_000, 13_000]))).toBe(
      'push: median 12.0 s (target 60.0 s); readings 12.0 s, 11.0 s, 13.0 s; min 11.0 s max 13.0 s; warm-up 5.0 s',
    );
  });
});

const sampler = {
  intervalMs: SAMPLE_INTERVAL_MS,
  boundMs: MAX_INDEXING_TX_MS,
  samples: 120,
  longestMs: 372,
  longestStatement: 'SELECT `x` FROM codegraph.blob',
  withinBound: true,
};

function arm(overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    arm: 'push',
    targetMs: PUSH_TARGET_MS,
    readings: readingsOf(15_000, [12_300, 12_500, 12_600]),
    error: null,
    trees: {
      base: {
        paths: 20_000,
        files: 20_000,
        textBytes: 588_890,
        largestFileBytes: 30,
        tarballBytes: 386_518,
      },
    },
    sampler,
    liveness: { resolutions: 965, failures: 0 },
    ...overrides,
  };
}

function run(arms: ArmResult[]): BenchRun {
  return {
    startedAt: '2026-11-13T16:34:52.979Z',
    seed: 'indexing-bench',
    config: { ...DEFAULT_WORKER_CONFIG, workers: 10 },
    perFileCapBytes: 1_048_576,
    arms,
  };
}

describe('verdicts', () => {
  it('meets an arm only with a median within target, every sample within the bound and no failed liveness read', () => {
    expect(armMet(arm())).toBe(true);
    expect(armMet(arm({ readings: readingsOf(1, [70_000, 61_000, 50_000]) }))).toBe(false);
    expect(armMet(arm({ sampler: { ...sampler, longestMs: 70_000, withinBound: false } }))).toBe(
      false,
    );
    expect(armMet(arm({ sampler: null }))).toBe(false);
    expect(armMet(arm({ liveness: { resolutions: 9, failures: 1 } }))).toBe(false);
    expect(armMet(arm({ readings: null, error: 'job failed' }))).toBe(false);
    expect(armMet(arm({ error: 'the sampler failed' }))).toBe(false);
    expect(runMet(run([arm(), arm({ arm: 'first-index', targetMs: FIRST_INDEX_TARGET_MS })]))).toBe(
      true,
    );
    expect(runMet(run([]))).toBe(false);
  });
});

describe('renderReport', () => {
  it('prints the configuration, every reading, the trees, the sampler and the liveness count', () => {
    const text = renderReport(run([arm()]));
    expect(text).toContain('Overall: **met**.');
    expect(text).toContain('Workers: 10; `BLOB_STORE_BATCH_SIZE` 500; `WORKER_POLL_MS` 100');
    expect(text).toContain('median **12.5 s** over 3 passes');
    expect(text).toContain('readings 12.3 s, 12.5 s, 12.6 s');
    expect(text).toContain('20000 paths, 20000 files, 588890 bytes of text');
    expect(text).toContain(
      '372 ms (bound `MAX_INDEXING_TX_MS` 60000 ms, within it), over 120 samples',
    );
    expect(text).toContain("`SELECT 'x' FROM codegraph.blob`");
    expect(text).toContain('965 resolutions');
    expect(text).not.toContain('Shape a fix');
    // One final newline, as the formatter leaves a committed report.
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
    expect(renderReport(run([])).endsWith('\n')).toBe(true);
  });

  it('reports a miss with the shape a fix would take, and an arm that stopped with its error', () => {
    const missed = renderReport(
      run([
        arm({ readings: readingsOf(1, [70_000, 71_000, 72_000]) }),
        arm({
          arm: 'first-index',
          targetMs: FIRST_INDEX_TARGET_MS,
          readings: null,
          error: 'did not resolve',
          sampler: null,
          trees: {
            large: {
              paths: 9_700,
              files: 9_700,
              textBytes: 217_100_000,
              largestFileBytes: 40_000,
              tarballBytes: 40_000_000,
            },
          },
        }),
        arm({ error: 'the sampler failed', sampler: { ...sampler, longestStatement: null } }),
      ]),
    );
    expect(missed).toContain('Overall: **missed**.');
    expect(missed).toContain('Verdict: **missed**.');
    expect(missed).toContain('Shape a fix would take: The window is the claim wait');
    expect(missed).toContain('Shape a fix would take: The window is one fetch and hash');
    expect(missed).toContain('Measured: no reading — did not resolve.');
    expect(missed).toContain('Longest indexing transaction: not sampled.');
    expect(missed).toContain('207.0 MiB (217100000 bytes)');
    expect(missed).toContain('- Error: the sampler failed');
    expect(missed).toContain('Statement: none open.');
  });
});

describe('the sampler', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('records the oldest open app-login transaction and the statement it ran', async () => {
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      const s = await startSampler({
        adminUrl: requireEnv('DATABASE_ADMIN_URL'),
        database: db.name,
        intervalMs: 20,
        boundMs: 150,
      });
      await app.query('BEGIN');
      await app.query('SELECT   1  AS held');
      await new Promise((resolve) => setTimeout(resolve, 400));
      await app.query('COMMIT');
      const reading = await s.stop();
      expect(reading.samples).toBeGreaterThan(5);
      expect(reading.intervalMs).toBe(20);
      expect(reading.longestMs).toBeGreaterThan(250);
      expect(reading.longestStatement).toBe('SELECT 1 AS held');
      expect(reading.withinBound).toBe(false);
    } finally {
      await app.end();
    }
  });

  it('reads nothing open on a quiet database, and surfaces a failed sample on stop', async () => {
    const quiet = await startSampler({
      adminUrl: requireEnv('DATABASE_ADMIN_URL'),
      database: db.name,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reading = await quiet.stop();
    expect(reading).toMatchObject({
      intervalMs: SAMPLE_INTERVAL_MS,
      boundMs: MAX_INDEXING_TX_MS,
      longestMs: 0,
      longestStatement: null,
      withinBound: true,
    });

    const broken = await startSampler({
      adminUrl: requireEnv('DATABASE_ADMIN_URL'),
      database: db.name,
      intervalMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Ending the sampler's own session between two reads fails the reading at stop.
    const admin = new pg.Client({ connectionString: requireEnv('DATABASE_ADMIN_URL') });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend($1)', [broken.backendPid]);
    await admin.end();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(broken.stop()).rejects.toThrow();
  });

  it('collapses a statement to one line of at most 200 characters', () => {
    expect(oneLine('SELECT\n  a,\n\tb')).toBe('SELECT a, b');
    const long = oneLine(`SELECT ${'x'.repeat(300)}`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
