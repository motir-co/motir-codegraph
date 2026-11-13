import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueMetrics } from '../../src/db/queueMetrics.js';
import {
  METRICS_NAMESPACE,
  publishQueueMetrics,
  renderQueueMetricsEmf,
  startQueueMetricsPublisher,
  type MetricsOutput,
} from '../../src/worker/metrics.js';

// The publisher against a stub database and a captured stdout: the document's
// shape, the failed read, the interval and its stop. The function itself is
// tested against the real database in tests/db/queueMetrics.test.ts.

const SAMPLE: QueueMetrics = {
  queuedJobs: 4,
  queuedBatches: 6,
  oldestQueuedJobAgeSeconds: 93,
  failedJobsRecent: 2,
};

const ROW = {
  queuedJobs: SAMPLE.queuedJobs,
  queuedBatches: SAMPLE.queuedBatches,
  oldestQueuedJobAgeSeconds: SAMPLE.oldestQueuedJobAgeSeconds,
  failedJobsRecent: SAMPLE.failedJobsRecent,
};

/** A client stub answering each query from `answers` in turn (an Error throws). */
function stubDb(...answers: (QueueMetrics | Error)[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  let i = 0;
  const db = {
    query: (text: string, values: unknown[]) => {
      calls.push({ text, values });
      const answer = answers[Math.min(i, answers.length - 1)] as QueueMetrics | Error;
      i += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ rows: [answer] });
    },
  };
  return { db: db as unknown as pg.ClientBase, calls };
}

function capture() {
  const written: string[] = [];
  const warnings: { fields: Record<string, unknown>; message: string }[] = [];
  const output: MetricsOutput = {
    write: (line) => written.push(line),
    log: { warn: (fields, message) => warnings.push({ fields, message }) },
    now: () => 1_700_000_000_000,
  };
  return { written, warnings, output };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('renderQueueMetricsEmf', () => {
  it('renders one newline-terminated document: the namespace, no dimension, four definitions', () => {
    const line = renderQueueMetricsEmf(SAMPLE, 1_700_000_000_000);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    const doc = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(
      [
        'FailedJobsRecent',
        'OldestQueuedJobAgeSeconds',
        'QueuedBatches',
        'QueuedJobs',
        '_aws',
      ].sort(),
    );
    expect(doc._aws).toEqual({
      Timestamp: 1_700_000_000_000,
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [[]],
          Metrics: [
            { Name: 'QueuedJobs', Unit: 'Count' },
            { Name: 'QueuedBatches', Unit: 'Count' },
            { Name: 'OldestQueuedJobAgeSeconds', Unit: 'Seconds' },
            { Name: 'FailedJobsRecent', Unit: 'Count' },
          ],
        },
      ],
    });
    expect(METRICS_NAMESPACE).toBe('Codegraph/IndexQueue');
    expect(doc).toMatchObject({
      QueuedJobs: 4,
      QueuedBatches: 6,
      OldestQueuedJobAgeSeconds: 93,
      FailedJobsRecent: 2,
    });
  });

  it('carries nothing but the four numbers, whatever else the input object holds', () => {
    const leaky = { ...SAMPLE, fetchUrl: 'https://x.example/?sig=1', tenantId: 't' };
    const line = renderQueueMetricsEmf(leaky, 0);
    expect(line).not.toContain('x.example');
    expect(line).not.toContain('tenantId');
  });
});

describe('publishQueueMetrics', () => {
  it('reads once with the window and writes exactly one line equal to the row', async () => {
    const { db, calls } = stubDb(ROW);
    const { written, warnings, output } = capture();
    expect(await publishQueueMetrics(db, { failedJobsWindow: 300_000 }, output)).toEqual(SAMPLE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('codegraph.codegraph_index_queue_metrics($1)');
    expect(calls[0]?.values).toEqual([300_000]);
    expect(written).toEqual([renderQueueMetricsEmf(SAMPLE, 1_700_000_000_000)]);
    expect(warnings).toEqual([]);
  });

  it('writes nothing and logs one warning naming the failure when the read throws', async () => {
    const { db } = stubDb(new Error('connection refused'));
    const { written, warnings, output } = capture();
    expect(await publishQueueMetrics(db, { failedJobsWindow: 1 }, output)).toBeNull();
    expect(written).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields.error).toBe('connection refused');
  });

  it('logs a non-Error rejection as its text', async () => {
    const db = { query: () => Promise.reject(new Error('boom')) } as unknown as pg.ClientBase;
    const nonError = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
      query: () => Promise.reject('plain'),
    } as unknown as pg.ClientBase;
    const { warnings, output } = capture();
    await publishQueueMetrics(db, { failedJobsWindow: 1 }, output);
    await publishQueueMetrics(nonError, { failedJobsWindow: 1 }, output);
    expect(warnings.map((w) => w.fields.error)).toEqual(['boom', 'plain']);
  });

  it('accumulates nothing: two samples of an unchanged queue answer the same numbers', async () => {
    const { db } = stubDb(ROW, ROW);
    const { written, output } = capture();
    await publishQueueMetrics(db, { failedJobsWindow: 1 }, output);
    await publishQueueMetrics(db, { failedJobsWindow: 1 }, output);
    expect(written[0]).toBe(written[1]);
  });

  it('takes a connection from a pool and returns it', async () => {
    const { db: client } = stubDb(ROW);
    const release = vi.fn();
    const pool = {
      totalCount: 0,
      connect: () => Promise.resolve(Object.assign(client, { release })),
    } as unknown as pg.Pool;
    const { written, output } = capture();
    await publishQueueMetrics(pool, { failedJobsWindow: 1 }, output);
    expect(written).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('startQueueMetricsPublisher', () => {
  it('publishes now and every interval, survives a failed tick, and writes nothing after stop', async () => {
    vi.useFakeTimers();
    const { db, calls } = stubDb(ROW, new Error('down'), ROW);
    const { written, warnings, output } = capture();
    const publisher = startQueueMetricsPublisher(
      db,
      { metricsInterval: 1_000, failedJobsWindow: 1 },
      output,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(written).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(written).toHaveLength(2);

    await publisher.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(written).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it('skips a tick while the previous read is in flight, and writes nothing a read finishes after stop', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { rows: QueueMetrics[] }) => void;
    let reads = 0;
    const db = {
      query: () => {
        reads += 1;
        return new Promise((r) => (resolve = r));
      },
    } as unknown as pg.ClientBase;
    const { written, output } = capture();
    const publisher = startQueueMetricsPublisher(
      db,
      { metricsInterval: 100, failedJobsWindow: 1 },
      output,
    );
    await vi.advanceTimersByTimeAsync(350);
    expect(reads).toBe(1);
    const stopping = publisher.stop();
    resolve({ rows: [SAMPLE] });
    await stopping;
    expect(written).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
