import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { insertBlobIfAbsent, insertContents } from '../../src/db/blobs.js';
import { findBlobsBelowExtractorVersion, insertFacts } from '../../src/db/facts.js';
import { TREE_SITTER_PRODUCER } from '../../src/extract/types.js';
import { listLanguages } from '../../src/indexer/registry.js';
import { REEXTRACT_LOCK_CLASS } from '../../src/indexing/reextract.js';
import { planReextraction, runReextraction } from '../../src/indexing/reextractRun.js';
import { freshDatabase, queryRows, type FreshDatabase } from '../helpers/db.js';
import { runScript, type CommandResult } from '../helpers/processes.js';
import { buildTenancyFixture } from '../helpers/tenancy.js';

// `pnpm reextract` as a process, started the way its package.json script starts
// it, and its decision module imported directly. The library's own behaviour
// (the lock released on a throw, the ReextractError shape, the page-size
// refusal, its own login check) is pinned by tests/indexing/reextract.test.ts;
// this suite drives the command's decisions over it. Stale rows are built as
// the owner, because a store always stamps the current version.

/** Each command loads every grammar on start, so a process case is given room. */
const PROCESS_TIMEOUT_MS = 60_000;
const OLD = '0.0.1/q0';

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
}, PROCESS_TIMEOUT_MS);

afterEach(async () => {
  // Every case starts from no blobs; facts and contents cascade.
  await owner.query('DELETE FROM codegraph.blob');
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

interface Seeded {
  tenantId: string;
  gitBlobHash: string;
  source: string;
}

/** A stale blob: `indexed` at an old version with one old fact, or stored `unsupported`. */
async function seedStale(
  tenantId: string,
  language: string,
  source: string,
  outcome: 'indexed' | 'unsupported' = 'indexed',
): Promise<Seeded> {
  const gitBlobHash = randomBytes(20).toString('hex');
  const key = { tenantId, gitBlobHash };
  await insertBlobIfAbsent(owner, {
    ...key,
    sizeBytes: Buffer.byteLength(source),
    outcome,
    lossy: false,
    language,
    ...(outcome === 'indexed' ? { extractorVersion: OLD, parsedWithErrors: false } : {}),
  });
  await insertContents(owner, { ...key, contents: source });
  if (outcome === 'indexed') {
    await insertFacts(owner, key, [
      {
        kind: 'reference',
        language,
        producer: TREE_SITTER_PRODUCER,
        extractorVersion: OLD,
        name: 'stale_marker',
        referenceKind: 'call',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        enclosingName: null,
      },
    ]);
  }
  return { ...key, source };
}

async function dropContents(blob: Seeded): Promise<void> {
  await owner.query(
    'DELETE FROM codegraph.blob_contents WHERE tenant_id = $1 AND git_blob_hash = $2',
    [blob.tenantId, blob.gitBlobHash],
  );
}

/** A blob's recorded version and the distinct versions and names of its facts. */
async function state(blob: Seeded) {
  const rows = await queryRows<{
    outcome: string;
    version: string | null;
    fact_versions: string[];
    names: string[];
  }>(
    owner,
    `SELECT b.outcome, b.extractor_version AS version,
            array(SELECT DISTINCT f.extractor_version FROM codegraph.blob_fact f
                   WHERE f.tenant_id = b.tenant_id AND f.git_blob_hash = b.git_blob_hash
                   ORDER BY 1) AS fact_versions,
            array(SELECT f.name FROM codegraph.blob_fact f
                   WHERE f.tenant_id = b.tenant_id AND f.git_blob_hash = b.git_blob_hash
                   ORDER BY 1) AS names
       FROM codegraph.blob b WHERE b.tenant_id = $1 AND b.git_blob_hash = $2`,
    [blob.tenantId, blob.gitBlobHash],
  );
  return rows[0];
}

/** Rebuilt at the registry's version, with freshly extracted facts in place of the marker. */
async function expectRebuilt(blob: Seeded, language: string): Promise<void> {
  const after = await state(blob);
  expect(after).toMatchObject({
    outcome: 'indexed',
    version: current(language),
    fact_versions: [current(language)],
  });
  expect(after?.names).not.toContain('stale_marker');
  expect(after?.names.length).toBeGreaterThan(0);
}

async function expectUntouched(blob: Seeded): Promise<void> {
  expect(await state(blob)).toMatchObject({
    outcome: 'indexed',
    version: OLD,
    fact_versions: [OLD],
    names: ['stale_marker'],
  });
}

/** Every blob and fact row outside `languages`, row by row, for a before-and-after comparison. */
async function snapshotExcept(languages: readonly string[]) {
  return {
    blobs: await queryRows(
      owner,
      `SELECT * FROM codegraph.blob WHERE language IS NULL OR NOT (language = ANY ($1))
        ORDER BY tenant_id, git_blob_hash`,
      [languages],
    ),
    facts: await queryRows(
      owner,
      `SELECT * FROM codegraph.blob_fact WHERE NOT (language = ANY ($1))
        ORDER BY tenant_id, git_blob_hash, producer, kind, name, start_line, start_column`,
      [languages],
    ),
  };
}

/** Re-extraction locks held by any session but `except`, read from the lock catalogue. */
async function heldReextractLocks(except: number | null = null): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    owner,
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND classid = $1::oid AND pid IS DISTINCT FROM $2`,
    [REEXTRACT_LOCK_CLASS, except],
  );
  return rows[0]?.n ?? -1;
}

const reextract = (env: NodeJS.ProcessEnv, args: string[] = []): Promise<CommandResult> =>
  runScript('reextract', env, args);
const asOwner = () => ({ DATABASE_URL: db.ownerUrl });
const lines = (result: CommandResult) => result.stdout.split('\n').filter((line) => line !== '');

function succeeded(result: CommandResult): string[] {
  expect(result.code, result.stderr).toBe(0);
  return lines(result);
}

const PY = (n: number) => `def f${String(n)}():\n    return g(${String(n)})\n`;
const TS = (n: number) => `export function f${String(n)}() { return g(${String(n)}); }\n`;

describe('pnpm reextract', () => {
  it(
    'prints its usage without reading DATABASE_URL',
    async () => {
      for (const flag of ['--help', '-h']) {
        const help = await reextract({ DATABASE_URL: 'not a url' }, [flag]);
        expect(help.code, help.stderr).toBe(0);
        expect(help.stdout).toContain('usage: pnpm reextract');
        expect(help.stdout).toContain('--language <id>');
        expect(help.stdout).toContain('codegraph_owner');
        expect(help.stderr).toBe('');
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'plans nothing and exits 0 on a database with nothing stale, leaving no lock',
    async () => {
      expect(await heldReextractLocks()).toBe(0);
      const out = succeeded(await reextract(asOwner()));
      expect(out).toEqual([
        'plan: 0 language(s) have stale blobs',
        'reextract: languages=0 swept=0 skipped=0 failed=0 blobs=0 facts=0',
      ]);
      expect(await heldReextractLocks()).toBe(0);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'narrows to --language across both tenants, then plans and sweeps every stale language in order',
    async () => {
      const pyA = await seedStale(tenantA, 'python', PY(1));
      const pyB = await seedStale(tenantB, 'python', PY(2));
      const ts = await seedStale(tenantA, 'typescript', TS(1));
      const bystander = await seedStale(tenantB, 'go', 'package m\nfunc F() { g() }\n');
      await owner.query(
        'UPDATE codegraph.blob SET extractor_version = $1 WHERE git_blob_hash = $2',
        [current('go'), bystander.gitBlobHash],
      );
      await owner.query(
        'UPDATE codegraph.blob_fact SET extractor_version = $1 WHERE git_blob_hash = $2',
        [current('go'), bystander.gitBlobHash],
      );

      const before = await snapshotExcept(['python']);
      const narrowed = succeeded(await reextract(asOwner(), ['--language', 'python']));
      expect(narrowed[0]).toBe('plan: 1 language(s) have stale blobs: python');
      expect(narrowed).toContainEqual(
        expect.stringMatching(/^batch language=python ordinal=1 blobs=2 facts=\d+$/),
      );
      expect(narrowed).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^language=python version=${current('python')} status=swept blobs=2 facts=\\d+$`,
          ),
        ),
      );
      expect(narrowed.at(-1)).toMatch(
        /^reextract: languages=1 swept=1 skipped=0 failed=0 blobs=2 facts=\d+$/,
      );
      await expectRebuilt(pyA, 'python');
      await expectRebuilt(pyB, 'python');
      await expectUntouched(ts);
      expect(await snapshotExcept(['python'])).toEqual(before);
      expect(await heldReextractLocks()).toBe(0);

      // Python goes stale again; a run with no --language plans both, ascending.
      const pyAgain = await seedStale(tenantB, 'python', PY(3));
      const unplanned = await snapshotExcept(['python', 'typescript']);
      const full = succeeded(await reextract(asOwner()));
      expect(full[0]).toBe('plan: 2 language(s) have stale blobs: python, typescript');
      const outcomes = full.filter((line) => line.startsWith('language='));
      expect(outcomes.map((line) => line.split(' ')[0])).toEqual([
        'language=python',
        'language=typescript',
      ]);
      expect(full.at(-1)).toMatch(
        /^reextract: languages=2 swept=2 skipped=0 failed=0 blobs=2 facts=\d+$/,
      );
      await expectRebuilt(pyAgain, 'python');
      await expectRebuilt(ts, 'typescript');
      expect(await snapshotExcept(['python', 'typescript'])).toEqual(unplanned);
      expect(await heldReextractLocks()).toBe(0);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'refuses the app login by name before the first probe, printing no connection string',
    async () => {
      const blob = await seedStale(tenantA, 'python', PY(1));
      const refused = await reextract({ DATABASE_URL: db.appUrl });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('must run as codegraph_owner');
      expect(refused.stderr).toContain('not as codegraph_app');
      expect(refused.stdout).toBe('');
      // The local password may equal the login's name, so the credential is
      // looked for in its URL form, where a leak of the string would put it.
      const { username, password, host } = new URL(db.appUrl);
      for (const stream of [refused.stdout, refused.stderr]) {
        expect(stream).not.toContain(db.appUrl);
        expect(stream).not.toContain(`:${password}@`);
        expect(stream).not.toContain(`${username}:`);
        expect(stream).not.toContain(host);
      }
      await expectUntouched(blob);
      expect(await heldReextractLocks()).toBe(0);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'refuses a --language listLanguages() does not answer, before connecting',
    async () => {
      // An unusable URL proves the refusal comes before any connection or probe.
      const unknown = await reextract({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }, [
        '--language',
        'klingon',
      ]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('klingon');
      expect(unknown.stderr).toContain('listLanguages()');
      expect(unknown.stdout).toBe('');
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'fails a language with a blob it cannot rebuild, keeps what came before, and still sweeps the next',
    async () => {
      const js = [
        await seedStale(tenantA, 'javascript', 'function a() { return g(1); }\n'),
        await seedStale(tenantA, 'javascript', 'function b() { return g(2); }\n'),
      ].sort((x, y) => (x.gitBlobHash < y.gitBlobHash ? -1 : 1));
      const [first, broken] = js as [Seeded, Seeded];
      await dropContents(broken);
      const lua = await seedStale(tenantB, 'lua', 'local function f() return g() end\n');

      const result = await reextract(asOwner());
      expect(result.code).toBe(1);
      const out = lines(result);
      expect(out[0]).toBe('plan: 2 language(s) have stale blobs: javascript, lua');
      expect(out).toContain(
        `language=javascript version=${current('javascript')} status=failed blobs=0 facts=0`,
      );
      expect(out).toContainEqual(expect.stringMatching(/^language=lua .* status=swept blobs=1 /));
      expect(out.at(-1)).toMatch(
        /^reextract: languages=2 swept=1 skipped=0 failed=1 blobs=1 facts=\d+$/,
      );
      expect(result.stderr).toContain(broken.gitBlobHash);
      expect(result.stderr).toContain('1 blob(s) were re-extracted before it');
      await expectRebuilt(first, 'javascript');
      await expectUntouched(broken);
      await expectRebuilt(lua, 'lua');
      expect(await heldReextractLocks()).toBe(0);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'skips a language whose lock another session holds, exits 1, and sweeps the rest',
    async () => {
      const go = await seedStale(tenantA, 'go', 'package m\nfunc F() { g() }\n');
      const rust = await seedStale(tenantB, 'rust', 'fn f() { g(); }\n');
      const holder = new pg.Client({ connectionString: db.ownerUrl });
      await holder.connect();
      try {
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid as number;
        await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [
          REEXTRACT_LOCK_CLASS,
          'go',
        ]);
        const result = await reextract(asOwner());
        expect(result.code).toBe(1);
        const out = lines(result);
        expect(out[0]).toBe('plan: 2 language(s) have stale blobs: go, rust');
        expect(out).toContain(
          `language=go version=${current('go')} status=skipped blobs=0 facts=0`,
        );
        expect(out).toContainEqual(
          expect.stringMatching(/^language=rust .* status=swept blobs=1 /),
        );
        expect(out.at(-1)).toMatch(/^reextract: languages=2 swept=1 skipped=1 failed=0 blobs=1 /);
        expect(result.stderr).toContain('another run holds the go re-extraction lock');
        await expectUntouched(go);
        await expectRebuilt(rust, 'rust');
        expect(await heldReextractLocks(pid)).toBe(0);
      } finally {
        await holder.end();
      }
    },
    PROCESS_TIMEOUT_MS,
  );
});

describe('planReextraction', () => {
  it('answers exactly what the shipped predicate reports, ascending, unsupported arm included', async () => {
    await seedStale(tenantB, 'ruby', 'def f\n  g\nend\n', 'unsupported');
    await seedStale(tenantA, 'c', 'int f(void) { return g(); }\n');
    const fresh = await seedStale(tenantA, 'java', 'class A { void f() { g(); } }\n');
    await owner.query('UPDATE codegraph.blob SET extractor_version = $1 WHERE git_blob_hash = $2', [
      current('java'),
      fresh.gitBlobHash,
    ]);

    const plan = await planReextraction(owner);
    expect(plan).toEqual([
      { language: 'c', extractorVersion: current('c') },
      { language: 'ruby', extractorVersion: current('ruby') },
    ]);
    // The predicate, asked directly per language, agrees — the plan re-derives nothing.
    const predicate = [];
    for (const { language, extractorVersion } of listLanguages()) {
      const page = await findBlobsBelowExtractorVersion(owner, null, language, extractorVersion, 1);
      if (page.blobs.length > 0) predicate.push(language);
    }
    expect(plan.map((entry) => entry.language)).toEqual(predicate);

    // Why the login is checked first: the app login's probe answers nothing, silently.
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      expect(await planReextraction(app)).toEqual([]);
    } finally {
      await app.end();
    }
  });
});

describe('runReextraction', () => {
  it('refuses an unknown language and a non-owner login, and reads a held lock as skipped', async () => {
    await expect(
      runReextraction({ connectionString: 'postgres://nobody@127.0.0.1:1/none', languages: ['x'] }),
    ).rejects.toMatchObject({
      name: 'ReextractionRefusedError',
      message: expect.stringContaining('x') as unknown,
    });
    await expect(runReextraction({ connectionString: db.appUrl })).rejects.toMatchObject({
      name: 'ReextractionRefusedError',
      message: expect.stringContaining('not as codegraph_app') as unknown,
    });

    await seedStale(tenantA, 'kotlin', 'fun f() { g() }\n');
    const holder = new pg.Client({ connectionString: db.ownerUrl });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [
        REEXTRACT_LOCK_CLASS,
        'kotlin',
      ]);
      const run = await runReextraction({ connectionString: db.ownerUrl, languages: ['kotlin'] });
      expect(run.outcomes).toEqual([
        {
          language: 'kotlin',
          extractorVersion: current('kotlin'),
          status: 'skipped',
          blobCount: 0,
          factCount: 0,
          batches: [],
          reason: 'another run holds the kotlin re-extraction lock',
        },
      ]);
      expect(run.drained).toBe(false);
    } finally {
      await holder.end();
    }
  });

  it('records a failed language and carries on to the next, not drained', async () => {
    const broken = await seedStale(tenantA, 'ruby', 'def f\n  g\nend\n', 'unsupported');
    await dropContents(broken);
    const rust = await seedStale(tenantB, 'rust', 'fn f() { g(); }\n');

    const run = await runReextraction({ connectionString: db.ownerUrl, batchSize: 1 });
    expect(run.plan.map((entry) => entry.language)).toEqual(['ruby', 'rust']);
    expect(run.outcomes[0]).toMatchObject({
      language: 'ruby',
      status: 'failed',
      blobCount: 0,
      batches: [],
    });
    expect(run.outcomes[0]?.reason).toContain(broken.gitBlobHash);
    expect(run.outcomes[1]).toMatchObject({
      language: 'rust',
      status: 'swept',
      blobCount: 1,
      batches: [{ ordinal: 1, blobCount: 1 }],
      reason: null,
    });
    expect(run.counts).toEqual({ swept: 1, not_stale: 0, skipped: 0, failed: 1 });
    expect(run.drained).toBe(false);
    expect(run.blobCount).toBe(1);
    await expectRebuilt(rust, 'rust');
    expect(await heldReextractLocks()).toBe(0);
  });

  it('reads a language drained before its sweep as not_stale, and a throw as failed', async () => {
    await seedStale(tenantA, 'c', 'int f(void) { return g(); }\n');
    await seedStale(tenantA, 'go', 'package m\nfunc F() { g() }\n');
    vi.resetModules();
    const calls: unknown[] = [];
    vi.doMock('../../src/indexing/reextract.js', () => ({
      reextractLanguage: (language: string, options: unknown) => {
        calls.push([language, options]);
        if (language === 'go') return Promise.reject(new Error('boom'));
        if (language === 'c') {
          // Another run drained it between the plan and this sweep.
          return Promise.resolve({
            language,
            extractorVersion: current(language),
            anotherRunInProgress: false,
            batches: [],
            blobCount: 0,
            factCount: 0,
          });
        }
        throw new Error(`unexpected ${language}`);
      },
    }));
    try {
      const mocked = await import('../../src/indexing/reextractRun.js');
      const run = await mocked.runReextraction({
        connectionString: db.ownerUrl,
        languages: ['c', 'go'],
      });
      expect(run.outcomes.map((o) => [o.language, o.status, o.reason])).toEqual([
        ['c', 'not_stale', null],
        ['go', 'failed', 'boom'],
      ]);
      expect(run.drained).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([
        'c',
        expect.objectContaining({ connectionString: db.ownerUrl }) as unknown,
      ]);
      expect((calls[0] as [string, object])[1]).not.toHaveProperty('batchSize');

      // A drained not_stale run on its own still counts as drained.
      const onlyC = await mocked.runReextraction({
        connectionString: db.ownerUrl,
        languages: ['c'],
      });
      expect(onlyC.drained).toBe(true);
    } finally {
      vi.doUnmock('../../src/indexing/reextract.js');
      vi.resetModules();
    }
  });
});
