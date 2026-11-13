import { randomBytes } from 'node:crypto';

import type pg from 'pg';

import { insertBlobIfAbsent, insertContents } from '../../src/db/blobs.js';
import { insertFacts } from '../../src/db/facts.js';
import {
  appendLayerPaths,
  insertLayer,
  markPublished,
  markSuperseded,
  moveRefHead,
  type LayerRow,
  type LayerScope,
  type PathEntry,
} from '../../src/db/layers.js';
import { TREE_SITTER_PRODUCER } from '../../src/extract/types.js';
import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { queryRows, withClient, type FreshDatabase } from './db.js';
import type { TenancyFixture } from './tenancy.js';

/** Forty hex characters: a git blob hash or a commit sha nobody else holds. */
export function sha(): string {
  return randomBytes(20).toString('hex');
}

/** What the release suites store per blob, so a cascade can be observed. */
export interface BlobPresence {
  readonly blob: boolean;
  readonly contents: boolean;
  readonly facts: number;
}

/**
 * Seeds layer, path, ref-head and blob rows through the shipped repository
 * writes, bound the way a request is. Every tenant it creates is its own, so a
 * tenant-wide sweep in one case never sees another case's rows. Tenant A of the
 * fixture is reached as the reader (granted A only); every other tenant as the
 * operator, granted by the owner.
 */
export function layerSeeder(db: FreshDatabase, fx: TenancyFixture, pool: pg.Pool) {
  const clientFor = (tenantId: string): string =>
    tenantId === fx.tenantA.id ? fx.readerId : fx.operatorId;

  async function grantOperator(tenantId: string): Promise<void> {
    await withClient(db.ownerUrl, (c) =>
      c.query('INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
        fx.operatorId,
        tenantId,
      ]),
    );
  }

  async function asOperator<T>(sql: string, params: unknown[]): Promise<T> {
    return withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.client_id', $1, true)", [fx.operatorId]);
      const [row] = await queryRows<{ value: T }>(c, `SELECT ${sql} AS value`, params);
      await c.query('COMMIT');
      return (row as { value: T }).value;
    });
  }

  /** A tenant of the case's own, the operator granted on it. */
  async function freshTenant(): Promise<string> {
    const id = await asOperator<string>('codegraph.codegraph_create_tenant($1)', [
      `tenant-${sha().slice(0, 8)}`,
    ]);
    await grantOperator(id);
    return id;
  }

  async function freshRepo(tenantId: string): Promise<LayerScope> {
    const id = await asOperator<string>('codegraph.codegraph_register_repository($1, $2)', [
      tenantId,
      `repo-${sha().slice(0, 8)}`,
    ]);
    return { tenantId, repositoryId: id };
  }

  async function deleteRepo(scope: LayerScope): Promise<void> {
    await asOperator('codegraph.codegraph_delete_repository_as_operator($1, $2)', [
      scope.tenantId,
      scope.repositoryId,
    ]);
  }

  /** Runs `fn` on a pooled connection bound to the tenant; rolls back unless `commit`. */
  async function bound<T>(
    tenantId: string,
    fn: (c: pg.PoolClient) => Promise<T>,
    commit = true,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(BIND_TENANT_SQL, [clientFor(tenantId), tenantId]);
      const result = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }

  /** A published layer for `commitSha` (a fresh one when omitted): a base, or a delta over `parent`. */
  async function published(
    scope: LayerScope,
    parent: LayerRow | null,
    entries: PathEntry[],
    commitSha = sha(),
  ): Promise<LayerRow> {
    return bound(scope.tenantId, async (c) => {
      const layer = await insertLayer(
        c,
        parent === null
          ? { ...scope, commitSha, kind: 'base' }
          : { ...scope, commitSha, kind: 'delta', parentLayerId: parent.id },
      );
      await appendLayerPaths(c, scope, layer.id, entries);
      return markPublished(c, scope, layer.id);
    });
  }

  /** A staged layer that stays staged: a base, or a delta over `parent`. */
  async function staged(
    scope: LayerScope,
    parent: LayerRow | null,
    entries: PathEntry[],
  ): Promise<LayerRow> {
    return bound(scope.tenantId, async (c) => {
      const layer = await insertLayer(
        c,
        parent === null
          ? { ...scope, commitSha: sha(), kind: 'base' }
          : { ...scope, commitSha: sha(), kind: 'delta', parentLayerId: parent.id },
      );
      await appendLayerPaths(c, scope, layer.id, entries);
      return layer;
    });
  }

  /**
   * Replaces `old`, a commit's current layer, by a newly published base for the
   * same commit holding `entries`, retiring `old` — the switch compaction makes.
   */
  async function replace(
    scope: LayerScope,
    old: LayerRow,
    entries: PathEntry[],
  ): Promise<LayerRow> {
    return bound(scope.tenantId, async (c) => {
      const base = await insertLayer(c, { ...scope, commitSha: old.commitSha, kind: 'base' });
      await appendLayerPaths(c, scope, base.id, entries);
      await markSuperseded(c, scope, old.id);
      return markPublished(c, scope, base.id);
    });
  }

  async function refHead(scope: LayerScope, refName: string, layer: LayerRow): Promise<void> {
    await bound(scope.tenantId, (c) =>
      moveRefHead(c, { ...scope, refName, layerId: layer.id, isDefaultBranch: false }),
    );
  }

  /** Blob rows for `hashes`, each with a contents row and one fact. */
  async function blobs(tenantId: string, hashes: readonly string[]): Promise<void> {
    await bound(tenantId, async (c) => {
      for (const gitBlobHash of hashes) {
        await insertBlobIfAbsent(c, {
          tenantId,
          gitBlobHash,
          sizeBytes: 1,
          outcome: 'unsupported',
          lossy: false,
        });
        await insertContents(c, { tenantId, gitBlobHash, contents: 'x' });
        await insertFacts(c, { tenantId, gitBlobHash }, [
          {
            language: 'typescript',
            producer: TREE_SITTER_PRODUCER,
            extractorVersion: '0.23.2/q1',
            kind: 'reference',
            name: 'call',
            referenceKind: 'call',
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
            enclosingName: null,
          },
        ]);
      }
    });
  }

  /** Blob rows only, no contents or facts: for the large batch cases. */
  async function bareBlobs(tenantId: string, count: number): Promise<string[]> {
    const hashes = Array.from({ length: count }, () => sha());
    await bound(tenantId, async (c) => {
      for (const gitBlobHash of hashes) {
        await insertBlobIfAbsent(c, {
          tenantId,
          gitBlobHash,
          sizeBytes: 1,
          outcome: 'unsupported',
          lossy: false,
        });
      }
    });
    return hashes.sort();
  }

  /** Read as the owner, past every policy. */
  async function presence(tenantId: string, hash: string): Promise<BlobPresence> {
    return withClient(db.ownerUrl, async (c) => {
      const [row] = await queryRows<{ blob: boolean; contents: boolean; facts: number }>(
        c,
        `SELECT EXISTS (SELECT 1 FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = $2) AS blob,
                EXISTS (SELECT 1 FROM codegraph.blob_contents WHERE tenant_id = $1 AND git_blob_hash = $2) AS contents,
                (SELECT count(*)::int FROM codegraph.blob_fact WHERE tenant_id = $1 AND git_blob_hash = $2) AS facts`,
        [tenantId, hash],
      );
      return row as BlobPresence;
    });
  }

  /** The tenant's layer ids, blob hashes and path-row count, read as the owner. */
  async function snapshot(
    tenantId: string,
  ): Promise<{ layers: string[]; blobs: string[]; paths: number }> {
    return withClient(db.ownerUrl, async (c) => {
      const layers = await queryRows<{ id: string }>(
        c,
        'SELECT id FROM codegraph.commit_layers WHERE tenant_id = $1 ORDER BY id',
        [tenantId],
      );
      const blobRows = await queryRows<{ h: string }>(
        c,
        'SELECT git_blob_hash AS h FROM codegraph.blob WHERE tenant_id = $1 ORDER BY git_blob_hash',
        [tenantId],
      );
      const [paths] = await queryRows<{ n: number }>(
        c,
        'SELECT count(*)::int AS n FROM codegraph.layer_paths WHERE tenant_id = $1',
        [tenantId],
      );
      return {
        layers: layers.map((r) => r.id),
        blobs: blobRows.map((r) => r.h),
        paths: (paths as { n: number }).n,
      };
    });
  }

  return {
    clientFor,
    grantOperator,
    freshTenant,
    freshRepo,
    deleteRepo,
    bound,
    published,
    staged,
    replace,
    refHead,
    blobs,
    bareBlobs,
    presence,
    snapshot,
  };
}

export type LayerSeeder = ReturnType<typeof layerSeeder>;
