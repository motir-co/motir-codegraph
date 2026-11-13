import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checksum, MIGRATIONS_DIR, readMigrations } from '../../src/db/migrate.js';
import {
  freshDatabase,
  queryRows,
  sqlState,
  withClient,
  type FreshDatabase,
} from '../helpers/db.js';
import { queueTenant, sha, type QueueTenant } from '../helpers/queue.js';

// The shape of the two tables migration 0010 creates — index_jobs and
// index_job_batches — read back from the applied database, each invariant
// beside the negative case it exists for. The claim function is
// tests/db/claimIndexJob.test.ts's; bound-session isolation and cascade
// deletion over a bound session are the integration gate's.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

const FILE = '0010_index_queue.sql';
const TABLES = ['index_job_batches', 'index_jobs'] as const;

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

/** Runs `fn` as the owner inside a transaction that is always rolled back. */
async function asOwner(fn: (c: pg.Client, t: QueueTenant) => Promise<void>): Promise<void> {
  await withClient(db.ownerUrl, async (c) => {
    await c.query('BEGIN');
    try {
      await fn(c, await queueTenant(c, 2));
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

interface JobColumns {
  kind?: string;
  commit_sha?: string | null;
  ref_name?: string | null;
  is_default_branch?: boolean;
  candidate_ancestors?: string[];
  changed_paths?: string[];
  fetch_url?: string | null;
  state?: string;
  lease_expires_at?: string | null;
  claimed_by?: string | null;
  failure_reason_code?: string | null;
  failure_message?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  attempts?: number;
  repository_id?: string;
}

const REQUEST: JobColumns = {
  kind: 'push',
  ref_name: 'refs/heads/main',
  fetch_url: 'https://example.test/a.tar.gz',
};

const INSERT_JOB = `INSERT INTO codegraph.index_jobs
  (id, tenant_id, repository_id, client_id, kind, commit_sha, ref_name, is_default_branch,
   candidate_ancestors, changed_paths, fetch_url, state, lease_expires_at, claimed_by,
   failure_reason_code, failure_message, enqueued_at, started_at, ended_at, attempts)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12,
          $13::timestamptz, $14, $15, $16, '2026-01-01T00:00:00Z', $17::timestamptz,
          $18::timestamptz, $19)`;

function jobParams(t: QueueTenant, row: JobColumns, id = randomUUID()): unknown[] {
  const pick = <K extends keyof JobColumns>(k: K, fallback: JobColumns[K]) =>
    k in row ? row[k] : fallback;
  return [
    id,
    t.tenantId,
    row.repository_id ?? t.repositoryId,
    t.clientId,
    row.kind ?? 'first_index',
    pick('commit_sha', sha()),
    pick('ref_name', 'refs/heads/main'),
    row.is_default_branch ?? false,
    row.candidate_ancestors ?? [],
    row.changed_paths ?? [],
    pick('fetch_url', 'https://example.test/src.tar.gz'),
    row.state ?? 'queued',
    row.lease_expires_at ?? null,
    row.claimed_by ?? null,
    row.failure_reason_code ?? null,
    row.failure_message ?? null,
    row.started_at ?? null,
    row.ended_at ?? null,
    row.attempts ?? 0,
  ];
}

/** Whether a job row with these columns is accepted (null) or the SQLSTATE refusing it. */
function job(c: pg.Client, t: QueueTenant, row: JobColumns = {}): Promise<string | null> {
  return sqlState(c, INSERT_JOB, jobParams(t, row));
}

async function insertJob(c: pg.Client, t: QueueTenant, row: JobColumns = {}): Promise<string> {
  const id = randomUUID();
  await c.query(INSERT_JOB, jobParams(t, row, id));
  return id;
}

const RUNNING = {
  state: 'running',
  started_at: '2026-01-01T00:01:00Z',
  lease_expires_at: '2026-01-01T00:02:00Z',
  claimed_by: 'token',
} as const;

const MAINTENANCE = { commit_sha: null, ref_name: null, fetch_url: null } as const;

interface BatchColumns {
  ordinal?: number;
  paths?: (string | null)[];
  git_blob_hashes?: (string | null)[];
  state?: string;
  stored_count?: number;
  lease_expires_at?: string | null;
  claimed_by?: string | null;
  failure_reason_code?: string | null;
  failure_message?: string | null;
  ended_at?: string | null;
  attempts?: number;
}

const INSERT_BATCH = `INSERT INTO codegraph.index_job_batches
  (tenant_id, repository_id, job_id, ordinal, paths, git_blob_hashes, state, stored_count,
   lease_expires_at, claimed_by, failure_reason_code, failure_message, enqueued_at, ended_at,
   attempts)
  VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9::timestamptz, $10, $11, $12,
          '2026-01-01T00:00:00Z', $13::timestamptz, $14)`;

function batch(
  c: pg.Client,
  t: QueueTenant,
  jobId: string,
  row: BatchColumns = {},
): Promise<string | null> {
  return sqlState(c, INSERT_BATCH, [
    t.tenantId,
    t.repositoryId,
    jobId,
    row.ordinal ?? 1,
    row.paths ?? ['a.ts', 'b.ts'],
    row.git_blob_hashes ?? [sha(), sha()],
    row.state ?? 'queued',
    row.stored_count ?? 0,
    row.lease_expires_at ?? null,
    row.claimed_by ?? null,
    row.failure_reason_code ?? null,
    row.failure_message ?? null,
    row.ended_at ?? null,
    row.attempts ?? 0,
  ]);
}

describe('migration 0010', () => {
  it('applies after 0009, is recorded with its checksum, and re-runs as a no-op', async () => {
    const files = await readMigrations(MIGRATIONS_DIR);
    const names = files.map((f) => f.name);
    expect(names.indexOf(FILE)).toBe(names.indexOf('0009_tenancy_and_ref_text_whitespace.sql') + 1);
    const file = files.find((f) => f.name === FILE);

    const snapshot = (c: pg.Client) =>
      queryRows(
        c,
        `SELECT
          (SELECT json_agg(x ORDER BY x.table_name, x.ordinal_position) FROM (
             SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
             FROM information_schema.columns WHERE table_schema = 'codegraph') x) AS columns,
          (SELECT json_agg(x ORDER BY x.conname) FROM (
             SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE connamespace = 'codegraph'::regnamespace) x) AS constraints,
          (SELECT json_agg(x ORDER BY x.indexname) FROM (
             SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'codegraph') x) AS indexes,
          (SELECT json_agg(x ORDER BY x.proname) FROM (
             SELECT proname, prosrc FROM pg_proc
             WHERE pronamespace = 'codegraph'::regnamespace) x) AS functions,
          (SELECT json_agg(x ORDER BY x.tablename, x.policyname) FROM (
             SELECT tablename, policyname, roles, qual, with_check FROM pg_policies
             WHERE schemaname = 'codegraph') x) AS policies`,
      );

    const before = await withClient(db.ownerUrl, async (c) => ({
      recorded: await queryRows<{ name: string; checksum: string }>(
        c,
        'SELECT name, checksum FROM codegraph.schema_migrations WHERE name = $1',
        [FILE],
      ),
      catalogue: await snapshot(c),
    }));
    expect(before.recorded).toEqual([{ name: FILE, checksum: checksum(file?.sql ?? '') }]);

    const again = await db.migrate({ log: () => undefined });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual(names);
    expect(await withClient(db.ownerUrl, snapshot)).toEqual(before.catalogue);
  });
});

describe('the declared shape', () => {
  it('carries exactly the columns each table declares', async () => {
    const columns = await withClient(db.ownerUrl, (c) =>
      queryRows<{ table: string; column: string; type: string; nullable: string }>(
        c,
        `SELECT table_name AS table, column_name AS column, udt_name AS type, is_nullable AS nullable
           FROM information_schema.columns
          WHERE table_schema = 'codegraph' AND table_name = ANY($1)
          ORDER BY table_name, ordinal_position`,
        [TABLES],
      ),
    );
    const t = (table: string, rows: [string, string, string][]) =>
      rows.map(([column, type, nullable]) => ({ table, column, type, nullable }));
    expect(columns).toEqual([
      ...t('index_job_batches', [
        ['id', 'uuid', 'NO'],
        ['tenant_id', 'uuid', 'NO'],
        ['repository_id', 'uuid', 'NO'],
        ['job_id', 'uuid', 'NO'],
        ['ordinal', 'int4', 'NO'],
        ['paths', '_text', 'NO'],
        ['git_blob_hashes', '_text', 'NO'],
        ['state', 'text', 'NO'],
        ['attempts', 'int4', 'NO'],
        ['lease_expires_at', 'timestamptz', 'YES'],
        ['claimed_by', 'text', 'YES'],
        ['stored_count', 'int4', 'NO'],
        ['failure_reason_code', 'text', 'YES'],
        ['failure_message', 'text', 'YES'],
        ['enqueued_at', 'timestamptz', 'NO'],
        ['ended_at', 'timestamptz', 'YES'],
      ]),
      ...t('index_jobs', [
        ['id', 'uuid', 'NO'],
        ['tenant_id', 'uuid', 'NO'],
        ['repository_id', 'uuid', 'NO'],
        ['client_id', 'uuid', 'NO'],
        ['kind', 'text', 'NO'],
        ['commit_sha', 'text', 'YES'],
        ['ref_name', 'text', 'YES'],
        ['is_default_branch', 'bool', 'NO'],
        ['candidate_ancestors', '_text', 'NO'],
        ['changed_paths', '_text', 'NO'],
        ['fetch_url', 'text', 'YES'],
        ['state', 'text', 'NO'],
        ['attempts', 'int4', 'NO'],
        ['lease_expires_at', 'timestamptz', 'YES'],
        ['claimed_by', 'text', 'YES'],
        ['failure_reason_code', 'text', 'YES'],
        ['failure_message', 'text', 'YES'],
        ['enqueued_at', 'timestamptz', 'NO'],
        ['started_at', 'timestamptz', 'YES'],
        ['ended_at', 'timestamptz', 'YES'],
      ]),
    ]);
  });

  it('declares every named constraint, and each foreign key with its columns, target and delete action', async () => {
    const shape = await withClient(db.ownerUrl, async (c) => ({
      constraints: await queryRows<{ conname: string; contype: string }>(
        c,
        // PostgreSQL 18 records NOT NULL as pg_constraint rows (contype 'n').
        `SELECT conname, contype FROM pg_constraint
          WHERE conrelid = ANY (ARRAY['codegraph.index_jobs',
                                      'codegraph.index_job_batches']::regclass[])
            AND contype <> 'n'
          ORDER BY 1`,
      ),
      foreignKeys: await queryRows(
        c,
        `SELECT k.conname,
                ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, i)
                        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n
                       ORDER BY u.i) AS columns,
                (SELECT n.nspname || '.' || r.relname FROM pg_class r
                   JOIN pg_namespace n ON n.oid = r.relnamespace WHERE r.oid = k.confrelid) AS target,
                ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, i)
                        JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n
                       ORDER BY u.i) AS target_columns,
                k.confdeltype AS on_delete
           FROM pg_constraint k
          WHERE k.contype = 'f'
            AND k.conrelid = ANY (ARRAY['codegraph.index_jobs',
                                        'codegraph.index_job_batches']::regclass[])
          ORDER BY 1`,
      ),
    }));
    expect(shape.constraints).toEqual(
      [
        ['index_job_batches_attempts_check', 'c'],
        ['index_job_batches_failure_check', 'c'],
        ['index_job_batches_job_fkey', 'f'],
        ['index_job_batches_job_ordinal_key', 'u'],
        ['index_job_batches_ordinal_check', 'c'],
        ['index_job_batches_pkey', 'p'],
        ['index_job_batches_repository_fkey', 'f'],
        ['index_job_batches_slice_check', 'c'],
        ['index_job_batches_state_check', 'c'],
        ['index_job_batches_state_lease_check', 'c'],
        ['index_job_batches_state_times_check', 'c'],
        ['index_job_batches_stored_count_check', 'c'],
        ['index_jobs_attempts_check', 'c'],
        ['index_jobs_commit_sha_check', 'c'],
        ['index_jobs_failure_check', 'c'],
        ['index_jobs_fetch_url_check', 'c'],
        ['index_jobs_kind_check', 'c'],
        ['index_jobs_kind_columns_check', 'c'],
        ['index_jobs_pkey', 'p'],
        ['index_jobs_ref_name_check', 'c'],
        ['index_jobs_repository_fkey', 'f'],
        ['index_jobs_state_check', 'c'],
        ['index_jobs_state_lease_check', 'c'],
        ['index_jobs_state_times_check', 'c'],
        ['index_jobs_tenant_repository_id_key', 'u'],
      ].map(([conname, contype]) => ({ conname, contype })),
    );
    const pair = ['tenant_id', 'repository_id'];
    expect(shape.foreignKeys).toEqual([
      {
        conname: 'index_job_batches_job_fkey',
        columns: [...pair, 'job_id'],
        target: 'codegraph.index_jobs',
        target_columns: [...pair, 'id'],
        on_delete: 'c',
      },
      {
        conname: 'index_job_batches_repository_fkey',
        columns: pair,
        target: 'codegraph.repositories',
        target_columns: ['tenant_id', 'id'],
        on_delete: 'c',
      },
      {
        conname: 'index_jobs_repository_fkey',
        columns: pair,
        target: 'codegraph.repositories',
        target_columns: ['tenant_id', 'id'],
        on_delete: 'c',
      },
    ]);
  });

  it('declares every index, each pair key backed by one leading with the pair', async () => {
    const indexes = await withClient(db.ownerUrl, (c) =>
      queryRows<{ indexname: string; indexdef: string }>(
        c,
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'codegraph' AND tablename = ANY($1) ORDER BY indexname`,
        [TABLES],
      ),
    );
    const on = (table: string) => `ON codegraph.${table} USING btree`;
    const running = "WHERE (state = 'running'::text)";
    const queued = "WHERE (state = 'queued'::text)";
    expect(indexes).toEqual(
      [
        [
          'index_job_batches_job_ordinal_key',
          `CREATE UNIQUE INDEX index_job_batches_job_ordinal_key ${on('index_job_batches')} (tenant_id, repository_id, job_id, ordinal)`,
        ],
        [
          'index_job_batches_lease_idx',
          `CREATE INDEX index_job_batches_lease_idx ${on('index_job_batches')} (lease_expires_at) ${running}`,
        ],
        [
          'index_job_batches_pkey',
          `CREATE UNIQUE INDEX index_job_batches_pkey ${on('index_job_batches')} (id)`,
        ],
        [
          'index_job_batches_queued_idx',
          `CREATE INDEX index_job_batches_queued_idx ${on('index_job_batches')} (state, job_id, ordinal) ${queued}`,
        ],
        [
          'index_jobs_lease_idx',
          `CREATE INDEX index_jobs_lease_idx ${on('index_jobs')} (lease_expires_at) ${running}`,
        ],
        [
          'index_jobs_one_running_per_repository',
          `CREATE UNIQUE INDEX index_jobs_one_running_per_repository ${on('index_jobs')} (tenant_id, repository_id) ${running}`,
        ],
        ['index_jobs_pkey', `CREATE UNIQUE INDEX index_jobs_pkey ${on('index_jobs')} (id)`],
        [
          'index_jobs_queued_idx',
          `CREATE INDEX index_jobs_queued_idx ${on('index_jobs')} (enqueued_at, id) ${queued}`,
        ],
        [
          'index_jobs_queued_push_ref_idx',
          `CREATE INDEX index_jobs_queued_push_ref_idx ${on('index_jobs')} (tenant_id, repository_id, ref_name) WHERE ((kind = 'push'::text) AND (state = 'queued'::text))`,
        ],
        [
          'index_jobs_repository_state_idx',
          `CREATE INDEX index_jobs_repository_state_idx ${on('index_jobs')} (tenant_id, repository_id, state)`,
        ],
        [
          'index_jobs_tenant_repository_id_key',
          `CREATE UNIQUE INDEX index_jobs_tenant_repository_id_key ${on('index_jobs')} (tenant_id, repository_id, id)`,
        ],
      ].map(([indexname, indexdef]) => ({ indexname, indexdef })),
    );
  });

  it('forces row-level security with exactly the app and owner policies on both tables', async () => {
    const shape = await withClient(db.ownerUrl, async (c) => {
      await c.query('SET search_path = pg_catalog');
      return {
        tables: await queryRows(
          c,
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'codegraph' AND c.relname = ANY($1) ORDER BY 1`,
          [TABLES],
        ),
        policies: await queryRows(
          c,
          `SELECT tablename, policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
             FROM pg_policies
            WHERE schemaname = 'codegraph' AND tablename = ANY($1)
            ORDER BY tablename, policyname`,
          [TABLES],
        ),
      };
    });
    expect(shape.tables).toEqual(
      TABLES.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
    );
    const bound =
      '(tenant_id = ( SELECT codegraph.codegraph_bound_tenant() AS codegraph_bound_tenant))';
    expect(shape.policies).toEqual(
      TABLES.flatMap((table) => [
        {
          tablename: table,
          policyname: `${table}_owner`,
          cmd: 'ALL',
          permissive: 'PERMISSIVE',
          roles: ['codegraph_owner'],
          qual: 'true',
          with_check: 'true',
        },
        {
          tablename: table,
          policyname: `${table}_tenant`,
          cmd: 'ALL',
          permissive: 'PERMISSIVE',
          roles: ['codegraph_app'],
          qual: bound,
          with_check: bound,
        },
      ]),
    );
  });

  it('grants codegraph_app exactly the per-verb and per-column matrix, and adds no trigger', async () => {
    const grants = await withClient(db.appUrl, async (c) => ({
      table: await queryRows<{ table: string; privilege: string }>(
        c,
        `SELECT t AS table, p AS privilege FROM unnest($1::text[]) t,
                unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
          WHERE has_table_privilege('codegraph.' || t, p) ORDER BY 1, 2`,
        [TABLES],
      ),
      columns: await queryRows<{ table: string; column: string; privilege: string }>(
        c,
        `SELECT table_name AS table, column_name AS column, p AS privilege
           FROM information_schema.columns,
                unnest(ARRAY['UPDATE','REFERENCES']) p
          WHERE table_schema = 'codegraph' AND table_name = ANY($1)
            AND has_column_privilege('codegraph.' || table_name, column_name, p)
          ORDER BY 1, 3, 2`,
        [TABLES],
      ),
      defaults: await queryRows(c, 'SELECT 1 FROM pg_default_acl'),
    }));
    expect(grants.table).toEqual(
      TABLES.flatMap((table) =>
        ['DELETE', 'INSERT', 'SELECT'].map((privilege) => ({ table, privilege })),
      ),
    );
    const updatable = {
      index_job_batches: [
        'claimed_by',
        'ended_at',
        'failure_message',
        'failure_reason_code',
        'lease_expires_at',
        'state',
        'stored_count',
      ],
      index_jobs: [
        'claimed_by',
        'ended_at',
        'failure_message',
        'failure_reason_code',
        'fetch_url',
        'lease_expires_at',
        'state',
      ],
    };
    expect(grants.columns).toEqual(
      TABLES.flatMap((table) =>
        updatable[table].map((column) => ({ table, column, privilege: 'UPDATE' })),
      ),
    );
    expect(grants.defaults).toEqual([]);
    const triggers = await withClient(db.ownerUrl, (c) =>
      queryRows(
        c,
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
            AND tgrelid = ANY (ARRAY['codegraph.index_jobs',
                                     'codegraph.index_job_batches']::regclass[])`,
      ),
    );
    expect(triggers).toEqual([]);
  });
});

describe('index_jobs invariants', () => {
  it('accepts exactly the six kinds and five states', async () => {
    await asOwner(async (c, t) => {
      for (const kind of ['first_index', 'push', 'refresh']) {
        expect(await job(c, t, { kind })).toBeNull();
      }
      expect(await job(c, t, { kind: 'compact', ref_name: null, fetch_url: null })).toBeNull();
      expect(await job(c, t, { kind: 'discard_stale', ...MAINTENANCE })).toBeNull();
      expect(await job(c, t, { kind: 'release', ...MAINTENANCE })).toBeNull();
      expect(await job(c, t, { kind: 'reextract', ...MAINTENANCE })).toBe(CHECK_VIOLATION);

      const ended = { ended_at: '2026-01-01T00:05:00Z', fetch_url: null };
      expect(await job(c, t, { state: 'succeeded', ...ended })).toBeNull();
      expect(await job(c, t, { state: 'superseded', ...ended })).toBeNull();
      expect(
        await job(c, t, { state: 'failed', ...ended, failure_reason_code: 'fetch_failed' }),
      ).toBeNull();
      expect(await job(c, t, { state: 'cancelled', ...ended })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { repository_id: t.repositoryIds[1] as string, ...RUNNING })).toBe(
        null,
      );
    });
  });

  it('refuses a kind whose columns disagree with it', async () => {
    await asOwner(async (c, t) => {
      // A request kind needs a commit, a ref and (queued) a fetch URL.
      expect(await job(c, t, { ...REQUEST, commit_sha: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...REQUEST, ref_name: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...REQUEST, fetch_url: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...REQUEST, fetch_url: '' })).toBe(CHECK_VIOLATION);
      // A push may carry its previous head and its changed paths.
      expect(
        await job(c, t, { ...REQUEST, candidate_ancestors: [sha()], changed_paths: ['a.ts'] }),
      ).toBeNull();
      expect(await job(c, t, { ...REQUEST, changed_paths: ['a.ts', null as never] })).toBe(
        CHECK_VIOLATION,
      );
      // compact carries its commit and nothing else.
      const compact = { kind: 'compact', ref_name: null, fetch_url: null };
      expect(await job(c, t, { ...compact, commit_sha: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...compact, ref_name: 'refs/heads/main' })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...compact, fetch_url: 'https://x.test/a' })).toBe(CHECK_VIOLATION);
      // discard_stale and release carry no commit, ref, ancestors or paths.
      for (const kind of ['discard_stale', 'release']) {
        const base = { kind, ...MAINTENANCE };
        expect(await job(c, t, { ...base, commit_sha: sha() })).toBe(CHECK_VIOLATION);
        expect(await job(c, t, { ...base, ref_name: 'refs/heads/main' })).toBe(CHECK_VIOLATION);
        expect(await job(c, t, { ...base, candidate_ancestors: [sha()] })).toBe(CHECK_VIOLATION);
        expect(await job(c, t, { ...base, changed_paths: ['a.ts'] })).toBe(CHECK_VIOLATION);
        expect(await job(c, t, { ...base, is_default_branch: true })).toBe(CHECK_VIOLATION);
        expect(await job(c, t, { ...base, fetch_url: 'https://x.test/a' })).toBe(CHECK_VIOLATION);
      }
    });
  });

  it('keeps a commit a lowercase 40- or 64-hex id, a ref non-blank and attempts non-negative', async () => {
    await asOwner(async (c, t) => {
      expect(await job(c, t, { commit_sha: sha(64) })).toBeNull();
      expect(await job(c, t, { commit_sha: sha().toUpperCase() })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { commit_sha: 'abc' })).toBe(CHECK_VIOLATION);
      for (const blank of ['', '   ', '\t\n', ' ', '　﻿']) {
        expect(await job(c, t, { ref_name: blank })).toBe(CHECK_VIOLATION);
      }
      expect(await job(c, t, { ref_name: 'v' })).toBeNull();
      expect(await job(c, t, { attempts: -1 })).toBe(CHECK_VIOLATION);
    });
  });

  it('pins times, the lease, the fetch URL and the failure to the state', async () => {
    await asOwner(async (c, t) => {
      const end = '2026-01-01T00:05:00Z';
      // queued: no start, no end.
      expect(await job(c, t, { started_at: '2026-01-01T00:01:00Z' })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ended_at: end })).toBe(CHECK_VIOLATION);
      // running: a start and no end; both lease and token, or neither.
      expect(await job(c, t, { ...RUNNING, started_at: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...RUNNING, ended_at: end })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...RUNNING, claimed_by: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...RUNNING, lease_expires_at: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...RUNNING, fetch_url: null })).toBe(CHECK_VIOLATION);
      // Neither: fanned out to its batches.
      expect(await job(c, t, { ...RUNNING, lease_expires_at: null, claimed_by: null })).toBeNull();
      await c.query("DELETE FROM codegraph.index_jobs WHERE state = 'running'");
      // Ended: an end, never before its start, no lease, token or fetch URL.
      const ended = { state: 'succeeded', ended_at: end, fetch_url: null };
      expect(await job(c, t, { ...ended, started_at: '2026-01-01T00:01:00Z' })).toBeNull();
      expect(await job(c, t, { ...ended, ended_at: null })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...ended, started_at: '2026-01-01T00:06:00Z' })).toBe(
        CHECK_VIOLATION,
      );
      expect(await job(c, t, { ...ended, fetch_url: 'https://x.test/a' })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...ended, lease_expires_at: end })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...ended, claimed_by: 'token' })).toBe(CHECK_VIOLATION);
      // failed alone carries a reason code; no other state carries a code or a message.
      const failed = { ...ended, state: 'failed' };
      expect(await job(c, t, failed)).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { ...failed, failure_reason_code: 'Not A Code' })).toBe(
        CHECK_VIOLATION,
      );
      expect(await job(c, t, { ...ended, failure_reason_code: 'fetch_failed' })).toBe(
        CHECK_VIOLATION,
      );
      expect(await job(c, t, { ...ended, failure_message: 'why' })).toBe(CHECK_VIOLATION);
      expect(await job(c, t, { failure_reason_code: 'fetch_failed' })).toBe(CHECK_VIOLATION);
    });
  });

  it('refuses a second running job for one repository, and allows one per repository', async () => {
    await asOwner(async (c, t) => {
      await insertJob(c, t, RUNNING);
      expect(await job(c, t, { ...RUNNING, claimed_by: 'another' })).toBe(UNIQUE_VIOLATION);
      expect(await job(c, t, { ...RUNNING, lease_expires_at: null, claimed_by: null })).toBe(
        UNIQUE_VIOLATION,
      );
      expect(await job(c, t, { ...RUNNING, repository_id: t.repositoryIds[1] as string })).toBe(
        null,
      );
    });
  });

  it('refuses a repository of another tenant', async () => {
    await asOwner(async (c, t) => {
      const other = await queueTenant(c);
      expect(await job(c, t, { repository_id: other.repositoryId })).toBe(FOREIGN_KEY_VIOLATION);
    });
  });
});

describe('index_job_batches invariants', () => {
  it('accepts exactly the four states, each with its times, lease and failure', async () => {
    await asOwner(async (c, t) => {
      const jobId = await insertJob(c, t, RUNNING);
      const lease = { lease_expires_at: '2026-01-01T00:02:00Z', claimed_by: 'b' };
      const end = { ended_at: '2026-01-01T00:05:00Z' };
      expect(await batch(c, t, jobId, { ordinal: 1 })).toBeNull();
      expect(await batch(c, t, jobId, { ordinal: 2, state: 'running', ...lease })).toBeNull();
      expect(
        await batch(c, t, jobId, { ordinal: 3, state: 'stored', stored_count: 2, ...end }),
      ).toBeNull();
      expect(
        await batch(c, t, jobId, {
          ordinal: 4,
          state: 'failed',
          failure_reason_code: 'store_failed',
          ...end,
        }),
      ).toBeNull();
      expect(await batch(c, t, jobId, { ordinal: 5, state: 'done', ...end })).toBe(CHECK_VIOLATION);
      // Times.
      expect(await batch(c, t, jobId, { ordinal: 6, ...end })).toBe(CHECK_VIOLATION);
      expect(await batch(c, t, jobId, { ordinal: 6, state: 'stored' })).toBe(CHECK_VIOLATION);
      expect(
        await batch(c, t, jobId, {
          ordinal: 6,
          state: 'stored',
          ended_at: '2025-12-31T00:00:00Z',
        }),
      ).toBe(CHECK_VIOLATION);
      // Lease: a running batch holds both or neither; no other state holds either.
      expect(await batch(c, t, jobId, { ordinal: 6, state: 'running', claimed_by: 'b' })).toBe(
        CHECK_VIOLATION,
      );
      expect(await batch(c, t, jobId, { ordinal: 6, ...lease })).toBe(CHECK_VIOLATION);
      // Failure: failed alone carries a code.
      expect(await batch(c, t, jobId, { ordinal: 6, state: 'failed', ...end })).toBe(
        CHECK_VIOLATION,
      );
      expect(await batch(c, t, jobId, { ordinal: 6, failure_message: 'why' })).toBe(
        CHECK_VIOLATION,
      );
      expect(await batch(c, t, jobId, { ordinal: 6, attempts: -1 })).toBe(CHECK_VIOLATION);
    });
  });

  it('refuses a ragged or empty slice, a stored count past the slice, an ordinal below 1 and a repeated ordinal', async () => {
    await asOwner(async (c, t) => {
      const jobId = await insertJob(c, t, RUNNING);
      expect(await batch(c, t, jobId, { paths: ['a.ts'], git_blob_hashes: [sha(), sha()] })).toBe(
        CHECK_VIOLATION,
      );
      expect(await batch(c, t, jobId, { paths: [], git_blob_hashes: [] })).toBe(CHECK_VIOLATION);
      expect(
        await batch(c, t, jobId, { paths: ['a.ts', null], git_blob_hashes: [sha(), sha()] }),
      ).toBe(CHECK_VIOLATION);
      expect(await batch(c, t, jobId, { git_blob_hashes: [sha(), null] })).toBe(CHECK_VIOLATION);
      expect(await batch(c, t, jobId, { stored_count: 3 })).toBe(CHECK_VIOLATION);
      expect(await batch(c, t, jobId, { stored_count: -1 })).toBe(CHECK_VIOLATION);
      expect(await batch(c, t, jobId, { ordinal: 0 })).toBe(CHECK_VIOLATION);
      expect(await batch(c, t, jobId, { ordinal: 1, stored_count: 2 })).toBeNull();
      expect(await batch(c, t, jobId, { ordinal: 1 })).toBe(UNIQUE_VIOLATION);
    });
  });

  it('refuses a job of another repository', async () => {
    await asOwner(async (c, t) => {
      const jobId = await insertJob(c, t, {
        ...RUNNING,
        repository_id: t.repositoryIds[1] as string,
      });
      expect(await batch(c, t, jobId)).toBe(FOREIGN_KEY_VIOLATION);
    });
  });
});

describe('deletion', () => {
  it('takes a job’s batches with the job, and both with their repository', async () => {
    await asOwner(async (c, t) => {
      const count = async () => {
        const rows = await queryRows<{ jobs: number; batches: number }>(
          c,
          `SELECT (SELECT count(*)::int FROM codegraph.index_jobs WHERE tenant_id = $1) AS jobs,
                  (SELECT count(*)::int FROM codegraph.index_job_batches WHERE tenant_id = $1) AS batches`,
          [t.tenantId],
        );
        return rows[0];
      };
      const first = await insertJob(c, t, RUNNING);
      expect(await batch(c, t, first, { ordinal: 1 })).toBeNull();
      expect(await batch(c, t, first, { ordinal: 2 })).toBeNull();
      await c.query('DELETE FROM codegraph.index_jobs WHERE id = $1', [first]);
      expect(await count()).toEqual({ jobs: 0, batches: 0 });

      const second = await insertJob(c, t, RUNNING);
      expect(await batch(c, t, second)).toBeNull();
      await insertJob(c, t);
      expect(await count()).toEqual({ jobs: 2, batches: 1 });
      await c.query('DELETE FROM codegraph.repositories WHERE id = $1', [t.repositoryId]);
      expect(await count()).toEqual({ jobs: 0, batches: 0 });
    });
  });
});
