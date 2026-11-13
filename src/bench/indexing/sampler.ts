/**
 * The bounded-transaction evidence: every SAMPLE_INTERVAL_MS, one read of the
 * Postgres activity view for the benchmark's database, keeping the oldest
 * open transaction of the service's login (codegraph_app — every indexing
 * write runs as it), its age, and the statement that connection was running.
 *
 * It reads on the cluster's admin connection (DATABASE_ADMIN_URL): the
 * activity view hides another role's transaction start and statement from
 * every login without pg_read_all_stats, the owner included, so on the owner
 * login the sampler would see nothing and report a clean bound it never
 * observed.
 *
 * A sample is evidence that a long transaction WAS present at that instant;
 * a run of samples is never proof that none occurred between two of them.
 */
import pg from 'pg';

import { APP_LOGIN } from '../../db/connection.js';

export const SAMPLE_INTERVAL_MS = 100;

/** The longest an indexing transaction may be open: longer than a whole push's budget. */
export const MAX_INDEXING_TX_MS = 60_000;

export interface SamplerReading {
  readonly intervalMs: number;
  readonly boundMs: number;
  readonly samples: number;
  /** The oldest open app-login transaction any sample saw, in ms; 0 when none was open. */
  readonly longestMs: number;
  /** The statement that connection was running then, whitespace collapsed; null when none. */
  readonly longestStatement: string | null;
  readonly withinBound: boolean;
}

export const OLDEST_TRANSACTION_SQL = `SELECT (extract(epoch FROM now() - xact_start) * 1000)::float8 AS age_ms,
       query
  FROM pg_stat_activity
 WHERE datname = $1 AND usename = $2 AND xact_start IS NOT NULL
 ORDER BY xact_start
 LIMIT 1`;

export interface Sampler {
  /** The sampler's own server process, so it can be told apart from the sessions it reads. */
  readonly backendPid: number;
  stop(): Promise<SamplerReading>;
}

/** Collapses a statement to one line of at most 200 characters. */
export function oneLine(statement: string): string {
  const line = statement.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export async function startSampler(options: {
  adminUrl: string;
  database: string;
  intervalMs?: number;
  boundMs?: number;
}): Promise<Sampler> {
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const boundMs = options.boundMs ?? MAX_INDEXING_TX_MS;
  const client = new pg.Client({ connectionString: options.adminUrl });
  let failure: Error | null = null;
  // A connection lost between two samples fails the reading at stop, never the process.
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  };
  client.on('error', fail);
  await client.connect();
  const backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
    ?.pid as number;
  let samples = 0;
  let longestMs = 0;
  let longestStatement: string | null = null;
  const state = { stopped: false };

  const sample = async () => {
    const { rows } = await client.query<{ age_ms: number; query: string }>(OLDEST_TRANSACTION_SQL, [
      options.database,
      APP_LOGIN,
    ]);
    samples += 1;
    const [oldest] = rows;
    if (oldest !== undefined && oldest.age_ms > longestMs) {
      longestMs = oldest.age_ms;
      longestStatement = oneLine(oldest.query);
    }
  };

  const loop = (async () => {
    while (!state.stopped) {
      const started = Date.now();
      try {
        await sample();
      } catch (error) {
        fail(error);
        return;
      }
      const wait = Math.max(0, intervalMs - (Date.now() - started));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  })();

  return {
    backendPid,
    async stop() {
      state.stopped = true;
      await loop;
      await client.end().catch(() => undefined);
      if (failure !== null) throw failure;
      return {
        intervalMs,
        boundMs,
        samples,
        longestMs,
        longestStatement,
        withinBound: longestMs <= boundMs,
      };
    },
  };
}
