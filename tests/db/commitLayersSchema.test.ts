import { randomBytes, randomUUID } from 'node:crypto';

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

// The shape of the three tables migration 0007 creates — commit_layers,
// layer_paths and ref_heads — read back from the applied database as the
// owner, each invariant beside the negative case it exists for. Bound-session
// isolation, cascade deletion over a bound session and the catalogue scan are
// the integration gate's (tests/integration), not this file's.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';

const FILE = '0007_commit_layers.sql';
const TABLES = ['commit_layers', 'layer_paths', 'ref_heads'] as const;

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

function sha(length: 40 | 64 = 40): string {
  return randomBytes(length / 2).toString('hex');
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

interface Repo {
  tenantId: string;
  repositoryId: string;
}

async function tenantWithRepositories(c: pg.Client, count = 1): Promise<Repo[]> {
  const tenantId = randomUUID();
  await c.query("INSERT INTO codegraph.tenants (id, display_name) VALUES ($1, 'T')", [tenantId]);
  const repos: Repo[] = [];
  for (let i = 0; i < count; i += 1) {
    const repositoryId = randomUUID();
    await c.query(
      'INSERT INTO codegraph.repositories (id, tenant_id, display_name) VALUES ($1, $2, $3)',
      [repositoryId, tenantId, `repo-${String(i)}`],
    );
    repos.push({ tenantId, repositoryId });
  }
  return repos;
}

interface LayerRow {
  id?: string;
  commitSha?: string;
  kind?: string;
  parent?: string | null;
  depth?: number;
  chain?: (string | null)[];
  state?: string;
  publishedAt?: string | null;
  supersededAt?: string | null;
}

const INSERT_LAYER = `INSERT INTO codegraph.commit_layers
  (id, tenant_id, repository_id, commit_sha, kind, parent_layer_id, depth, chain, state,
   staged_at, published_at, superseded_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9,
          '2026-01-01T00:00:00Z', $10::timestamptz, $11::timestamptz)`;

function layerParams(repo: Repo, row: LayerRow): unknown[] {
  const id = row.id ?? randomUUID();
  return [
    id,
    repo.tenantId,
    repo.repositoryId,
    row.commitSha ?? sha(),
    row.kind ?? 'base',
    row.parent ?? null,
    row.depth ?? 0,
    row.chain ?? [id],
    row.state ?? 'staged',
    row.publishedAt ?? null,
    row.supersededAt ?? null,
  ];
}

/** Inserts a layer and answers its id. */
async function layer(c: pg.Client, repo: Repo, row: LayerRow = {}): Promise<string> {
  const params = layerParams(repo, row);
  await c.query(INSERT_LAYER, params);
  return params[0] as string;
}

const PUBLISHED = { state: 'published', publishedAt: '2026-01-01T00:01:00Z' } as const;

const INSERT_PATH = `INSERT INTO codegraph.layer_paths
  (tenant_id, repository_id, layer_id, path, git_blob_hash) VALUES ($1, $2, $3, $4, $5)`;

const INSERT_REF = `INSERT INTO codegraph.ref_heads
  (tenant_id, repository_id, ref_name, commit_sha, layer_id, is_default_branch)
  VALUES ($1, $2, $3, $4, $5, $6)`;

describe('migration 0007', () => {
  it('applies after every earlier file, is recorded with its checksum, and re-runs as a no-op', async () => {
    const files = await readMigrations(MIGRATIONS_DIR);
    const names = files.map((f) => f.name);
    expect(names).toContain(FILE);
    // Filename order: every file before it is applied before it.
    expect(names.indexOf(FILE)).toBe(names.filter((n) => n < FILE).length);
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
          (SELECT json_agg(x ORDER BY x.table_name, x.grantee, x.privilege_type) FROM (
             SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
             WHERE table_schema = 'codegraph') x) AS table_grants,
          (SELECT json_agg(x ORDER BY x.table_name, x.column_name, x.privilege_type) FROM (
             SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
             WHERE table_schema = 'codegraph' AND grantee = 'codegraph_app') x) AS column_grants,
          (SELECT json_agg(x ORDER BY x.tablename, x.policyname) FROM (
             SELECT tablename, policyname, roles, qual, with_check FROM pg_policies
             WHERE schemaname = 'codegraph') x) AS policies`,
      );

    const before = await withClient(db.ownerUrl, async (c) => ({
      recorded: await queryRows<{ name: string; checksum: string }>(
        c,
        'SELECT name, checksum FROM codegraph.schema_migrations ORDER BY name',
      ),
      catalogue: await snapshot(c),
    }));
    expect(before.recorded.map((r) => r.name)).toEqual(names);
    expect(before.recorded.find((r) => r.name === FILE)).toEqual({
      name: FILE,
      checksum: checksum(file?.sql ?? ''),
    });

    const again = await db.migrate({ log: () => undefined });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual(names);
    const after = await withClient(db.ownerUrl, snapshot);
    expect(after).toEqual(before.catalogue);
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
      ...t('commit_layers', [
        ['id', 'uuid', 'NO'],
        ['tenant_id', 'uuid', 'NO'],
        ['repository_id', 'uuid', 'NO'],
        ['commit_sha', 'text', 'NO'],
        ['kind', 'text', 'NO'],
        ['parent_layer_id', 'uuid', 'YES'],
        ['depth', 'int4', 'NO'],
        ['chain', '_uuid', 'NO'],
        ['state', 'text', 'NO'],
        ['staged_at', 'timestamptz', 'NO'],
        ['published_at', 'timestamptz', 'YES'],
        ['superseded_at', 'timestamptz', 'YES'],
      ]),
      ...t('layer_paths', [
        ['tenant_id', 'uuid', 'NO'],
        ['repository_id', 'uuid', 'NO'],
        ['layer_id', 'uuid', 'NO'],
        ['path', 'text', 'NO'],
        ['git_blob_hash', 'text', 'YES'],
      ]),
      ...t('ref_heads', [
        ['tenant_id', 'uuid', 'NO'],
        ['repository_id', 'uuid', 'NO'],
        ['ref_name', 'text', 'NO'],
        ['commit_sha', 'text', 'NO'],
        ['layer_id', 'uuid', 'NO'],
        ['is_default_branch', 'bool', 'NO'],
      ]),
    ]);
  });

  it('declares every named constraint, and each foreign key with its columns, target and delete action', async () => {
    const shape = await withClient(db.ownerUrl, async (c) => ({
      constraints: await queryRows<{ table: string; conname: string; contype: string }>(
        c,
        // PostgreSQL 18 records NOT NULL as pg_constraint rows (contype 'n');
        // nullability is asserted above, so only named constraints count here.
        `SELECT (SELECT n.nspname || '.' || r.relname FROM pg_class r
                   JOIN pg_namespace n ON n.oid = r.relnamespace WHERE r.oid = conrelid) AS table,
                conname, contype FROM pg_constraint
          WHERE conrelid = ANY (ARRAY['codegraph.commit_layers', 'codegraph.layer_paths',
                                      'codegraph.ref_heads']::regclass[])
            AND contype <> 'n'
          ORDER BY 1, 2`,
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
            AND k.conrelid = ANY (ARRAY['codegraph.commit_layers', 'codegraph.layer_paths',
                                        'codegraph.ref_heads']::regclass[])
          ORDER BY 1`,
      ),
    }));
    const named = (table: string, rows: [string, string][]) =>
      rows.map(([conname, contype]) => ({ table: `codegraph.${table}`, conname, contype }));
    expect(shape.constraints).toEqual([
      ...named('commit_layers', [
        ['commit_layers_commit_sha_check', 'c'],
        ['commit_layers_kind_check', 'c'],
        ['commit_layers_kind_shape_check', 'c'],
        ['commit_layers_parent_fkey', 'f'],
        ['commit_layers_pkey', 'p'],
        ['commit_layers_repository_fkey', 'f'],
        ['commit_layers_state_check', 'c'],
        ['commit_layers_state_times_check', 'c'],
        ['commit_layers_tenant_repository_id_key', 'u'],
      ]),
      ...named('layer_paths', [
        ['layer_paths_git_blob_hash_check', 'c'],
        ['layer_paths_layer_fkey', 'f'],
        ['layer_paths_path_check', 'c'],
        ['layer_paths_pkey', 'p'],
        ['layer_paths_repository_fkey', 'f'],
      ]),
      ...named('ref_heads', [
        ['ref_heads_commit_sha_check', 'c'],
        ['ref_heads_layer_fkey', 'f'],
        ['ref_heads_pkey', 'p'],
        ['ref_heads_ref_name_check', 'c'],
        ['ref_heads_repository_fkey', 'f'],
      ]),
    ]);
    const pair = ['tenant_id', 'repository_id'];
    const layerKey = ['tenant_id', 'repository_id', 'id'];
    expect(shape.foreignKeys).toEqual([
      {
        conname: 'commit_layers_parent_fkey',
        columns: [...pair, 'parent_layer_id'],
        target: 'codegraph.commit_layers',
        target_columns: layerKey,
        on_delete: 'a',
      },
      {
        conname: 'commit_layers_repository_fkey',
        columns: pair,
        target: 'codegraph.repositories',
        target_columns: ['tenant_id', 'id'],
        on_delete: 'c',
      },
      {
        conname: 'layer_paths_layer_fkey',
        columns: [...pair, 'layer_id'],
        target: 'codegraph.commit_layers',
        target_columns: layerKey,
        on_delete: 'c',
      },
      {
        conname: 'layer_paths_repository_fkey',
        columns: pair,
        target: 'codegraph.repositories',
        target_columns: ['tenant_id', 'id'],
        on_delete: 'c',
      },
      {
        conname: 'ref_heads_layer_fkey',
        columns: [...pair, 'layer_id'],
        target: 'codegraph.commit_layers',
        target_columns: layerKey,
        on_delete: 'a',
      },
      {
        conname: 'ref_heads_repository_fkey',
        columns: pair,
        target: 'codegraph.repositories',
        target_columns: ['tenant_id', 'id'],
        on_delete: 'c',
      },
    ]);
  });

  it('declares every index, each leading with the tenant and every pair key backed by one', async () => {
    const indexes = await withClient(db.ownerUrl, (c) =>
      queryRows<{ indexname: string; indexdef: string }>(
        c,
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'codegraph' AND tablename = ANY($1) ORDER BY indexname`,
        [TABLES],
      ),
    );
    expect(indexes).toEqual([
      {
        indexname: 'commit_layers_chain_idx',
        indexdef:
          'CREATE INDEX commit_layers_chain_idx ON codegraph.commit_layers USING gin (chain)',
      },
      {
        indexname: 'commit_layers_current_published_key',
        indexdef:
          "CREATE UNIQUE INDEX commit_layers_current_published_key ON codegraph.commit_layers USING btree (tenant_id, repository_id, commit_sha) WHERE ((state = 'published'::text) AND (superseded_at IS NULL))",
      },
      {
        indexname: 'commit_layers_pkey',
        indexdef:
          'CREATE UNIQUE INDEX commit_layers_pkey ON codegraph.commit_layers USING btree (id)',
      },
      {
        indexname: 'commit_layers_staged_idx',
        indexdef:
          "CREATE INDEX commit_layers_staged_idx ON codegraph.commit_layers USING btree (tenant_id, staged_at) WHERE (state = 'staged'::text)",
      },
      {
        indexname: 'commit_layers_tenant_repository_id_key',
        indexdef:
          'CREATE UNIQUE INDEX commit_layers_tenant_repository_id_key ON codegraph.commit_layers USING btree (tenant_id, repository_id, id)',
      },
      {
        indexname: 'layer_paths_blob_idx',
        indexdef:
          'CREATE INDEX layer_paths_blob_idx ON codegraph.layer_paths USING btree (tenant_id, git_blob_hash) WHERE (git_blob_hash IS NOT NULL)',
      },
      {
        indexname: 'layer_paths_pkey',
        indexdef:
          'CREATE UNIQUE INDEX layer_paths_pkey ON codegraph.layer_paths USING btree (tenant_id, repository_id, layer_id, path)',
      },
      {
        indexname: 'ref_heads_layer_idx',
        indexdef:
          'CREATE INDEX ref_heads_layer_idx ON codegraph.ref_heads USING btree (tenant_id, repository_id, layer_id)',
      },
      {
        indexname: 'ref_heads_one_default_per_repository',
        indexdef:
          'CREATE UNIQUE INDEX ref_heads_one_default_per_repository ON codegraph.ref_heads USING btree (tenant_id, repository_id) WHERE is_default_branch',
      },
      {
        indexname: 'ref_heads_pkey',
        indexdef:
          'CREATE UNIQUE INDEX ref_heads_pkey ON codegraph.ref_heads USING btree (tenant_id, repository_id, ref_name)',
      },
    ]);
  });

  it('forces row-level security with exactly the app and owner policies on all three tables', async () => {
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

  it('grants codegraph_app exactly the per-verb and per-column matrix', async () => {
    const grants = await withClient(db.appUrl, async (c) => ({
      table: await queryRows<{ table: string; privilege: string }>(
        c,
        `SELECT t AS table, p AS privilege FROM unnest($1::text[]) t,
                unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
          WHERE has_table_privilege('codegraph.' || t, p) ORDER BY 1, 2`,
        [TABLES],
      ),
      columns: await queryRows<{ table: string; column: string }>(
        c,
        `SELECT table_name AS table, column_name AS column FROM information_schema.columns
          WHERE table_schema = 'codegraph' AND table_name = ANY($1)
            AND has_column_privilege('codegraph.' || table_name, column_name, 'UPDATE')
          ORDER BY 1, 2`,
        [TABLES],
      ),
      defaults: await queryRows(c, 'SELECT 1 FROM pg_default_acl'),
    }));
    expect(grants.table).toEqual([
      { table: 'commit_layers', privilege: 'DELETE' },
      { table: 'commit_layers', privilege: 'INSERT' },
      { table: 'commit_layers', privilege: 'SELECT' },
      { table: 'layer_paths', privilege: 'DELETE' },
      { table: 'layer_paths', privilege: 'INSERT' },
      { table: 'layer_paths', privilege: 'SELECT' },
      { table: 'ref_heads', privilege: 'INSERT' },
      { table: 'ref_heads', privilege: 'SELECT' },
    ]);
    expect(grants.columns).toEqual([
      { table: 'commit_layers', column: 'published_at' },
      { table: 'commit_layers', column: 'state' },
      { table: 'commit_layers', column: 'superseded_at' },
      { table: 'ref_heads', column: 'commit_sha' },
      { table: 'ref_heads', column: 'is_default_branch' },
      { table: 'ref_heads', column: 'layer_id' },
    ]);
    expect(grants.defaults).toEqual([]);
  });

  it('holds no column named for a Motir organisation, project or workspace, and adds no function or trigger', async () => {
    const found = await withClient(db.ownerUrl, async (c) => ({
      columns: await queryRows<{ column_name: string }>(
        c,
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'codegraph' AND table_name = ANY($1)`,
        [TABLES],
      ),
      triggers: await queryRows(
        c,
        `SELECT tgname FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid = ANY (ARRAY['codegraph.commit_layers',
                'codegraph.layer_paths', 'codegraph.ref_heads']::regclass[])`,
      ),
      functions: await queryRows<{ proname: string }>(
        c,
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
          WHERE n.nspname = 'codegraph' AND d.objid IS NULL`,
      ),
    }));
    const forbidden = /^(org|organisation|organization|project|workspace)s?$/i;
    expect(
      found.columns.filter((col) => col.column_name.split('_').some((s) => forbidden.test(s))),
    ).toEqual([]);
    expect(found.triggers).toEqual([]);
    expect(found.functions.every((f) => f.proname.startsWith('codegraph_'))).toBe(true);
  });
});

describe('commit_layers invariants', () => {
  it('admits a base and a delta whose chain starts with itself, names its parent second and is depth + 1 long', async () => {
    await asOwner(async (c) => {
      const [repo] = await tenantWithRepositories(c);
      if (repo === undefined) throw new Error('no repository');
      const base = await layer(c, repo, PUBLISHED);
      const deltaId = randomUUID();
      expect(
        await sqlState(
          c,
          INSERT_LAYER,
          layerParams(repo, {
            id: deltaId,
            kind: 'delta',
            parent: base,
            depth: 1,
            chain: [deltaId, base],
          }),
        ),
      ).toBeNull();
      const defaulted = await queryRows<{ staged_at: Date }>(
        c,
        `INSERT INTO codegraph.commit_layers
           (id, tenant_id, repository_id, commit_sha, kind, depth, chain, state)
         VALUES ($1, $2, $3, $4, 'base', 0, ARRAY[$1]::uuid[], 'staged') RETURNING staged_at`,
        [randomUUID(), repo.tenantId, repo.repositoryId, sha(64)],
      );
      expect(defaulted[0]?.staged_at).toBeInstanceOf(Date);
    });
  });

  it('refuses a chain, kind, depth or parent that disagree', async () => {
    await asOwner(async (c) => {
      const [repo] = await tenantWithRepositories(c);
      if (repo === undefined) throw new Error('no repository');
      const base = await layer(c, repo, PUBLISHED);
      const id = randomUUID();
      const cases: [string, LayerRow][] = [
        ['a chain that does not begin with its own id', { id, chain: [randomUUID()] }],
        ['a base whose chain length disagrees with its depth', { id, chain: [id, base] }],
        ['an empty chain', { id, chain: [] }],
        [
          'a chain holding a NULL',
          { id, kind: 'delta', parent: base, depth: 1, chain: [id, null] },
        ],
        ['a base carrying a parent', { id, parent: base }],
        ['a base deeper than 0', { id, depth: 1, chain: [id, base] }],
        ['a delta without a parent', { id, kind: 'delta', depth: 1, chain: [id, base] }],
        ['a delta at depth 0', { id, kind: 'delta', parent: base, depth: 0, chain: [id] }],
        [
          'a delta whose chain is parent-first',
          { id, kind: 'delta', parent: base, depth: 1, chain: [base, id] },
        ],
        [
          'a delta whose chain names another layer second',
          { id, kind: 'delta', parent: base, depth: 1, chain: [id, randomUUID()] },
        ],
        [
          'a delta whose chain is shorter than its depth',
          { id, kind: 'delta', parent: base, depth: 2, chain: [id, base] },
        ],
        ['an unknown kind', { id, kind: 'snapshot' }],
        ['an unknown state', { id, state: 'retired' }],
        ['a shortened commit sha', { id, commitSha: sha().slice(0, 12) }],
        ['an uppercase commit sha', { id, commitSha: sha().toUpperCase() }],
      ];
      for (const [name, row] of cases) {
        expect(await sqlState(c, INSERT_LAYER, layerParams(repo, row)), name).toBe(CHECK_VIOLATION);
      }
      expect(
        await sqlState(c, INSERT_LAYER, layerParams(repo, { id, chain: [[id, id]] as never })),
        'a two-dimensional chain',
      ).not.toBeNull();
    });
  });

  it('couples the state to the publication and supersession times', async () => {
    await asOwner(async (c) => {
      const [repo] = await tenantWithRepositories(c);
      if (repo === undefined) throw new Error('no repository');
      const refused: [string, LayerRow][] = [
        ['a staged row carrying a publication time', { publishedAt: '2026-01-01T00:01:00Z' }],
        ['a staged row carrying a supersession time', { supersededAt: '2026-01-01T00:01:00Z' }],
        ['a published row without a publication time', { state: 'published' }],
        [
          'a publication before staging',
          { state: 'published', publishedAt: '2025-12-31T00:00:00Z' },
        ],
        [
          'a supersession before publication',
          { ...PUBLISHED, supersededAt: '2026-01-01T00:00:30Z' },
        ],
      ];
      for (const [name, row] of refused) {
        expect(await sqlState(c, INSERT_LAYER, layerParams(repo, row)), name).toBe(CHECK_VIOLATION);
      }
      expect(
        await sqlState(
          c,
          INSERT_LAYER,
          layerParams(repo, { ...PUBLISHED, supersededAt: '2026-01-01T00:02:00Z' }),
        ),
      ).toBeNull();
    });
  });

  it('admits one current layer per commit beside any number of staged and superseded ones', async () => {
    await asOwner(async (c) => {
      const [repo, sibling] = await tenantWithRepositories(c, 2);
      if (repo === undefined || sibling === undefined) throw new Error('no repository');
      const commitSha = sha();
      const current = await layer(c, repo, { commitSha, ...PUBLISHED });
      // A second current layer for the commit is refused …
      expect(await sqlState(c, INSERT_LAYER, layerParams(repo, { commitSha, ...PUBLISHED }))).toBe(
        UNIQUE_VIOLATION,
      );
      // … while staged layers (a killed job's and a retry's) and superseded ones coexist.
      await layer(c, repo, { commitSha });
      await layer(c, repo, { commitSha });
      const retired = await layer(c, repo, {
        commitSha,
        ...PUBLISHED,
        supersededAt: '2026-01-01T00:02:00Z',
      });
      await layer(c, repo, { commitSha, ...PUBLISHED, supersededAt: '2026-01-01T00:03:00Z' });
      // The same commit in another repository has its own current layer.
      await layer(c, sibling, { commitSha, ...PUBLISHED });

      // A superseded layer stays readable as a member of another commit's chain.
      const deltaId = randomUUID();
      await layer(c, repo, {
        id: deltaId,
        kind: 'delta',
        parent: retired,
        depth: 1,
        chain: [deltaId, retired],
        ...PUBLISHED,
      });
      const chainMembers = await queryRows<{ id: string; state: string }>(
        c,
        `SELECT l.id, l.state FROM codegraph.commit_layers d
           JOIN codegraph.commit_layers l ON l.id = ANY (d.chain)
          WHERE d.id = $1 ORDER BY array_position(d.chain, l.id)`,
        [deltaId],
      );
      expect(chainMembers).toEqual([
        { id: deltaId, state: 'published' },
        { id: retired, state: 'published' },
      ]);

      // Superseding the current one lets another become current.
      await c.query(
        "UPDATE codegraph.commit_layers SET superseded_at = '2026-01-01T00:04:00Z' WHERE id = $1",
        [current],
      );
      expect(
        await sqlState(c, INSERT_LAYER, layerParams(repo, { commitSha, ...PUBLISHED })),
      ).toBeNull();
      const counts = await queryRows<{ state: string; superseded: boolean; n: string }>(
        c,
        `SELECT state, superseded_at IS NOT NULL AS superseded, count(*) AS n
           FROM codegraph.commit_layers WHERE repository_id = $1 AND commit_sha = $2
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [repo.repositoryId, commitSha],
      );
      expect(counts).toEqual([
        { state: 'published', superseded: false, n: '1' },
        { state: 'published', superseded: true, n: '3' },
        { state: 'staged', superseded: false, n: '2' },
      ]);
    });
  });

  it('refuses a parent that does not exist or belongs to another repository, and a lone delete of a parent', async () => {
    await asOwner(async (c) => {
      const [repo, sibling] = await tenantWithRepositories(c, 2);
      if (repo === undefined || sibling === undefined) throw new Error('no repository');
      const foreign = await layer(c, sibling, PUBLISHED);
      const base = await layer(c, repo, PUBLISHED);
      for (const parent of [foreign, randomUUID()]) {
        const id = randomUUID();
        expect(
          await sqlState(
            c,
            INSERT_LAYER,
            layerParams(repo, { id, kind: 'delta', parent, depth: 1, chain: [id, parent] }),
          ),
        ).toBe(FOREIGN_KEY_VIOLATION);
      }
      const delta = randomUUID();
      await layer(c, repo, {
        id: delta,
        kind: 'delta',
        parent: base,
        depth: 1,
        chain: [delta, base],
      });
      expect(await sqlState(c, 'DELETE FROM codegraph.commit_layers WHERE id = $1', [base])).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });
  });
});

describe('layer_paths invariants', () => {
  it('holds one row per path of a layer, a hash or a tombstone, and goes with its layer', async () => {
    await asOwner(async (c) => {
      const [repo] = await tenantWithRepositories(c);
      if (repo === undefined) throw new Error('no repository');
      const l = await layer(c, repo);
      const p = (path: string, hash: string | null) => [
        repo.tenantId,
        repo.repositoryId,
        l,
        path,
        hash,
      ];
      expect(await sqlState(c, INSERT_PATH, p('src/a.ts', sha()))).toBeNull();
      expect(await sqlState(c, INSERT_PATH, p('src/b.ts', sha(64)))).toBeNull();
      expect(await sqlState(c, INSERT_PATH, p('gone.ts', null))).toBeNull();
      expect(await sqlState(c, INSERT_PATH, p('src/a.ts', sha()))).toBe(UNIQUE_VIOLATION);
      expect(await sqlState(c, INSERT_PATH, p('', sha()))).toBe(CHECK_VIOLATION);
      for (const bad of [sha().slice(0, 39), sha().toUpperCase(), `${sha()}0`, 'g'.repeat(40)]) {
        expect(await sqlState(c, INSERT_PATH, p('x.ts', bad)), bad).toBe(CHECK_VIOLATION);
      }
      expect(
        await sqlState(c, INSERT_PATH, [repo.tenantId, repo.repositoryId, l, null, sha()]),
      ).toBe(NOT_NULL_VIOLATION);
      // No key to the blob table: the hashes above name blobs nobody stored.
      expect(await queryRows(c, 'SELECT 1 FROM codegraph.blob')).toEqual([]);

      await c.query('DELETE FROM codegraph.commit_layers WHERE id = $1', [l]);
      expect(
        await queryRows(c, 'SELECT 1 FROM codegraph.layer_paths WHERE layer_id = $1', [l]),
      ).toEqual([]);
    });
  });

  it('refuses a path naming a layer of another repository, or none', async () => {
    await asOwner(async (c) => {
      const [repo, sibling] = await tenantWithRepositories(c, 2);
      if (repo === undefined || sibling === undefined) throw new Error('no repository');
      const foreign = await layer(c, sibling);
      for (const l of [foreign, randomUUID()]) {
        expect(
          await sqlState(c, INSERT_PATH, [repo.tenantId, repo.repositoryId, l, 'a.ts', sha()]),
        ).toBe(FOREIGN_KEY_VIOLATION);
      }
    });
  });
});

describe('ref_heads invariants', () => {
  it('holds one row per ref, at most one default branch per repository, and a non-blank name', async () => {
    await asOwner(async (c) => {
      const [repo, sibling] = await tenantWithRepositories(c, 2);
      if (repo === undefined || sibling === undefined) throw new Error('no repository');
      const commitSha = sha();
      const l = await layer(c, repo, { commitSha, ...PUBLISHED });
      const s = await layer(c, sibling, { commitSha, ...PUBLISHED });
      const ref = (r: Repo, name: string, layerId: string, isDefault: boolean, at = commitSha) => [
        r.tenantId,
        r.repositoryId,
        name,
        at,
        layerId,
        isDefault,
      ];
      expect(await sqlState(c, INSERT_REF, ref(repo, 'refs/heads/main', l, true))).toBeNull();
      expect(await sqlState(c, INSERT_REF, ref(repo, 'refs/heads/main', l, false))).toBe(
        UNIQUE_VIOLATION,
      );
      expect(await sqlState(c, INSERT_REF, ref(repo, 'refs/heads/feature', l, false))).toBeNull();
      expect(await sqlState(c, INSERT_REF, ref(repo, 'refs/heads/trunk', l, true))).toBe(
        UNIQUE_VIOLATION,
      );
      // Another repository has its own default branch.
      expect(await sqlState(c, INSERT_REF, ref(sibling, 'refs/heads/main', s, true))).toBeNull();
      expect(await sqlState(c, INSERT_REF, ref(repo, '  ', l, false))).toBe(CHECK_VIOLATION);
      expect(await sqlState(c, INSERT_REF, ref(repo, 'x', l, false, 'abc'))).toBe(CHECK_VIOLATION);
      const defaulted = await queryRows<{ is_default_branch: boolean }>(
        c,
        `INSERT INTO codegraph.ref_heads (tenant_id, repository_id, ref_name, commit_sha, layer_id)
         VALUES ($1, $2, 'refs/tags/v1', $3, $4) RETURNING is_default_branch`,
        [repo.tenantId, repo.repositoryId, commitSha, l],
      );
      expect(defaulted).toEqual([{ is_default_branch: false }]);
    });
  });

  it('refuses a ref naming a layer of another repository, and a lone delete of the layer a ref names', async () => {
    await asOwner(async (c) => {
      const [repo, sibling] = await tenantWithRepositories(c, 2);
      if (repo === undefined || sibling === undefined) throw new Error('no repository');
      const commitSha = sha();
      const foreign = await layer(c, sibling, { commitSha, ...PUBLISHED });
      expect(
        await sqlState(c, INSERT_REF, [
          repo.tenantId,
          repo.repositoryId,
          'refs/heads/main',
          commitSha,
          foreign,
          true,
        ]),
      ).toBe(FOREIGN_KEY_VIOLATION);
      const own = await layer(c, repo, { commitSha, ...PUBLISHED });
      await c.query(INSERT_REF, [
        repo.tenantId,
        repo.repositoryId,
        'refs/heads/main',
        commitSha,
        own,
        true,
      ]);
      expect(await sqlState(c, 'DELETE FROM codegraph.commit_layers WHERE id = $1', [own])).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });
  });
});

describe('a repository delete', () => {
  it('removes all three tables’ rows in one statement and leaves a sibling repository’s rows', async () => {
    await asOwner(async (c) => {
      const [repo, sibling] = await tenantWithRepositories(c, 2);
      if (repo === undefined || sibling === undefined) throw new Error('no repository');
      const seed = async (r: Repo) => {
        const commitSha = sha();
        const base = await layer(c, r, { commitSha, ...PUBLISHED });
        const delta = randomUUID();
        await layer(c, r, {
          id: delta,
          kind: 'delta',
          parent: base,
          depth: 1,
          chain: [delta, base],
          ...PUBLISHED,
        });
        await c.query(INSERT_PATH, [r.tenantId, r.repositoryId, base, 'a.ts', sha()]);
        await c.query(INSERT_PATH, [r.tenantId, r.repositoryId, delta, 'a.ts', null]);
        await c.query(INSERT_REF, [
          r.tenantId,
          r.repositoryId,
          'refs/heads/main',
          commitSha,
          base,
          true,
        ]);
      };
      await seed(repo);
      await seed(sibling);
      const count = async (repositoryId: string) =>
        (
          await queryRows<{ layers: string; paths: string; refs: string }>(
            c,
            `SELECT (SELECT count(*) FROM codegraph.commit_layers WHERE repository_id = $1) AS layers,
                    (SELECT count(*) FROM codegraph.layer_paths WHERE repository_id = $1) AS paths,
                    (SELECT count(*) FROM codegraph.ref_heads WHERE repository_id = $1) AS refs`,
            [repositoryId],
          )
        )[0];
      expect(await count(repo.repositoryId)).toEqual({ layers: '2', paths: '2', refs: '1' });
      expect(
        await sqlState(c, 'DELETE FROM codegraph.repositories WHERE id = $1', [repo.repositoryId]),
      ).toBeNull();
      expect(await count(repo.repositoryId)).toEqual({ layers: '0', paths: '0', refs: '0' });
      expect(await count(sibling.repositoryId)).toEqual({ layers: '2', paths: '2', refs: '1' });

      // The tenant delete takes the sibling with it.
      expect(
        await sqlState(c, 'DELETE FROM codegraph.tenants WHERE id = $1', [sibling.tenantId]),
      ).toBeNull();
      expect(await count(sibling.repositoryId)).toEqual({ layers: '0', paths: '0', refs: '0' });
    });
  });
});
