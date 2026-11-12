import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertBlobIfAbsent, insertContents, type BlobOutcome } from '../../src/db/blobs.js';
import { insertFacts, type StoredFact } from '../../src/db/facts.js';
import { TREE_SITTER_PRODUCER } from '../../src/extract/types.js';
import { listLanguages } from '../../src/indexer/registry.js';
import {
  DEFAULT_REEXTRACT_BATCH_SIZE,
  REEXTRACT_LOCK_CLASS,
  ReextractError,
  reextractLanguage,
} from '../../src/indexing/reextract.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { buildTenancyFixture } from '../helpers/tenancy.js';

// The sweep runs on the owner login it opens from its options. Stale rows are
// built through the repositories as the owner, because the store library always
// stamps the current version and so cannot produce staleness.

const OLD = '0.0.1/q0';
const OTHER_PRODUCER = 'fixture-producer';

let db: FreshDatabase;
let owner: pg.Client;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  db = await freshDatabase();
  const fixture = await buildTenancyFixture(db);
  tenantA = fixture.tenantA.id;
  tenantB = fixture.tenantB.id;
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await db.drop();
});

function current(language: string): string {
  const entry = listLanguages().find((e) => e.language === language);
  if (entry === undefined) throw new Error(`no entry for ${language}`);
  return entry.extractorVersion;
}

interface Seed {
  outcome?: Extract<BlobOutcome, 'indexed' | 'unsupported'>;
  version?: string;
  parsedWithErrors?: boolean;
  contents?: boolean;
  otherProducer?: boolean;
}

interface Seeded {
  tenantId: string;
  gitBlobHash: string;
  source: string;
}

/** A stale blob of `language`: its row, its stored contents and one old tree-sitter fact. */
async function seedStale(
  tenantId: string,
  language: string,
  source: string,
  seed: Seed = {},
): Promise<Seeded> {
  const gitBlobHash = randomBytes(20).toString('hex');
  const outcome = seed.outcome ?? 'indexed';
  const key = { tenantId, gitBlobHash };
  await insertBlobIfAbsent(owner, {
    ...key,
    sizeBytes: Buffer.byteLength(source),
    outcome,
    lossy: false,
    language,
    ...(outcome === 'indexed'
      ? { extractorVersion: seed.version ?? OLD, parsedWithErrors: seed.parsedWithErrors ?? false }
      : {}),
  });
  if (seed.contents !== false) {
    await insertContents(owner, { ...key, contents: source });
  }
  if (outcome === 'indexed') {
    await insertFacts(owner, key, [oldFact(language, TREE_SITTER_PRODUCER, seed.version ?? OLD)]);
  }
  if (seed.otherProducer === true) {
    await insertFacts(owner, key, [oldFact(language, OTHER_PRODUCER, 'fixture@1')]);
  }
  return { ...key, source };
}

function oldFact(language: string, producer: string, extractorVersion: string): StoredFact {
  return {
    kind: 'reference',
    language,
    producer,
    extractorVersion,
    name: 'stale_marker',
    referenceKind: 'call',
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    enclosingName: null,
  };
}

async function blobRow(blob: { tenantId: string; gitBlobHash: string }) {
  return (
    await queryRows(
      owner,
      'SELECT * FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = $2',
      [blob.tenantId, blob.gitBlobHash],
    )
  )[0];
}

async function factRows(blob: { tenantId: string; gitBlobHash: string }, producer?: string) {
  return await queryRows(
    owner,
    `SELECT * FROM codegraph.blob_fact WHERE tenant_id = $1 AND git_blob_hash = $2
       AND ($3::text IS NULL OR producer = $3) ORDER BY kind, name, start_line, start_column`,
    [blob.tenantId, blob.gitBlobHash, producer ?? null],
  );
}

async function contentsOf(blob: { tenantId: string; gitBlobHash: string }) {
  return (
    await queryRows<{ contents: string }>(
      owner,
      'SELECT contents FROM codegraph.blob_contents WHERE tenant_id = $1 AND git_blob_hash = $2',
      [blob.tenantId, blob.gitBlobHash],
    )
  )[0]?.contents;
}

/** Every row of every language but `language`, for a before-and-after comparison. */
async function snapshotExcept(language: string) {
  return {
    blobs: await queryRows(
      owner,
      'SELECT * FROM codegraph.blob WHERE language IS DISTINCT FROM $1 ORDER BY tenant_id, git_blob_hash',
      [language],
    ),
    facts: await queryRows(
      owner,
      `SELECT * FROM codegraph.blob_fact WHERE language <> $1
        ORDER BY tenant_id, git_blob_hash, producer, kind, name, start_line, start_column`,
      [language],
    ),
  };
}

async function heldReextractLocks(): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    owner,
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid`,
    [REEXTRACT_LOCK_CLASS],
  );
  return rows[0]?.n ?? -1;
}

const run = (language: string, options: Parameters<typeof reextractLanguage>[1] = {}) =>
  reextractLanguage(language, { connectionString: db.ownerUrl, ...options });

describe('reextractLanguage', () => {
  it('rebuilds a language from stored contents alone, across tenants, leaving every other language as it was', async () => {
    // A noise blob of another language, stale too, that must not move.
    await seedStale(tenantA, 'csharp', 'class A { void F() { G(); } }\n');
    const dir = mkdtempSync(join(tmpdir(), 'reextract-'));
    const files = {
      a: join(dir, 'a.ts'),
      b: join(dir, 'b.ts'),
    };
    writeFileSync(
      files.a,
      'import { x } from "./x";\nexport class A extends B { run() { go(); } }\n',
    );
    writeFileSync(files.b, 'export function f() { return g(1); }\n');
    const a = await seedStale(tenantA, 'typescript', readFileSync(files.a, 'utf8'), {
      otherProducer: true,
    });
    const b = await seedStale(tenantB, 'typescript', readFileSync(files.b, 'utf8'));
    rmSync(dir, { recursive: true }); // the source exists only as stored contents now
    const before = await snapshotExcept('typescript');
    const fixtureRows = await factRows(a, OTHER_PRODUCER);

    // A registry whose typescript entry was raised: the same grammar and query.
    const raised = `${current('typescript')}+raised`;
    const registry = listLanguages().map((e) =>
      e.language === 'typescript' ? { ...e, extractorVersion: raised } : e,
    );
    const report = await run('typescript', { registry });

    expect(report).toMatchObject({
      language: 'typescript',
      extractorVersion: raised,
      anotherRunInProgress: false,
    });
    const reported = report.batches.flatMap((batch) => batch.blobs);
    expect(reported.map((r) => `${r.tenantId}/${r.gitBlobHash}`).sort()).toEqual(
      [a, b].map((s) => `${s.tenantId}/${s.gitBlobHash}`).sort(),
    );
    for (const blob of [a, b]) {
      const facts = await factRows(blob, TREE_SITTER_PRODUCER);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => f.name === 'stale_marker')).toBe(false);
      for (const fact of facts) {
        expect(fact).toMatchObject({
          producer: TREE_SITTER_PRODUCER,
          language: 'typescript',
          extractor_version: raised,
        });
      }
      expect(await blobRow(blob)).toMatchObject({ outcome: 'indexed', extractor_version: raised });
      expect(reported.find((r) => r.gitBlobHash === blob.gitBlobHash)?.factCount).toBe(
        facts.length,
      );
    }
    expect(report.blobCount).toBe(2);
    expect(report.factCount).toBe(reported.reduce((sum, r) => sum + r.factCount, 0));
    // The second producer's rows are untouched, beside the new set.
    expect(await factRows(a, OTHER_PRODUCER)).toEqual(fixtureRows);
    // No other language moved.
    expect(await snapshotExcept('typescript')).toEqual(before);
  });

  it('moves the parse flag with the new extraction', async () => {
    const broken = await seedStale(tenantA, 'tsx', 'export const A = () => <div>{go(</div>;\n', {
      parsedWithErrors: false,
    });
    await run('tsx');
    expect(await blobRow(broken)).toMatchObject({
      parsed_with_errors: true,
      extractor_version: current('tsx'),
    });
  });

  it('promotes unsupported blobs of a language that has gained a grammar, contents unchanged', async () => {
    const source = 'local function f()\n  return g(1)\nend\n';
    const blobs = [
      await seedStale(tenantA, 'lua', source, { outcome: 'unsupported' }),
      await seedStale(tenantB, 'lua', source, { outcome: 'unsupported' }),
    ];
    const report = await run('lua');
    expect(report.blobCount).toBe(2);
    for (const blob of blobs) {
      expect(await blobRow(blob)).toMatchObject({
        outcome: 'indexed',
        language: 'lua',
        extractor_version: current('lua'),
        parsed_with_errors: false,
        lossy: false,
      });
      expect((await factRows(blob)).length).toBeGreaterThan(0);
      const back = await contentsOf(blob);
      expect(Buffer.from(back ?? '', 'utf8').equals(Buffer.from(source, 'utf8'))).toBe(true);
    }
  });

  it('rebuilds nothing for a language with no grammar, and reports a null version', async () => {
    const swift = await seedStale(tenantA, 'swift', 'func f() {}\n', { outcome: 'unsupported' });
    const report = await run('swift');
    expect(report).toEqual({
      language: 'swift',
      extractorVersion: null,
      anotherRunInProgress: false,
      batches: [],
      blobCount: 0,
      factCount: 0,
    });
    expect(await blobRow(swift)).toMatchObject({ outcome: 'unsupported', extractor_version: null });
  });

  it('pages 2, 2 and 1 over five stale blobs, and refuses a page size below one', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedStale(i % 2 === 0 ? tenantA : tenantB, 'python', `def f${String(i)}():\n    g()\n`);
    }
    const report = await run('python', { batchSize: 2 });
    expect(report.batches.map((b) => [b.ordinal, b.blobs.length])).toEqual([
      [1, 2],
      [2, 2],
      [3, 1],
    ]);
    expect(report.blobCount).toBe(5);
    expect(report.factCount).toBe(
      report.batches.flatMap((b) => b.blobs).reduce((n, b) => n + b.factCount, 0),
    );
    for (const blob of report.batches.flatMap((b) => b.blobs)) {
      expect(blob).toEqual({
        tenantId: expect.any(String) as string,
        gitBlobHash: expect.any(String) as string,
        factCount: expect.any(Number) as number,
      });
    }
    for (const batchSize of [0, -1, 1.5]) {
      await expect(run('python', { batchSize })).rejects.toThrow(RangeError);
    }
    expect(DEFAULT_REEXTRACT_BATCH_SIZE).toBe(100);
  });

  it('refuses a connection that is not the owner login, before any page', async () => {
    const blob = await seedStale(tenantA, 'go', 'package m\nfunc F() { g() }\n');
    await expect(reextractLanguage('go', { connectionString: db.appUrl })).rejects.toThrow(
      /must run as codegraph_owner/,
    );
    expect(await blobRow(blob)).toMatchObject({ extractor_version: OLD });
    expect(await heldReextractLocks()).toBe(0);
  });

  it('reports another run in progress, writing nothing, while the language lock is held', async () => {
    const blob = await seedStale(tenantA, 'rust', 'fn f() { g(); }\n');
    const holder = new pg.Client({ connectionString: db.ownerUrl });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [
        REEXTRACT_LOCK_CLASS,
        'rust',
      ]);
      const report = await run('rust');
      expect(report).toMatchObject({ anotherRunInProgress: true, batches: [], blobCount: 0 });
      expect(await blobRow(blob)).toMatchObject({ extractor_version: OLD });
    } finally {
      await holder.end();
    }
    // Once the holder's session ends its key is gone, and a run proceeds.
    expect((await run('rust')).blobCount).toBe(1);
    expect(await heldReextractLocks()).toBe(0);
  });

  it('serialises two concurrent calls: one sweeps, the other reports the run in progress', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedStale(tenantA, 'c', `int f${String(i)}(void) { return g(); }\n`);
    }
    const reports = await Promise.all([run('c', { batchSize: 1 }), run('c', { batchSize: 1 })]);
    const total = reports.reduce((n, r) => n + r.blobCount, 0);
    expect(total).toBe(3);
    // Either the calls overlapped (one reports the other) or ran back to back
    // (the second found nothing stale); neither re-extracts a blob twice.
    for (const report of reports) {
      if (report.anotherRunInProgress) expect(report.blobCount).toBe(0);
    }
    expect(await heldReextractLocks()).toBe(0);
  });

  it('aborts on a stale blob with no contents, keeping the work before it, and resumes from the rows', async () => {
    const sources = Array.from(
      { length: 5 },
      (_, i) => `function f${String(i)}() { return g(${String(i)}); }\n`,
    );
    const seeded: Seeded[] = [];
    for (const source of sources) {
      seeded.push(await seedStale(tenantA, 'javascript', source));
    }
    // The sweep's order is (tenant, hash): drop the fourth blob's contents.
    const ordered = [...seeded].sort((x, y) => (x.gitBlobHash < y.gitBlobHash ? -1 : 1));
    const fourth = ordered[3] as Seeded;
    await owner.query(
      'DELETE FROM codegraph.blob_contents WHERE tenant_id = $1 AND git_blob_hash = $2',
      [fourth.tenantId, fourth.gitBlobHash],
    );

    const error = await run('javascript', { batchSize: 2 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReextractError);
    expect(error).toMatchObject({ gitBlobHash: fourth.gitBlobHash, reextractedBefore: 3 });
    expect(await heldReextractLocks()).toBe(0); // released on the throw
    for (const blob of ordered.slice(0, 3)) {
      expect(await blobRow(blob)).toMatchObject({ extractor_version: current('javascript') });
    }
    for (const blob of ordered.slice(3)) {
      expect(await blobRow(blob)).toMatchObject({ outcome: 'indexed', extractor_version: OLD });
      expect((await factRows(blob)).map((f) => f.name)).toEqual(['stale_marker']);
    }

    // The broken invariant mended, a second call does exactly the remaining two.
    await owner.query(
      'INSERT INTO codegraph.blob_contents (tenant_id, git_blob_hash, contents) VALUES ($1, $2, $3)',
      [fourth.tenantId, fourth.gitBlobHash, fourth.source],
    );
    const resumed = await run('javascript', { batchSize: 2 });
    expect(resumed.batches.flatMap((b) => b.blobs.map((r) => r.gitBlobHash))).toEqual(
      ordered.slice(3).map((s) => s.gitBlobHash),
    );
  });

  it('raises ReextractError for an unsupported blob with no contents, leaving it unsupported', async () => {
    const blob = await seedStale(tenantB, 'ruby', 'def f\n  g\nend\n', {
      outcome: 'unsupported',
      contents: false,
    });
    await expect(run('ruby')).rejects.toMatchObject({
      name: 'ReextractError',
      gitBlobHash: blob.gitBlobHash,
      reextractedBefore: 0,
    });
    expect(await blobRow(blob)).toMatchObject({ outcome: 'unsupported', extractor_version: null });
    expect(await factRows(blob)).toEqual([]);
  });

  it('reads DATABASE_URL when no connection string is passed', async () => {
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.ownerUrl;
    try {
      expect(await reextractLanguage('swift')).toMatchObject({ extractorVersion: null });
      expect(await reextractLanguage('java')).toMatchObject({ blobCount: 0 });
    } finally {
      process.env.DATABASE_URL = before;
    }
  });
});

describe('the owner login is the only one that reaches every tenant', () => {
  it('is what a direct app-login read would have missed', async () => {
    const blob = await seedStale(tenantB, 'kotlin', 'fun f() { g() }\n');
    const appSees = await withClient(db.appUrl, (c) =>
      queryRows(c, 'SELECT 1 FROM codegraph.blob WHERE git_blob_hash = $1', [blob.gitBlobHash]),
    );
    expect(appSees).toEqual([]);
    expect((await run('kotlin')).blobCount).toBe(1);
  });
});
