/**
 * The indexing queue's four numbers, across every tenant, through the one
 * aggregate read that may cross tenants: the owner-defined function
 * `codegraph.codegraph_index_queue_metrics`
 * (db/migrations/0011_index_queue_metrics.sql). This is the only module in
 * `src/` that names it.
 *
 * It opens no transaction and binds no tenant: the function answers the same
 * counts whatever the session is bound to, and it answers counts only.
 */
import type pg from 'pg';

/** One sample of the queue. Every value is a whole number of 0 or more. */
export interface QueueMetrics {
  /** Jobs waiting to be claimed. */
  readonly queuedJobs: number;
  /** Batches still owed: queued or running, never a terminal one. */
  readonly queuedBatches: number;
  /** Whole seconds since the oldest waiting job was enqueued; 0 when none waits. */
  readonly oldestQueuedJobAgeSeconds: number;
  /** Jobs that ended failed inside the trailing window. */
  readonly failedJobsRecent: number;
}

export const QUEUE_METRICS_SQL = `SELECT queued_jobs AS "queuedJobs",
    queued_batches AS "queuedBatches",
    oldest_queued_job_age_seconds AS "oldestQueuedJobAgeSeconds",
    failed_jobs_recent AS "failedJobsRecent"
  FROM codegraph.codegraph_index_queue_metrics($1)`;

/**
 * Reads the queue's four numbers in one statement, counting failures that
 * ended within the last `failedWindowMs` milliseconds. A window that is not a
 * positive whole number is refused (RangeError) before any statement.
 */
export async function readQueueMetrics(
  db: pg.ClientBase,
  failedWindowMs: number,
): Promise<QueueMetrics> {
  if (!Number.isSafeInteger(failedWindowMs) || failedWindowMs < 1) {
    throw new RangeError(
      `failedWindowMs must be a positive whole number of milliseconds, not ${String(failedWindowMs)}.`,
    );
  }
  const { rows } = await db.query<QueueMetrics>(QUEUE_METRICS_SQL, [failedWindowMs]);
  const row = rows[0];
  /* v8 ignore next 3 -- the function returns exactly one row */
  if (row === undefined) {
    throw new Error('The queue metrics function answered no row.');
  }
  return row;
}
