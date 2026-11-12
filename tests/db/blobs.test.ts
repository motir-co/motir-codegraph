import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DELETE_BATCH_SIZE,
  deleteBlobBatch,
  deleteBlobs,
  getBlob,
  insertBlobIfAbsent,
  insertContents,
  insertContentsIfAbsent,
  readContents,
  setBlobClassification,
  UnknownBlobError,
  type BlobRow,
  type ConnectionSource,
  type NewBlob,
} from '../../src/db/blobs.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import {
  asOperator,
  buildTenancyFixture,
  inBoundTransaction,
  type TenancyFixture,
} from '../helpers/tenancy.js';

// Every write here runs as codegraph_app, inside a bound transaction, the way
// the indexing library will call this module. Rows are read back both through a
// bound session and as codegraph_owner, which no policy filters.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const SERIALIZATION_FAILURE = '40001';

let db: FreshDatabase;
let fixture: TenancyFixture;
let owner: pg.Client;
/** Granted tenant A and, below, tenant B. */
let reader: string;
/** A live client holding no grant at all. */
let stranger: string;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  db = await freshDatabase();
  fixture = await buildTenancyFixture(db);
  tenantA = fixture.tenantA.id;
  tenantB = fixture.tenantB.id;
  reader = fixture.readerId;
  await asOperator(db.appUrl, fixture.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
    reader,
    tenantB,
  ]);
  stranger = (await asOperator<string>(
    db.appUrl,
    fixture.operatorId,
    'codegraph.codegraph_create_client($1, $2)',
    ['stranger', 'client'],
  )) as string;
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  // Both tenants hold blobs from the start, so a session that forgot its
  // binding would see a population different from the bound one.
  for (const tenantId of [tenantA, tenantB]) {
    await asTenant(tenantId, (c) => insertBlobIfAbsent(c, indexed(tenantId, hash())));
  }
});

afterAll(async () => {
  await owner.end();
  await db.drop();
});

function hash(): string {
  return randomBytes(20).toString('hex');
}

function indexed(tenantId: string, gitBlobHash: string, sizeBytes = 120): NewBlob {
  return {
    tenantId,
    gitBlobHash,
    sizeBytes,
    outcome: 'indexed',
    parsedWithErrors: false,
    lossy: false,
    language: 'typescript',
    extractorVersion: '0.23.2/q1',
  };
}

function refused(tenantId: string, gitBlobHash: string): NewBlob {
  return {
    tenantId,
    gitBlobHash,
    sizeBytes: 3_000_000,
    outcome: 'refused',
    refusedCapBytes: 2_097_152,
  };
}

/** Runs `fn` on a new app connection in a transaction bound to `tenantId`, and commits. */
async function asTenant<T>(tenantId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return await withClient(db.appUrl, (c) =>
    inBoundTransaction(c, { clientId: reader, tenantId }, () => fn(c), { commit: true }),
  );
}

async function ownerRows(
  tenantId: string,
  gitBlobHash: string,
): Promise<Record<string, unknown>[]> {
  return await queryRows(
    owner,
    'SELECT * FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = $2',
    [tenantId, gitBlobHash],
  );
}

async function ownerCount(table: string, tenantId: string, hashes: string[]): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    owner,
    `SELECT count(*)::int AS n FROM codegraph.${table} WHERE tenant_id = $1 AND git_blob_hash = ANY($2)`,
    [tenantId, hashes],
  );
  return rows[0]?.n ?? -1;
}

/** A connection bound to `tenantId` with its transaction left open. */
async function openBound(tenantId: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  await c.query('BEGIN');
  await c.query(BIND_TENANT_SQL, [reader, tenantId]);
  return c;
}

/** The transaction id a connection's open transaction holds, assigning one. */
async function xactId(c: pg.Client): Promise<string> {
  const rows = await queryRows<{ xid: string }>(c, 'SELECT pg_current_xact_id()::text AS xid');
  return rows[0]?.xid ?? '';
}

/** Whether every named transaction is in progress at this one instant, seen from a third session. */
async function allInProgress(xids: string[]): Promise<boolean> {
  const rows = await queryRows<{ n: number }>(
    owner,
    `SELECT count(*)::int AS n FROM unnest($1::text[]) AS x
      WHERE pg_xact_status(x::xid8) = 'in progress'`,
    [xids],
  );
  return rows[0]?.n === xids.length;
}

/** The backend a client is served by, known without a statement (one may be blocked). */
function backendPid(c: pg.Client): number {
  return (c as unknown as { processID: number }).processID;
}

/** Polls until `pid` waits on a lock, up to five seconds. */
async function waitsOnLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await queryRows(owner, 'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [
      pid,
    ]);
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('insertBlobIfAbsent', () => {
  it('creates a row once, and a second store answers the row already on record', async () => {
    const h = hash();
    const first = await asTenant(tenantA, (c) => insertBlobIfAbsent(c, indexed(tenantA, h, 512)));
    expect(first.created).toBe(true);
    expect(first.blob).toEqual<BlobRow>({
      tenantId: tenantA,
      gitBlobHash: h,
      sizeBytes: 512,
      outcome: 'indexed',
      parsedWithErrors: false,
      lossy: false,
      refusedCapBytes: null,
      language: 'typescript',
      extractorVersion: '0.23.2/q1',
    });

    // A different payload for the same pair: nothing it carries is written.
    const second = await asTenant(tenantA, (c) =>
      insertBlobIfAbsent(c, { ...refused(tenantA, h), sizeBytes: 9 }),
    );
    expect(second).toEqual({ created: false, blob: first.blob });
    expect(await ownerRows(tenantA, h)).toHaveLength(1);
  });

  it('stores absent optional fields as null', async () => {
    const h = hash();
    const { blob } = await asTenant(tenantA, (c) =>
      insertBlobIfAbsent(c, { tenantId: tenantA, gitBlobHash: h, sizeBytes: 4, outcome: 'binary' }),
    );
    expect(blob).toMatchObject({
      outcome: 'binary',
      parsedWithErrors: null,
      lossy: null,
      refusedCapBytes: null,
      language: null,
      extractorVersion: null,
    });
  });

  it('settles two overlapping writers of one pair on one row, the loser answered the winner’s row', async () => {
    const h = hash();
    const one = await openBound(tenantA);
    const two = await openBound(tenantA);
    try {
      // Both transactions hold a snapshot before either insert is issued.
      const overlapped = await allInProgress([await xactId(one), await xactId(two)]);

      const store = async (c: pg.Client, sizeBytes: number) => {
        const answer = await insertBlobIfAbsent(c, indexed(tenantA, h, sizeBytes));
        await c.query('COMMIT');
        return answer;
      };
      const answers = await Promise.all([store(one, 100), store(two, 200)]);

      // Recorded, so a degenerate sequential run is never reported as the race.
      expect(overlapped).toBe(true);
      expect(answers.filter((a) => a.created)).toHaveLength(1);
      const winner = answers.find((a) => a.created);
      const loser = answers.find((a) => !a.created);
      expect(loser?.blob).toEqual(winner?.blob);
      expect(await ownerRows(tenantA, h)).toHaveLength(1);
    } finally {
      await one.end();
      await two.end();
    }
  });

  it('makes the losing writer wait for the winner, then read its committed row', async () => {
    const h = hash();
    const winner = await openBound(tenantA);
    const loser = await openBound(tenantA);
    try {
      const won = await insertBlobIfAbsent(winner, indexed(tenantA, h, 300));
      const pending = insertBlobIfAbsent(loser, indexed(tenantA, h, 400));
      expect(await waitsOnLock(backendPid(loser))).toBe(true);
      await winner.query('COMMIT');
      const lost = await pending;
      await loser.query('COMMIT');
      expect(won.created).toBe(true);
      expect(lost).toEqual({ created: false, blob: won.blob });
    } finally {
      await winner.end();
      await loser.end();
    }
  });

  it('lets the waiting writer create the row when the winner rolls back', async () => {
    const h = hash();
    const first = await openBound(tenantA);
    const second = await openBound(tenantA);
    try {
      await insertBlobIfAbsent(first, indexed(tenantA, h, 300));
      const pending = insertBlobIfAbsent(second, indexed(tenantA, h, 400));
      expect(await waitsOnLock(backendPid(second))).toBe(true);
      await first.query('ROLLBACK');
      const answer = await pending;
      await second.query('COMMIT');
      expect(answer.created).toBe(true);
      expect(answer.blob.sizeBytes).toBe(400);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('cannot read the winner’s row above READ COMMITTED, which is why a caller must not raise it', async () => {
    const h = hash();
    const late = new pg.Client({ connectionString: db.appUrl });
    await late.connect();
    try {
      await late.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await late.query(BIND_TENANT_SQL, [reader, tenantA]);
      await late.query('SELECT 1 FROM codegraph.blob LIMIT 1'); // takes the snapshot
      await asTenant(tenantA, (c) => insertBlobIfAbsent(c, indexed(tenantA, h)));
      await expect(insertBlobIfAbsent(late, indexed(tenantA, h))).rejects.toMatchObject({
        code: SERIALIZATION_FAILURE,
      });
      await late.query('ROLLBACK');
    } finally {
      await late.end();
    }
  });

  it('raises rather than answering empty when a conflict cannot be read back', async () => {
    const silent = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as pg.ClientBase;
    await expect(insertBlobIfAbsent(silent, indexed(tenantA, hash()))).rejects.toThrow(
      /could not be read back/,
    );
  });
});

describe('the caller’s transaction', () => {
  it('opens none: a rollback leaves no blob and no contents, and nothing is seen before commit', async () => {
    const h = hash();
    const writer = await openBound(tenantA);
    try {
      await insertBlobIfAbsent(writer, indexed(tenantA, h));
      await insertContents(writer, { tenantId: tenantA, gitBlobHash: h, contents: 'let x = 1;' });
      expect(await readContents(writer, tenantA, h)).toBe('let x = 1;');

      const seen = await asTenant(tenantA, async (c) => ({
        blob: await getBlob(c, tenantA, h),
        contents: await readContents(c, tenantA, h),
      }));
      expect(seen).toEqual({ blob: null, contents: null });

      await writer.query('ROLLBACK');
    } finally {
      await writer.end();
    }
    expect(await ownerCount('blob', tenantA, [h])).toBe(0);
    expect(await ownerCount('blob_contents', tenantA, [h])).toBe(0);
  });
});

describe('contents', () => {
  async function storeWithContents(tenantId: string, h: string, contents: string): Promise<void> {
    await asTenant(tenantId, async (c) => {
      await insertBlobIfAbsent(c, indexed(tenantId, h));
      await insertContents(c, { tenantId, gitBlobHash: h, contents });
    });
  }

  it('reads back multi-byte text code unit for code unit, and its UTF-8 bytes exactly', async () => {
    const text = 'naïve — 世界 🎉 \u{1F9EA} Ωmega\n\ttabs\r\nand CRLF';
    const h = hash();
    await storeWithContents(tenantA, h, text);
    const back = await asTenant(tenantA, (c) => readContents(c, tenantA, h));
    expect(back).toBe(text);
    expect(Buffer.from(back ?? '', 'utf8').equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it('reads back a source fixture of several kilobytes unchanged', async () => {
    const source = readFileSync(new URL('../../src/indexer/registry.ts', import.meta.url), 'utf8');
    expect(source.length).toBeGreaterThan(4_096);
    const h = hash();
    await storeWithContents(tenantA, h, source);
    const back = await asTenant(tenantA, (c) => readContents(c, tenantA, h));
    expect(back).toBe(source);
    expect(Buffer.from(back ?? '', 'utf8').equals(Buffer.from(source, 'utf8'))).toBe(true);
  });

  it('stores quotes and backslashes as data, never as SQL', async () => {
    const text = `it's "quoted" \\ back\\slash '); DROP TABLE codegraph.blob; --\\'`;
    const h = hash();
    await storeWithContents(tenantA, h, text);
    expect(await asTenant(tenantA, (c) => readContents(c, tenantA, h))).toBe(text);
  });

  it('refuses a second contents row with 23505 and keeps the stored text', async () => {
    const h = hash();
    await storeWithContents(tenantA, h, 'original');
    const state = await withClient(db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: reader, tenantId: tenantA }, () =>
        insertContents(c, { tenantId: tenantA, gitBlobHash: h, contents: 'replacement' }).then(
          () => null,
          (error: unknown) => (error as { code?: string }).code ?? 'unknown',
        ),
      ),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
    expect(await asTenant(tenantA, (c) => readContents(c, tenantA, h))).toBe('original');
    expect(await ownerCount('blob_contents', tenantA, [h])).toBe(1);
  });

  it('insertContentsIfAbsent writes once and then answers that it wrote nothing', async () => {
    const h = hash();
    await asTenant(tenantA, (c) => insertBlobIfAbsent(c, indexed(tenantA, h)));
    const wrote = await asTenant(tenantA, (c) =>
      insertContentsIfAbsent(c, { tenantId: tenantA, gitBlobHash: h, contents: 'first' }),
    );
    const again = await asTenant(tenantA, (c) =>
      insertContentsIfAbsent(c, { tenantId: tenantA, gitBlobHash: h, contents: 'second' }),
    );
    expect([wrote, again]).toEqual([true, false]);
    expect(await asTenant(tenantA, (c) => readContents(c, tenantA, h))).toBe('first');
    expect(await ownerCount('blob_contents', tenantA, [h])).toBe(1);
  });
});

describe('tenant scoping', () => {
  it('answers null for a hash only the other tenant holds', async () => {
    const h = hash();
    await asTenant(tenantA, async (c) => {
      await insertBlobIfAbsent(c, indexed(tenantA, h));
      await insertContents(c, { tenantId: tenantA, gitBlobHash: h, contents: 'A only' });
    });
    const fromB = await asTenant(tenantB, async (c) => ({
      blob: await getBlob(c, tenantA, h),
      contents: await readContents(c, tenantA, h),
      asB: await getBlob(c, tenantB, h),
    }));
    expect(fromB).toEqual({ blob: null, contents: null, asB: null });
    // The bound session sees fewer blobs than exist.
    const visible = await asTenant(tenantB, (c) =>
      queryRows<{ n: number }>(c, 'SELECT count(*)::int AS n FROM codegraph.blob'),
    );
    const all = await queryRows<{ n: number }>(
      owner,
      'SELECT count(*)::int AS n FROM codegraph.blob',
    );
    expect(visible[0]?.n).toBeGreaterThan(0);
    expect(visible[0]?.n).toBeLessThan(all[0]?.n ?? 0);
  });

  it('gives each tenant its own row and contents for the same hash', async () => {
    const h = hash();
    for (const [tenantId, size, text] of [
      [tenantA, 10, 'tenant A text'],
      [tenantB, 20, 'tenant B text'],
    ] as const) {
      const answer = await asTenant(tenantId, async (c) => {
        const stored = await insertBlobIfAbsent(c, indexed(tenantId, h, size));
        await insertContents(c, { tenantId, gitBlobHash: h, contents: text });
        return stored;
      });
      expect(answer.created).toBe(true);
    }
    expect(await asTenant(tenantA, (c) => getBlob(c, tenantA, h))).toMatchObject({ sizeBytes: 10 });
    expect(await asTenant(tenantB, (c) => getBlob(c, tenantB, h))).toMatchObject({ sizeBytes: 20 });
    expect(await asTenant(tenantA, (c) => readContents(c, tenantA, h))).toBe('tenant A text');
    expect(await asTenant(tenantB, (c) => readContents(c, tenantB, h))).toBe('tenant B text');
  });
});

describe('getBlob', () => {
  it('answers every column the table defines', async () => {
    const one = hash();
    const two = hash();
    await asTenant(tenantA, async (c) => {
      await insertBlobIfAbsent(c, {
        ...indexed(tenantA, one, 777),
        parsedWithErrors: true,
        lossy: true,
        language: 'python',
        extractorVersion: '0.25.0/q3',
      });
      await insertBlobIfAbsent(c, refused(tenantA, two));
    });
    const rows = await asTenant(tenantA, async (c) => [
      await getBlob(c, tenantA, one),
      await getBlob(c, tenantA, two),
    ]);
    expect(rows).toEqual<BlobRow[]>([
      {
        tenantId: tenantA,
        gitBlobHash: one,
        sizeBytes: 777,
        outcome: 'indexed',
        parsedWithErrors: true,
        lossy: true,
        refusedCapBytes: null,
        language: 'python',
        extractorVersion: '0.25.0/q3',
      },
      {
        tenantId: tenantA,
        gitBlobHash: two,
        sizeBytes: 3_000_000,
        outcome: 'refused',
        parsedWithErrors: null,
        lossy: null,
        refusedCapBytes: 2_097_152,
        language: null,
        extractorVersion: null,
      },
    ]);
  });

  it('answers null without an error for a hash the tenant has not stored', async () => {
    expect(await asTenant(tenantA, (c) => getBlob(c, tenantA, hash()))).toBeNull();
    expect(await asTenant(tenantA, (c) => readContents(c, tenantA, hash()))).toBeNull();
  });
});

describe('setBlobClassification', () => {
  it('moves the four classification columns and nothing else', async () => {
    const h = hash();
    const before = (await asTenant(tenantA, (c) => insertBlobIfAbsent(c, refused(tenantA, h))))
      .blob;
    const after = await asTenant(tenantA, (c) =>
      setBlobClassification(c, tenantA, h, {
        outcome: 'unsupported',
        language: 'swift',
        lossy: false,
        refusedCapBytes: null,
      }),
    );
    expect(after).toEqual<BlobRow>({
      ...before,
      outcome: 'unsupported',
      language: 'swift',
      lossy: false,
      refusedCapBytes: null,
    });
    expect(await asTenant(tenantA, (c) => getBlob(c, tenantA, h))).toEqual(after);
    expect(await ownerRows(tenantA, h)).toHaveLength(1);
  });

  it('promotes a refused row to indexed once the row carries what indexed requires', async () => {
    // The table admits no indexed row without an extractor version and parse
    // flag, columns this update never moves; the promotion lands in one
    // transaction after the fact replacement has stamped them.
    const h = hash();
    const before = (await asTenant(tenantA, (c) => insertBlobIfAbsent(c, refused(tenantA, h))))
      .blob;
    const after = await asTenant(tenantA, async (c) => {
      await setBlobClassification(c, tenantA, h, {
        outcome: 'unsupported',
        language: 'typescript',
        lossy: false,
        refusedCapBytes: null,
      });
      await c.query(
        `UPDATE codegraph.blob SET outcome = 'indexed', extractor_version = $3, parsed_with_errors = false
          WHERE tenant_id = $1 AND git_blob_hash = $2`,
        [tenantA, h, '0.23.2/q1'],
      );
      return await setBlobClassification(c, tenantA, h, {
        outcome: 'indexed',
        language: 'tsx',
        lossy: false,
        refusedCapBytes: null,
      });
    });
    expect(after).toEqual<BlobRow>({
      tenantId: before.tenantId,
      gitBlobHash: before.gitBlobHash,
      sizeBytes: before.sizeBytes,
      outcome: 'indexed',
      parsedWithErrors: false,
      lossy: false,
      refusedCapBytes: null,
      language: 'tsx',
      extractorVersion: '0.23.2/q1',
    });
  });

  it('cannot move a refused row straight to indexed: the outcome check refuses it, row unchanged', async () => {
    const h = hash();
    const before = (await asTenant(tenantA, (c) => insertBlobIfAbsent(c, refused(tenantA, h))))
      .blob;
    const state = await withClient(db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: reader, tenantId: tenantA }, async () => {
        try {
          await setBlobClassification(c, tenantA, h, {
            outcome: 'indexed',
            language: 'typescript',
            lossy: false,
            refusedCapBytes: null,
          });
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? 'unknown';
        }
      }),
    );
    expect(state).toBe(CHECK_VIOLATION);
    expect(await asTenant(tenantA, (c) => getBlob(c, tenantA, h))).toEqual(before);
  });

  it('raises UnknownBlobError and creates nothing for a hash the bound tenant does not hold', async () => {
    const mine = hash();
    await asTenant(tenantB, (c) => insertBlobIfAbsent(c, refused(tenantB, mine)));
    for (const [tenantId, h] of [
      [tenantA, hash()],
      [tenantA, mine],
    ] as const) {
      const error = await asTenant(tenantA, (c) =>
        setBlobClassification(c, tenantId, h, {
          outcome: 'unsupported',
          language: null,
          lossy: false,
          refusedCapBytes: null,
        }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnknownBlobError);
      expect(error).toMatchObject({ name: 'UnknownBlobError', tenantId, gitBlobHash: h });
    }
    expect(await ownerRows(tenantA, mine)).toHaveLength(0);
    expect(await ownerRows(tenantB, mine)).toMatchObject([{ outcome: 'refused' }]);
  });
});

describe('deleteBlobBatch', () => {
  async function storeFull(tenantId: string, h: string): Promise<void> {
    await asTenant(tenantId, async (c) => {
      await insertBlobIfAbsent(c, indexed(tenantId, h));
      await insertContents(c, { tenantId, gitBlobHash: h, contents: `contents of ${h}` });
    });
    await owner.query(
      `INSERT INTO codegraph.blob_fact
        (tenant_id, git_blob_hash, kind, language, producer, extractor_version, name,
         start_line, start_column, end_line, end_column, definition_kind)
        VALUES ($1, $2, 'definition', 'typescript', 'tree-sitter', '0.23.2/q1', 'f', 1, 1, 1, 2, 'function')`,
      [tenantId, h],
    );
  }

  it('removes exactly the named hashes of the bound tenant, children with them', async () => {
    const [gone1, gone2, kept] = [hash(), hash(), hash()];
    for (const h of [gone1, gone2, kept]) await storeFull(tenantA, h);
    await storeFull(tenantB, gone1);
    const absent = hash();

    const removed = await asTenant(tenantA, (c) =>
      deleteBlobBatch(c, tenantA, [gone1, gone2, absent]),
    );
    expect(removed.sort()).toEqual([gone1, gone2].sort());
    for (const table of ['blob', 'blob_contents', 'blob_fact']) {
      expect(await ownerCount(table, tenantA, [gone1, gone2])).toBe(0);
      expect(await ownerCount(table, tenantA, [kept])).toBe(1);
      expect(await ownerCount(table, tenantB, [gone1])).toBe(1);
    }
  });

  it('removes nothing, and raises nothing, for a hash only another tenant holds', async () => {
    const theirs = hash();
    await storeFull(tenantB, theirs);
    expect(await asTenant(tenantA, (c) => deleteBlobBatch(c, tenantA, [theirs]))).toEqual([]);
    expect(await asTenant(tenantA, (c) => deleteBlobBatch(c, tenantB, [theirs]))).toEqual([]);
    expect(await ownerCount('blob', tenantB, [theirs])).toBe(1);
  });

  it('treats quotes and backslashes in a hash as data', async () => {
    const odd = [`'); DELETE FROM codegraph.blob; --`, 'back\\slash', '"quoted"'];
    expect(await asTenant(tenantA, (c) => deleteBlobBatch(c, tenantA, odd))).toEqual([]);
  });

  it('issues no statement for an empty list', async () => {
    const silent = {
      query: () => Promise.reject(new Error('no statement expected')),
    } as unknown as pg.ClientBase;
    expect(await deleteBlobBatch(silent, tenantA, [])).toEqual([]);
  });
});

/** A pool wrapper that records each connection it hands out and the statements run on it. */
function recordingPool(
  pool: pg.Pool,
  onConnect: (index: number) => Promise<void> = () => Promise.resolve(),
  failOn?: (index: number, sql: string) => boolean,
) {
  const connections: { statements: string[]; released: unknown[] }[] = [];
  const source: ConnectionSource = {
    async connect() {
      await onConnect(connections.length);
      const client = await pool.connect();
      const entry = { statements: [] as string[], released: [] as unknown[] };
      const index = connections.length;
      connections.push(entry);
      return {
        query(sql: string, params?: unknown[]) {
          entry.statements.push(sql);
          if (failOn?.(index, sql) === true) return Promise.reject(new Error('forced failure'));
          return client.query(sql, params);
        },
        release(error?: Error | boolean) {
          entry.released.push(error);
          client.release(error);
        },
      } as unknown as pg.PoolClient;
    },
  };
  return { source, connections };
}

describe('deleteBlobs', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: db.appUrl, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function storeMany(tenantId: string, count: number): Promise<string[]> {
    const hashes = Array.from({ length: count }, () => hash());
    await owner.query(
      `INSERT INTO codegraph.blob (tenant_id, git_blob_hash, size_bytes, outcome)
        SELECT $1, h, 1, 'binary' FROM unnest($2::text[]) AS h`,
      [tenantId, hashes],
    );
    return hashes;
  }

  it('defaults to 500 per batch', () => {
    expect(DELETE_BATCH_SIZE).toBe(500);
  });

  it('drains 1,200 hashes in three committed batches on three connections', async () => {
    const hashes = await storeMany(tenantA, 1_200);
    const kept = await storeMany(tenantA, 3);
    const remainingAtConnect: number[] = [];
    const { source, connections } = recordingPool(pool, async () => {
      remainingAtConnect.push(await ownerCount('blob', tenantA, hashes));
    });

    const result = await deleteBlobs(
      source,
      { clientId: reader, tenantId: tenantA },
      [...hashes, ...hashes.slice(0, 50)], // duplicates are named once
    );

    expect(result.batches.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(result.batches.flat().sort()).toEqual([...hashes].sort());
    expect(connections).toHaveLength(3);
    for (const { statements, released } of connections) {
      expect(statements.filter((s) => s === 'BEGIN')).toHaveLength(1);
      expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(1);
      expect(statements[1]).toBe(BIND_TENANT_SQL);
      expect(released).toEqual([undefined]);
    }
    // Each batch was gone to another connection before the next one began.
    expect(remainingAtConnect).toEqual([1_200, 700, 200]);
    expect(await ownerCount('blob', tenantA, hashes)).toBe(0);
    expect(await ownerCount('blob', tenantA, kept)).toBe(3);
  });

  it('honours a batch size passed per call and refuses one that is not a positive integer', async () => {
    const hashes = await storeMany(tenantA, 5);
    const { source, connections } = recordingPool(pool);
    const result = await deleteBlobs(source, { clientId: reader, tenantId: tenantA }, hashes, {
      batchSize: 2,
    });
    expect(result.batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(connections).toHaveLength(3);
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      await expect(
        deleteBlobs(source, { clientId: reader, tenantId: tenantA }, hashes, { batchSize }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('takes no connection for an empty set', async () => {
    const { source, connections } = recordingPool(pool);
    expect(await deleteBlobs(source, { clientId: reader, tenantId: tenantA }, [])).toEqual({
      batches: [],
    });
    expect(connections).toHaveLength(0);
  });

  it('removes nothing for absent, foreign or oddly quoted hashes', async () => {
    const theirs = await storeMany(tenantB, 1);
    const { source } = recordingPool(pool);
    const result = await deleteBlobs(source, { clientId: reader, tenantId: tenantA }, [
      hash(),
      ...theirs,
      `x'); DROP TABLE codegraph.blob; --\\`,
    ]);
    expect(result).toEqual({ batches: [[]] });
    expect(await ownerCount('blob', tenantB, theirs)).toBe(1);
  });

  it('deletes nothing under a binding the policy admits nothing for', async () => {
    const hashes = await storeMany(tenantA, 3);
    const { source } = recordingPool(pool);
    // Nothing bound at all: an empty setting reads as unbound.
    expect(await deleteBlobs(source, { clientId: '', tenantId: tenantA }, hashes)).toEqual({
      batches: [[]],
    });
    // A live client holding no grant on the tenant.
    expect(await deleteBlobs(source, { clientId: stranger, tenantId: tenantA }, hashes)).toEqual({
      batches: [[]],
    });
    expect(await ownerCount('blob', tenantA, hashes)).toBe(3);
  });

  it('keeps earlier batches committed when a later one fails, and rolls the failing one back', async () => {
    const hashes = await storeMany(tenantA, 4);
    const { source, connections } = recordingPool(
      pool,
      undefined,
      (index, sql) => index === 1 && sql.startsWith('DELETE'),
    );
    await expect(
      deleteBlobs(source, { clientId: reader, tenantId: tenantA }, hashes, { batchSize: 2 }),
    ).rejects.toThrow('forced failure');
    expect(await ownerCount('blob', tenantA, hashes.slice(0, 2))).toBe(0);
    expect(await ownerCount('blob', tenantA, hashes.slice(2))).toBe(2);
    expect(connections[1]?.statements.at(-1)).toBe('ROLLBACK');
    expect(connections[1]?.released).toEqual([undefined]);

    // Calling again with the same set resumes.
    const { source: again } = recordingPool(pool);
    const resumed = await deleteBlobs(again, { clientId: reader, tenantId: tenantA }, hashes, {
      batchSize: 2,
    });
    expect(resumed.batches.flat().sort()).toEqual(hashes.slice(2).sort());
  });

  it('discards a connection that cannot roll back', async () => {
    const released: unknown[] = [];
    const broken: ConnectionSource = {
      connect: () =>
        Promise.resolve({
          query: () => Promise.reject(new Error('connection lost')),
          release: (error?: unknown) => released.push(error),
        } as unknown as pg.PoolClient),
    };
    await expect(
      deleteBlobs(broken, { clientId: reader, tenantId: tenantA }, [hash()]),
    ).rejects.toThrow('connection lost');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });
});

describe('getBlob under a binding the policy admits nothing for', () => {
  it('answers null with no tenant bound, and for a client holding no grant', async () => {
    const h = hash();
    await asTenant(tenantA, (c) => insertBlobIfAbsent(c, indexed(tenantA, h)));
    const unbound = await withClient(db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: reader }, () => getBlob(c, tenantA, h)),
    );
    const ungranted = await withClient(db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: stranger, tenantId: tenantA }, () =>
        getBlob(c, tenantA, h),
      ),
    );
    expect([unbound, ungranted]).toEqual([null, null]);
    expect(await ownerRows(tenantA, h)).toHaveLength(1);
  });
});
