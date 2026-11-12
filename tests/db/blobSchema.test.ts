import { randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  freshDatabase,
  INSUFFICIENT_PRIVILEGE,
  queryRows,
  sqlState,
  withClient,
  type FreshDatabase,
} from '../helpers/db.js';
import { inBoundTransaction } from '../helpers/tenancy.js';

// The shape of the two content-addressed tables migration 0005 creates, read
// back from the applied database rather than from the migration file.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const MUST_BE_OWNER = '42501';

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

function hash(length: 40 | 64 = 40): string {
  return randomBytes(length / 2).toString('hex');
}

async function tenant(owner: pg.Client, name = 'Tenant'): Promise<string> {
  const id = randomUUID();
  await owner.query('INSERT INTO codegraph.tenants (id, display_name) VALUES ($1, $2)', [id, name]);
  return id;
}

interface BlobRow {
  outcome: string;
  size_bytes?: number;
  parsed_with_errors?: boolean | null;
  lossy?: boolean | null;
  refused_cap_bytes?: number | null;
  language?: string | null;
  extractor_version?: string | null;
}

const INDEXED: BlobRow = {
  outcome: 'indexed',
  language: 'python',
  extractor_version: 'python@1',
  parsed_with_errors: false,
  lossy: false,
};
const UNSUPPORTED: BlobRow = { outcome: 'unsupported', lossy: false };
const BINARY: BlobRow = { outcome: 'binary' };
const REFUSED: BlobRow = { outcome: 'refused', refused_cap_bytes: 1_048_576 };

const INSERT_BLOB = `INSERT INTO codegraph.blob
  (tenant_id, git_blob_hash, size_bytes, outcome, parsed_with_errors, lossy, refused_cap_bytes, language, extractor_version)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

function blobParams(tenantId: string, gitBlobHash: string, row: BlobRow): unknown[] {
  return [
    tenantId,
    gitBlobHash,
    row.size_bytes ?? 10,
    row.outcome,
    row.parsed_with_errors ?? null,
    row.lossy ?? null,
    row.refused_cap_bytes ?? null,
    row.language ?? null,
    row.extractor_version ?? null,
  ];
}

/** Runs `fn` as the owner inside a transaction that is always rolled back. */
async function asOwner(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  await withClient(db.ownerUrl, async (c) => {
    await c.query('BEGIN');
    try {
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

describe('codegraph.blob', () => {
  it('carries exactly its nine columns, and no repository, path or blob reference', async () => {
    const columns = await withClient(db.ownerUrl, (c) =>
      queryRows<{ column_name: string; data_type: string; is_nullable: string }>(
        c,
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'codegraph' AND table_name = 'blob' ORDER BY ordinal_position`,
      ),
    );
    expect(columns).toEqual([
      { column_name: 'tenant_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'git_blob_hash', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'size_bytes', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'outcome', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'parsed_with_errors', data_type: 'boolean', is_nullable: 'YES' },
      { column_name: 'lossy', data_type: 'boolean', is_nullable: 'YES' },
      { column_name: 'refused_cap_bytes', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'language', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'extractor_version', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it('is keyed by (tenant_id, git_blob_hash): a second tenant may store the same hash, the same tenant may not', async () => {
    await asOwner(async (c) => {
      const a = await tenant(c, 'A');
      const b = await tenant(c, 'B');
      const h = hash();
      expect(await sqlState(c, INSERT_BLOB, blobParams(a, h, BINARY))).toBeNull();
      expect(await sqlState(c, INSERT_BLOB, blobParams(a, h, BINARY))).toBe(UNIQUE_VIOLATION);
      expect(await sqlState(c, INSERT_BLOB, blobParams(b, h, BINARY))).toBeNull();
    });
  });

  it('admits a 40- or 64-character lowercase hex git object id and nothing else', async () => {
    await asOwner(async (c) => {
      const a = await tenant(c);
      expect(await sqlState(c, INSERT_BLOB, blobParams(a, hash(40), BINARY))).toBeNull();
      expect(await sqlState(c, INSERT_BLOB, blobParams(a, hash(64), BINARY))).toBeNull();
      for (const bad of [hash().slice(0, 39), hash().toUpperCase(), `${hash()}0`, 'g'.repeat(40)]) {
        expect(await sqlState(c, INSERT_BLOB, blobParams(a, bad, BINARY)), bad).toBe(
          CHECK_VIOLATION,
        );
      }
    });
  });

  it('refuses a missing tenant, a negative size and a non-positive cap', async () => {
    await asOwner(async (c) => {
      const a = await tenant(c);
      expect(await sqlState(c, INSERT_BLOB, blobParams(randomUUID(), hash(), BINARY))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      expect(
        await sqlState(c, INSERT_BLOB, blobParams(a, hash(), { ...BINARY, size_bytes: -1 })),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(c, INSERT_BLOB, blobParams(a, hash(), { ...REFUSED, refused_cap_bytes: 0 })),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(c, INSERT_BLOB, blobParams(a, hash(), { outcome: null as never })),
      ).toBe(NOT_NULL_VIOLATION);
    });
  });

  it('admits exactly the four outcomes', async () => {
    await asOwner(async (c) => {
      const a = await tenant(c);
      for (const row of [INDEXED, UNSUPPORTED, BINARY, REFUSED]) {
        expect(await sqlState(c, INSERT_BLOB, blobParams(a, hash(), row)), row.outcome).toBeNull();
      }
      expect(await sqlState(c, INSERT_BLOB, blobParams(a, hash(), { outcome: 'skipped' }))).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  it('couples each outcome to the columns it uses, in both directions', async () => {
    const admitted: BlobRow[] = [
      INDEXED,
      { ...INDEXED, parsed_with_errors: true, lossy: true },
      UNSUPPORTED,
      { ...UNSUPPORTED, language: 'swift' },
      BINARY,
      REFUSED,
    ];
    const refused: [string, BlobRow][] = [
      ['indexed without a language', { ...INDEXED, language: null }],
      ['indexed without a version', { ...INDEXED, extractor_version: null }],
      ['indexed without parsed_with_errors', { ...INDEXED, parsed_with_errors: null }],
      ['indexed without lossy', { ...INDEXED, lossy: null }],
      ['indexed with a cap', { ...INDEXED, refused_cap_bytes: 10 }],
      ['unsupported without lossy', { ...UNSUPPORTED, lossy: null }],
      ['unsupported with a version', { ...UNSUPPORTED, extractor_version: 'swift@1' }],
      ['unsupported with parsed_with_errors', { ...UNSUPPORTED, parsed_with_errors: false }],
      ['unsupported with a cap', { ...UNSUPPORTED, refused_cap_bytes: 10 }],
      ['binary with a language', { ...BINARY, language: 'python' }],
      ['binary with lossy', { ...BINARY, lossy: false }],
      ['binary with a version', { ...BINARY, extractor_version: 'python@1' }],
      ['binary with parsed_with_errors', { ...BINARY, parsed_with_errors: false }],
      ['binary with a cap', { ...BINARY, refused_cap_bytes: 10 }],
      ['refused without a cap', { ...REFUSED, refused_cap_bytes: null }],
      ['refused with a language', { ...REFUSED, language: 'python' }],
      ['refused with lossy', { ...REFUSED, lossy: false }],
      ['refused with a version', { ...REFUSED, extractor_version: 'python@1' }],
      ['refused with parsed_with_errors', { ...REFUSED, parsed_with_errors: true }],
    ];
    await asOwner(async (c) => {
      const a = await tenant(c);
      for (const row of admitted) {
        expect(
          await sqlState(c, INSERT_BLOB, blobParams(a, hash(), row)),
          JSON.stringify(row),
        ).toBe(null);
      }
      for (const [name, row] of refused) {
        expect(await sqlState(c, INSERT_BLOB, blobParams(a, hash(), row)), name).toBe(
          CHECK_VIOLATION,
        );
      }
    });
  });

  it('carries the named checks, the tenant foreign key and the language/version index', async () => {
    const shape = await withClient(db.ownerUrl, async (c) => ({
      constraints: await queryRows<{ conname: string; contype: string }>(
        c,
        `SELECT conname, contype FROM pg_constraint
          WHERE conrelid = 'codegraph.blob'::regclass ORDER BY conname`,
      ),
      fkey: await queryRows(
        c,
        `SELECT n.nspname || '.' || t.relname AS target, confdeltype FROM pg_constraint
           JOIN pg_class t ON t.oid = confrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE conname = 'blob_tenant_fkey'`,
      ),
      index: await queryRows<{ indexdef: string }>(
        c,
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'codegraph' AND indexname = 'blob_language_version_idx'`,
      ),
    }));
    expect(shape.constraints).toEqual([
      { conname: 'blob_git_blob_hash_check', contype: 'c' },
      { conname: 'blob_outcome_check', contype: 'c' },
      { conname: 'blob_outcome_columns_check', contype: 'c' },
      { conname: 'blob_pkey', contype: 'p' },
      { conname: 'blob_refused_cap_check', contype: 'c' },
      { conname: 'blob_size_bytes_check', contype: 'c' },
      { conname: 'blob_tenant_fkey', contype: 'f' },
    ]);
    expect(shape.fkey).toEqual([{ target: 'codegraph.tenants', confdeltype: 'c' }]);
    expect(shape.index.map((r) => r.indexdef)).toEqual([
      'CREATE INDEX blob_language_version_idx ON codegraph.blob USING btree (tenant_id, language, extractor_version)',
    ]);
  });
});

describe('codegraph.blob_contents', () => {
  const INSERT_CONTENTS =
    'INSERT INTO codegraph.blob_contents (tenant_id, git_blob_hash, contents) VALUES ($1, $2, $3)';

  it('holds one text row per blob, refuses an orphan, and goes with its blob', async () => {
    await asOwner(async (c) => {
      const a = await tenant(c);
      const h = hash();
      expect(await sqlState(c, INSERT_CONTENTS, [a, h, 'orphan'])).toBe(FOREIGN_KEY_VIOLATION);
      await c.query(INSERT_BLOB, blobParams(a, h, UNSUPPORTED));
      expect(await sqlState(c, INSERT_CONTENTS, [a, h, 'print(1)\n'])).toBeNull();
      expect(await sqlState(c, INSERT_CONTENTS, [a, h, 'again'])).toBe(UNIQUE_VIOLATION);
      await c.query('DELETE FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = $2', [
        a,
        h,
      ]);
      const left = await queryRows(
        c,
        'SELECT 1 FROM codegraph.blob_contents WHERE tenant_id = $1',
        [a],
      );
      expect(left).toEqual([]);
    });
  });

  it('refuses a value carrying a NUL character', async () => {
    await asOwner(async (c) => {
      const a = await tenant(c);
      const h = hash();
      await c.query(INSERT_BLOB, blobParams(a, h, UNSUPPORTED));
      expect(await sqlState(c, INSERT_CONTENTS, [a, h, 'a\u0000b'])).not.toBeNull();
      const stored = await queryRows(
        c,
        'SELECT 1 FROM codegraph.blob_contents WHERE tenant_id = $1',
        [a],
      );
      expect(stored).toEqual([]);
    });
  });

  it('round-trips a large text value byte for byte', async () => {
    await asOwner(async (c) => {
      const a = await tenant(c);
      const h = hash();
      const text = `// ünïcödé ✓\n${'const x = 1;\n'.repeat(20_000)}`;
      await c.query(INSERT_BLOB, blobParams(a, h, UNSUPPORTED));
      await c.query(INSERT_CONTENTS, [a, h, text]);
      const [row] = await queryRows<{ contents: string; method: string | null }>(
        c,
        `SELECT contents, pg_column_compression(contents) AS method
           FROM codegraph.blob_contents WHERE tenant_id = $1`,
        [a],
      );
      expect(Buffer.from(row?.contents ?? '', 'utf8').equals(Buffer.from(text, 'utf8'))).toBe(true);
      expect(row?.method).toBe('lz4');
    });
  });

  it('declares lz4 on the column and a GIN trigram index over it', async () => {
    const shape = await withClient(db.ownerUrl, async (c) => ({
      column: await queryRows(
        c,
        `SELECT a.attcompression::text AS compression, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a
          WHERE a.attrelid = 'codegraph.blob_contents'::regclass AND a.attname = 'contents'`,
      ),
      index: await queryRows(
        c,
        `SELECT am.amname AS method, opc.opcname AS opclass, opn.nspname AS opclass_schema
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_am am ON am.oid = ic.relam
           JOIN pg_opclass opc ON opc.oid = i.indclass[0]
           JOIN pg_namespace opn ON opn.oid = opc.opcnamespace
          WHERE ic.relname = 'blob_contents_contents_trgm_idx'`,
      ),
      fkey: await queryRows(
        c,
        `SELECT n.nspname || '.' || t.relname AS target, confdeltype FROM pg_constraint
           JOIN pg_class t ON t.oid = confrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE conname = 'blob_contents_blob_fkey'`,
      ),
    }));
    expect(shape.column).toEqual([{ compression: 'l', type: 'text' }]);
    expect(shape.index).toEqual([
      { method: 'gin', opclass: 'gin_trgm_ops', opclass_schema: 'codegraph' },
    ]);
    expect(shape.fkey).toEqual([{ target: 'codegraph.blob', confdeltype: 'c' }]);
  });
});

describe('row-level security and grants on both tables', () => {
  it('forces row-level security with exactly the app and owner policies', async () => {
    const shape = await withClient(db.ownerUrl, async (c) => {
      await c.query('SET search_path = pg_catalog');
      return {
        tables: await queryRows(
          c,
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'codegraph' AND c.relname IN ('blob', 'blob_contents') ORDER BY 1`,
        ),
        policies: await queryRows(
          c,
          `SELECT tablename, policyname, roles::text[] AS roles, qual, with_check FROM pg_policies
            WHERE schemaname = 'codegraph' AND tablename IN ('blob', 'blob_contents')
            ORDER BY tablename, policyname`,
        ),
      };
    });
    expect(shape.tables).toEqual([
      { relname: 'blob', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'blob_contents', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const bound =
      '(tenant_id = ( SELECT codegraph.codegraph_bound_tenant() AS codegraph_bound_tenant))';
    expect(shape.policies).toEqual(
      ['blob', 'blob_contents'].flatMap((table) => [
        {
          tablename: table,
          policyname: `${table}_owner`,
          roles: ['codegraph_owner'],
          qual: 'true',
          with_check: 'true',
        },
        {
          tablename: table,
          policyname: `${table}_tenant`,
          roles: ['codegraph_app'],
          qual: bound,
          with_check: bound,
        },
      ]),
    );
  });

  it('lets codegraph_app read and write only the bound tenant’s rows', async () => {
    const ids = await withClient(db.ownerUrl, async (c) => {
      const a = await tenant(c, 'A');
      const b = await tenant(c, 'B');
      const client = randomUUID();
      await c.query("INSERT INTO codegraph.clients (id, name, kind) VALUES ($1, 'r', 'client')", [
        client,
      ]);
      await c.query('INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
        client,
        a,
      ]);
      const h = hash();
      for (const t of [a, b]) {
        await c.query(INSERT_BLOB, blobParams(t, h, UNSUPPORTED));
        await c.query(
          'INSERT INTO codegraph.blob_contents (tenant_id, git_blob_hash, contents) VALUES ($1, $2, $3)',
          [t, h, `contents of ${t}`],
        );
      }
      return { a, b, client, h };
    });
    try {
      await withClient(db.appUrl, async (c) => {
        const seen = await inBoundTransaction(
          c,
          { clientId: ids.client, tenantId: ids.a },
          async () => ({
            blob: await queryRows(c, 'SELECT tenant_id FROM codegraph.blob'),
            contents: await queryRows(c, 'SELECT tenant_id, contents FROM codegraph.blob_contents'),
            writeOther: await sqlState(c, INSERT_BLOB, blobParams(ids.b, hash(), BINARY)),
            writeOwn: await sqlState(c, INSERT_BLOB, blobParams(ids.a, hash(), BINARY)),
            updateOwn: await sqlState(
              c,
              "UPDATE codegraph.blob SET outcome = 'unsupported', language = 'swift', lossy = true WHERE tenant_id = $1",
              [ids.a],
            ),
            updateSize: await sqlState(c, 'UPDATE codegraph.blob SET size_bytes = 1'),
            updateContents: await sqlState(c, "UPDATE codegraph.blob_contents SET contents = 'x'"),
            truncate: await sqlState(c, 'TRUNCATE codegraph.blob_contents'),
          }),
        );
        expect(seen.blob).toEqual([{ tenant_id: ids.a }]);
        expect(seen.contents).toEqual([{ tenant_id: ids.a, contents: `contents of ${ids.a}` }]);
        expect(seen.writeOther).toBe('42501');
        expect(seen.writeOwn).toBeNull();
        expect(seen.updateOwn).toBeNull();
        expect(seen.updateSize).toBe(INSUFFICIENT_PRIVILEGE);
        expect(seen.updateContents).toBe(INSUFFICIENT_PRIVILEGE);
        expect(seen.truncate).toBe(INSUFFICIENT_PRIVILEGE);

        const unbound = await inBoundTransaction(c, {}, async () => ({
          blob: await queryRows(c, 'SELECT 1 FROM codegraph.blob'),
          contents: await queryRows(c, 'SELECT 1 FROM codegraph.blob_contents'),
        }));
        expect(unbound).toEqual({ blob: [], contents: [] });

        await c.query('BEGIN');
        for (const table of ['blob', 'blob_contents']) {
          expect(
            await sqlState(c, `ALTER TABLE codegraph.${table} DISABLE ROW LEVEL SECURITY`),
          ).toBe(MUST_BE_OWNER);
        }
        await c.query('ROLLBACK');
      });
    } finally {
      await withClient(db.ownerUrl, (c) =>
        c.query('DELETE FROM codegraph.tenants WHERE id = ANY($1)', [[ids.a, ids.b]]),
      );
    }
  });

  it('holds exactly SELECT, INSERT, DELETE on both tables and UPDATE on six blob columns', async () => {
    const grants = await withClient(db.appUrl, async (c) => ({
      table: await queryRows<{ table: string; privilege: string }>(
        c,
        `SELECT t AS table, p AS privilege FROM unnest(ARRAY['blob', 'blob_contents']) t,
                unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
          WHERE has_table_privilege('codegraph.' || t, p) ORDER BY 1, 2`,
      ),
      columns: await queryRows<{ table: string; column: string }>(
        c,
        `SELECT table_name AS table, column_name AS column FROM information_schema.columns
          WHERE table_schema = 'codegraph' AND table_name IN ('blob', 'blob_contents')
            AND has_column_privilege('codegraph.' || table_name, column_name, 'UPDATE')
          ORDER BY 1, 2`,
      ),
    }));
    expect(grants.table).toEqual([
      { table: 'blob', privilege: 'DELETE' },
      { table: 'blob', privilege: 'INSERT' },
      { table: 'blob', privilege: 'SELECT' },
      { table: 'blob_contents', privilege: 'DELETE' },
      { table: 'blob_contents', privilege: 'INSERT' },
      { table: 'blob_contents', privilege: 'SELECT' },
    ]);
    expect(grants.columns).toEqual(
      [
        'extractor_version',
        'language',
        'lossy',
        'outcome',
        'parsed_with_errors',
        'refused_cap_bytes',
      ].map((column) => ({ table: 'blob', column })),
    );
  });

  it('adds no function and no default privilege', async () => {
    const rows = await withClient(db.ownerUrl, async (c) => ({
      functions: await queryRows<{ proname: string }>(
        c,
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
          WHERE n.nspname = 'codegraph' AND d.objid IS NULL ORDER BY 1`,
      ),
      defaults: await queryRows(c, 'SELECT 1 FROM pg_default_acl'),
    }));
    expect(rows.functions.every((f) => f.proname.startsWith('codegraph_'))).toBe(true);
    expect(rows.defaults).toEqual([]);
  });
});
