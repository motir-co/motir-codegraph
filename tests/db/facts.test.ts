import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_STALE_PAGE_SIZE,
  FACT_INSERT_CHUNK,
  factsForBlob,
  factToRow,
  findBlobsBelowExtractorVersion,
  insertFacts,
  replaceFactsForBlob,
  rowToFact,
  TenantBindingMismatchError,
  UnknownBlobFactsError,
  UnrecognizedFactKindError,
  type BlobKey,
  type BlobState,
  type StaleBlob,
  type StoredFact,
} from '../../src/db/facts.js';
import { TREE_SITTER_PRODUCER } from '../../src/extract/types.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { asOperator, buildTenancyFixture, inBoundTransaction } from '../helpers/tenancy.js';

// Every write runs as codegraph_app in a bound transaction, the way the store
// and the re-extraction sweep call this module; rows are checked as the owner.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const OTHER_PRODUCER = 'fixture-producer';
const V1 = '0.23.2/q1';
const V2 = '0.23.2/q2';

let db: FreshDatabase;
let owner: pg.Client;
let reader: string;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  db = await freshDatabase();
  const fixture = await buildTenancyFixture(db);
  tenantA = fixture.tenantA.id;
  tenantB = fixture.tenantB.id;
  reader = fixture.readerId;
  await asOperator(db.appUrl, fixture.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
    reader,
    tenantB,
  ]);
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await db.drop();
});

function hash(): string {
  return randomBytes(20).toString('hex');
}

function range(line: number, from: number, to: number) {
  return { startLine: line, startColumn: from, endLine: line, endColumn: to };
}

function stamp(producer = TREE_SITTER_PRODUCER, extractorVersion = V1, language = 'typescript') {
  return { language, producer, extractorVersion };
}

/** One fact of each kind, every optional field populated. */
function fourKinds(producer = TREE_SITTER_PRODUCER, extractorVersion = V1): StoredFact[] {
  const s = stamp(producer, extractorVersion);
  return [
    {
      ...s,
      kind: 'import',
      moduleSpecifier: './base',
      importedNames: ['Base', 'Helper'],
      range: range(1, 1, 40),
      enclosingName: null,
    },
    {
      ...s,
      kind: 'definition',
      name: 'Repo',
      definitionKind: 'class',
      range: { startLine: 3, startColumn: 1, endLine: 9, endColumn: 2 },
      enclosingName: null,
    },
    {
      ...s,
      kind: 'inheritance',
      name: 'Repo',
      parentName: 'Base',
      relation: 'implements',
      range: range(3, 20, 24),
      enclosingName: 'Repo',
    },
    {
      ...s,
      kind: 'reference',
      name: 'parse',
      referenceKind: 'call',
      range: range(5, 12, 21),
      enclosingName: 'load',
    },
  ];
}

/** `count` reference facts, distinct by position. */
function many(count: number, producer = TREE_SITTER_PRODUCER, name = 'call'): StoredFact[] {
  return Array.from({ length: count }, (_, index) => ({
    ...stamp(producer),
    kind: 'reference' as const,
    name,
    referenceKind: 'call',
    range: range(index + 1, 1, 5),
    enclosingName: null,
  }));
}

const STATE: BlobState = {
  extractorVersion: V2,
  parsedWithErrors: true,
  language: 'typescript',
  outcome: 'indexed',
};

interface BlobSeed {
  outcome?: 'indexed' | 'unsupported';
  language?: string;
  version?: string | null;
}

/** Blob rows, as the owner: the blob table's own writer is another module. */
async function seedBlobs(tenantId: string, count: number, seed: BlobSeed = {}): Promise<string[]> {
  const hashes = Array.from({ length: count }, () => hash());
  const outcome = seed.outcome ?? 'indexed';
  await owner.query(
    `INSERT INTO codegraph.blob
      (tenant_id, git_blob_hash, size_bytes, outcome, parsed_with_errors, lossy, language, extractor_version)
      SELECT $1, h, 10, $2, $3, false, $4, $5 FROM unnest($6::text[]) AS h`,
    [
      tenantId,
      outcome,
      outcome === 'indexed' ? false : null,
      seed.language ?? 'typescript',
      outcome === 'indexed' ? (seed.version ?? V1) : null,
      hashes,
    ],
  );
  return hashes;
}

async function seedBlob(tenantId: string, seed: BlobSeed = {}): Promise<BlobKey> {
  const [gitBlobHash] = await seedBlobs(tenantId, 1, seed);
  return { tenantId, gitBlobHash: gitBlobHash ?? '' };
}

/** Runs `fn` in a transaction bound to `tenantId`, on a new app connection, and commits. */
async function asTenant<T>(tenantId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return await withClient(db.appUrl, (c) =>
    inBoundTransaction(c, { clientId: reader, tenantId }, () => fn(c), { commit: true }),
  );
}

async function openBound(tenantId: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  await c.query('BEGIN');
  await c.query(BIND_TENANT_SQL, [reader, tenantId]);
  return c;
}

async function blobRow(blob: BlobKey): Promise<Record<string, unknown> | undefined> {
  const rows = await queryRows(
    owner,
    'SELECT * FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = $2',
    [blob.tenantId, blob.gitBlobHash],
  );
  return rows[0];
}

async function factCount(blob: BlobKey, producer?: string): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    owner,
    `SELECT count(*)::int AS n FROM codegraph.blob_fact
      WHERE tenant_id = $1 AND git_blob_hash = $2 AND ($3::text IS NULL OR producer = $3)`,
    [blob.tenantId, blob.gitBlobHash, producer ?? null],
  );
  return rows[0]?.n ?? -1;
}

/** A client wrapper recording every statement issued through it. */
function recording(c: pg.Client): { client: pg.ClientBase; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query(sql: string, params?: unknown[]) {
      statements.push(sql);
      return c.query(sql, params);
    },
  } as unknown as pg.ClientBase;
  return { client, statements };
}

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? 'unknown';
}

/** Runs `fn` inside a savepoint and rolls back to it, answering the SQLSTATE `fn` failed with. */
async function inSavepoint(c: pg.Client, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query('SAVEPOINT probe');
  try {
    await fn();
    await c.query('RELEASE SAVEPOINT probe');
    return null;
  } catch (error) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return errorCode(error);
  }
}

describe('the indexes', () => {
  it('are exactly the identity key and a tenant-leading name index, both fixed-size', async () => {
    const defs = await queryRows<{ indexname: string; indexdef: string }>(
      owner,
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'codegraph' AND tablename = 'blob_fact' ORDER BY indexname`,
    );
    expect(defs.map((d) => d.indexname)).toEqual(['blob_fact_identity_key', 'blob_fact_name_idx']);
    expect(defs[0]?.indexdef).toMatch(
      /^CREATE UNIQUE INDEX blob_fact_identity_key ON codegraph\.blob_fact USING btree \(tenant_id, git_blob_hash, producer, kind, .*md5\(.*\) NULLS NOT DISTINCT$/,
    );
    expect(defs[1]?.indexdef).toBe(
      'CREATE INDEX blob_fact_name_idx ON codegraph.blob_fact USING btree (tenant_id, md5(name), kind)',
    );
  });

  it('serves a lookup by a name of any length within a tenant from the name index', async () => {
    const blob = await seedBlob(tenantA);
    const longName = `f${randomBytes(2000).toString('hex')}`;
    const fact = { ...(fourKinds()[1] as StoredFact), name: longName } as StoredFact;
    await asTenant(tenantA, (c) => insertFacts(c, blob, [fact]));
    const lookup = `SELECT name FROM codegraph.blob_fact
      WHERE tenant_id = $1 AND md5(name) = md5($2) AND name = $2`;
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL enable_seqscan = off');
      const plan = await queryRows<{ 'QUERY PLAN': string }>(owner, `EXPLAIN ${lookup}`, [
        tenantA,
        longName,
      ]);
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('blob_fact_name_idx');
      const found = await queryRows<{ name: string }>(owner, lookup, [tenantA, longName]);
      expect(found).toEqual([{ name: longName }]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('the mapping', () => {
  it('round-trips all four kinds with their stamps', async () => {
    const blob = await seedBlob(tenantA);
    const facts = fourKinds();
    const back = await asTenant(tenantA, async (c) => {
      await insertFacts(c, blob, facts);
      return await factsForBlob(c, blob);
    });
    expect(back).toEqual(facts); // the fixture is already in the read order
  });

  it('writes no column of another kind, and names no repository, path or commit', () => {
    const rows = fourKinds().map(factToRow);
    expect(rows.map((r) => Object.keys(r).sort())).toEqual(
      rows.map(() =>
        [
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
        ].sort(),
      ),
    );
    expect(rows.map((r) => [r.kind, r.name, r.definition_kind, r.reference_kind])).toEqual([
      ['import', null, null, null],
      ['definition', 'Repo', 'class', null],
      ['inheritance', 'Repo', null, null],
      ['reference', 'parse', null, 'call'],
    ]);
  });

  it('stores the same facts under two blobs as equal rows apart from the blob key', async () => {
    const one = await seedBlob(tenantA);
    const two = await seedBlob(tenantA);
    await asTenant(tenantA, async (c) => {
      await insertFacts(c, one, fourKinds());
      await insertFacts(c, two, fourKinds());
    });
    const rowsOf = (blob: BlobKey) =>
      queryRows(
        owner,
        `SELECT * FROM codegraph.blob_fact WHERE tenant_id = $1 AND git_blob_hash = $2
          ORDER BY kind, start_line`,
        [blob.tenantId, blob.gitBlobHash],
      ).then((rows) =>
        rows.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'git_blob_hash')),
        ),
      );
    expect(await rowsOf(one)).toEqual(await rowsOf(two));
  });

  it('raises UnrecognizedFactKindError naming a kind it does not map', () => {
    const row = { ...factToRow(fourKinds()[1] as StoredFact), kind: 'macro' };
    expect(() => rowToFact(row)).toThrow(UnrecognizedFactKindError);
    expect(() => rowToFact(row)).toThrow(/"macro"/);
  });

  it('refuses a row that cannot be a member of the union rather than guessing', () => {
    const inheritance = factToRow(fourKinds()[2] as StoredFact);
    expect(() => rowToFact({ ...inheritance, start_line: null })).toThrow(/source range/);
    expect(() => rowToFact({ ...inheritance, parent_name: null })).toThrow(/parent_name/);
  });

  it('reads an import stored with no names list as an empty list', () => {
    const imported = factToRow(fourKinds()[0] as StoredFact);
    expect(rowToFact({ ...imported, imported_names: null })).toMatchObject({ importedNames: [] });
  });
});

describe('producers', () => {
  it('replaces one producer’s facts and leaves the other’s untouched', async () => {
    const blob = await seedBlob(tenantA);
    await asTenant(tenantA, async (c) => {
      await insertFacts(c, blob, fourKinds());
      await insertFacts(c, blob, fourKinds(OTHER_PRODUCER, 'fixture@7'));
    });
    const treeSitterBefore = await asTenant(tenantA, (c) =>
      factsForBlob(c, blob, TREE_SITTER_PRODUCER),
    );

    await asTenant(tenantA, (c) =>
      replaceFactsForBlob(c, blob, OTHER_PRODUCER, many(2, OTHER_PRODUCER), STATE),
    );
    expect(await asTenant(tenantA, (c) => factsForBlob(c, blob, TREE_SITTER_PRODUCER))).toEqual(
      treeSitterBefore,
    );
    expect(await factCount(blob, OTHER_PRODUCER)).toBe(2);

    await asTenant(tenantA, (c) =>
      replaceFactsForBlob(c, blob, TREE_SITTER_PRODUCER, many(3), STATE),
    );
    expect(await asTenant(tenantA, (c) => factsForBlob(c, blob, OTHER_PRODUCER))).toEqual(
      many(2, OTHER_PRODUCER),
    );
    expect(await factCount(blob, TREE_SITTER_PRODUCER)).toBe(3);
    // All producers, ordered by producer first.
    const all = await asTenant(tenantA, (c) => factsForBlob(c, blob));
    expect(all.map((f) => f.producer)).toEqual([
      ...Array<string>(2).fill(OTHER_PRODUCER),
      ...Array<string>(3).fill(TREE_SITTER_PRODUCER),
    ]);
  });

  it('refuses a replacement handed another producer’s fact, writing nothing', async () => {
    const blob = await seedBlob(tenantA);
    await expect(
      asTenant(tenantA, (c) =>
        replaceFactsForBlob(c, blob, TREE_SITTER_PRODUCER, many(1, OTHER_PRODUCER), STATE),
      ),
    ).rejects.toThrow(/produced by fixture-producer/);
    expect(await blobRow(blob)).toMatchObject({ extractor_version: V1 });
  });
});

describe('replaceFactsForBlob', () => {
  it('moves the facts and the recorded state together, and the blob leaves the page', async () => {
    const blob = await seedBlob(tenantA, { language: 'go' });
    await asTenant(tenantA, (c) => insertFacts(c, blob, many(2)));
    const state: BlobState = { ...STATE, language: 'go' };
    const { statements, page } = await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: reader, tenantId: tenantA },
        async () => {
          const rec = recording(c);
          await replaceFactsForBlob(rec.client, blob, TREE_SITTER_PRODUCER, many(4), state);
          return {
            statements: rec.statements,
            page: await findBlobsBelowExtractorVersion(c, tenantA, 'go', V2),
          };
        },
        { commit: true },
      ),
    );
    expect(page.blobs).toEqual([]);
    expect(await blobRow(blob)).toMatchObject({
      outcome: 'indexed',
      language: 'go',
      extractor_version: V2,
      parsed_with_errors: true,
      refused_cap_bytes: null,
    });
    expect(await factCount(blob)).toBe(4);
    // The lock is the no-op column UPDATE the app login's grant admits; the
    // module never begins, commits, rolls back or takes a locking SELECT.
    expect(statements[0]).toMatch(
      /^UPDATE codegraph\.blob SET extractor_version = extractor_version/,
    );
    expect(statements.join('\n')).not.toMatch(/FOR UPDATE|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/);
  });

  it('promotes an unsupported blob to indexed, and keeps an indexed one indexed', async () => {
    const unsupported = await seedBlob(tenantA, { outcome: 'unsupported', language: 'swift' });
    const indexed = await seedBlob(tenantA, { language: 'swift' });
    const state: BlobState = { ...STATE, language: 'swift' };
    await asTenant(tenantA, async (c) => {
      await replaceFactsForBlob(c, unsupported, TREE_SITTER_PRODUCER, many(1), state);
      await replaceFactsForBlob(c, indexed, TREE_SITTER_PRODUCER, many(1), state);
    });
    for (const blob of [unsupported, indexed]) {
      expect(await blobRow(blob)).toMatchObject({
        outcome: 'indexed',
        language: 'swift',
        extractor_version: V2,
      });
      expect(await factCount(blob)).toBe(1);
    }
  });

  it('commits nothing of its own: a refused insert inside a savepoint leaves everything as it was', async () => {
    const blob = await seedBlob(tenantA);
    await asTenant(tenantA, (c) => insertFacts(c, blob, fourKinds()));
    const before = {
      row: await blobRow(blob),
      facts: await asTenant(tenantA, (c) => factsForBlob(c, blob)),
    };
    const broken = [...many(2), { ...(many(1)[0] as StoredFact), name: '   ' }];

    const { state, statements } = await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: reader, tenantId: tenantA },
        async () => {
          const rec = recording(c);
          const code = await inSavepoint(c, () =>
            replaceFactsForBlob(rec.client, blob, TREE_SITTER_PRODUCER, broken, STATE),
          );
          return { state: code, statements: rec.statements };
        },
        { commit: true },
      ),
    );
    expect(state).toBe(CHECK_VIOLATION);
    expect(statements.join('\n')).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|SAVEPOINT/);
    expect(await blobRow(blob)).toEqual(before.row);
    expect(await asTenant(tenantA, (c) => factsForBlob(c, blob))).toEqual(before.facts);
  });

  it('raises UnknownBlobFactsError and writes nothing for a blob with no row', async () => {
    const missing = { tenantId: tenantA, gitBlobHash: hash() };
    const theirs = await seedBlob(tenantB);
    for (const blob of [missing, { tenantId: tenantA, gitBlobHash: theirs.gitBlobHash }]) {
      const error = await asTenant(tenantA, (c) =>
        replaceFactsForBlob(c, blob, TREE_SITTER_PRODUCER, many(1), STATE),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnknownBlobFactsError);
      expect(error).toMatchObject({ tenantId: tenantA, gitBlobHash: blob.gitBlobHash });
    }
    const rows = await queryRows<{ n: number }>(
      owner,
      'SELECT count(*)::int AS n FROM codegraph.blob_fact WHERE git_blob_hash = ANY($1)',
      [[missing.gitBlobHash, theirs.gitBlobHash]],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('serialises two interleaved replaces: the blob ends with exactly one whole set', async () => {
    const blob = await seedBlob(tenantA);
    await asTenant(tenantA, (c) => insertFacts(c, blob, many(3, TREE_SITTER_PRODUCER, 'old')));
    const first = await openBound(tenantA);
    const second = await openBound(tenantA);
    try {
      await replaceFactsForBlob(
        first,
        blob,
        TREE_SITTER_PRODUCER,
        many(2, TREE_SITTER_PRODUCER, 'one'),
        STATE,
      );
      const pending = replaceFactsForBlob(
        second,
        blob,
        TREE_SITTER_PRODUCER,
        many(5, TREE_SITTER_PRODUCER, 'two'),
        STATE,
      );
      // The second writer is held on the blob's row lock before it deletes.
      expect(await waitsOnLock(second)).toBe(true);
      await first.query('COMMIT');
      await pending;
      await second.query('COMMIT');
    } finally {
      await first.end();
      await second.end();
    }
    expectOneWholeSet(await asTenant(tenantA, (c) => factsForBlob(c, blob)));
  });

  it('serialises two replaces awaited together, whichever wins', async () => {
    const blob = await seedBlob(tenantA);
    const one = await openBound(tenantA);
    const two = await openBound(tenantA);
    try {
      const replace = async (c: pg.Client, facts: StoredFact[]) => {
        await replaceFactsForBlob(c, blob, TREE_SITTER_PRODUCER, facts, STATE);
        await c.query('COMMIT');
      };
      await Promise.all([
        replace(one, many(2, TREE_SITTER_PRODUCER, 'one')),
        replace(two, many(5, TREE_SITTER_PRODUCER, 'two')),
      ]);
    } finally {
      await one.end();
      await two.end();
    }
    expectOneWholeSet(await asTenant(tenantA, (c) => factsForBlob(c, blob)));
  });

  it('lands a set larger than one chunk in several statements, or none of it', async () => {
    const blob = await seedBlob(tenantA);
    const size = FACT_INSERT_CHUNK * 2 + 7;
    const { statements } = await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: reader, tenantId: tenantA },
        async () => {
          const rec = recording(c);
          await replaceFactsForBlob(rec.client, blob, TREE_SITTER_PRODUCER, many(size), STATE);
          return rec;
        },
        { commit: true },
      ),
    );
    expect(statements.filter((s) => s.startsWith('INSERT'))).toHaveLength(3);
    expect(await factCount(blob)).toBe(size);

    // The last chunk is refused: none of the new set is left, the old set is.
    const doomed = [
      ...many(size - 1, TREE_SITTER_PRODUCER, 'new'),
      { ...(many(1)[0] as StoredFact), name: ' ' },
    ];
    const state = await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: reader, tenantId: tenantA },
        () =>
          inSavepoint(c, () => replaceFactsForBlob(c, blob, TREE_SITTER_PRODUCER, doomed, STATE)),
        { commit: true },
      ),
    );
    expect(state).toBe(CHECK_VIOLATION);
    const after = await asTenant(tenantA, (c) => factsForBlob(c, blob));
    expect(after).toHaveLength(size);
    expect(after.every((f) => f.kind === 'reference' && f.name === 'call')).toBe(true);
  });
});

/** Both submitted sets are reference facts named 'one' (2) or 'two' (5). */
function expectOneWholeSet(facts: StoredFact[]): void {
  const names = new Set(facts.map((f) => (f.kind === 'import' ? '' : f.name)));
  expect(names.size).toBe(1);
  const [name] = [...names];
  expect(facts).toHaveLength(name === 'one' ? 2 : 5);
  expect(['one', 'two']).toContain(name);
}

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

describe('insertFacts', () => {
  it('raises on a second set for the same producer, leaving the first exactly as it was', async () => {
    const blob = await seedBlob(tenantA);
    await asTenant(tenantA, (c) => insertFacts(c, blob, fourKinds()));
    const state = await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: reader, tenantId: tenantA },
        () => inSavepoint(c, () => insertFacts(c, blob, fourKinds())),
        { commit: true },
      ),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
    expect(await asTenant(tenantA, (c) => factsForBlob(c, blob))).toEqual(fourKinds());
  });

  it('issues no statement for an empty set', async () => {
    const silent = {
      query: () => Promise.reject(new Error('unexpected')),
    } as unknown as pg.ClientBase;
    await expect(
      insertFacts(silent, { tenantId: tenantA, gitBlobHash: hash() }, []),
    ).resolves.toBeUndefined();
  });
});

describe('the binding checks', () => {
  it('factsForBlob raises for a tenant other than the bound one', async () => {
    const blob = await seedBlob(tenantB);
    const error = await asTenant(tenantA, (c) => factsForBlob(c, blob)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TenantBindingMismatchError);
    expect(error).toMatchObject({ requested: tenantB, bound: tenantA });
  });

  it('factsForBlob accepts the bound tenant written in upper case', async () => {
    const blob = await seedBlob(tenantA);
    await asTenant(tenantA, (c) => insertFacts(c, blob, many(1)));
    const back = await asTenant(tenantA, (c) =>
      factsForBlob(c, { ...blob, tenantId: tenantA.toUpperCase() }),
    );
    expect(back).toHaveLength(1);
  });

  it('the page raises for a null tenant on a bound session, and for another tenant', async () => {
    for (const tenantId of [null, tenantB]) {
      await expect(
        asTenant(tenantA, (c) => findBlobsBelowExtractorVersion(c, tenantId, 'typescript', V2)),
      ).rejects.toBeInstanceOf(TenantBindingMismatchError);
    }
  });

  it('the page raises for a named tenant on a session with none bound', async () => {
    await expect(
      findBlobsBelowExtractorVersion(owner, tenantA, 'typescript', V2),
    ).rejects.toBeInstanceOf(TenantBindingMismatchError);
  });
});

describe('findBlobsBelowExtractorVersion', () => {
  /** A language of its own per test, so earlier tests' blobs never land in a page. */
  function language(): string {
    return `lang_${randomBytes(4).toString('hex')}`;
  }

  async function seedStale(lang: string) {
    const a = {
      indexed: await seedBlobs(tenantA, 3, { language: lang, version: V1 }),
      unversioned: await seedBlobs(tenantA, 1, { outcome: 'unsupported', language: lang }),
      current: await seedBlobs(tenantA, 2, { language: lang, version: V2 }),
    };
    const b = {
      indexed: await seedBlobs(tenantB, 2, { language: lang, version: 'older' }),
      unversioned: await seedBlobs(tenantB, 1, { outcome: 'unsupported', language: lang }),
    };
    await seedBlobs(tenantA, 2, { language: `${lang}_other`, version: V1 });
    return { a, b };
  }

  const keyOf = (blob: StaleBlob) => `${blob.tenantId}/${blob.gitBlobHash}`;
  const sorted = (blobs: StaleBlob[]) =>
    [...blobs].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));

  it('pages one tenant’s stale blobs of one language, both kinds, in key order', async () => {
    const lang = language();
    const { a } = await seedStale(lang);
    const page = await asTenant(tenantA, (c) =>
      findBlobsBelowExtractorVersion(c, tenantA, lang, V2, 10),
    );
    const expected = sorted(
      [...a.indexed, ...a.unversioned].map((gitBlobHash) => ({ tenantId: tenantA, gitBlobHash })),
    );
    expect(page).toEqual({ blobs: expected, nextAfter: null });
  });

  it('pages every tenant on the owner login, each entry naming its own tenant', async () => {
    const lang = language();
    const { a, b } = await seedStale(lang);
    const scoped = await asTenant(tenantA, (c) =>
      findBlobsBelowExtractorVersion(c, tenantA, lang, V2, 100),
    );
    const everyone = await findBlobsBelowExtractorVersion(owner, null, lang, V2, 100);
    expect(everyone.blobs).toEqual(
      sorted([
        ...[...a.indexed, ...a.unversioned].map((gitBlobHash) => ({
          tenantId: tenantA,
          gitBlobHash,
        })),
        ...[...b.indexed, ...b.unversioned].map((gitBlobHash) => ({
          tenantId: tenantB,
          gitBlobHash,
        })),
      ]),
    );
    expect(everyone.blobs.length).toBeGreaterThan(scoped.blobs.length);
  });

  it('bounds a page, carries the pair cursor on a full page, and refuses a size below one', async () => {
    const lang = language();
    await seedStale(lang);
    const full = await findBlobsBelowExtractorVersion(owner, null, lang, V2, 3);
    expect(full.blobs).toHaveLength(3);
    expect(full.nextAfter).toEqual(full.blobs[2]);
    expect(Object.keys(full.nextAfter ?? {}).sort()).toEqual(['gitBlobHash', 'tenantId']);
    const short = await findBlobsBelowExtractorVersion(owner, null, lang, V2, 100);
    expect(short.nextAfter).toBeNull();
    for (const size of [0, -3, 2.5]) {
      await expect(findBlobsBelowExtractorVersion(owner, null, lang, V2, size)).rejects.toThrow(
        RangeError,
      );
    }
    expect(DEFAULT_STALE_PAGE_SIZE).toBeGreaterThan(0);
  });

  it('drains every stale blob exactly once while replacing, across the tenant boundary', async () => {
    const lang = language();
    const { a, b } = await seedStale(lang);
    const stale = new Set(
      [...a.indexed, ...a.unversioned, ...b.indexed, ...b.unversioned].map(String),
    );
    const seen: StaleBlob[] = [];
    let after: StaleBlob | null = null;
    let pages = 0;
    const state: BlobState = { ...STATE, language: lang };
    for (;;) {
      const page = await findBlobsBelowExtractorVersion(owner, null, lang, V2, 5, after);
      pages += 1;
      for (const blob of page.blobs) {
        seen.push(blob);
        const fact = { ...(many(1)[0] as StoredFact), language: lang };
        await replaceFactsForBlob(owner, blob, TREE_SITTER_PRODUCER, [fact], state);
      }
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    expect(seen.map((s) => s.gitBlobHash).sort()).toEqual([...stale].sort());
    expect(new Set(seen.map(keyOf)).size).toBe(seen.length);
    // Four and three stale blobs at five a page: whichever tenant sorts first,
    // the first page runs across the tenant boundary.
    expect(pages).toBe(2);
    expect((await findBlobsBelowExtractorVersion(owner, null, lang, V2)).blobs).toEqual([]);
  });

  it('answers an unbound app session nothing, rather than every tenant', async () => {
    const lang = language();
    await seedStale(lang);
    const page = await withClient(db.appUrl, (c) =>
      findBlobsBelowExtractorVersion(c, null, lang, V2),
    );
    expect(page).toEqual({ blobs: [], nextAfter: null });
  });
});
