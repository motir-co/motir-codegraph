/**
 * The worker's poll: claim one job, run it, and when there was nothing to run
 * wait `WORKER_POLL_MS` before claiming again. The claim is its only statement
 * outside a tenant-bound transaction; it holds no cross-tenant read of its own.
 *
 * After each run the loop gives the run's repository a maintenance tick, at
 * most once per `MAINTENANCE_INTERVAL_MS` per repository and never before a
 * first claim: the tick enqueues the discard and release jobs that repository
 * is due, bound as the client of the job just run.
 */
import type pg from 'pg';

import type { MaintenanceSettings, WorkerSettings } from '../config.js';
import { claimNext, type Claim } from '../db/workerJobs.js';
import { runBatch } from './fanOut.js';
import { runMaintenanceTick } from './maintenance.js';
import { runJob, type RunJobDeps, type RunResult, type WorkerLogger } from './runJob.js';

/** What the tick hook is handed, once per iteration whether or not a job ran. */
export interface TickContext {
  readonly pool: pg.Pool;
  readonly settings: WorkerSettings;
  readonly log: WorkerLogger;
  /** The iteration's run, or null when it claimed nothing it could run. */
  readonly ran: RunResult | null;
}

export interface WorkerLoopDeps extends RunJobDeps {
  /** Called once per iteration; a throw is logged and never ends the loop. */
  readonly onTick?: (context: TickContext) => void | Promise<void>;
  /** The maintenance tick's interval and per-tick cap. */
  readonly maintenance: MaintenanceSettings;
  /** Runs a claimed batch; `runBatch` from `./fanOut.js` when omitted. */
  readonly runBatch?: (deps: RunJobDeps, claim: Claim) => Promise<RunResult>;
}

export interface WorkerLoop {
  /** Stops claiming; resolves once the in-flight job, if any, has ended. */
  stop(): Promise<void>;
  /** Resolves when the loop has stopped. */
  readonly done: Promise<void>;
}

/**
 * Starts the loop. A throw in any one iteration (a claim that failed, a run
 * that raised past its own handling) is logged and the loop carries on: a
 * worker that dies of one bad job is a queue that stops draining.
 */
export function runWorkerLoop(deps: WorkerLoopDeps): WorkerLoop {
  const state = { stopping: false };
  // Read through a call: `stop()` flips it while an iteration is awaited.
  const stopping = () => state.stopping;
  let wake: (() => void) | null = null;

  const idle = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, deps.settings.pollMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  // When each repository was last ticked; entries older than the interval are dropped.
  const lastTick = new Map<string, number>();

  const tick = async (claim: Claim): Promise<void> => {
    const now = Date.now();
    for (const [key, at] of lastTick) {
      if (now - at >= deps.maintenance.intervalMs) lastTick.delete(key);
    }
    const key = `${claim.tenantId}:${claim.repositoryId}`;
    if (lastTick.has(key)) return;
    lastTick.set(key, now);
    try {
      await runMaintenanceTick(deps, claim);
    } catch (error) {
      deps.log.error(
        {
          tenantId: claim.tenantId,
          repositoryId: claim.repositoryId,
          error: error instanceof Error ? error.message : String(error),
        },
        'maintenance tick failed',
      );
    }
  };

  const iterate = async (): Promise<RunResult | null> => {
    const claim = await claimNext(deps.pool, deps.settings);
    if (claim === null) return null;
    const ran =
      claim.kind === 'batch'
        ? await (deps.runBatch ?? runBatch)(deps, claim)
        : await runJob(deps, claim);
    if (ran.outcome !== 'grant_lost') await tick(claim);
    return ran;
  };

  const done = (async () => {
    while (!stopping()) {
      let ran: RunResult | null = null;
      try {
        ran = await iterate();
      } catch (error) {
        deps.log.error(
          { error: error instanceof Error ? error.message : String(error) },
          'worker iteration failed',
        );
      }
      try {
        await deps.onTick?.({ pool: deps.pool, settings: deps.settings, log: deps.log, ran });
      } catch (error) {
        deps.log.error(
          { error: error instanceof Error ? error.message : String(error) },
          'worker tick failed',
        );
      }
      if (ran === null && !stopping()) await idle();
    }
  })();

  return {
    done,
    stop() {
      state.stopping = true;
      wake?.();
      return done;
    },
  };
}
