import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PER_FILE_CAP_BYTES } from '../../src/config.js';
import { TREE_SITTER_PRODUCER } from '../../src/extract/types.js';
import { languageForPath } from '../../src/indexer/registry.js';
import {
  BINARY_SNIFF_BYTES,
  BlobBytesMismatchError,
  classify,
  decode,
  storeBlob,
  type StoreBlobInput,
  type StoredBlob,
} from '../../src/indexing/storeBlob.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { recordQueries } from '../helpers/queryLog.js';
import { asOperator, buildTenancyFixture, inBoundTransaction } from '../helpers/tenancy.js';

// storeBlob runs as codegraph_app on a connection the test holds, exactly as a
// worker will; every row is read back as codegraph_owner, so the assertions see
// what was written rather than what was reported.

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../extract/fixtures/${name}`, import.meta.url));
const CLEAN = fixture('clean.ts.txt');
const BROKEN = fixture('broken.ts.txt');
const TS_VERSION = languageForPath('x.ts')?.extractorVersion;

let db: FreshDatabase;
let owner: pg.Client;
let app: pg.Client;
let reader: string;
let stranger: string;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  db = await freshDatabase();
  const tenancy = await buildTenancyFixture(db);
  tenantA = tenancy.tenantA.id;
  tenantB = tenancy.tenantB.id;
  reader = tenancy.readerId;
  await asOperator(db.appUrl, tenancy.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
    reader,
    tenantB,
  ]);
  stranger = (await asOperator<string>(
    db.appUrl,
    tenancy.operatorId,
    'codegraph.codegraph_create_client($1, $2)',
    ['stranger', 'client'],
  )) as string;
  owner = new pg.Client({ connectionString: db.ownerUrl });
  app = new pg.Client({ connectionString: db.appUrl });
  await owner.connect();
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

function hash(): string {
  return randomBytes(20).toString('hex');
}

function input(bytes: Uint8Array, path = 'src/repo.ts', tenantId = tenantA): StoreBlobInput {
  return { tenantId, clientId: reader, gitBlobHash: hash(), path, bytes };
}

interface Rows {
  blob: Record<string, unknown>[];
  contents: string[];
  facts: Record<string, unknown>[];
}

async function rowsOf(tenantId: string, gitBlobHash: string): Promise<Rows> {
  const params = [tenantId, gitBlobHash];
  const where = 'WHERE tenant_id = $1 AND git_blob_hash = $2';
  return {
    blob: await queryRows(owner, `SELECT * FROM codegraph.blob ${where}`, params),
    contents: (
      await queryRows<{ contents: string }>(
        owner,
        `SELECT contents FROM codegraph.blob_contents ${where}`,
        params,
      )
    ).map((r) => r.contents),
    facts: await queryRows(
      owner,
      `SELECT * FROM codegraph.blob_fact ${where} ORDER BY kind, name, start_line, start_column`,
      params,
    ),
  };
}

/** A connection wrapper recording each statement, optionally failing one. */
function recording(c: pg.Client, failWhen?: (sql: string) => boolean) {
  const statements: string[] = [];
  const client = {
    query(sql: string, params?: unknown[]) {
      statements.push(sql);
      if (failWhen?.(sql) === true) return Promise.reject(new Error('forced failure'));
      return c.query(sql, params);
    },
  } as unknown as pg.ClientBase;
  return { client, statements };
}

async function expectOutcomeOnRow(stored: StoredBlob, tenantId: string, gitBlobHash: string) {
  const [row] = (await rowsOf(tenantId, gitBlobHash)).blob;
  expect(row?.outcome).toBe(stored.outcome);
}

describe('classify and decode', () => {
  it('decides cap, then NUL anywhere, then text', () => {
    expect(classify(Buffer.alloc(11), 10)).toEqual({ outcome: 'refused', capBytes: 10 });
    expect(classify(Buffer.from('a\0b'), 10)).toEqual({ outcome: 'binary' });
    const lateNul = Buffer.alloc(BINARY_SNIFF_BYTES + 5, 0x61);
    lateNul[BINARY_SNIFF_BYTES + 2] = 0;
    expect(classify(lateNul, 1_000_000)).toEqual({ outcome: 'binary' });
    expect(classify(Buffer.from('plain'), 10)).toEqual({ outcome: 'text' });
    expect(classify(Buffer.alloc(10, 0x61), 10)).toEqual({ outcome: 'text' });
  });

  it('keeps a byte order mark and measures loss', () => {
    const bom = Buffer.from('﻿hi', 'utf8');
    expect(decode(bom)).toEqual({ text: '﻿hi', lossy: false });
    expect(decode(Buffer.from([0x61, 0xff, 0x62]))).toEqual({ text: 'a�b', lossy: true });
    // A truncated sequence at the end decodes shorter than the input.
    expect(decode(Buffer.from([0x61, 0xe2, 0x82]))).toMatchObject({ lossy: true });
  });
});

describe('storeBlob', () => {
  it('stores once: a second store is a no-op answering the same fields, whatever the path', async () => {
    const first = input(CLEAN);
    const one = await storeBlob(app, first);
    const before = await rowsOf(tenantA, first.gitBlobHash);
    const rec = recording(app);
    const two = await storeBlob(rec.client, { ...first, path: 'elsewhere/other-name.ts' });

    expect(one.alreadyStored).toBe(false);
    expect(two).toEqual({ ...one, alreadyStored: true });
    const after = await rowsOf(tenantA, first.gitBlobHash);
    expect(after).toEqual(before);
    expect(after.blob).toHaveLength(1);
    expect(after.contents).toHaveLength(1);
    expect(after.facts.length).toBeGreaterThan(0);
    // The no-op wrote nothing: the binding, one read, and the transaction's own statements.
    expect(rec.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/.test(s))).toEqual([]);
    expect(rec.statements[0]).toBe('BEGIN');
    expect(rec.statements[1]).toBe(BIND_TENANT_SQL);
    expect(rec.statements.at(-1)).toBe('COMMIT');
  });

  it('gives each tenant its own rows for the same bytes, and a bound session reads only its own', async () => {
    const gitBlobHash = hash();
    for (const tenantId of [tenantA, tenantB]) {
      const stored = await storeBlob(app, { ...input(CLEAN, 'a.ts', tenantId), gitBlobHash });
      expect(stored.alreadyStored).toBe(false);
    }
    const a = await rowsOf(tenantA, gitBlobHash);
    const b = await rowsOf(tenantB, gitBlobHash);
    expect([a.blob.length, a.contents.length, b.blob.length, b.contents.length]).toEqual([
      1, 1, 1, 1,
    ]);
    expect(a.facts.length).toBe(b.facts.length);
    const all = await queryRows<{ n: number }>(
      owner,
      'SELECT count(*)::int AS n FROM codegraph.blob WHERE git_blob_hash = $1',
      [gitBlobHash],
    );
    const visible = await withClient(db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: reader, tenantId: tenantB }, () =>
        queryRows<{ tenant_id: string }>(
          c,
          'SELECT tenant_id FROM codegraph.blob WHERE git_blob_hash = $1',
          [gitBlobHash],
        ),
      ),
    );
    expect(all[0]?.n).toBe(2);
    expect(visible).toEqual([{ tenant_id: tenantB }]);
  });

  it('refuses a file over the cap, recording its exact size and the cap in force', async () => {
    const bytes = Buffer.alloc(101, 0x61);
    const file = input(bytes);
    const stored = await storeBlob(app, file, { capBytes: 100 });
    expect(stored).toEqual<StoredBlob>({
      outcome: 'refused',
      alreadyStored: false,
      sizeBytes: 101,
      parsedWithErrors: null,
      lossy: null,
      refusedCapBytes: 100,
      language: null,
      extractorVersion: null,
    });
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    expect([rows.contents, rows.facts]).toEqual([[], []]);
    await expectOutcomeOnRow(stored, tenantA, file.gitBlobHash);
  });

  it('reads the cap from PER_FILE_CAP_BYTES when no cap is passed', async () => {
    const before = process.env.PER_FILE_CAP_BYTES;
    process.env.PER_FILE_CAP_BYTES = '16';
    try {
      const stored = await storeBlob(app, input(Buffer.alloc(17, 0x61)));
      expect(stored).toMatchObject({ outcome: 'refused', refusedCapBytes: 16 });
    } finally {
      if (before === undefined) delete process.env.PER_FILE_CAP_BYTES;
      else process.env.PER_FILE_CAP_BYTES = before;
    }
    expect(DEFAULT_PER_FILE_CAP_BYTES).toBe(1_048_576);
  });

  it('stores a NUL-bearing file as binary, including a NUL past the first 8,000 bytes', async () => {
    const early = Buffer.from('ab\0cd');
    const late = Buffer.alloc(BINARY_SNIFF_BYTES + 100, 0x61);
    late[BINARY_SNIFF_BYTES + 50] = 0;
    for (const bytes of [early, late]) {
      const file = input(bytes);
      const stored = await storeBlob(app, file);
      expect(stored).toMatchObject({ outcome: 'binary', sizeBytes: bytes.byteLength, lossy: null });
      const rows = await rowsOf(tenantA, file.gitBlobHash);
      expect([rows.contents, rows.facts]).toEqual([[], []]);
      await expectOutcomeOnRow(stored, tenantA, file.gitBlobHash);
    }
  });

  it('applies the laid order where two rules apply', async () => {
    const overAndBinary = await storeBlob(app, input(Buffer.from('a\0bcdef')), { capBytes: 3 });
    expect(overAndBinary.outcome).toBe('refused');
    const binaryUnknown = await storeBlob(app, input(Buffer.from('a\0b'), 'blob.unknownext'));
    expect(binaryUnknown.outcome).toBe('binary');
  });

  it('stores an unsupported file’s contents byte-exact with no facts, recording a known language', async () => {
    const text = Buffer.from('let swift = "café"\n', 'utf8');
    const known = input(text, 'Sources/App.swift');
    const unknown = input(text, 'notes/README.unknownext');
    const s1 = await storeBlob(app, known);
    const s2 = await storeBlob(app, unknown);
    expect(s1).toMatchObject({
      outcome: 'unsupported',
      language: 'swift',
      lossy: false,
      extractorVersion: null,
    });
    expect(s2).toMatchObject({ outcome: 'unsupported', language: null, lossy: false });
    for (const file of [known, unknown]) {
      const rows = await rowsOf(tenantA, file.gitBlobHash);
      expect(rows.facts).toEqual([]);
      expect(Buffer.from(rows.contents[0] ?? '', 'utf8').equals(text)).toBe(true);
    }
    await expectOutcomeOnRow(s1, tenantA, known.gitBlobHash);
  });

  it('indexes a clean file and a broken one, flagging the parse error and keeping recovered facts', async () => {
    const clean = input(CLEAN);
    const broken = input(BROKEN, 'src/broken.ts');
    const s1 = await storeBlob(app, clean);
    const s2 = await storeBlob(app, broken);
    expect(s1).toMatchObject({
      outcome: 'indexed',
      parsedWithErrors: false,
      lossy: false,
      language: 'typescript',
      extractorVersion: TS_VERSION,
    });
    expect(s2).toMatchObject({
      outcome: 'indexed',
      parsedWithErrors: true,
      language: 'typescript',
    });
    for (const [file, stored] of [
      [clean, s1],
      [broken, s2],
    ] as const) {
      const rows = await rowsOf(tenantA, file.gitBlobHash);
      expect(rows.facts.length).toBeGreaterThan(0);
      for (const fact of rows.facts) {
        expect(fact).toMatchObject({
          language: 'typescript',
          producer: TREE_SITTER_PRODUCER,
          extractor_version: TS_VERSION,
        });
      }
      expect(rows.blob[0]).toMatchObject({ language: 'typescript', extractor_version: TS_VERSION });
      expect(Buffer.from(rows.contents[0] ?? '', 'utf8').equals(file.bytes)).toBe(true);
      await expectOutcomeOnRow(stored, tenantA, file.gitBlobHash);
    }
    const brokenFacts = (await rowsOf(tenantA, broken.gitBlobHash)).facts;
    expect(brokenFacts.some((f) => f.kind === 'definition' && f.name === 'Repo')).toBe(true);
  });

  it('indexes a file whose import list and names are far over a btree entry’s 2,704 bytes', async () => {
    // Random names, so no compression brings an index entry back under the limit.
    const word = (prefix: string, bytes: number) =>
      `${prefix}${randomBytes(bytes).toString('hex')}`;
    const names = Array.from({ length: 600 }, (_, n) => word(`Icon${String(n)}_`, 8));
    const longName = word('f', 2000);
    const longParent = word('Base', 2000);
    const longModule = `./${word('m', 1500)}`;
    const source = [
      `import { ${names.join(', ')} } from '${longModule}';`,
      `export function ${longName}() { return ${longName}(); }`,
      `export class Shape extends ${longParent} {}`,
      '',
    ].join('\n');
    const file = input(Buffer.from(source, 'utf8'), 'src/icons.ts');
    expect(await storeBlob(app, file)).toMatchObject({
      outcome: 'indexed',
      parsedWithErrors: false,
    });
    const { facts } = await rowsOf(tenantA, file.gitBlobHash);
    expect(facts).toContainEqual(
      expect.objectContaining({
        kind: 'import',
        module_specifier: longModule,
        imported_names: names,
      }),
    );
    expect(facts).toContainEqual(expect.objectContaining({ kind: 'definition', name: longName }));
    expect(facts).toContainEqual(
      expect.objectContaining({ kind: 'reference', name: longName, enclosing_name: longName }),
    );
    expect(facts).toContainEqual(
      expect.objectContaining({ kind: 'inheritance', name: 'Shape', parent_name: longParent }),
    );
  });

  it('keeps a byte order mark, and flags invalid UTF-8 as lossy with U+FFFD stored', async () => {
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('export const a = 1;\n'),
    ]);
    const bad = Buffer.concat([
      Buffer.from('const s = "'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('";\n'),
    ]);
    const withBom = input(bom);
    const invalid = input(bad);
    expect(await storeBlob(app, withBom)).toMatchObject({ outcome: 'indexed', lossy: false });
    expect(await storeBlob(app, invalid)).toMatchObject({ outcome: 'indexed', lossy: true });
    const bomBack = (await rowsOf(tenantA, withBom.gitBlobHash)).contents[0] ?? '';
    expect(Buffer.from(bomBack, 'utf8').equals(bom)).toBe(true);
    const badBack = (await rowsOf(tenantA, invalid.gitBlobHash)).contents[0] ?? '';
    expect(badBack).toContain('�');
    expect((await rowsOf(tenantA, invalid.gitBlobHash)).blob[0]).toMatchObject({ lossy: true });
  });

  it('writes one transaction: BEGIN first, COMMIT last, and a failed fact write leaves no row', async () => {
    const ok = input(CLEAN);
    const rec = recording(app);
    await storeBlob(rec.client, ok);
    expect(rec.statements[0]).toBe('BEGIN');
    expect(rec.statements[1]).toBe(BIND_TENANT_SQL);
    expect(rec.statements.at(-1)).toBe('COMMIT');
    expect(rec.statements.filter((s) => s === 'BEGIN' || s === 'COMMIT')).toHaveLength(2);

    const doomed = input(CLEAN);
    const failing = recording(app, (sql) => sql.startsWith('INSERT INTO codegraph.blob_fact'));
    await expect(storeBlob(failing.client, doomed)).rejects.toThrow('forced failure');
    expect(failing.statements.at(-1)).toBe('ROLLBACK');
    expect(await rowsOf(tenantA, doomed.gitBlobHash)).toEqual({
      blob: [],
      contents: [],
      facts: [],
    });
    // The connection is usable afterwards: nothing is left open on it.
    expect((await storeBlob(app, doomed)).alreadyStored).toBe(false);
  });

  it('raises the original error even when the rollback itself fails', async () => {
    const file = input(CLEAN);
    const own = new pg.Client({ connectionString: db.appUrl });
    await own.connect();
    try {
      const failing = recording(
        own,
        (sql) => sql.startsWith('INSERT INTO codegraph.blob_fact') || sql === 'ROLLBACK',
      );
      await expect(storeBlob(failing.client, file)).rejects.toThrow('forced failure');
    } finally {
      await own.end(); // a connection that could not roll back is not reused
    }
    expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual({ blob: [], contents: [], facts: [] });
  });

  it('settles two concurrent stores of one blob on one copy and one fact set', async () => {
    const reference = input(CLEAN);
    await storeBlob(app, reference);
    const single = (await rowsOf(tenantA, reference.gitBlobHash)).facts.length;

    const file = input(CLEAN);
    const one = new pg.Client({ connectionString: db.appUrl });
    const two = new pg.Client({ connectionString: db.appUrl });
    await one.connect();
    await two.connect();
    try {
      const answers = await Promise.all([storeBlob(one, file), storeBlob(two, file)]);
      expect(answers.filter((a) => !a.alreadyStored)).toHaveLength(1);
      expect(answers[0]).toEqual({ ...answers[1], alreadyStored: answers[0].alreadyStored });
    } finally {
      await one.end();
      await two.end();
    }
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    expect([rows.blob.length, rows.contents.length, rows.facts.length]).toEqual([1, 1, single]);
  });

  it('answers the winner’s row to a writer that lost the race after its own read', async () => {
    // The loser's dedupe read happens before the winner commits, so the
    // insert, not the read, is what tells it the blob is already stored.
    const file = input(CLEAN);
    const winner = new pg.Client({ connectionString: db.appUrl });
    await winner.connect();
    try {
      await winner.query('BEGIN');
      await winner.query(BIND_TENANT_SQL, [reader, tenantA]);
      await winner.query(
        `INSERT INTO codegraph.blob (tenant_id, git_blob_hash, size_bytes, outcome) VALUES ($1, $2, $3, 'binary')`,
        [tenantA, file.gitBlobHash, file.bytes.byteLength],
      );
      const pending = storeBlob(app, file);
      await waitsOnLock(app);
      await winner.query('COMMIT');
      expect(await pending).toMatchObject({ outcome: 'binary', alreadyStored: true });
    } finally {
      await winner.end();
    }
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    expect([rows.contents, rows.facts]).toEqual([[], []]);
  });

  it('throws for a client with no live grant on the tenant, leaving no row', async () => {
    const file = { ...input(CLEAN), clientId: stranger };
    await expect(storeBlob(app, file)).rejects.toMatchObject({ code: '42501' });
    expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual({ blob: [], contents: [], facts: [] });
  });

  it('answers a stored refused or unsupported blob as a no-op on this path', async () => {
    const refused = input(Buffer.alloc(50, 0x61));
    await storeBlob(app, refused, { capBytes: 10 });
    const again = recording(app);
    expect(await storeBlob(again.client, refused, { capBytes: 10 })).toMatchObject({
      outcome: 'refused',
      alreadyStored: true,
    });
    expect(again.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/.test(s))).toEqual([]);
  });
});

async function waitsOnLock(c: pg.Client): Promise<void> {
  const pid = (c as unknown as { processID: number }).processID;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await queryRows(owner, 'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [
      pid,
    ]);
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the second writer never waited on the first');
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE)/;

describe('storeBlob re-classifies a stored outcome the configuration now decides differently', () => {
  it('promotes a refused blob that now fits to indexed, with contents, facts and the cap cleared', async () => {
    const file = input(CLEAN);
    expect(await storeBlob(app, file, { capBytes: 10 })).toMatchObject({ outcome: 'refused' });
    const corrected = await storeBlob(app, file);
    expect(corrected).toEqual<StoredBlob>({
      outcome: 'indexed',
      alreadyStored: true,
      sizeBytes: CLEAN.byteLength,
      parsedWithErrors: false,
      lossy: false,
      refusedCapBytes: null,
      language: 'typescript',
      extractorVersion: TS_VERSION ?? '',
    });
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    expect(rows.blob[0]).toMatchObject({ outcome: 'indexed', refused_cap_bytes: null });
    expect(Buffer.from(rows.contents[0] ?? '', 'utf8').equals(CLEAN)).toBe(true);
    expect(rows.facts.length).toBeGreaterThan(0);
    for (const fact of rows.facts) {
      expect(fact).toMatchObject({
        language: 'typescript',
        producer: TREE_SITTER_PRODUCER,
        extractor_version: TS_VERSION,
      });
    }
    // The same facts a first store of these bytes writes.
    const fresh = input(CLEAN);
    await storeBlob(app, fresh);
    expect((await rowsOf(tenantA, fresh.gitBlobHash)).facts.length).toBe(rows.facts.length);
  });

  it('flags a promoted file whose source has a syntax error rather than failing', async () => {
    const file = input(BROKEN, 'src/broken.ts');
    await storeBlob(app, file, { capBytes: 10 });
    expect(await storeBlob(app, file)).toMatchObject({
      outcome: 'indexed',
      parsedWithErrors: true,
    });
    expect((await rowsOf(tenantA, file.gitBlobHash)).facts.length).toBeGreaterThan(0);
  });

  it('re-classifies a refused blob to binary, including a NUL past the first 8,000 bytes', async () => {
    const bytes = Buffer.alloc(BINARY_SNIFF_BYTES + 200, 0x61);
    bytes[BINARY_SNIFF_BYTES + 100] = 0;
    const file = input(bytes);
    await storeBlob(app, file, { capBytes: 10 });
    expect(await storeBlob(app, file)).toMatchObject({ outcome: 'binary', alreadyStored: true });
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    expect(rows.blob[0]).toMatchObject({
      outcome: 'binary',
      size_bytes: bytes.byteLength,
      language: null,
      extractor_version: null,
      parsed_with_errors: null,
      lossy: null,
      refused_cap_bytes: null,
    });
    expect([rows.contents, rows.facts]).toEqual([[], []]);
  });

  it('re-classifies a refused blob to unsupported, byte-exact, recording a known language', async () => {
    const bytes = Buffer.from('struct Point { let x: Int }\n', 'utf8');
    const known = input(bytes, 'Sources/Point.swift');
    const unknown = input(bytes, 'notes/point.unknownext');
    for (const file of [known, unknown]) {
      await storeBlob(app, file, { capBytes: 4 });
      await storeBlob(app, file);
    }
    const k = await rowsOf(tenantA, known.gitBlobHash);
    const u = await rowsOf(tenantA, unknown.gitBlobHash);
    expect(k.blob[0]).toMatchObject({ outcome: 'unsupported', language: 'swift', lossy: false });
    expect(u.blob[0]).toMatchObject({ outcome: 'unsupported', language: null });
    for (const rows of [k, u]) {
      expect(rows.facts).toEqual([]);
      expect(Buffer.from(rows.contents[0] ?? '', 'utf8').equals(bytes)).toBe(true);
    }
  });

  it('leaves a refused blob still over the cap exactly as it is', async () => {
    const file = input(Buffer.alloc(64, 0x61));
    await storeBlob(app, file, { capBytes: 10 });
    const before = await rowsOf(tenantA, file.gitBlobHash);
    const rec = recording(app);
    expect(await storeBlob(rec.client, file, { capBytes: 20 })).toMatchObject({
      outcome: 'refused',
      refusedCapBytes: 10,
      alreadyStored: true,
    });
    expect(rec.statements.filter((sql) => WRITE.test(sql))).toEqual([]);
    expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual(before);
  });

  it('promotes an unsupported blob with no language once its path resolves to an entry', async () => {
    const gitBlobHash = hash();
    for (const tenantId of [tenantA, tenantB]) {
      await storeBlob(app, { ...input(CLEAN, 'README.unknownext', tenantId), gitBlobHash });
    }
    const otherBefore = await rowsOf(tenantB, gitBlobHash);
    const corrected = await storeBlob(app, { ...input(CLEAN, 'src/repo.ts'), gitBlobHash });
    expect(corrected).toMatchObject({
      outcome: 'indexed',
      alreadyStored: true,
      language: 'typescript',
    });
    const rows = await rowsOf(tenantA, gitBlobHash);
    expect(rows.facts.length).toBeGreaterThan(0);
    expect(Buffer.from(rows.contents[0] ?? '', 'utf8').equals(CLEAN)).toBe(true);
    // The other tenant's copy of the same hash is untouched.
    expect(await rowsOf(tenantB, gitBlobHash)).toEqual(otherBefore);
    expect(otherBefore.blob[0]).toMatchObject({ outcome: 'unsupported', language: null });
  });

  it('records the language of an unsupported blob whose path the registry now knows without a grammar', async () => {
    const bytes = Buffer.from('func f() {}\n');
    const file = input(bytes, 'f.unknownext');
    await storeBlob(app, file);
    expect(await storeBlob(app, { ...file, path: 'Sources/f.swift' })).toMatchObject({
      outcome: 'unsupported',
      language: 'swift',
    });
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    expect(rows.facts).toEqual([]);
    expect(Buffer.from(rows.contents[0] ?? '', 'utf8').equals(bytes)).toBe(true);
    // An unclaimed path still is: nothing changes.
    expect(await storeBlob(app, { ...input(bytes, 'g.unknownext') })).toMatchObject({
      language: null,
    });
  });

  it('leaves an unsupported blob that records a language to the sweep', async () => {
    const file = input(Buffer.from('let a = 1\n'), 'Sources/a.swift');
    await storeBlob(app, file);
    const before = await rowsOf(tenantA, file.gitBlobHash);
    const rec = recording(app);
    expect(await storeBlob(rec.client, { ...file, path: 'src/a.ts' })).toMatchObject({
      outcome: 'unsupported',
      language: 'swift',
    });
    expect(rec.statements.filter((sql) => WRITE.test(sql))).toEqual([]);
    expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual(before);
  });

  it('never demotes an unsupported blob over a lowered cap to refused', async () => {
    const file = input(Buffer.alloc(40, 0x61), 'x.unknownext');
    await storeBlob(app, file);
    const before = await rowsOf(tenantA, file.gitBlobHash);
    expect(await storeBlob(app, { ...file, path: 'x.ts' }, { capBytes: 8 })).toMatchObject({
      outcome: 'unsupported',
    });
    expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual(before);
  });

  it('writes nothing re-storing an indexed or a binary blob, on a pool wrapped by recordQueries', async () => {
    const indexed = input(CLEAN);
    const binary = input(Buffer.from('a\0b'));
    await storeBlob(app, indexed);
    await storeBlob(app, binary);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 1 });
    const log = recordQueries(pool);
    const client = await pool.connect();
    try {
      for (const file of [indexed, binary]) {
        const before = await rowsOf(tenantA, file.gitBlobHash);
        expect((await storeBlob(client, file)).alreadyStored).toBe(true);
        expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual(before);
      }
    } finally {
      client.release();
      await pool.end();
    }
    expect(log.texts().filter((sql) => WRITE.test(sql))).toEqual([]);
    expect(log.texts().filter((sql) => sql === 'BEGIN')).toHaveLength(2);
  });

  it('raises BlobBytesMismatchError naming both sizes and writes nothing', async () => {
    const file = input(Buffer.alloc(30, 0x61));
    await storeBlob(app, file, { capBytes: 10 });
    const before = await rowsOf(tenantA, file.gitBlobHash);
    const error = await storeBlob(app, { ...file, bytes: Buffer.alloc(31, 0x61) }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BlobBytesMismatchError);
    expect(error).toMatchObject({ recordedSizeBytes: 30, presentedSizeBytes: 31 });
    expect((error as Error).message).toMatch(/30.*31/);
    expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual(before);
  });

  it('settles two overlapping corrections of one refused blob on one copy and one fact set', async () => {
    const file = input(CLEAN);
    await storeBlob(app, file, { capBytes: 10 });
    const one = new pg.Client({ connectionString: db.appUrl });
    const two = new pg.Client({ connectionString: db.appUrl });
    await one.connect();
    await two.connect();
    try {
      // The first correction is held just before its COMMIT, so the second
      // provably runs while the first transaction is still open.
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
      const first = storeBlob(held, file);
      await atCommit;
      const second = storeBlob(two, file);
      const overlapped = await waitedOnLock(two);
      release();
      const answers = await Promise.all([first, second]);
      expect(overlapped).toBe(true);
      expect(answers.map((a) => [a.outcome, a.alreadyStored])).toEqual([
        ['indexed', true],
        ['indexed', true],
      ]);
    } finally {
      await one.end();
      await two.end();
    }
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    const fresh = input(CLEAN);
    await storeBlob(app, fresh);
    const single = (await rowsOf(tenantA, fresh.gitBlobHash)).facts.length;
    expect([rows.blob.length, rows.contents.length, rows.facts.length]).toEqual([1, 1, single]);
  });

  it('writes nothing on a further call after a correction', async () => {
    const file = input(CLEAN);
    await storeBlob(app, file, { capBytes: 10 });
    const corrected = await storeBlob(app, file);
    const before = await rowsOf(tenantA, file.gitBlobHash);
    const rec = recording(app);
    expect(await storeBlob(rec.client, file)).toEqual(corrected);
    expect(rec.statements.filter((sql) => WRITE.test(sql))).toEqual([]);
    expect(await rowsOf(tenantA, file.gitBlobHash)).toEqual(before);
  });

  it('lands the whole correction in one transaction: a failed fact write leaves the row refused', async () => {
    const file = input(CLEAN);
    await storeBlob(app, file, { capBytes: 10 });
    const failing = recording(app, (sql) => sql.startsWith('INSERT INTO codegraph.blob_fact'));
    await expect(storeBlob(failing.client, file)).rejects.toThrow('forced failure');
    const rows = await rowsOf(tenantA, file.gitBlobHash);
    expect(rows.blob[0]).toMatchObject({ outcome: 'refused', refused_cap_bytes: 10 });
    expect([rows.contents, rows.facts]).toEqual([[], []]);
  });
});

/** Polls until `c`'s backend waits on a lock, up to five seconds; answers whether it did. */
async function waitedOnLock(c: pg.Client): Promise<boolean> {
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
