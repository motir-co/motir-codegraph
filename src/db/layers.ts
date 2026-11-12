/**
 * The database-client layer over `codegraph.commit_layers`,
 * `codegraph.layer_paths` and `codegraph.ref_heads`
 * (db/migrations/0007_commit_layers.sql): every single-operation row access on
 * the three tables, and the two per-tenant advisory locks.
 *
 * THE CALLER'S TRANSACTION, NEVER OURS. Every function takes the client it is
 * handed and runs its statements on it; none of them begins, commits or rolls
 * back. The caller must already be inside a transaction bound to the tenant
 * (`BIND_TENANT_SQL`), because the tables' policies admit no row otherwise —
 * and the binding is transaction-local, as is an advisory transaction lock, so
 * a function that reached for a second connection would silently lose both and
 * read or write nothing for a tenant nobody bound. Row-level security decides
 * what a statement sees: a row another tenant holds reads as absent, never as
 * an error.
 *
 * What lives elsewhere, and is not restated here: the one resolving statement
 * (src/layers/resolution.ts), the release sweep's deciding reads and deletes
 * (src/db/release.ts) and the discard sweep's guarded delete
 * (src/layers/discard.ts). No function here reads a blob row: whether a path's
 * blob is stored is the publisher's question.
 *
 * Every value reaches the database as a parameter. A refusal is a typed error,
 * never a silent zero-row answer.
 */
import { randomUUID } from 'node:crypto';

import type pg from 'pg';

/** A layer holds a commit's whole map (`base`) or what changed over its parent (`delta`). */
export type LayerKind = 'base' | 'delta';

/** A staged layer is being written; a published one is readable. */
export type LayerState = 'staged' | 'published';

/** The tenant and repository every layer, path and ref row belongs to. */
export interface LayerScope {
  readonly tenantId: string;
  readonly repositoryId: string;
}

/** One layer row, as the table declares it. */
export interface LayerRow {
  readonly id: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  readonly kind: LayerKind;
  readonly parentLayerId: string | null;
  readonly depth: number;
  /** The layer ids from this layer back to its base, nearest first. */
  readonly chain: readonly string[];
  readonly state: LayerState;
  readonly stagedAt: Date;
  readonly publishedAt: Date | null;
  readonly supersededAt: Date | null;
}

/**
 * What opening a layer supplies. A base names no parent; a delta names the
 * published layer it hangs off. The id, the depth and the chain are composed by
 * `insertLayer`, never supplied.
 */
export type NewLayer = LayerScope & { readonly commitSha: string } & (
    | { readonly kind: 'base'; readonly parentLayerId?: null }
    | { readonly kind: 'delta'; readonly parentLayerId: string }
  );

/** The layer a commit currently resolves through: published, not superseded. */
export type CurrentLayer = LayerRow & { readonly state: 'published'; readonly supersededAt: null };

/** A candidate commit that has a current published layer, and that layer. */
export interface PublishedAncestor {
  readonly commitSha: string;
  readonly layerId: string;
}

/** One path a layer carries: its blob hash, or null for a tombstone. */
export interface PathEntry {
  readonly path: string;
  readonly gitBlobHash: string | null;
}

/** One path row, with the layer that carries it. */
export interface LayerPathRow extends PathEntry {
  readonly layerId: string;
}

/** One ref head row. */
export interface RefHeadRow {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly refName: string;
  readonly commitSha: string;
  readonly layerId: string;
  readonly isDefaultBranch: boolean;
}

/** What `moveRefHead` points a ref at. The commit is the layer's own. */
export interface RefHeadMove extends LayerScope {
  readonly refName: string;
  readonly layerId: string;
  readonly isDefaultBranch: boolean;
}

/** One page of a tenant's referenced blob hashes, and where the next starts. */
export interface BlobHashPage {
  readonly hashes: readonly string[];
  /** Pass as `after` to read the next page; null when this page was the last. */
  readonly next: string | null;
}

/** One page of stale staged layers. */
export interface StagedLayerPage {
  readonly layers: readonly LayerRow[];
}

/** Path entries per `appendLayerPaths` statement. */
export const APPEND_BATCH_SIZE = 500;
/** Hashes per `listReferencedBlobHashes` page. */
export const HASH_PAGE_SIZE = 1_000;
/** Layer ids per `readLayerPathsByLayerIds` statement: a chain at the default ceiling. */
export const LAYER_ID_CHUNK_SIZE = 32;
/** Layers per `listStagedLayersStagedBefore` page. */
export const STAGED_PAGE_SIZE = 100;

/** No such layer, or no usable parent or target, in this tenant and repository. */
export class UnknownLayerError extends Error {
  readonly layerId: string | null;

  constructor(message: string, layerId: string | null) {
    super(message);
    this.name = 'UnknownLayerError';
    this.layerId = layerId;
  }
}

/** A delta named a parent that exists but is not published. */
export class ParentNotPublishedError extends Error {
  readonly parentLayerId: string;

  constructor(parentLayerId: string) {
    super(`Layer ${parentLayerId} is not published, so no delta may be written over it.`);
    this.name = 'ParentNotPublishedError';
    this.parentLayerId = parentLayerId;
  }
}

/** An append or a publish aimed at a layer that is not staged (or not this repository's). */
export class LayerNotStagedError extends Error {
  readonly layerId: string;

  constructor(layerId: string) {
    super(`Layer ${layerId} is not a staged layer of this repository.`);
    this.name = 'LayerNotStagedError';
    this.layerId = layerId;
  }
}

/** A supersede aimed at a layer that is not published, or already retired. */
export class LayerNotPublishedError extends Error {
  readonly layerId: string;

  constructor(layerId: string) {
    super(`Layer ${layerId} is not a current published layer of this repository.`);
    this.name = 'LayerNotPublishedError';
    this.layerId = layerId;
  }
}

/** A delete of a layer another layer's chain still carries. */
export class LayerStillReferencedError extends Error {
  readonly layerId: string;

  constructor(layerId: string) {
    super(`Layer ${layerId} is in another layer's chain and cannot be deleted.`);
    this.name = 'LayerStillReferencedError';
    this.layerId = layerId;
  }
}

/** The table's columns, aliased to `LayerRow`'s names: the one place they are listed. */
const LAYER_COLUMNS = `id, tenant_id AS "tenantId", repository_id AS "repositoryId",
  commit_sha AS "commitSha", kind, parent_layer_id AS "parentLayerId", depth, chain, state,
  staged_at AS "stagedAt", published_at AS "publishedAt", superseded_at AS "supersededAt"`;

const REF_COLUMNS = `tenant_id AS "tenantId", repository_id AS "repositoryId",
  ref_name AS "refName", commit_sha AS "commitSha", layer_id AS "layerId",
  is_default_branch AS "isDefaultBranch"`;

const SELECT_LAYER_SQL = `SELECT ${LAYER_COLUMNS} FROM codegraph.commit_layers
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3`;

const INSERT_LAYER_SQL = `INSERT INTO codegraph.commit_layers
  (id, tenant_id, repository_id, commit_sha, kind, parent_layer_id, depth, chain, state)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], 'staged')
  RETURNING ${LAYER_COLUMNS}`;

// The staged-state guard is part of the insert: a layer that is not staged (or
// not this repository's) yields no source row, so nothing is written. FOR SHARE
// holds the layer against a concurrent publish until this transaction ends.
const APPEND_PATHS_SQL = `INSERT INTO codegraph.layer_paths
  (tenant_id, repository_id, layer_id, path, git_blob_hash)
  SELECT l.tenant_id, l.repository_id, l.id, e.path, e.git_blob_hash
    FROM (SELECT tenant_id, repository_id, id FROM codegraph.commit_layers
           WHERE tenant_id = $1 AND repository_id = $2 AND id = $3 AND state = 'staged'
           FOR SHARE) l
    CROSS JOIN unnest($4::text[], $5::text[]) AS e(path, git_blob_hash)`;

const MARK_PUBLISHED_SQL = `UPDATE codegraph.commit_layers
  SET state = 'published', published_at = now()
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3 AND state = 'staged'
  RETURNING ${LAYER_COLUMNS}`;

const MARK_SUPERSEDED_SQL = `UPDATE codegraph.commit_layers
  SET superseded_at = now()
  WHERE tenant_id = $1 AND repository_id = $2 AND id = $3
    AND state = 'published' AND superseded_at IS NULL
  RETURNING ${LAYER_COLUMNS}`;

// The commit comes from the layer, so a ref can never name a commit its layer
// does not hold; only a current published layer of this repository qualifies.
const MOVE_REF_HEAD_SQL = `INSERT INTO codegraph.ref_heads
  (tenant_id, repository_id, ref_name, commit_sha, layer_id, is_default_branch)
  SELECT l.tenant_id, l.repository_id, $3, l.commit_sha, l.id, $5
    FROM codegraph.commit_layers l
   WHERE l.tenant_id = $1 AND l.repository_id = $2 AND l.id = $4
     AND l.state = 'published' AND l.superseded_at IS NULL
  ON CONFLICT (tenant_id, repository_id, ref_name) DO UPDATE
    SET commit_sha = EXCLUDED.commit_sha,
        layer_id = EXCLUDED.layer_id,
        is_default_branch = EXCLUDED.is_default_branch
  RETURNING ${REF_COLUMNS}`;

// Refused, in the statement, when another layer of the repository carries the
// id in its chain (the chain index answers the containment).
const DELETE_LAYER_SQL = `DELETE FROM codegraph.commit_layers l
  WHERE l.tenant_id = $1 AND l.repository_id = $2 AND l.id = $3
    AND NOT EXISTS (
      SELECT 1 FROM codegraph.commit_layers o
       WHERE o.tenant_id = $1 AND o.repository_id = $2 AND o.id <> l.id
         AND o.chain @> ARRAY[l.id])
  RETURNING l.id`;

const SELECT_PATHS_SQL = `SELECT p.layer_id AS "layerId", p.path, p.git_blob_hash AS "gitBlobHash"
  FROM codegraph.layer_paths p
  JOIN unnest($3::uuid[]) WITH ORDINALITY AS wanted(id, position) ON wanted.id = p.layer_id
  WHERE p.tenant_id = $1 AND p.repository_id = $2
  ORDER BY wanted.position, p.path COLLATE "C"`;

const SELECT_REF_HEAD_SQL = `SELECT ${REF_COLUMNS} FROM codegraph.ref_heads
  WHERE tenant_id = $1 AND repository_id = $2 AND ref_name = $3`;

const SELECT_CURRENT_SQL = `SELECT ${LAYER_COLUMNS} FROM codegraph.commit_layers
  WHERE tenant_id = $1 AND repository_id = $2 AND commit_sha = $3
    AND state = 'published' AND superseded_at IS NULL`;

const STAGED_OF_COMMIT_SQL = `SELECT ${LAYER_COLUMNS} FROM codegraph.commit_layers
  WHERE tenant_id = $1 AND repository_id = $2 AND commit_sha = $3 AND state = 'staged'
  ORDER BY staged_at, id`;

const NEAREST_ANCESTOR_SQL = `SELECT l.commit_sha AS "commitSha", l.id AS "layerId"
  FROM unnest($3::text[]) WITH ORDINALITY AS candidate(sha, position)
  JOIN codegraph.commit_layers l
    ON l.tenant_id = $1 AND l.repository_id = $2 AND l.commit_sha = candidate.sha
   AND l.state = 'published' AND l.superseded_at IS NULL
  ORDER BY candidate.position
  LIMIT 1`;

const REFS_NAMING_LAYER_SQL = `SELECT ${REF_COLUMNS} FROM codegraph.ref_heads
  WHERE tenant_id = $1 AND repository_id = $2 AND layer_id = $3
  ORDER BY ref_name COLLATE "C"`;

const REFERENCED_HASHES_SQL = `SELECT DISTINCT git_blob_hash AS "gitBlobHash"
  FROM codegraph.layer_paths
  WHERE tenant_id = $1 AND git_blob_hash IS NOT NULL
    AND ($2::text IS NULL OR git_blob_hash > $2)
  ORDER BY 1
  LIMIT $3`;

const STAGED_BEFORE_SQL = `SELECT ${LAYER_COLUMNS} FROM codegraph.commit_layers
  WHERE tenant_id = $1 AND state = 'staged' AND staged_at < $2
  ORDER BY staged_at, id
  LIMIT $3`;

/**
 * The one key expression both tenant locks use, so a shared and an exclusive
 * taker of one tenant contend. Prefixed so it cannot collide with another
 * module's advisory key; a hash collision between two tenants only makes them
 * serialise needlessly.
 */
const TENANT_LOCK_KEY = "hashtext('codegraph.layers.tenant:' || $1::text)";

function positiveBatch(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, not ${String(value)}.`);
  }
  return value;
}

/**
 * The bound tenant's layer for the id in this repository, with its chain, or
 * null — never an error — for a layer it does not hold. Reads only.
 */
export async function readLayerById(
  db: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
): Promise<LayerRow | null> {
  const { rows } = await db.query<LayerRow>(SELECT_LAYER_SQL, [
    scope.tenantId,
    scope.repositoryId,
    layerId,
  ]);
  return rows[0] ?? null;
}

/**
 * Opens a STAGED layer and answers the row it wrote. Mints the id, and composes
 * the depth and the chain: a base is depth 0 with a chain of its own id; a
 * delta is its parent's depth plus one, with its own id followed by the
 * parent's chain. Refuses, writing nothing: a base that names a parent
 * (RangeError); a delta naming no parent, or a parent not in this tenant and
 * repository (`UnknownLayerError`); a parent that is not published
 * (`ParentNotPublishedError`), because a staged parent's rows would drop out of
 * this layer's map the day the stale sweep discarded it.
 */
export async function insertLayer(db: pg.ClientBase, layer: NewLayer): Promise<LayerRow> {
  const id = randomUUID();
  let parentId: string | null = null;
  let depth = 0;
  let chain: string[] = [id];
  if (layer.kind === 'base') {
    // The type forbids it; a caller past the type (plain JS, a cast) is refused here.
    const named: unknown = (layer as { parentLayerId?: unknown }).parentLayerId;
    if (named !== undefined && named !== null) {
      throw new RangeError('A base layer names no parent.');
    }
  } else {
    const named = (layer as { parentLayerId?: string | null }).parentLayerId;
    if (named === undefined || named === null || named === '') {
      throw new UnknownLayerError('A delta layer must name the layer it is written over.', null);
    }
    const parent = await readLayerById(db, layer, named);
    if (parent === null) {
      throw new UnknownLayerError(
        `Layer ${named} is not a layer of repository ${layer.repositoryId}.`,
        named,
      );
    }
    if (parent.state !== 'published') {
      throw new ParentNotPublishedError(named);
    }
    parentId = parent.id;
    depth = parent.depth + 1;
    chain = [id, ...parent.chain];
  }
  const { rows } = await db.query<LayerRow>(INSERT_LAYER_SQL, [
    id,
    layer.tenantId,
    layer.repositoryId,
    layer.commitSha,
    layer.kind,
    parentId,
    depth,
    chain,
  ]);
  const row = rows[0];
  /* v8 ignore next 3 -- an INSERT ... RETURNING that did not raise returns its row */
  if (row === undefined) {
    throw new Error(`Layer ${id} was inserted but not returned.`);
  }
  return row;
}

/**
 * Appends ONE batch of path entries to a staged layer in ONE statement, and
 * answers how many rows it wrote. A null hash is a tombstone. A batch larger
 * than `batchSize` is refused (RangeError) rather than split, so a call is one
 * bounded statement. Refuses with `LayerNotStagedError`, writing nothing, when
 * the layer is published or not this tenant's and repository's. A path the
 * layer already carries fails the whole batch with a unique violation (23505).
 */
export async function appendLayerPaths(
  db: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
  entries: readonly PathEntry[],
  options: { readonly batchSize?: number } = {},
): Promise<number> {
  const batchSize = positiveBatch('batchSize', options.batchSize ?? APPEND_BATCH_SIZE);
  if (entries.length > batchSize) {
    throw new RangeError(
      `A batch holds at most ${String(batchSize)} entries, not ${String(entries.length)}.`,
    );
  }
  if (entries.length === 0) return 0;
  const { rowCount } = await db.query(APPEND_PATHS_SQL, [
    scope.tenantId,
    scope.repositoryId,
    layerId,
    entries.map((entry) => entry.path),
    entries.map((entry) => entry.gitBlobHash),
  ]);
  if (rowCount === 0) throw new LayerNotStagedError(layerId);
  return rowCount ?? 0;
}

/**
 * Flips a staged layer to published, stamping the time, and answers the row.
 * Checks no blob: that is the publisher's. Refuses with `LayerNotStagedError`
 * when the layer is not staged or not this repository's, so a published
 * layer's time never moves. A second current layer for the commit is refused by
 * the schema (23505): supersede the current one first, in the same transaction.
 */
export async function markPublished(
  db: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
): Promise<LayerRow> {
  const { rows } = await db.query<LayerRow>(MARK_PUBLISHED_SQL, [
    scope.tenantId,
    scope.repositoryId,
    layerId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new LayerNotStagedError(layerId);
  return row;
}

/**
 * Stamps `superseded_at` on a current published layer and answers the row. The
 * layer keeps its state, its published time and every path row: other commits'
 * chains still read it. Refuses with `LayerNotPublishedError`, writing nothing,
 * for a staged layer, an already retired one, or one not this repository's.
 */
export async function markSuperseded(
  db: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
): Promise<LayerRow> {
  const { rows } = await db.query<LayerRow>(MARK_SUPERSEDED_SQL, [
    scope.tenantId,
    scope.repositoryId,
    layerId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new LayerNotPublishedError(layerId);
  return row;
}

/**
 * Inserts one ref's row on first use, or moves it, onto a current published
 * layer of this repository, taking the commit from that layer; answers the row.
 * Touches no other ref. Refuses with `UnknownLayerError`, writing no ref row,
 * for a layer that is staged, retired, or not this repository's. A second
 * default-branch ref of the repository is refused by the schema (23505).
 */
export async function moveRefHead(db: pg.ClientBase, move: RefHeadMove): Promise<RefHeadRow> {
  const { rows } = await db.query<RefHeadRow>(MOVE_REF_HEAD_SQL, [
    move.tenantId,
    move.repositoryId,
    move.refName,
    move.layerId,
    move.isDefaultBranch,
  ]);
  const row = rows[0];
  if (row === undefined) {
    throw new UnknownLayerError(
      `Layer ${move.layerId} is not a current published layer of repository ${move.repositoryId}.`,
      move.layerId,
    );
  }
  return row;
}

/**
 * Deletes a layer together with its path rows (by cascade) and answers true.
 * Answers false, without an error, for a layer the bound tenant does not hold
 * in this repository — including a second delete of the same id. Refuses with
 * `LayerStillReferencedError`, removing nothing, when another layer of the
 * repository carries the id in its chain. A layer a ref head names is refused
 * by the schema (23503).
 */
export async function deleteLayerById(
  db: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(DELETE_LAYER_SQL, [
    scope.tenantId,
    scope.repositoryId,
    layerId,
  ]);
  if (rowCount === 1) return true;
  if ((await readLayerById(db, scope, layerId)) === null) return false;
  throw new LayerStillReferencedError(layerId);
}

/**
 * The raw path rows of the named layers — never a resolved map — ordered by
 * the position of their layer in `layerIds`, then by path. One statement per
 * chunk of at most `batchSize` layer ids. Reads only; another tenant's rows are
 * never answered.
 */
export async function readLayerPathsByLayerIds(
  db: pg.ClientBase,
  scope: LayerScope,
  layerIds: readonly string[],
  options: { readonly batchSize?: number } = {},
): Promise<LayerPathRow[]> {
  const batchSize = positiveBatch('batchSize', options.batchSize ?? LAYER_ID_CHUNK_SIZE);
  const found: LayerPathRow[] = [];
  for (let start = 0; start < layerIds.length; start += batchSize) {
    const { rows } = await db.query<LayerPathRow>(SELECT_PATHS_SQL, [
      scope.tenantId,
      scope.repositoryId,
      layerIds.slice(start, start + batchSize),
    ]);
    found.push(...rows);
  }
  return found;
}

/** One repository's row for one ref name, or null. Reads only. */
export async function readRefHead(
  db: pg.ClientBase,
  scope: LayerScope,
  refName: string,
): Promise<RefHeadRow | null> {
  const { rows } = await db.query<RefHeadRow>(SELECT_REF_HEAD_SQL, [
    scope.tenantId,
    scope.repositoryId,
    refName,
  ]);
  return rows[0] ?? null;
}

/**
 * The one layer a commit currently resolves through — published, with no
 * supersession time — or null; never a staged or a retired layer. With
 * `forUpdate`, the row is locked until the transaction ends, so a caller about
 * to replace it serialises with a concurrent publisher or compaction.
 */
export async function readCurrentPublishedLayer(
  db: pg.ClientBase,
  scope: LayerScope,
  commitSha: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<CurrentLayer | null> {
  const sql = options.forUpdate === true ? `${SELECT_CURRENT_SQL} FOR UPDATE` : SELECT_CURRENT_SQL;
  const { rows } = await db.query<CurrentLayer>(sql, [
    scope.tenantId,
    scope.repositoryId,
    commitSha,
  ]);
  return rows[0] ?? null;
}

/**
 * Every staged layer of one commit in this repository, oldest first; empty when
 * there is none. A commit has at most a handful (a retried job replaces its
 * own), so the read is unpaged. Reads only.
 */
export async function listStagedLayersOfCommit(
  db: pg.ClientBase,
  scope: LayerScope,
  commitSha: string,
): Promise<LayerRow[]> {
  const { rows } = await db.query<LayerRow>(STAGED_OF_COMMIT_SQL, [
    scope.tenantId,
    scope.repositoryId,
    commitSha,
  ]);
  return rows;
}

/**
 * The first candidate commit, in the caller's order, that has a current
 * published layer in this tenant and repository, with that layer; or null.
 * One statement whatever the number of candidates.
 */
export async function findNearestPublishedAncestor(
  db: pg.ClientBase,
  scope: LayerScope,
  candidateShas: readonly string[],
): Promise<PublishedAncestor | null> {
  if (candidateShas.length === 0) return null;
  const { rows } = await db.query<PublishedAncestor>(NEAREST_ANCESTOR_SQL, [
    scope.tenantId,
    scope.repositoryId,
    candidateShas,
  ]);
  return rows[0] ?? null;
}

/** Every ref head of the repository naming the layer, ordered by ref name. Reads only. */
export async function listRefHeadsNamingLayer(
  db: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
): Promise<RefHeadRow[]> {
  const { rows } = await db.query<RefHeadRow>(REFS_NAMING_LAYER_SQL, [
    scope.tenantId,
    scope.repositoryId,
    layerId,
  ]);
  return rows;
}

/**
 * One page of the distinct non-null blob hashes that any staged or published
 * layer path of the tenant references — a retired layer's among them until it
 * is released — in ascending order after `after`. Tombstones contribute
 * nothing. Decides nothing and reads no blob row.
 */
export async function listReferencedBlobHashes(
  db: pg.ClientBase,
  tenantId: string,
  options: { readonly after?: string | null; readonly limit?: number } = {},
): Promise<BlobHashPage> {
  const limit = positiveBatch('limit', options.limit ?? HASH_PAGE_SIZE);
  const { rows } = await db.query<{ gitBlobHash: string }>(REFERENCED_HASHES_SQL, [
    tenantId,
    options.after ?? null,
    limit,
  ]);
  const hashes = rows.map((row) => row.gitBlobHash);
  return { hashes, next: hashes.length === limit ? (hashes.at(-1) ?? null) : null };
}

/**
 * One page of the tenant's layers still staged whose staged time is before
 * `cutoff`, oldest first. A published layer is never answered. The cutoff and
 * the decision to sweep belong to the caller.
 */
export async function listStagedLayersStagedBefore(
  db: pg.ClientBase,
  tenantId: string,
  cutoff: Date,
  options: { readonly limit?: number } = {},
): Promise<StagedLayerPage> {
  const limit = positiveBatch('limit', options.limit ?? STAGED_PAGE_SIZE);
  const { rows } = await db.query<LayerRow>(STAGED_BEFORE_SQL, [tenantId, cutoff, limit]);
  return { layers: rows };
}

/**
 * Takes the tenant's layer lock in SHARED mode for the rest of the transaction:
 * staging takes it, so any number of jobs stage at once while release waits.
 */
export async function lockTenantShared(db: pg.ClientBase, tenantId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock_shared(${TENANT_LOCK_KEY})`, [tenantId]);
}

/**
 * Takes the tenant's layer lock in EXCLUSIVE mode for the rest of the
 * transaction: release takes it, so no blob an in-flight job has pinned is
 * released underneath it.
 */
export async function lockTenantExclusive(db: pg.ClientBase, tenantId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(${TENANT_LOCK_KEY})`, [tenantId]);
}
