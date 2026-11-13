/**
 * The indexing benchmark's report: printed after every run, and written to
 * `--report <path>` by the two-arm run, from the values that run produced and
 * nothing else. A miss is reported, never hidden: the verdict, the
 * configuration the run used, and the shape a fix would take.
 */
import type { Readings } from './measure.js';
import { seconds } from './measure.js';
import { MAX_INDEXING_TX_MS, SAMPLE_INTERVAL_MS, type SamplerReading } from './sampler.js';
import type { WorkerConfig } from './stack.js';
import type { TreeTotals } from './tree.js';

export const PUSH_TARGET_MS = 60_000;
export const FIRST_INDEX_TARGET_MS = 600_000;

export interface Liveness {
  readonly resolutions: number;
  readonly failures: number;
}

export interface ArmResult {
  readonly arm: 'push' | 'first-index';
  readonly targetMs: number;
  /** Null when the arm stopped before its passes finished; `error` then says why. */
  readonly readings: Readings | null;
  readonly error: string | null;
  /** Each generated tree the arm indexed, by name. */
  readonly trees: Readonly<Record<string, TreeTotals & { tarballBytes: number }>>;
  readonly sampler: SamplerReading | null;
  readonly liveness: Liveness;
}

export interface BenchRun {
  readonly startedAt: string;
  readonly seed: string;
  readonly config: WorkerConfig;
  readonly perFileCapBytes: number;
  readonly arms: readonly ArmResult[];
}

/** Met: a median within its target, every sample within the bound, and no failed liveness read. */
export function armMet(arm: ArmResult): boolean {
  return (
    arm.error === null &&
    arm.readings !== null &&
    arm.readings.median <= arm.targetMs &&
    (arm.sampler?.withinBound ?? false) &&
    arm.liveness.failures === 0
  );
}

export function runMet(run: BenchRun): boolean {
  return run.arms.length > 0 && run.arms.every(armMet);
}

const FIX_SHAPE: Record<ArmResult['arm'], string> = {
  push:
    'The window is the claim wait (at most one poll interval), the fetch of the whole tarball, ' +
    'hashing every file of the tree against the blobs the tenant holds, and the publish. ' +
    'A fix takes the slowest of those from the workers’ job lines: a shorter poll for the wait, ' +
    'or hashing only the paths the push names when the previous head is published.',
  'first-index':
    'The window is one fetch and hash followed by the batches the store fans out into. ' +
    'A fix raises the worker count or the batch size until the batches run in parallel, ' +
    'or moves fact extraction out of the store transaction if the batches are CPU-bound.',
};

function kib(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB (${String(bytes)} bytes)`
    : `${String(bytes)} bytes`;
}

function armSection(arm: ArmResult): string[] {
  const title =
    arm.arm === 'push' ? 'Push arm — a 50-file push' : 'First-index arm — a motir-core-sized tree';
  const lines = [`## ${title}`, ''];
  const verdict = armMet(arm) ? 'met' : 'missed';
  lines.push(
    `- Target: ${seconds(arm.targetMs)} from the call's 202 to the first tenant-bound \`resolveCommit\` answering the full expected map.`,
  );
  if (arm.readings === null) {
    lines.push(`- Measured: no reading — ${arm.error ?? 'the arm stopped'}.`);
  } else {
    const r = arm.readings;
    lines.push(
      `- Measured: median **${seconds(r.median)}** over ${String(r.ms.length)} passes after one discarded warm-up (${seconds(r.warmUpMs)}); readings ${r.ms.map(seconds).join(', ')}; min ${seconds(r.min)}, max ${seconds(r.max)}.`,
    );
    if (arm.error !== null) lines.push(`- Error: ${arm.error}`);
  }
  lines.push(`- Verdict: **${verdict}**.`);
  for (const [name, t] of Object.entries(arm.trees)) {
    lines.push(
      `- Tree \`${name}\`: ${String(t.paths)} paths, ${String(t.files)} files, ${kib(t.textBytes)} of text, largest file ${String(t.largestFileBytes)} bytes, tarball ${kib(t.tarballBytes)} deflated.`,
    );
  }
  if (arm.sampler === null) {
    lines.push('- Longest indexing transaction: not sampled.');
  } else {
    const s = arm.sampler;
    lines.push(
      `- Longest indexing transaction observed: ${s.longestMs.toFixed(0)} ms (bound \`MAX_INDEXING_TX_MS\` ${String(s.boundMs)} ms, ${s.withinBound ? 'within' : 'PAST'} it), over ${String(s.samples)} samples every ${String(s.intervalMs)} ms. Statement: ${s.longestStatement === null ? 'none open' : `\`${s.longestStatement.replace(/`/g, "'")}\``}.`,
      `  A sample shows a long transaction was present at that instant; the samples are not proof that none occurred between two of them.`,
    );
  }
  lines.push(
    `- Liveness (not a read target): ${String(arm.liveness.resolutions)} resolutions of the other repository's published commit during the arm, ${String(arm.liveness.failures)} failed.`,
  );
  if (verdict === 'missed') lines.push(`- Shape a fix would take: ${FIX_SHAPE[arm.arm]}`);
  lines.push('');
  return lines;
}

export function renderReport(run: BenchRun): string {
  const c = run.config;
  return [
    '# Indexing capacity',
    '',
    `Written by \`pnpm bench:indexing\` from the run started ${run.startedAt}; every number below is that run's own.`,
    '',
    `Overall: **${runMet(run) ? 'met' : 'missed'}**.`,
    '',
    '## Configuration',
    '',
    `- Seed: \`${run.seed}\``,
    `- Workers: ${String(c.workers)}; \`BLOB_STORE_BATCH_SIZE\` ${String(c.batchSize)}; \`WORKER_POLL_MS\` ${String(c.pollMs)}; \`JOB_LEASE_MS\` ${String(c.leaseMs)}; \`MAX_ATTEMPTS\` ${String(c.maxAttempts)}`,
    `- Per-file cap: ${String(run.perFileCapBytes)} bytes`,
    `- Targets: push ${seconds(PUSH_TARGET_MS)}, first index ${seconds(FIRST_INDEX_TARGET_MS)}`,
    `- Sampler: every ${String(SAMPLE_INTERVAL_MS)} ms, bound \`MAX_INDEXING_TX_MS\` ${String(MAX_INDEXING_TX_MS)} ms`,
    '',
    ...run.arms.flatMap(armSection),
  ]
    .join('\n')
    .replace(/\n*$/, '\n'); // exactly one final newline, as the formatter writes it
}
