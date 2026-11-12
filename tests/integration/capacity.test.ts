import { performance } from 'node:perf_hooks';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { languageForPath } from '../../src/indexer/registry.js';
import { storeBlob, type StoredBlob } from '../../src/indexing/storeBlob.js';
import { queryRows, withClient } from '../helpers/db.js';
import {
  BATCH_SIZE,
  capacityBatch,
  FIXTURE_LANGUAGES,
  MAX_FILE_BYTES,
  MIN_FILE_BYTES,
  type CapacityFile,
} from './capacity.fixture.js';
import { foundation, type Foundation } from './foundation.fixture.js';

// MOTIR-11002's capacity target: one worker extracts and stores a batch of 50
// changed source files in at most 10 s against the CI Postgres. The other
// integration suites assert on the statements a request issued rather than on
// timing; this one is the exception the target requires, and it prints the
// total with its per-file spread so a later run compares numbers, not ticks.
//
// The clock wraps only the fifty storeBlob calls. Bootstrap, migrations, the
// tenancy fixture, connections and fixture materialization all happen before it
// starts, because the budget is the work a worker does on a batch it has
// already fetched. One cold sample: no warm-up, no retry, no average.

/** The story's budget, in milliseconds. Never relaxed for CI. */
const BUDGET_MS = 10_000;

/** Above the budget, so an overrun fails on the assertion and its numbers. */
const TIMED_CASE_TIMEOUT_MS = 60_000;

/** The incrementality run's size. */
const STEP_BATCH_SIZE = 10;

interface Timed {
  readonly file: CapacityFile;
  readonly stored: StoredBlob;
  readonly ms: number;
}

let foundationDb: Foundation;
let app: pg.Client;
let observer: pg.Client;
let tenantId: string;
let clientId: string;
const batch = capacityBatch();
let timed: Timed[] = [];
let elapsedMs = Number.NaN;

beforeAll(async () => {
  foundationDb = await foundation();
  tenantId = foundationDb.fx.tenantA.id;
  clientId = foundationDb.fx.readerId;
  // The connection the library stores through, as a worker holds one.
  app = new pg.Client({ connectionString: foundationDb.db.appUrl });
  // A second connection, as the owner, that reads back what landed.
  observer = new pg.Client({ connectionString: foundationDb.db.ownerUrl });
  await app.connect();
  await observer.connect();
});

afterAll(async () => {
  await app.end();
  await observer.end();
  await foundationDb.db.drop();
});

function totalBytes(files: readonly CapacityFile[]): number {
  return files.reduce((sum, f) => sum + f.bytes.length, 0);
}

function round(ms: number): string {
  return ms.toFixed(1);
}

/** The total, the per-file spread, the slowest file and the batch's bytes. */
function report(): string {
  const sorted = [...timed].sort((a, b) => a.ms - b.ms);
  const median =
    sorted.length % 2 === 1
      ? (sorted[(sorted.length - 1) / 2]?.ms ?? Number.NaN)
      : ((sorted[sorted.length / 2 - 1]?.ms ?? Number.NaN) +
          (sorted[sorted.length / 2]?.ms ?? Number.NaN)) /
        2;
  const slowest = sorted.at(-1);
  return [
    `capacity: ${String(timed.length)} files stored in ${round(elapsedMs)} ms (budget ${String(BUDGET_MS)} ms)`,
    `  per file: min ${round(sorted[0]?.ms ?? Number.NaN)} ms · median ${round(median)} ms · max ${round(slowest?.ms ?? Number.NaN)} ms`,
    `  slowest: ${slowest?.file.path ?? 'none'} (${slowest?.file.language ?? 'none'})`,
    `  batch: ${String(totalBytes(batch))} bytes`,
  ].join('\n');
}

async function countBlobs(): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    observer,
    'SELECT count(*)::int AS n FROM codegraph.blob WHERE tenant_id = $1',
    [tenantId],
  );
  return rows[0]?.n ?? 0;
}

describe('the capacity gate: fifty changed files stored in ten seconds', () => {
  it('materializes fifty distinct files inside the size band, each resolving to its declared language', () => {
    expect(batch).toHaveLength(BATCH_SIZE);
    expect(new Set(batch.map((f) => f.path)).size).toBe(BATCH_SIZE);
    expect(new Set(batch.map((f) => f.bytes.toString('hex'))).size).toBe(BATCH_SIZE);
    expect(new Set(batch.map((f) => f.gitBlobHash)).size).toBe(BATCH_SIZE);

    const outOfBand = batch.filter(
      (f) => f.bytes.length < MIN_FILE_BYTES || f.bytes.length > MAX_FILE_BYTES,
    );
    expect(outOfBand.map((f) => `${f.path} (${String(f.bytes.length)} bytes)`)).toEqual([]);

    const unresolved = batch.filter((f) => languageForPath(f.path)?.language !== f.language);
    expect(unresolved.map((f) => f.path)).toEqual([]);
    // Every grammar-backed language in the fixture is in the batch.
    expect(new Set(batch.map((f) => f.language))).toEqual(new Set(FIXTURE_LANGUAGES));

    const perLanguage = new Map<string, number>();
    for (const f of batch) perLanguage.set(f.language, (perLanguage.get(f.language) ?? 0) + 1);
    console.log(
      `capacity batch: ${String(batch.length)} files, ${String(totalBytes(batch))} bytes\n  ` +
        [...perLanguage].map(([language, n]) => `${language} ${String(n)}`).join(' · '),
    );
  });

  it(
    'stores the batch within the budget, every file indexed without parse errors',
    async () => {
      const results: Timed[] = [];
      const start = performance.now();
      for (const file of batch) {
        const before = performance.now();
        const stored = await storeBlob(app, {
          tenantId,
          clientId,
          gitBlobHash: file.gitBlobHash,
          path: file.path,
          bytes: file.bytes,
        });
        results.push({ file, stored, ms: performance.now() - before });
      }
      elapsedMs = performance.now() - start;
      timed = results;
      console.log(report());

      // A file that skipped decoding, extraction or writing would post a fast,
      // meaningless number, so the population the timer saw must all be work.
      const notEarned = timed
        .filter((t) => t.stored.outcome !== 'indexed' || t.stored.parsedWithErrors !== false)
        .map(
          (t) =>
            `${t.file.path}: ${t.stored.outcome}, parsedWithErrors ${String(t.stored.parsedWithErrors)}`,
        );
      expect(notEarned).toEqual([]);
      expect(timed.every((t) => !t.stored.alreadyStored)).toBe(true);

      expect(elapsedMs, `over budget\n${report()}`).toBeLessThanOrEqual(BUDGET_MS);
    },
    TIMED_CASE_TIMEOUT_MS,
  );

  it('the batch landed: read back on another connection, every blob has its contents and facts', async () => {
    expect(timed).toHaveLength(BATCH_SIZE);
    const blobs = await queryRows<{ hash: string; outcome: string }>(
      observer,
      'SELECT git_blob_hash AS hash, outcome FROM codegraph.blob WHERE tenant_id = $1',
      [tenantId],
    );
    expect(blobs).toHaveLength(BATCH_SIZE);
    expect(blobs.every((b) => b.outcome === 'indexed')).toBe(true);

    const contents = await queryRows<{ hash: string; contents: string }>(
      observer,
      'SELECT git_blob_hash AS hash, contents FROM codegraph.blob_contents WHERE tenant_id = $1',
      [tenantId],
    );
    expect(contents).toHaveLength(BATCH_SIZE);
    const byHash = new Map(contents.map((c) => [c.hash, c.contents]));
    const mismatched = batch.filter(
      (f) => !Buffer.from(byHash.get(f.gitBlobHash) ?? '', 'utf8').equals(f.bytes),
    );
    expect(mismatched.map((f) => f.path)).toEqual([]);

    const facts = await queryRows<{ hash: string; n: number }>(
      observer,
      `SELECT git_blob_hash AS hash, count(*)::int AS n FROM codegraph.blob_fact
        WHERE tenant_id = $1 GROUP BY git_blob_hash`,
      [tenantId],
    );
    const factCount = new Map(facts.map((f) => [f.hash, f.n]));
    const factless = batch.filter((f) => (factCount.get(f.gitBlobHash) ?? 0) < 1);
    expect(factless.map((f) => f.path)).toEqual([]);
  });

  it('commits each file before the next store begins, leaving no session idle in transaction', async () => {
    const steps = capacityBatch(STEP_BATCH_SIZE, 'capacity-steps');
    const before = await countBlobs();
    const seen: number[] = [];
    for (const file of steps) {
      await storeBlob(app, {
        tenantId,
        clientId,
        gitBlobHash: file.gitBlobHash,
        path: file.path,
        bytes: file.bytes,
      });
      seen.push((await countBlobs()) - before);
    }
    expect(seen).toEqual(Array.from({ length: STEP_BATCH_SIZE }, (_, i) => i + 1));

    // pg_stat_activity hides another role's state from an ordinary login, so
    // the check runs as the admin login, which sees every session's.
    const idle = await withClient(foundationDb.db.adminUrl, (admin) =>
      queryRows<{ pid: number }>(
        admin,
        `SELECT pid FROM pg_stat_activity
          WHERE datname = $1 AND state LIKE 'idle in transaction%'`,
        [foundationDb.db.name],
      ),
    );
    expect(idle).toEqual([]);
  });
});
