import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  languageForPath,
  listLanguages,
  unavailableLanguages,
} from '../../src/indexer/registry.js';
import { queryRows, withClient } from '../helpers/db.js';
import { runScript, type CommandResult } from '../helpers/processes.js';
import { asOperator, inBoundTransaction } from '../helpers/tenancy.js';
import { foundation, type Foundation } from './foundation.fixture.js';

// The story's verification recipe as one journey over the bundled sample tree:
// every mode of `pnpm fixture:sample-tree` runs as a separate process, started
// the way its package.json script starts it, against one real database the
// suite bootstraps and drops. Each step asserts on the state the step before
// it left, so the cases run in order. Rows are read back with the journey's
// own SQL, bound exactly as a request binds; this story ships no read surface.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TREE = join(ROOT, 'fixtures/sample-tree');
const MANIFEST_PATH = join(ROOT, 'fixtures/sample-tree.manifest.json');

/** Each command loads every grammar on start, so a step is given room. */
const STEP_TIMEOUT_MS = 60_000;

interface ManifestEntry {
  path: string;
  language: string | null;
  outcome: 'indexed' | 'unsupported' | 'binary' | 'refused';
  parsedWithErrors: boolean | null;
  factKinds: string[];
  callReferenceKind: string | null;
  inheritance: { token: string; relation: string; name: string; parentName: string } | null;
}

const manifest = (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { fixtures: ManifestEntry[] })
  .fixtures;
const byPath = new Map(manifest.map((entry) => [entry.path, entry]));
const languageFixtures = manifest.filter((entry) => entry.path.startsWith('languages/'));
const TS_FIXTURE = 'languages/typescript/shapes.ts';
const REEXTRACTED = 'python';

/** Every file under the tree, `/`-separated and sorted as the command sorts. */
function walk(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => statSync(join(root, entry)).isFile())
    .map((entry) => entry.split(sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const treeFiles = walk(TREE);

let f: Foundation;
let tenantA: string;
let tenantB: string;
let reader: string;
let stranger: string;
let repoA1: string;
let repoA2: string;
let repoB: string;
let copy: string | undefined;

beforeAll(async () => {
  f = await foundation();
  tenantA = f.fx.tenantA.id;
  tenantB = f.fx.tenantB.id;
  reader = f.fx.readerId;
  repoA1 = f.fx.tenantA.repositories[0]?.id ?? '';
  repoA2 = f.fx.tenantA.repositories[1]?.id ?? '';
  repoB = f.fx.tenantB.repositories[0]?.id ?? '';
  // The fixture grants the reader tenant A only; the journey stores for B too.
  await asOperator(f.db.appUrl, f.fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
    reader,
    tenantB,
  ]);
  stranger = (await asOperator<string>(
    f.db.appUrl,
    f.fx.operatorId,
    'codegraph.codegraph_create_client($1, $2)',
    ['stranger', 'client'],
  )) as string;
}, STEP_TIMEOUT_MS);

afterAll(async () => {
  if (copy !== undefined) rmSync(copy, { recursive: true, force: true });
  await f.db.drop();
});

const appEnv = (): NodeJS.ProcessEnv => ({ DATABASE_APP_URL: f.db.appUrl });

function sampleTree(args: string[], env: NodeJS.ProcessEnv = appEnv()): Promise<CommandResult> {
  return runScript('fixture:sample-tree', env, args);
}

function succeeded(result: CommandResult): string[] {
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.split('\n').filter((line) => line !== '');
}

interface StoreLine {
  path: string;
  hash: string;
  outcome: string;
  fields: Record<string, string>;
}

function parseStoreLine(line: string): StoreLine {
  const [path = '', hash = '', outcome = '', ...rest] = line.split(' ');
  const fields = Object.fromEntries(
    rest.map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
  return { path, hash, outcome, fields };
}

/** The store mode's lines, split into the per-file lines and the summary. */
function storeOutput(result: CommandResult): {
  files: StoreLine[];
  summary: Record<string, string>;
} {
  const lines = succeeded(result);
  const summaryLine = lines.at(-1) ?? '';
  expect(summaryLine.startsWith('summary ')).toBe(true);
  return {
    files: lines.slice(0, -1).map(parseStoreLine),
    summary: parseStoreLine(`- - ${summaryLine}`).fields,
  };
}

interface Counts {
  blobs: number;
  contents: number;
  facts: number;
}

/** What a session bound to `tenantId` sees, as `codegraph_app`. */
async function boundCounts(tenantId: string): Promise<Counts> {
  return await withClient(f.db.appUrl, (c) =>
    inBoundTransaction(c, { clientId: reader, tenantId }, async () => {
      const rows = await queryRows<{ blobs: number; contents: number; facts: number }>(
        c,
        `SELECT (SELECT count(*)::int FROM codegraph.blob) AS blobs,
                (SELECT count(*)::int FROM codegraph.blob_contents) AS contents,
                (SELECT count(*)::int FROM codegraph.blob_fact) AS facts`,
      );
      return rows[0] as Counts;
    }),
  );
}

/** Every row of `tenantId`, as the owner sees them regardless of binding. */
async function ownerCounts(tenantId: string): Promise<Counts> {
  return await withClient(f.db.ownerUrl, async (c) => {
    const rows = await queryRows<{ blobs: number; contents: number; facts: number }>(
      c,
      `SELECT (SELECT count(*)::int FROM codegraph.blob WHERE tenant_id = $1) AS blobs,
              (SELECT count(*)::int FROM codegraph.blob_contents WHERE tenant_id = $1) AS contents,
              (SELECT count(*)::int FROM codegraph.blob_fact WHERE tenant_id = $1) AS facts`,
      [tenantId],
    );
    return rows[0] as Counts;
  });
}

interface FactRow {
  kind: string;
  name: string | null;
  start_line: number | null;
  end_line: number | null;
  language: string;
  producer: string;
  extractor_version: string;
  definition_kind: string | null;
  reference_kind: string | null;
  module_specifier: string | null;
  relation: string | null;
  parent_name: string | null;
}

/** One blob's fact rows, read in a session bound to `tenantId`. */
async function factsOf(tenantId: string, hash: string): Promise<FactRow[]> {
  return await withClient(f.db.appUrl, (c) =>
    inBoundTransaction(c, { clientId: reader, tenantId }, () =>
      queryRows<FactRow>(
        c,
        `SELECT kind, name, start_line, end_line, language, producer, extractor_version,
                definition_kind, reference_kind, module_specifier, relation, parent_name
           FROM codegraph.blob_fact WHERE git_blob_hash = $1`,
        [hash],
      ),
    ),
  );
}

/** The hash of each file of tenant A's first store, by path. */
const hashes = new Map<string, string>();
let firstCounts: Counts;

describe('the sample tree, through the shipped library and its fixture command', () => {
  it(
    'step 1: a second migrate applies nothing, and the three tables exist',
    async () => {
      const result = await runScript('db:migrate', { DATABASE_URL: f.db.ownerUrl });
      expect(succeeded(result)).toEqual(['nothing to apply (6 already applied)']);
      const tables = await withClient(f.db.ownerUrl, (c) =>
        queryRows<{ name: string; present: boolean }>(
          c,
          `SELECT name, to_regclass(name) IS NOT NULL AS present
           FROM unnest(ARRAY['codegraph.blob', 'codegraph.blob_contents', 'codegraph.blob_fact']) AS name`,
        ),
      );
      expect(tables).toEqual([
        { name: 'codegraph.blob', present: true },
        { name: 'codegraph.blob_contents', present: true },
        { name: 'codegraph.blob_fact', present: true },
      ]);
    },
    STEP_TIMEOUT_MS,
  );

  it('the fixture set matches the registry: one per registered entry, one per grammar-less language', () => {
    // Coverage is read from the files on disk, by what the registry resolves
    // each one to, so a missing fixture is named by its language.
    const registered = listLanguages().map((entry) => entry.language);
    const onDisk = treeFiles
      .filter((path) => path.startsWith('languages/'))
      .map((path) => languageForPath(path)?.language ?? null);
    const absent = registered.filter((id) => !onDisk.includes(id));
    expect(absent, `registered entries with no fixture: ${absent.join(', ')}`).toEqual([]);

    // The manifest lists exactly the files on disk.
    expect(manifest.map((e) => e.path).sort()).toEqual(treeFiles);

    const covered = languageFixtures.map((e) => e.language);
    const missing = registered.filter((id) => !covered.includes(id));
    expect(missing, `registered entries with no fixture: ${missing.join(', ')}`).toEqual([]);
    const unserved = covered.filter((id) => id === null || !registered.includes(id));
    expect(unserved, `fixtures naming a language the registry does not serve`).toEqual([]);
    expect(covered).toHaveLength(registered.length);
    // Each file resolves through the registry to the language it declares.
    for (const entry of languageFixtures) {
      expect(languageForPath(entry.path)?.language, entry.path).toBe(entry.language);
    }

    const grammarless = unavailableLanguages().map((record) => record.id);
    const unsupported = manifest.filter((e) => e.path.startsWith('unsupported/'));
    const unsupportedLanguages = unsupported.map((e) => e.language).filter((id) => id !== null);
    const uncovered = grammarless.filter((id) => !unsupportedLanguages.includes(id));
    expect(uncovered, `grammar-less languages with no fixture: ${uncovered.join(', ')}`).toEqual(
      [],
    );
    expect(unsupportedLanguages).toHaveLength(grammarless.length);
    // Plus one plain file that maps to no language at all.
    expect(unsupported.filter((e) => e.language === null)).toHaveLength(1);

    for (const directory of ['syntax-error/', 'binary/', 'over-cap/']) {
      expect(
        manifest.filter((e) => e.path.startsWith(directory)),
        directory,
      ).toHaveLength(1);
    }
  });

  it(
    'a client with no grant on the tenant is refused before anything is written',
    async () => {
      const before = await ownerCounts(tenantA);
      const result = await sampleTree([
        'store',
        '--tenant',
        tenantA,
        '--client',
        stranger,
        '--repository',
        repoA1,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`Cannot bind tenant ${tenantA} for client ${stranger}`);
      expect(result.stdout).toBe('');
      expect(await ownerCounts(tenantA)).toEqual(before);
      expect(before).toEqual({ blobs: 0, contents: 0, facts: 0 });
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'step 2: tenant A stores the tree — one line per file in sorted order, then its counts',
    async () => {
      const { files, summary } = storeOutput(
        await sampleTree([
          'store',
          '--tenant',
          tenantA,
          '--client',
          reader,
          '--repository',
          repoA1,
        ]),
      );
      expect(files.map((line) => line.path)).toEqual(treeFiles);
      for (const line of files) {
        const entry = byPath.get(line.path);
        expect(line.outcome, line.path).toBe(entry?.outcome);
        expect(line.hash, line.path).toMatch(/^[0-9a-f]{40}$/);
        expect(line.fields.already, line.path).toBe('false');
        expect(Number(line.fields.size), line.path).toBe(statSync(join(TREE, line.path)).size);
        hashes.set(line.path, line.hash);
      }
      firstCounts = await boundCounts(tenantA);
      expect(summary).toMatchObject({
        tenant: tenantA,
        repository: repoA1,
        files: String(treeFiles.length),
        blobs: String(firstCounts.blobs),
        contents: String(firstCounts.contents),
        facts: String(firstCounts.facts),
      });
      expect(firstCounts.blobs).toBe(treeFiles.length);

      // The syntax-error file is indexed, flagged, and still yields a definition.
      const broken = files.find((line) => line.path === 'syntax-error/broken.ts');
      expect(broken?.outcome).toBe('indexed');
      expect(broken?.fields.parsedWithErrors).toBe('true');
      const recovered = (await factsOf(tenantA, broken?.hash ?? '')).filter(
        (fact) => fact.kind === 'definition',
      );
      expect(recovered.length).toBeGreaterThan(0);
      expect(recovered.every((fact) => fact.name !== null && fact.start_line !== null)).toBe(true);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'every language fixture yields a definition, a call and an import, and its inheritance',
    async () => {
      for (const entry of languageFixtures) {
        const facts = await factsOf(tenantA, hashes.get(entry.path) ?? '');
        const kinds = new Set(facts.map((fact) => fact.kind));
        expect(kinds.has('definition'), entry.path).toBe(true);
        expect(kinds.has('import'), entry.path).toBe(true);
        const query = languageForPath(entry.path)?.query ?? '';
        if (entry.callReferenceKind === null) {
          // Only a language whose tags query captures no call may be excused.
          expect(query, `${entry.path} excused from calls`).not.toMatch(
            /@reference\.(call|send)\b/,
          );
        } else {
          expect(
            facts.some(
              (fact) =>
                fact.kind === 'reference' && fact.reference_kind === entry.callReferenceKind,
            ),
            `${entry.path} call`,
          ).toBe(true);
        }
        if (entry.inheritance !== null) {
          const { token, relation, name, parentName } = entry.inheritance;
          expect(readFileSync(join(TREE, entry.path), 'utf8'), entry.path).toContain(token);
          expect(facts, `${entry.path} inheritance`).toContainEqual(
            expect.objectContaining({
              kind: 'inheritance',
              name,
              relation,
              parent_name: parentName,
            }),
          );
        }
        for (const kind of entry.factKinds)
          expect(kinds.has(kind), `${entry.path} ${kind}`).toBe(true);
      }
    },
    STEP_TIMEOUT_MS,
  );

  it('the outcomes other than indexed store exactly what they allow', async () => {
    const rows = await withClient(f.db.ownerUrl, (c) =>
      queryRows<{
        hash: string;
        outcome: string;
        size_bytes: number;
        refused_cap_bytes: number | null;
        language: string | null;
        has_contents: boolean;
        facts: number;
      }>(
        c,
        `SELECT b.git_blob_hash AS hash, b.outcome, b.size_bytes, b.refused_cap_bytes, b.language,
                EXISTS (SELECT 1 FROM codegraph.blob_contents bc
                         WHERE bc.tenant_id = b.tenant_id AND bc.git_blob_hash = b.git_blob_hash)
                  AS has_contents,
                (SELECT count(*)::int FROM codegraph.blob_fact bf
                  WHERE bf.tenant_id = b.tenant_id AND bf.git_blob_hash = b.git_blob_hash) AS facts
           FROM codegraph.blob b WHERE b.tenant_id = $1`,
        [tenantA],
      ),
    );
    const row = (path: string) => rows.find((r) => r.hash === hashes.get(path));
    for (const entry of manifest.filter((e) => e.outcome !== 'indexed')) {
      const stored = row(entry.path);
      const size = statSync(join(TREE, entry.path)).size;
      expect(stored?.outcome, entry.path).toBe(entry.outcome);
      expect(stored?.size_bytes, entry.path).toBe(size);
      expect(stored?.facts, entry.path).toBe(0);
      expect(stored?.has_contents, entry.path).toBe(entry.outcome === 'unsupported');
      expect(stored?.language ?? null, entry.path).toBe(entry.language);
      if (entry.outcome === 'refused') {
        expect(stored?.refused_cap_bytes).toBe(1_048_576);
        expect(size).toBe(1_048_577);
      } else {
        expect(stored?.refused_cap_bytes, entry.path).toBeNull();
      }
    }
  });

  it(
    'step 3: tenant A re-stores the tree under its second repository and nothing changes',
    async () => {
      const { files, summary } = storeOutput(
        await sampleTree([
          'store',
          '--tenant',
          tenantA,
          '--client',
          reader,
          '--repository',
          repoA2,
        ]),
      );
      expect(files.map((line) => line.path)).toEqual(treeFiles);
      for (const line of files) {
        expect(line.fields.already, line.path).toBe('true');
        expect(line.outcome, line.path).toBe(byPath.get(line.path)?.outcome);
        expect(line.hash, line.path).toBe(hashes.get(line.path));
      }
      expect(summary.repository).toBe(repoA2);
      expect(await boundCounts(tenantA)).toEqual(firstCounts);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'step 4: tenant B stores the tree from a copy; each tenant sees its own rows only',
    async () => {
      copy = mkdtempSync(join(tmpdir(), 'codegraph-sample-tree-'));
      cpSync(TREE, copy, { recursive: true });
      const { files } = storeOutput(
        await sampleTree([
          'store',
          '--tenant',
          tenantB,
          '--client',
          reader,
          '--repository',
          repoB,
          '--tree',
          copy,
        ]),
      );
      expect(files.every((line) => line.fields.already === 'false')).toBe(true);
      expect(files.map((line) => line.hash)).toEqual(treeFiles.map((path) => hashes.get(path)));
      expect(await boundCounts(tenantB)).toEqual(firstCounts);
      expect(await ownerCounts(tenantB)).toEqual(firstCounts);

      // The same hashes are two tenants' rows, each visible only under its own binding.
      const seen = async (tenantId: string) =>
        withClient(f.db.appUrl, (c) =>
          inBoundTransaction(c, { clientId: reader, tenantId }, () =>
            queryRows<{ tenant_id: string }>(c, 'SELECT DISTINCT tenant_id FROM codegraph.blob'),
          ),
        );
      expect(await seen(tenantA)).toEqual([{ tenant_id: tenantA }]);
      expect(await seen(tenantB)).toEqual([{ tenant_id: tenantB }]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'step 5: one TypeScript fixture’s facts read back with names, kinds, ranges and their stamp',
    async () => {
      const lines = succeeded(
        await sampleTree(['show', '--tenant', tenantA, '--client', reader, '--path', TS_FIXTURE]),
      );
      const version = languageForPath(TS_FIXTURE)?.extractorVersion ?? '';
      expect(lines[0]).toBe(
        `${TS_FIXTURE} ${hashes.get(TS_FIXTURE) ?? ''} indexed size=${String(statSync(join(TREE, TS_FIXTURE)).size)} ` +
          `parsedWithErrors=false lossy=false refusedCapBytes=- language=typescript extractorVersion=${version}`,
      );
      const facts = lines.filter((line) => line.startsWith('fact '));
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) {
        expect(fact).toContain(
          ` language=typescript producer=tree-sitter extractorVersion=${version}`,
        );
      }
      expect(facts).toContainEqual(
        expect.stringMatching(
          /^fact definition name=Circle range=\d+:\d+-\d+:\d+ definitionKind=class /,
        ),
      );
      expect(facts).toContainEqual(
        expect.stringMatching(
          /^fact definition name=area range=\d+:\d+-\d+:\d+ definitionKind=method /,
        ),
      );
      // Calls and imports carry the plain name as written, never a resolved target.
      expect(facts).toContainEqual(
        expect.stringMatching(/^fact reference name=square range=\S+ referenceKind=call /),
      );
      expect(facts).toContainEqual(
        expect.stringMatching(/^fact import name=- range=\S+ module=\.\/shape names=Shape /),
      );

      // The same rows, read directly, are stamped the same way.
      const rows = await factsOf(tenantA, hashes.get(TS_FIXTURE) ?? '');
      expect(rows.length).toBe(facts.length);
      expect(
        rows.every(
          (r) =>
            r.producer === 'tree-sitter' &&
            r.language === 'typescript' &&
            r.extractor_version === version,
        ),
      ).toBe(true);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'step 6: its contents read back byte for byte, from an lz4 column behind a trigram index',
    async () => {
      const bytes = readFileSync(join(TREE, TS_FIXTURE));
      const result = await sampleTree([
        'show',
        '--tenant',
        tenantA,
        '--client',
        reader,
        '--path',
        TS_FIXTURE,
      ]);
      expect(result.code, result.stderr).toBe(0);
      const marker = '\ncontents:\n';
      const printed = result.stdout.slice(result.stdout.indexOf(marker) + marker.length);
      expect(Buffer.from(printed, 'utf8').equals(bytes)).toBe(true);

      const stored = await withClient(f.db.appUrl, (c) =>
        inBoundTransaction(c, { clientId: reader, tenantId: tenantA }, () =>
          queryRows<{ contents: string }>(
            c,
            'SELECT contents FROM codegraph.blob_contents WHERE git_blob_hash = $1',
            [hashes.get(TS_FIXTURE)],
          ),
        ),
      );
      expect(Buffer.from(stored[0]?.contents ?? '', 'utf8').equals(bytes)).toBe(true);

      const column = await withClient(f.db.ownerUrl, (c) =>
        queryRows<{ type: string; compression: string }>(
          c,
          `SELECT format_type(atttypid, atttypmod) AS type, attcompression::text AS compression
           FROM pg_attribute
          WHERE attrelid = 'codegraph.blob_contents'::regclass AND attname = 'contents'`,
        ),
      );
      expect(column).toEqual([{ type: 'text', compression: 'l' }]);
      const index = await withClient(f.db.ownerUrl, (c) =>
        queryRows<{ method: string; opclass: string }>(
          c,
          `SELECT am.amname AS method, oc.opcname AS opclass
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_am am ON am.oid = ic.relam
           JOIN pg_opclass oc ON oc.oid = i.indclass[0]
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = 'codegraph.blob_contents'::regclass AND a.attname = 'contents'`,
        ),
      );
      expect(index).toEqual([{ method: 'gin', opclass: 'gin_trgm_ops' }]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'step 7: one language re-extracted from stored contents, with the source copy gone',
    async () => {
      rmSync(copy ?? '', { recursive: true, force: true });
      const current = listLanguages().find((e) => e.language === REEXTRACTED)?.extractorVersion;
      expect(current).toBeDefined();
      const ownerEnv = { DATABASE_URL: f.db.ownerUrl };

      // The re-extract mode refuses any login but the owner, and writes nothing.
      const refused = await sampleTree(['reextract', '--language', REEXTRACTED], {
        DATABASE_URL: f.db.appUrl,
      });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('must run as codegraph_owner');
      expect(refused.stderr).toContain('not as codegraph_app');

      // A grammar bump, as the store sees it: this language's blobs and facts
      // now carry a version that is not the registry's current one.
      const others = async () =>
        withClient(f.db.ownerUrl, (c) =>
          queryRows(
            c,
            `SELECT b.tenant_id, b.git_blob_hash, b.extractor_version,
                  (SELECT array_agg(bf.kind || ':' || coalesce(bf.name, '') || ':' || bf.extractor_version
                                    ORDER BY bf.kind, bf.name, bf.start_line, bf.start_column)
                     FROM codegraph.blob_fact bf
                    WHERE bf.tenant_id = b.tenant_id AND bf.git_blob_hash = b.git_blob_hash) AS facts
             FROM codegraph.blob b
            WHERE b.language IS DISTINCT FROM $1
            ORDER BY b.tenant_id, b.git_blob_hash`,
            [REEXTRACTED],
          ),
        );
      const factsBefore = { a: await ownerCounts(tenantA), b: await ownerCounts(tenantB) };
      await withClient(f.db.ownerUrl, async (c) => {
        await c.query(
          `UPDATE codegraph.blob SET extractor_version = '0.0.0/q0'
          WHERE language = $1 AND outcome = 'indexed'`,
          [REEXTRACTED],
        );
        await c.query(
          `UPDATE codegraph.blob_fact SET extractor_version = '0.0.0/q0' WHERE language = $1`,
          [REEXTRACTED],
        );
      });
      const othersBefore = await others();
      const stale = await withClient(f.db.ownerUrl, (c) =>
        queryRows<{ tenant_id: string; hash: string }>(
          c,
          `SELECT tenant_id, git_blob_hash AS hash FROM codegraph.blob
          WHERE language = $1 AND extractor_version = '0.0.0/q0' ORDER BY tenant_id, git_blob_hash`,
          [REEXTRACTED],
        ),
      );
      expect(stale).toHaveLength(2);

      const lines = succeeded(await sampleTree(['reextract', '--language', REEXTRACTED], ownerEnv));
      const moved = lines.filter((line) => line.startsWith('batch '));
      expect(moved).toHaveLength(2);
      for (const { tenant_id, hash } of stale) {
        expect(moved).toContainEqual(
          expect.stringMatching(new RegExp(`^batch 1 tenant=${tenant_id} ${hash} facts=\\d+$`)),
        );
      }
      expect(lines.at(-1)).toMatch(
        new RegExp(
          `^reextract ${REEXTRACTED} to ${(current ?? '').replace(/[.]/g, '\\.')}: batches=1 blobs=2 facts=\\d+$`,
        ),
      );

      const after = await withClient(f.db.ownerUrl, (c) =>
        queryRows<{ blob_version: string; fact_versions: string[] }>(
          c,
          `SELECT b.extractor_version AS blob_version,
                array(SELECT DISTINCT bf.extractor_version FROM codegraph.blob_fact bf
                       WHERE bf.tenant_id = b.tenant_id AND bf.git_blob_hash = b.git_blob_hash) AS fact_versions
           FROM codegraph.blob b WHERE b.language = $1`,
          [REEXTRACTED],
        ),
      );
      expect(after).toEqual([
        { blob_version: current, fact_versions: [current] },
        { blob_version: current, fact_versions: [current] },
      ]);
      // Rebuilt, not merely restamped: the same facts, and every other language untouched.
      expect({ a: await ownerCounts(tenantA), b: await ownerCounts(tenantB) }).toEqual(factsBefore);
      expect(await others()).toEqual(othersBefore);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'step 8: bound to B, deleting A removes nothing and deleting B removes all of B',
    async () => {
      const a = await ownerCounts(tenantA);
      const b = await ownerCounts(tenantB);
      const deleteAs = (target: string) =>
        withClient(f.db.appUrl, (c) =>
          inBoundTransaction(
            c,
            { clientId: reader, tenantId: tenantB },
            async () =>
              (await c.query('DELETE FROM codegraph.tenants WHERE id = $1', [target])).rowCount,
            { commit: true },
          ),
        );
      expect(await deleteAs(tenantA)).toBe(0);
      expect(await ownerCounts(tenantA)).toEqual(a);
      expect(await ownerCounts(tenantB)).toEqual(b);

      expect(await deleteAs(tenantB)).toBe(1);
      expect(await ownerCounts(tenantB)).toEqual({ blobs: 0, contents: 0, facts: 0 });
      expect(await ownerCounts(tenantA)).toEqual(a);
    },
    STEP_TIMEOUT_MS,
  );
});
