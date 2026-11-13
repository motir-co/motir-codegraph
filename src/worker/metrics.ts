/**
 * The worker's queue metrics: every `METRICS_INTERVAL_MS`, one read of the
 * queue's four numbers (`readQueueMetrics`), rendered as ONE CloudWatch
 * embedded-metric-format line and written to stdout, where the log
 * destination extracts it. No AWS SDK and no PutMetricData: the task role
 * stays empty.
 *
 * Each sample is a gauge of the queue's current state and the publisher keeps
 * nothing between ticks, so a missed tick is a gap in resolution rather than a
 * wrong figure, and two tasks publishing in the same minute agree. The four
 * metrics carry no dimension, because every task publishes the same gauge: a
 * consumer reading Average gets the value, not one series per task.
 */
import type pg from 'pg';

import type { MetricsSettings } from '../config.js';
import { readQueueMetrics, type QueueMetrics } from '../db/queueMetrics.js';
import type { WorkerLogger } from './runJob.js';

export const METRICS_NAMESPACE = 'Codegraph/IndexQueue';

/** The four metrics, in document order, with their CloudWatch units. */
export const QUEUE_METRIC_DEFINITIONS = [
  { Name: 'QueuedJobs', Unit: 'Count', key: 'queuedJobs' },
  { Name: 'QueuedBatches', Unit: 'Count', key: 'queuedBatches' },
  { Name: 'OldestQueuedJobAgeSeconds', Unit: 'Seconds', key: 'oldestQueuedJobAgeSeconds' },
  { Name: 'FailedJobsRecent', Unit: 'Count', key: 'failedJobsRecent' },
] as const satisfies readonly { Name: string; Unit: string; key: keyof QueueMetrics }[];

/** Where a published document goes, and the warning a failed tick logs. Stdout in production. */
export interface MetricsOutput {
  readonly write: (line: string) => void;
  readonly log: Pick<WorkerLogger, 'warn'>;
  /** The sample's timestamp, in epoch milliseconds. */
  readonly now?: () => number;
}

/** A database handle the read can run on: the worker's pool, or one client. */
export type MetricsDb = pg.Pool | pg.ClientBase;

/**
 * The one-line embedded-metric-format document for one sample, newline
 * terminated. Its keys are `_aws` and the four metric names, and every value
 * comes from `metrics`; `_aws.CloudWatchMetrics[0].Dimensions` is one EMPTY
 * dimension set, which CloudWatch reads as "publish with no dimension". Pure.
 */
export function renderQueueMetricsEmf(metrics: QueueMetrics, timestampMs: number): string {
  const document: Record<string, unknown> = {
    _aws: {
      Timestamp: timestampMs,
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [[]],
          Metrics: QUEUE_METRIC_DEFINITIONS.map(({ Name, Unit }) => ({ Name, Unit })),
        },
      ],
    },
  };
  for (const { Name, key } of QUEUE_METRIC_DEFINITIONS) document[Name] = metrics[key];
  return `${JSON.stringify(document)}\n`;
}

async function readOn(db: MetricsDb, failedWindowMs: number): Promise<QueueMetrics> {
  if ('totalCount' in db) {
    const client = await db.connect();
    try {
      return await readQueueMetrics(client, failedWindowMs);
    } finally {
      client.release();
    }
  }
  return await readQueueMetrics(db, failedWindowMs);
}

/**
 * One sample: read, render, write one line. A read that throws writes no
 * document and logs one warning naming the failure; it never throws. Answers
 * the numbers it published, or null when it published none.
 */
export async function publishQueueMetrics(
  db: MetricsDb,
  settings: Pick<MetricsSettings, 'failedJobsWindow'>,
  output: MetricsOutput,
): Promise<QueueMetrics | null> {
  let metrics: QueueMetrics;
  try {
    metrics = await readOn(db, settings.failedJobsWindow);
  } catch (error) {
    output.log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'queue metrics not published: the read failed',
    );
    return null;
  }
  output.write(renderQueueMetricsEmf(metrics, (output.now ?? Date.now)()));
  return metrics;
}

export interface QueueMetricsPublisher {
  /** Clears the timer and waits for a tick in flight; nothing is written after. */
  stop(): Promise<void>;
}

/**
 * Publishes one sample now and one every `METRICS_INTERVAL_MS` after. A tick
 * that comes while the previous one is still reading is skipped rather than
 * stacked. The answer's `stop()` leaves no timer active and no document
 * written after it resolves.
 */
export function startQueueMetricsPublisher(
  db: MetricsDb,
  settings: MetricsSettings,
  output: MetricsOutput,
): QueueMetricsPublisher {
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  const guarded: MetricsOutput = {
    ...output,
    write: (line) => {
      if (!stopped) output.write(line);
    },
  };
  const tick = () => {
    if (stopped || inFlight !== null) return;
    inFlight = publishQueueMetrics(db, settings, guarded).finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(tick, settings.metricsInterval);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
