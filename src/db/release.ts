// Release reads: the two decisions the release sweep turns into deletes.
//
// A layer is RELEASABLE when it is not staged, no live layer's chain names it,
// and no ref head names it. "Live" is a current published layer (no
// supersession time), a staged one, or any layer a ref head names: a ref head
// on a retired layer keeps that layer's whole chain, so no state can leave a
// releasable parent under a kept child. A chain begins with its own layer's id,
// so a current published layer protects itself by membership, while a retired
// one (published, with a supersession time) is protected only by the live
// chains of the commits written over it — and is released once the last of
// them has gone. The state is read only to tell staged from not staged, so the
// rule stays total over whatever else marks a layer retired.
//
// A blob is UNREFERENCED when no path row of its tenant names its hash. The
// anti-join carries no state filter: a staged layer's path pins its blob
// exactly as a published or retired one does, which is what keeps an in-flight
// job's blobs safe. A tombstone (a path row with no hash) matches no blob.
//
// Releasable layers are taken DEEPEST FIRST, then by id. A layer's parent key
// refuses a delete that leaves a child naming it, and a releasable layer's
// releasable children are all deeper than it, so a batch the limit cuts short
// never takes a parent without every releasable child below it.
//
// Every statement is parameterised and bounded by its own ORDER BY and LIMIT.
// None opens a transaction or takes a lock: the sweep in src/layers/release.ts
// does, once per batch, and these run inside it.

import type pg from 'pg';

/** One releasable layer, as the deciding read answers it. */
export interface SupersededLayerRow {
  readonly id: string;
}

/** One unreferenced blob, keyed as the blob table keys it. */
export interface UnreferencedBlobRow {
  readonly gitBlobHash: string;
}

export interface ReleaseReadOptions {
  /** Narrow the layer decision to one repository of the tenant. */
  readonly repositoryId?: string | null;
}

// The three conditions, written once and used by both the read and the delete.
// `$1` is the tenant and `$2` the optional repository.
const RELEASABLE_LAYER_WHERE = `l.tenant_id = $1
    AND ($2::uuid IS NULL OR l.repository_id = $2)
    AND l.state <> 'staged'
    AND NOT EXISTS (
      SELECT 1 FROM codegraph.commit_layers live
      WHERE live.tenant_id = l.tenant_id AND live.repository_id = l.repository_id
        AND live.chain @> ARRAY[l.id]
        AND (live.state = 'staged'
          OR (live.state = 'published' AND live.superseded_at IS NULL)
          OR EXISTS (
            SELECT 1 FROM codegraph.ref_heads lr
            WHERE lr.tenant_id = live.tenant_id AND lr.repository_id = live.repository_id
              AND lr.layer_id = live.id)))
    AND NOT EXISTS (
      SELECT 1 FROM codegraph.ref_heads r
      WHERE r.tenant_id = l.tenant_id AND r.repository_id = l.repository_id
        AND r.layer_id = l.id)`;

const LIST_SUPERSEDED_SQL = `SELECT l.id FROM codegraph.commit_layers l
  WHERE ${RELEASABLE_LAYER_WHERE}
  ORDER BY l.depth DESC, l.id
  LIMIT $3`;

// The guard is re-stated, not trusted from an earlier read: a layer that became
// live in between is spared. FOR UPDATE makes a writer that does not take the
// tenant lock (a ref-head move) either finish first and fail the guard, or
// wait. The path rows go by the migration's cascade, in this same statement.
const DELETE_SUPERSEDED_SQL = `WITH doomed AS (
    SELECT l.id FROM codegraph.commit_layers l
    WHERE ${RELEASABLE_LAYER_WHERE}
    ORDER BY l.depth DESC, l.id
    LIMIT $3
    FOR UPDATE
  )
  DELETE FROM codegraph.commit_layers l USING doomed d
  WHERE l.tenant_id = $1 AND l.id = d.id
  RETURNING l.id, l.depth`;

const LIST_UNREFERENCED_BLOBS_SQL = `SELECT b.git_blob_hash AS "gitBlobHash"
  FROM codegraph.blob b
  WHERE b.tenant_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM codegraph.layer_paths p
      WHERE p.tenant_id = b.tenant_id AND p.git_blob_hash = b.git_blob_hash)
  ORDER BY b.git_blob_hash
  LIMIT $2`;

const BOUND_TENANT_SQL = 'SELECT codegraph.codegraph_bound_tenant() AS tenant';

function positiveLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, not ${String(limit)}.`);
  }
  return limit;
}

/**
 * Deepest first, then by id: lower-case uuid text sorts as Postgres compares
 * uuids, and the ids of one answer are distinct.
 */
function deepestFirst(rows: { id: string; depth: number }[]): string[] {
  return rows.sort((x, y) => y.depth - x.depth || (x.id < y.id ? -1 : 1)).map((row) => row.id);
}

/**
 * The tenant's releasable layers, at most `limit` of them deepest first, then
 * by id. Reads nothing it then deletes; the sweep's delete re-states the rule.
 */
export async function listSupersededLayerIds(
  db: pg.ClientBase,
  tenantId: string,
  limit: number,
  options: ReleaseReadOptions = {},
): Promise<string[]> {
  const { rows } = await db.query<SupersededLayerRow>(LIST_SUPERSEDED_SQL, [
    tenantId,
    options.repositoryId ?? null,
    positiveLimit(limit),
  ]);
  return rows.map((row) => row.id);
}

/**
 * Deletes at most `limit` of the tenant's releasable layers, deciding and
 * deleting in one statement, and answers the ids it removed deepest first, then by id.
 * Their path rows go with them by cascade. Opens no transaction.
 */
export async function deleteSupersededLayers(
  db: pg.ClientBase,
  tenantId: string,
  limit: number,
  options: ReleaseReadOptions = {},
): Promise<string[]> {
  const { rows } = await db.query<SupersededLayerRow & { depth: number }>(DELETE_SUPERSEDED_SQL, [
    tenantId,
    options.repositoryId ?? null,
    positiveLimit(limit),
  ]);
  return deepestFirst(rows);
}

/**
 * The tenant's blobs no path row of the tenant names, at most `limit` of them
 * in hash order. One anti-join; no referenced set is read into memory.
 */
export async function listUnreferencedBlobHashes(
  db: pg.ClientBase,
  tenantId: string,
  limit: number,
): Promise<string[]> {
  const { rows } = await db.query<UnreferencedBlobRow>(LIST_UNREFERENCED_BLOBS_SQL, [
    tenantId,
    positiveLimit(limit),
  ]);
  return rows.map((row) => row.gitBlobHash);
}

/**
 * The tenant the session's binding admits, read back through the function every
 * tenant policy compares against: null when it admits none.
 */
export async function readBoundTenant(db: pg.ClientBase): Promise<string | null> {
  const { rows } = await db.query<{ tenant: string | null }>(BOUND_TENANT_SQL);
  return rows[0]?.tenant ?? null;
}
