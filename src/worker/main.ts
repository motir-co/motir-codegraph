// `pnpm worker` / `pnpm start:worker`: the indexer worker, as codegraph_app.
// The one file that binds the real fetcher, pool and logger: everything it
// starts takes them as dependencies. Beside the loop it publishes the queue's
// metrics to stdout every METRICS_INTERVAL_MS. It exits non-zero only when it
// cannot start; SIGTERM or SIGINT stops claiming, lets the in-flight job end,
// stops the metrics publisher, closes the pool and exits 0.
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

import {
  readFetchSettings,
  readLayerSettings,
  readMaintenanceSettings,
  readMetricsSettings,
  readWorkerSettings,
  requireEnv,
  type FetchSettings,
} from '../config.js';
import { fetchTree, FetchRefusedError } from '../fetch/fetchTree.js';
import { createAppPool } from '../server/pool.js';
import { runWorkerLoop } from './loop.js';
import { startQueueMetricsPublisher } from './metrics.js';
import type { FetchOutcome, WorkerLogger } from './runJob.js';

/** One JSON object per line on stdout: level, time, message, then the fields. */
function jsonLine(level: string, fields: Record<string, unknown>, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields })}\n`,
  );
}

const log: WorkerLogger = {
  info: (fields, message) => {
    jsonLine('info', fields, message);
  },
  warn: (fields, message) => {
    jsonLine('warn', fields, message);
  },
  error: (fields, message) => {
    jsonLine('error', fields, message);
  },
};

/** The fetcher's one entry point, its refusal turned into the run path's outcome. */
async function toFetchOutcome(
  target: { readonly url: string; readonly dir: string },
  settings: FetchSettings,
): Promise<FetchOutcome> {
  try {
    return { ok: true, tree: await fetchTree(target, { settings }) };
  } catch (error) {
    if (error instanceof FetchRefusedError) {
      return { ok: false, reasonCode: error.reasonCode, message: error.message };
    }
    throw error;
  }
}

/** SCRATCH_DIR must be an existing directory this process can write. */
async function checkScratchDir(dir: string): Promise<void> {
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
    await access(dir, constants.W_OK);
  } catch {
    throw new Error(`SCRATCH_DIR (${dir}) must be an existing directory the worker can write.`);
  }
}

try {
  const appUrl = requireEnv('DATABASE_APP_URL');
  const settings = readWorkerSettings();
  const layerSettings = readLayerSettings();
  const fetchSettings = readFetchSettings();
  const maintenance = readMaintenanceSettings();
  const metricsSettings = readMetricsSettings();
  await checkScratchDir(settings.scratchDir);
  const pool = createAppPool(appUrl);
  const loop = runWorkerLoop({
    pool,
    settings,
    layerSettings,
    maintenance,
    fetch: (target) => toFetchOutcome(target, fetchSettings),
    log,
  });
  const metrics = startQueueMetricsPublisher(pool, metricsSettings, {
    write: (line) => process.stdout.write(line),
    log,
  });
  log.info({ pollMs: settings.pollMs }, 'worker started');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'stopping: no more claims, finishing the job in flight');
      loop
        .stop()
        .then(() => metrics.stop())
        .then(() => pool.end())
        .then(
          () => {
            log.info({}, 'worker stopped');
            process.exit(0);
          },
          (error: unknown) => {
            log.error({ error: String(error) }, 'shutdown failed');
            process.exit(1);
          },
        );
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
