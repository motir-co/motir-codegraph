// `pnpm bench:indexing`: the write path's capacity, measured above the
// commit-layer library. Two arms, each timed from the call's 202 answer to the
// first tenant-bound `resolveCommit` that answers the arm's full expected map:
//
//   push         a 20,000-path base is published first; then one push of
//                exactly 50 changed paths over it is timed. Target 60 s.
//   first-index  a motir-core-sized tree (at least 207 MB of text) is first
//                indexed at the worker count given. Target 10 minutes.
//
// Each arm runs the capacity gate's protocol — one discarded warm-up, three
// measured passes, the median reported with every reading — while a sampler
// reads the activity view every 100 ms for the longest open indexing
// transaction, and a liveness loop resolves another repository's published
// commit. Nothing retries a slow pass or drops one, and no target moves.
//
// It needs DATABASE_URL, DATABASE_APP_URL and DATABASE_ADMIN_URL, as the CI
// test lane sets them, against a bootstrapped database. Every tenant, worker
// and scratch directory it starts is gone when it returns, on success, on a
// miss, on an error and on SIGINT or SIGTERM. Exit 0 when every target is met,
// 1 on a miss, 2 on a usage error.

import { randomBytes, createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { perFileCapBytes } from '../config.js';
import { measure, describeReadings, type Readings } from '../bench/indexing/measure.js';
import {
  FIRST_INDEX_TARGET_MS,
  PUSH_TARGET_MS,
  renderReport,
  runMet,
  type ArmResult,
  type BenchRun,
  type Liveness,
} from '../bench/indexing/report.js';
import { startSampler, type SamplerReading } from '../bench/indexing/sampler.js';
import {
  DEFAULT_WORKER_CONFIG,
  readBenchUrls,
  startStack,
  type Stack,
  type WorkerConfig,
} from '../bench/indexing/stack.js';
import {
  largeTree,
  materialise,
  MOTIR_CORE_TEXT_BYTES,
  pushBase,
  pushChangedPaths,
  pushSuccessor,
  type TreeFile,
  type TreeTotals,
} from '../bench/indexing/tree.js';

const USAGE = `Usage: pnpm bench:indexing [--arm push|first-index|all] [--workers N] [--seed LABEL] [--report PATH]

  --arm      which arm to run (default all)
  --workers  worker processes to start (default 10, production's worker ceiling)
  --seed     the label the generated trees derive from (default indexing-bench)
  --report   write the markdown report here; only with --arm all, so a
             single-arm run cannot overwrite the two-arm baseline
  --help     print this and exit

Needs DATABASE_URL, DATABASE_APP_URL and DATABASE_ADMIN_URL.`;

/** production's services.codegraphV2.ceiling (motir-infra), the worker service's maximum task count. */
export const DEFAULT_WORKERS = 10;
const REF = 'refs/heads/main';
/** A window still open at this multiple of its target is abandoned as a miss. */
const GIVE_UP_FACTOR = 2;
const POLL_MS = 100;

type Arm = 'push' | 'first-index';

interface Options {
  arms: Arm[];
  workers: number;
  seed: string;
  report: string | undefined;
}

class UsageError extends Error {}

function parseOptions(argv: string[]): Options | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      arm: { type: 'string', default: 'all' },
      workers: { type: 'string', default: String(DEFAULT_WORKERS) },
      seed: { type: 'string', default: 'indexing-bench' },
      report: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const arm = values.arm;
  if (arm !== 'push' && arm !== 'first-index' && arm !== 'all') {
    throw new UsageError(`--arm must be push, first-index or all, not ${arm}.`);
  }
  if (values.report !== undefined && arm !== 'all') {
    throw new UsageError(
      '--report is written only by --arm all: a single-arm run cannot overwrite the two-arm baseline.',
    );
  }
  const workers = Number(values.workers);
  if (!/^\d+$/.test(values.workers) || !Number.isSafeInteger(workers) || workers < 1) {
    throw new UsageError(`--workers must be a whole number of 1 or more, not ${values.workers}.`);
  }
  if (values.seed.trim() === '') throw new UsageError('--seed may not be blank.');
  return {
    arms: arm === 'all' ? ['push', 'first-index'] : [arm],
    workers,
    seed: values.seed,
    report: values.report,
  };
}

const commitOf = (seed: string, label: string) =>
  createHash('sha1').update(`indexing bench ${seed} ${label}`).digest('hex');

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function* take(files: Iterable<TreeFile>, n: number): Generator<TreeFile> {
  let i = 0;
  for (const file of files) {
    if (i >= n) return;
    yield file;
    i += 1;
  }
}

interface Scope {
  tenantId: string;
  repositoryId: string;
}

/**
 * Calls `route`, then polls `resolveCommit` until it answers `expected`
 * exactly. Answers the window from the 202 to that answer. A failed job, a
 * map that differs, or a window past GIVE_UP_FACTOR × the target ends it.
 */
async function timedToResolved(
  stack: Stack,
  scope: Scope,
  route: 'first-index' | 'push',
  body: Record<string, unknown>,
  commit: string,
  expected: ReadonlyMap<string, string>,
  targetMs: number,
): Promise<{ ms: number; result: null }> {
  const answer = await stack.call(
    `/v1/tenants/${scope.tenantId}/repositories/${scope.repositoryId}/${route}`,
    { commit, ref: REF, isDefaultBranch: true, ...body },
  );
  const opened = performance.now();
  if (answer.status !== 202) {
    throw new Error(`${route} answered ${String(answer.status)}: ${JSON.stringify(answer.body)}`);
  }
  const { jobId } = answer.body as { jobId: string };
  for (;;) {
    const resolution = await stack.resolve(scope, commit);
    if (resolution.state === 'indexed') {
      const ms = performance.now() - opened;
      if (!sameMap(resolution.paths, expected)) {
        throw new Error(
          `${commit} resolved to ${String(resolution.paths.size)} paths that are not the ${String(expected.size)} it pushed`,
        );
      }
      return { ms, result: null };
    }
    const job = await stack.job(jobId);
    if (job.state === 'failed' || job.state === 'superseded') {
      throw new Error(
        `the ${route} job ended ${job.state} (${job.reason ?? 'no reason'}: ${job.message ?? ''})\n${stack.workerTail()}`,
      );
    }
    if (performance.now() - opened > GIVE_UP_FACTOR * targetMs) {
      throw new Error(
        `${commit} did not resolve within ${String(GIVE_UP_FACTOR)}× the ${String(targetMs / 1000)} s target (job ${job.state})\n${stack.workerTail()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Resolves the liveness commit until stopped, counting answers and failures. */
function startLiveness(
  stack: Stack,
  scope: Scope,
  commit: string,
  expected: ReadonlyMap<string, string>,
): { stop(): Promise<Liveness> } {
  const state = { stopped: false };
  let resolutions = 0;
  let failures = 0;
  const loop = (async () => {
    while (!state.stopped) {
      try {
        const r = await stack.resolve(scope, commit);
        resolutions += 1;
        if (r.state !== 'indexed' || !sameMap(r.paths, expected)) failures += 1;
      } catch {
        resolutions += 1;
        failures += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return {
    async stop() {
      state.stopped = true;
      await loop;
      return { resolutions, failures };
    },
  };
}

interface Shared {
  push: Scope;
  liveness: Scope & { commit: string; map: Map<string, string> };
}

/** The push tenant with its two repositories; the second's commit is the liveness target. */
async function prepareShared(stack: Stack, seed: string, run: string): Promise<Shared> {
  const seeded = await stack.seedTenant(`indexing bench ${run}`, 2);
  const push = { tenantId: seeded.tenantId, repositoryId: seeded.repositoryIds[0] as string };
  const liveScope = { tenantId: seeded.tenantId, repositoryId: seeded.repositoryIds[1] as string };
  const dir = join(stack.scratchRoot, 'liveness');
  const tarball = join(stack.scratchRoot, 'liveness.tar.gz');
  const commit = commitOf(seed, 'liveness');
  const tree = await materialise(take(pushBase(`${seed} liveness`), 200), {
    dir,
    tarball,
    prefix: `liveness-${commit}`,
  });
  await timedToResolved(
    stack,
    liveScope,
    'first-index',
    { fetchUrl: stack.serve('liveness.tar.gz', tarball) },
    commit,
    tree.map,
    PUSH_TARGET_MS,
  );
  await rm(dir, { recursive: true, force: true });
  return { push, liveness: { ...liveScope, commit, map: tree.map } };
}

type TreeRecord = TreeTotals & { tarballBytes: number };

async function runArm(
  arm: Arm,
  body: (trees: Record<string, TreeRecord>) => Promise<Readings>,
  stack: Stack,
  shared: Shared,
): Promise<ArmResult> {
  const trees: Record<string, TreeRecord> = {};
  const sampler = await startSampler({
    adminUrl: stack.urls.adminUrl,
    database: stack.urls.database,
  });
  const liveness = startLiveness(
    stack,
    shared.liveness,
    shared.liveness.commit,
    shared.liveness.map,
  );
  let readings: Readings | null = null;
  let error: string | null = null;
  try {
    readings = await body(trees);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const live = await liveness.stop();
  let sampled: SamplerReading | null = null;
  try {
    sampled = await sampler.stop();
  } catch (caught) {
    error ??= `the sampler failed: ${String(caught)}`;
  }
  return {
    arm,
    targetMs: arm === 'push' ? PUSH_TARGET_MS : FIRST_INDEX_TARGET_MS,
    readings,
    error,
    trees,
    sampler: sampled,
    liveness: live,
  };
}

async function pushArm(stack: Stack, shared: Shared, seed: string): Promise<ArmResult> {
  return runArm(
    'push',
    async (trees) => {
      const baseCommit = commitOf(seed, 'push base');
      const baseTarball = join(stack.scratchRoot, 'push-base.tar.gz');
      const base = await materialise(pushBase(seed), {
        dir: join(stack.scratchRoot, 'push-base'),
        tarball: baseTarball,
        prefix: `bench-${baseCommit}`,
      });
      trees.base = { ...base.totals, tarballBytes: base.tarballBytes };
      await rm(join(stack.scratchRoot, 'push-base'), { recursive: true, force: true });
      // The base is published before any window opens.
      await timedToResolved(
        stack,
        shared.push,
        'first-index',
        { fetchUrl: stack.serve('push-base.tar.gz', baseTarball) },
        baseCommit,
        base.map,
        PUSH_TARGET_MS * 10,
      );
      const changedPaths = pushChangedPaths();
      return await measure(
        async (pass) => {
          const label = `pass ${String(pass)}`;
          const commit = commitOf(seed, `push ${label}`);
          const name = `push-${String(pass)}.tar.gz`;
          const tarball = join(stack.scratchRoot, name);
          const dir = join(stack.scratchRoot, `push-${String(pass)}`);
          const tree = await materialise(pushSuccessor(seed, label), {
            dir,
            tarball,
            prefix: `bench-${commit}`,
          });
          await rm(dir, { recursive: true, force: true });
          trees.successor = { ...tree.totals, tarballBytes: tree.tarballBytes };
          return { commit, tarball, map: tree.map, url: stack.serve(name, tarball) };
        },
        (_pass, p) =>
          timedToResolved(
            stack,
            shared.push,
            'push',
            { previousHead: baseCommit, changedPaths, fetchUrl: p.url },
            p.commit,
            p.map,
            PUSH_TARGET_MS,
          ),
        async (_pass, _result, p) => {
          let changed = 0;
          for (const [path, hash] of p.map) if (base.map.get(path) !== hash) changed += 1;
          if (changed !== changedPaths.length) {
            throw new Error(
              `the successor changed ${String(changed)} paths, not ${String(changedPaths.length)}`,
            );
          }
          await rm(p.tarball, { force: true });
        },
      );
    },
    stack,
    shared,
  );
}

async function firstIndexArm(
  stack: Stack,
  shared: Shared,
  seed: string,
  run: string,
): Promise<ArmResult> {
  return runArm(
    'first-index',
    async (trees) => {
      const commit = commitOf(seed, 'first index');
      const tarball = join(stack.scratchRoot, 'large.tar.gz');
      const dir = join(stack.scratchRoot, 'large');
      const tree = await materialise(largeTree(seed), { dir, tarball, prefix: `bench-${commit}` });
      await rm(dir, { recursive: true, force: true });
      trees.large = { ...tree.totals, tarballBytes: tree.tarballBytes };
      if (tree.totals.textBytes < MOTIR_CORE_TEXT_BYTES) {
        throw new Error(
          `the large tree holds ${String(tree.totals.textBytes)} bytes, under motir-core's ${String(MOTIR_CORE_TEXT_BYTES)}`,
        );
      }
      if (tree.totals.largestFileBytes > perFileCapBytes()) {
        throw new Error(
          `a generated file of ${String(tree.totals.largestFileBytes)} bytes is past the per-file cap`,
        );
      }
      const url = stack.serve('large.tar.gz', tarball);
      // Each pass indexes into a tenant of its own, so every blob is missing again.
      return await measure(
        async (pass) => {
          const seeded = await stack.seedTenant(
            `indexing bench ${run} first index ${String(pass)}`,
            1,
          );
          return { tenantId: seeded.tenantId, repositoryId: seeded.repositoryIds[0] as string };
        },
        (_pass, scope) =>
          timedToResolved(
            stack,
            scope,
            'first-index',
            { fetchUrl: url },
            commit,
            tree.map,
            FIRST_INDEX_TARGET_MS,
          ),
        async (_pass, _result, scope) => {
          await stack.deleteTenant(scope.tenantId);
        },
      );
    },
    stack,
    shared,
  );
}

export async function runBench(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let options: Options | 'help';
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (options === 'help') {
    console.log(USAGE);
    return 0;
  }
  const urls = readBenchUrls(env);
  const config: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, workers: options.workers };
  const run = randomBytes(4).toString('hex');
  const startedAt = new Date().toISOString();
  console.log(
    `indexing bench ${run}: arms ${options.arms.join(', ')}; ${String(config.workers)} workers; seed ${options.seed}`,
  );

  const stack = await startStack({ urls, config, run, env });
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`${signal}: tearing down`);
    void stack.teardown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  // An error no await catches still tears down before the process ends.
  const onUncaught = (error: Error) => {
    console.error(error);
    void stack.teardown().finally(() => process.exit(1));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('uncaughtException', onUncaught);

  const arms: ArmResult[] = [];
  try {
    const shared = await prepareShared(stack, options.seed, run);
    for (const arm of options.arms) {
      console.log(`running the ${arm} arm`);
      const result =
        arm === 'push'
          ? await pushArm(stack, shared, options.seed)
          : await firstIndexArm(stack, shared, options.seed, run);
      arms.push(result);
      if (result.readings !== null) {
        console.log(describeReadings(arm, result.targetMs, result.readings));
      }
      if (result.error !== null) console.log(`${arm}: ${result.error}`);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('uncaughtException', onUncaught);
    await stack.teardown();
  }

  const report: BenchRun = {
    startedAt,
    seed: options.seed,
    config,
    perFileCapBytes: perFileCapBytes(env),
    arms,
  };
  const text = renderReport(report);
  process.stdout.write(text);
  if (options.report !== undefined) {
    await mkdir(join(options.report, '..'), { recursive: true });
    await writeFile(options.report, text);
    console.log(`wrote ${options.report}`);
  }
  return runMet(report) ? 0 : 1;
}

process.exitCode = await runBench(process.argv.slice(2));
