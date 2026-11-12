import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteBlobs, readContents } from '../../src/db/blobs.js';
import { listLanguages } from '../../src/indexer/registry.js';
import { reextractLanguage } from '../../src/indexing/reextract.js';
import { storeBlob, type StoredBlob } from '../../src/indexing/storeBlob.js';
import { queryRows, withClient } from '../helpers/db.js';
import { rowsReferencing } from '../helpers/rows.js';
import { asOperator, inBoundTransaction } from '../helpers/tenancy.js';
import { foundation, type Foundation } from './foundation.fixture.js';

// The integration gate over the per-blob layer: only the joins between the
// story's cards that a real Postgres can show, driven through the shipped
// doors (storeBlob, the two repositories, re-extraction) on a database built
// by the real bootstrap and migrations. What a single card's suite already
// pins is left there; the cases below each cross at least two cards.
//
// The cases share one database and run in order; the tenant delete is last.

const SAMPLE = new URL('../../fixtures/sample-tree/languages/', import.meta.url);
const sample = (path: string): Buffer => readFileSync(new URL(path, SAMPLE));

/** `git hash-object`: computed here, so a key that is not content-derived fails. */
function gitBlobHash(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

/** The same source under a header of its own, so its hash is new. */
function variant(bytes: Buffer, label: string, comment = '//'): Buffer {
  return Buffer.concat([Buffer.from(`${comment} ${label}\n`), bytes]);
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';

let f: Foundation;
let tenantA: string;
let tenantB: string;
let reader: string;
let app: pg.Client;
let owner: pg.Client;

beforeAll(async () => {
  f = await foundation();
  tenantA = f.fx.tenantA.id;
  tenantB = f.fx.tenantB.id;
  reader = f.fx.readerId;
  await asOperator(f.db.appUrl, f.fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
    reader,
    tenantB,
  ]);
  app = new pg.Client({ connectionString: f.db.appUrl });
  owner = new pg.Client({ connectionString: f.db.ownerUrl });
  await app.connect();
  await owner.connect();
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await f.db.drop();
});

function store(tenantId: string, path: string, bytes: Buffer, c: pg.ClientBase = app) {
  return storeBlob(c, { tenantId, clientId: reader, gitBlobHash: gitBlobHash(bytes), path, bytes });
}

interface Counts {
  blobs: number;
  contents: number;
  facts: number;
}

async function counts(tenantId: string, hash?: string): Promise<Counts> {
  const rows = await queryRows<Counts>(
    owner,
    `SELECT (SELECT count(*)::int FROM codegraph.blob WHERE tenant_id = $1 AND ($2::text IS NULL OR git_blob_hash = $2)) AS blobs,
            (SELECT count(*)::int FROM codegraph.blob_contents WHERE tenant_id = $1 AND ($2::text IS NULL OR git_blob_hash = $2)) AS contents,
            (SELECT count(*)::int FROM codegraph.blob_fact WHERE tenant_id = $1 AND ($2::text IS NULL OR git_blob_hash = $2)) AS facts`,
    [tenantId, hash ?? null],
  );
  return rows[0] as Counts;
}

/** Every row of the three tables, keyed but not filtered, in a stable order. */
async function tables(c: pg.Client, where = 'true', params: unknown[] = []) {
  return {
    blob: await queryRows(
      c,
      `SELECT * FROM codegraph.blob WHERE ${where} ORDER BY tenant_id, git_blob_hash`,
      params,
    ),
    contents: await queryRows(
      c,
      `SELECT tenant_id, git_blob_hash, md5(contents) AS digest FROM codegraph.blob_contents
        WHERE ${where} ORDER BY tenant_id, git_blob_hash`,
      params,
    ),
    facts: await queryRows(
      c,
      `SELECT * FROM codegraph.blob_fact WHERE ${where}
        ORDER BY tenant_id, git_blob_hash, producer, kind, name, start_line, start_column, parent_name`,
      params,
    ),
  };
}

const TS = sample('typescript/shapes.ts');
const TS_HASH = gitBlobHash(TS);

describe('one blob per tenant, whatever the repository', () => {
  it('stores the same bytes once for a tenant across two repositories’ paths', async () => {
    const [web, api] = f.fx.tenantA.repositories;
    const first = await store(tenantA, `${web?.name ?? ''}/src/shapes.ts`, TS);
    expect(first).toMatchObject({ outcome: 'indexed', alreadyStored: false });
    const once = await counts(tenantA, TS_HASH);
    expect(once.blobs).toBe(1);
    expect(once.contents).toBe(1);
    expect(once.facts).toBeGreaterThan(0);

    const second = await store(tenantA, `${api?.name ?? ''}/lib/shapes.ts`, TS);
    expect(second).toEqual({ ...first, alreadyStored: true });
    expect(await counts(tenantA)).toEqual(once);
  });

  it('gives the other tenant its own rows for the same hash, leaving the first’s alone', async () => {
    const before = await counts(tenantA);
    const stored = await store(tenantB, 'globex-core/shapes.ts', TS);
    expect(stored).toMatchObject({ outcome: 'indexed', alreadyStored: false });
    expect(await counts(tenantB, TS_HASH)).toEqual(before);
    expect(await counts(tenantA)).toEqual(before);
  });

  it('a session bound to one tenant reads exactly that tenant’s rows of all three tables', async () => {
    // One hash is held by both tenants, so an unscoped read would see more.
    const everything = await tables(owner);
    expect(everything.blob.filter((row) => row.git_blob_hash === TS_HASH)).toHaveLength(2);
    const bound = await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: reader, tenantId: tenantA }, () => tables(c)),
    );
    expect(bound).toEqual(await tables(owner, 'tenant_id = $1', [tenantA]));
    expect(bound.blob.length).toBeLessThan(everything.blob.length);
  });

  it('a session bound to one tenant cannot insert, change or delete the other’s rows', async () => {
    const before = await tables(owner);
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: reader, tenantId: tenantA }, async () => {
        const probe = async (sql: string, params: unknown[]) => {
          await c.query('SAVEPOINT probe');
          try {
            const result = await c.query(sql, params);
            await c.query('RELEASE SAVEPOINT probe');
            return { rows: result.rowCount };
          } catch (error) {
            await c.query('ROLLBACK TO SAVEPOINT probe');
            return { code: (error as { code?: string }).code };
          }
        };
        const other = gitBlobHash(Buffer.from('another tenant'));
        const attempts: (() => ReturnType<typeof probe>)[] = [
          () =>
            probe(
              `INSERT INTO codegraph.blob (tenant_id, git_blob_hash, size_bytes, outcome) VALUES ($1, $2, 1, 'binary')`,
              [tenantB, other],
            ),
          () => probe(`UPDATE codegraph.blob SET language = 'x' WHERE tenant_id = $1`, [tenantB]),
          () => probe('DELETE FROM codegraph.blob WHERE tenant_id = $1', [tenantB]),
          () =>
            probe(
              'INSERT INTO codegraph.blob_contents (tenant_id, git_blob_hash, contents) VALUES ($1, $2, $3)',
              [tenantB, TS_HASH, 'x'],
            ),
          () =>
            probe(`UPDATE codegraph.blob_contents SET contents = 'x' WHERE tenant_id = $1`, [
              tenantB,
            ]),
          () => probe('DELETE FROM codegraph.blob_contents WHERE tenant_id = $1', [tenantB]),
          () =>
            probe(
              `INSERT INTO codegraph.blob_fact (tenant_id, git_blob_hash, kind, language, producer, extractor_version, name, parent_name, relation)
             VALUES ($1, $2, 'inheritance', 'typescript', 'tree-sitter', 'v', 'A', 'B', 'extends')`,
              [tenantB, TS_HASH],
            ),
          () => probe(`UPDATE codegraph.blob_fact SET name = 'x' WHERE tenant_id = $1`, [tenantB]),
          () => probe('DELETE FROM codegraph.blob_fact WHERE tenant_id = $1', [tenantB]),
        ];
        const results = [];
        for (const attempt of attempts) results.push(await attempt());
        for (const result of results) {
          expect(
            result.code === INSUFFICIENT_PRIVILEGE || result.rows === 0,
            JSON.stringify(result),
          ).toBe(true);
        }
      }),
    );
    expect(await tables(owner)).toEqual(before);
  });
});

/** Polls until `c` waits on a lock it has not been granted. */
async function waitsOnLock(c: pg.Client): Promise<boolean> {
  const pid = (c as unknown as { processID: number }).processID;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await queryRows(owner, 'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [
      pid,
    ]);
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('two workers storing one blob at once', () => {
  it('leave one blob, one contents row and one fact set, and provably overlapped', async () => {
    const bytes = variant(sample('python/shapes.py'), 'concurrent', '#');
    const hash = gitBlobHash(bytes);
    const one = new pg.Client({ connectionString: f.db.appUrl });
    const two = new pg.Client({ connectionString: f.db.appUrl });
    await one.connect();
    await two.connect();
    let answers: StoredBlob[];
    let overlapped: boolean;
    try {
      // The first store is held just before its COMMIT, so the second runs
      // while the first transaction is still open; pg_locks shows it waiting.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedCommit: () => void = () => undefined;
      const atCommit = new Promise<void>((resolve) => {
        reachedCommit = resolve;
      });
      const held = {
        query(sql: string, params?: unknown[]) {
          if (sql === 'COMMIT') {
            reachedCommit();
            return gate.then(() => one.query(sql));
          }
          return one.query(sql, params);
        },
      } as unknown as pg.ClientBase;
      const first = store(tenantA, 'a/shapes.py', bytes, held);
      await atCommit;
      const second = store(tenantA, 'b/shapes.py', bytes, two);
      overlapped = await waitsOnLock(two);
      release();
      answers = await Promise.all([first, second]);
    } finally {
      await one.end();
      await two.end();
    }
    expect(overlapped, 'the two stores did not overlap').toBe(true);
    expect(answers.map((a) => a.outcome)).toEqual(['indexed', 'indexed']);
    expect(answers.map((a) => a.alreadyStored)).toEqual([false, true]);

    const rows = await counts(tenantA, hash);
    expect([rows.blobs, rows.contents]).toEqual([1, 1]);
    const duplicates = await queryRows(
      owner,
      `SELECT producer, kind, name, start_line, start_column, end_line, end_column, count(*)::int AS n
         FROM codegraph.blob_fact WHERE tenant_id = $1 AND git_blob_hash = $2
        GROUP BY 1, 2, 3, 4, 5, 6, 7 HAVING count(*) > 1`,
      [tenantA, hash],
    );
    expect(duplicates).toEqual([]);
    // One fact set: the same count a single store of the same source yields.
    const single = variant(sample('python/shapes.py'), 'single', '#');
    await store(tenantA, 'c/shapes.py', single);
    expect(rows.facts).toBe((await counts(tenantA, gitBlobHash(single))).facts);
  });
});

describe('contents stored by the entry point, read back by the repository', () => {
  it('round-trip a multi-byte payload above the TOAST threshold byte for byte, compressed', async () => {
    const lines: string[] = [];
    for (let n = 0; Buffer.byteLength(lines.join('')) < 16_384; n += 1) {
      lines.push(
        `// ünïcødé ✓ 漢字 — line ${String(n)}\nexport const value${String(n)} = '€${String(n)}';\n`,
      );
    }
    const bytes = Buffer.from(lines.join(''), 'utf8');
    expect(bytes.length).toBeGreaterThan(16_384);
    const stored = await store(tenantA, 'src/large.ts', bytes);
    expect(stored).toMatchObject({ outcome: 'indexed', lossy: false });

    const text = await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: reader, tenantId: tenantA }, () =>
        readContents(c, tenantA, gitBlobHash(bytes)),
      ),
    );
    expect(Buffer.from(text ?? '', 'utf8').equals(bytes)).toBe(true);

    // The column's declaration is pinned by the schema suite; this measures
    // that the stored value really is compressed.
    const size = await queryRows<{ stored: number; raw: number; compression: string | null }>(
      owner,
      `SELECT pg_column_size(contents) AS stored, octet_length(contents) AS raw,
              pg_column_compression(contents) AS compression
         FROM codegraph.blob_contents WHERE tenant_id = $1 AND git_blob_hash = $2`,
      [tenantA, gitBlobHash(bytes)],
    );
    expect(size[0]?.compression).toBe('lz4');
    expect(size[0]?.stored ?? Infinity).toBeLessThan(size[0]?.raw ?? 0);
  });
});

describe('re-extraction seen from another connection', () => {
  it('moves only the bumped language, and no reader sees old facts beside a new version', async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await store(tenantId, 'svc/shapes.py', sample('python/shapes.py'));
      await store(tenantId, 'svc/shapes.go', sample('go/shapes.go'));
    }
    const python = listLanguages().find((entry) => entry.language === 'python');
    if (python === undefined) throw new Error('the registry has no python entry');
    const bumped = `${python.grammarVersion}/q${String(Number(python.queryVersion) + 1)}`;
    const registry = listLanguages().map((entry) =>
      entry.language === 'python' ? { ...entry, extractorVersion: bumped } : entry,
    );
    const byLanguage = async (predicate: string) => ({
      blob: await queryRows(
        owner,
        `SELECT * FROM codegraph.blob WHERE language ${predicate} ORDER BY tenant_id, git_blob_hash`,
      ),
      facts: await queryRows(
        owner,
        `SELECT * FROM codegraph.blob_fact WHERE language ${predicate}
          ORDER BY tenant_id, git_blob_hash, producer, kind, name, start_line, start_column, parent_name`,
      ),
    });
    const others = () => byLanguage(`IS DISTINCT FROM 'python'`);
    const othersBefore = await others();
    const pythonBlobs = (await byLanguage(`= 'python'`)).blob.length;
    expect(pythonBlobs).toBeGreaterThanOrEqual(4);

    // A second connection reads each Python blob's version and its facts'
    // versions in one statement, over and over, while the sweep runs.
    const observer = new pg.Client({ connectionString: f.db.ownerUrl });
    await observer.connect();
    const torn: unknown[] = [];
    let reads = 0;
    const sweep = { running: true };
    const watch = (async () => {
      while (sweep.running) {
        const rows = await queryRows<{ version: string; fact_versions: string[] }>(
          observer,
          `SELECT b.extractor_version AS version,
                  array(SELECT DISTINCT bf.extractor_version FROM codegraph.blob_fact bf
                         WHERE bf.tenant_id = b.tenant_id AND bf.git_blob_hash = b.git_blob_hash) AS fact_versions
             FROM codegraph.blob b WHERE b.language = 'python'`,
        );
        reads += 1;
        torn.push(...rows.filter((r) => r.fact_versions.join() !== r.version));
      }
    })();
    try {
      const report = await reextractLanguage('python', {
        connectionString: f.db.ownerUrl,
        registry,
        batchSize: 1,
      });
      expect(report.blobCount).toBe(pythonBlobs);
    } finally {
      sweep.running = false;
      await watch;
      await observer.end();
    }
    expect(reads).toBeGreaterThan(0);
    expect(torn).toEqual([]);

    const after = await byLanguage(`= 'python'`);
    expect(after.blob.every((row) => row.extractor_version === bumped)).toBe(true);
    expect(after.facts.every((row) => row.extractor_version === bumped)).toBe(true);
    expect(await others()).toEqual(othersBefore);
  });
});

describe('the fact table’s own refusals', () => {
  const COLUMNS = [
    'kind',
    'language',
    'producer',
    'extractor_version',
    'name',
    'start_line',
    'start_column',
    'end_line',
    'end_column',
    'enclosing_name',
    'definition_kind',
    'reference_kind',
    'module_specifier',
    'imported_names',
    'parent_name',
    'relation',
  ] as const;
  type Row = Partial<Record<(typeof COLUMNS)[number], unknown>>;
  const stamp = { language: 'typescript', producer: 'constraint-probe', extractor_version: 'v1' };
  const range = { start_line: 1, start_column: 1, end_line: 1, end_column: 5 };
  const BASE: Record<string, Row> = {
    definition: { kind: 'definition', ...stamp, ...range, name: 'f', definition_kind: 'function' },
    reference: { kind: 'reference', ...stamp, ...range, name: 'g', reference_kind: 'call' },
    import: { kind: 'import', ...stamp, ...range, module_specifier: './m', imported_names: ['a'] },
    inheritance: {
      kind: 'inheritance',
      ...stamp,
      name: 'A',
      parent_name: 'B',
      relation: 'extends',
    },
  };
  const base = (kind: string): Row => ({ ...(BASE[kind] as Row) });

  /** Inserts the rows in order inside a savepoint that is always rolled back. */
  async function attempt(...rows: Row[]): Promise<string | null> {
    await owner.query('SAVEPOINT probe');
    try {
      for (const row of rows) {
        await owner.query(
          `INSERT INTO codegraph.blob_fact (tenant_id, git_blob_hash, ${COLUMNS.join(', ')})
           VALUES ($1, $2, ${COLUMNS.map((_, i) => `$${String(i + 3)}`).join(', ')})`,
          [tenantA, TS_HASH, ...COLUMNS.map((column) => row[column] ?? null)],
        );
      }
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await owner.query('ROLLBACK TO SAVEPOINT probe');
    }
  }

  beforeAll(async () => {
    await owner.query('BEGIN');
  });
  afterAll(async () => {
    await owner.query('ROLLBACK');
  });

  it('admits each of the four kinds, and refuses a fifth', async () => {
    for (const kind of Object.keys(BASE)) expect(await attempt(base(kind)), kind).toBeNull();
    expect(await attempt({ ...base('reference'), kind: 'call' })).toBe(CHECK_VIOLATION);
  });

  it.each<[string, Row]>([
    ['a definition without its kind', { ...base('definition'), definition_kind: null }],
    ['a definition without its name', { ...base('definition'), name: null }],
    [
      'a definition without its range',
      {
        ...base('definition'),
        start_line: null,
        start_column: null,
        end_line: null,
        end_column: null,
      },
    ],
    ['a definition carrying a reference kind', { ...base('definition'), reference_kind: 'call' }],
    ['a definition carrying a parent', { ...base('definition'), parent_name: 'B' }],
    ['a reference without its kind', { ...base('reference'), reference_kind: null }],
    ['a reference carrying a definition kind', { ...base('reference'), definition_kind: 'class' }],
    [
      'a reference without its range',
      {
        ...base('reference'),
        start_line: null,
        start_column: null,
        end_line: null,
        end_column: null,
      },
    ],
    ['an import without its module', { ...base('import'), module_specifier: null }],
    ['an import carrying a name', { ...base('import'), name: 'x' }],
    [
      'an import without its range',
      { ...base('import'), start_line: null, start_column: null, end_line: null, end_column: null },
    ],
    ['an inheritance without its parent', { ...base('inheritance'), parent_name: null }],
    ['an inheritance without its relation', { ...base('inheritance'), relation: null }],
    ['an inheritance carrying a module', { ...base('inheritance'), module_specifier: './m' }],
  ])('couples kind to columns: refuses %s', async (_label, row) => {
    expect(await attempt(row)).toBe(CHECK_VIOLATION);
  });

  it('admits an inheritance row with all four range columns or none', async () => {
    expect(await attempt({ ...base('inheritance'), ...range })).toBeNull();
    expect(await attempt(base('inheritance'))).toBeNull();
  });

  it.each<[string, Row]>([
    ['three of four range columns', { ...base('definition'), end_column: null }],
    ['a line below one', { ...base('definition'), start_line: 0 }],
    ['a column below one', { ...base('reference'), start_column: 0 }],
    [
      'a start after its end',
      { ...base('import'), start_line: 3, start_column: 1, end_line: 2, end_column: 9 },
    ],
    [
      'a partial range on an inheritance',
      { ...base('inheritance'), start_line: 1, start_column: 1 },
    ],
  ])('refuses a range with %s', async (_label, row) => {
    expect(await attempt(row)).toBe(CHECK_VIOLATION);
  });

  it('refuses a relation outside extends and implements', async () => {
    expect(await attempt({ ...base('inheritance'), relation: 'implements' })).toBeNull();
    expect(await attempt({ ...base('inheritance'), relation: 'mixes' })).toBe(CHECK_VIOLATION);
  });

  it.each<[string, Row]>([
    ['language', { ...base('definition'), language: '  ' }],
    ['producer', { ...base('definition'), producer: ' ' }],
    ['extractor_version', { ...base('definition'), extractor_version: '   ' }],
    ['name', { ...base('definition'), name: ' ' }],
    ['definition_kind', { ...base('definition'), definition_kind: ' ' }],
    ['reference_kind', { ...base('reference'), reference_kind: ' ' }],
    ['module_specifier', { ...base('import'), module_specifier: ' ' }],
    ['parent_name', { ...base('inheritance'), parent_name: ' ' }],
    ['enclosing_name', { ...base('definition'), enclosing_name: ' ' }],
  ])('refuses a whitespace-only %s', async (_label, row) => {
    expect(await attempt(row)).toBe(CHECK_VIOLATION);
  });

  it('refuses a second identical fact, absent columns included, and at a bumped version', async () => {
    expect(await attempt(base('definition'), base('definition'))).toBe(UNIQUE_VIOLATION);
    // The inheritance row leaves the range and three other columns NULL: the
    // key treats NULLs as equal, so a duplicate still cannot exist.
    expect(await attempt(base('inheritance'), base('inheritance'))).toBe(UNIQUE_VIOLATION);
    expect(
      await attempt(base('reference'), { ...base('reference'), extractor_version: 'v2' }),
    ).toBe(UNIQUE_VIOLATION);
    // imported_names is not part of the key: one import per specifier at one range.
    expect(await attempt(base('import'), { ...base('import'), imported_names: ['b'] })).toBe(
      UNIQUE_VIOLATION,
    );
    // The enclosing name is: the same definition inside another one is another fact.
    expect(
      await attempt(base('definition'), { ...base('definition'), enclosing_name: 'Outer' }),
    ).toBeNull();
    // The producer is part of the key: another producer's identical fact is admitted.
    expect(
      await attempt(base('reference'), { ...base('reference'), producer: 'other' }),
    ).toBeNull();
  });
});

describe('deletes', () => {
  it('delete-blobs removes only the bound tenant’s named blobs, across batches', async () => {
    const named: string[] = [];
    const kept: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      const bytes = variant(TS, `delete-${String(n)}`);
      await store(tenantA, `del/${String(n)}.ts`, bytes);
      (n < 3 ? named : kept).push(gitBlobHash(bytes));
    }
    // TS_HASH is held by both tenants; only A's copy is named for deletion.
    named.push(TS_HASH);
    const bBefore = await counts(tenantB, TS_HASH);
    const pool = new pg.Pool({ connectionString: f.db.appUrl, max: 2 });
    try {
      const result = await deleteBlobs(pool, { clientId: reader, tenantId: tenantA }, named, {
        batchSize: 2,
      });
      expect(result.batches.map((batch) => batch.length)).toEqual([2, 2]);
      expect(result.batches.flat().sort()).toEqual([...named].sort());
    } finally {
      await pool.end();
    }
    for (const hash of named) {
      expect(await counts(tenantA, hash), hash).toEqual({ blobs: 0, contents: 0, facts: 0 });
    }
    for (const hash of kept) {
      const left = await counts(tenantA, hash);
      expect([left.blobs, left.contents], hash).toEqual([1, 1]);
      expect(left.facts, hash).toBeGreaterThan(0);
    }
    expect(await counts(tenantB, TS_HASH)).toEqual(bBefore);
    expect(bBefore.blobs).toBe(1);
  });

  it('deleting a repository leaves the tenant’s blobs, which carry no repository', async () => {
    const before = await counts(tenantA);
    expect(before.blobs).toBeGreaterThan(0);
    const [web] = f.fx.tenantA.repositories;
    const removed = await owner.query('DELETE FROM codegraph.repositories WHERE id = $1', [
      web?.id,
    ]);
    expect(removed.rowCount).toBe(1);
    expect(await counts(tenantA)).toEqual(before);
  });

  it('deleting a tenant leaves no row with its id anywhere, and the other tenant whole', async () => {
    const otherBefore = await tables(owner, 'tenant_id = $1', [tenantB]);
    expect(otherBefore.blob.length).toBeGreaterThan(0);
    expect((await counts(tenantA)).blobs).toBeGreaterThan(0);
    await owner.query('DELETE FROM codegraph.tenants WHERE id = $1', [tenantA]);
    const left = await rowsReferencing(owner, 'tenant_id', tenantA);
    expect(Object.keys(left)).toEqual(
      expect.arrayContaining(['blob', 'blob_contents', 'blob_fact']),
    );
    expect(Object.values(left).every((n) => n === 0)).toBe(true);
    expect(await tables(owner, 'tenant_id = $1', [tenantB])).toEqual(otherBefore);
  });
});
