// Publish a layer: the one call that makes a commit readable.
//
// In ONE transaction `publishLayer` proves that every non-tombstone path of a
// staged layer names a blob the tenant holds, refusing while one does not; then
// retires the commit's current published layer (a supersession time, never a
// delete: other commits' chains still name it), flips this layer to published,
// moves every ref head that named the retired layer onto it, and writes the
// caller's ref head. Neither half lands without the other, so a
// job that dies, is refused or is killed leaves the repository on its previous
// published commit.
//
// It takes no tenant lock: the staged path rows are the pins a release
// respects, so the set this transaction proves is the set no release deletes.

import type pg from 'pg';

import {
  LayerNotStagedError,
  listRefHeadsNamingLayer,
  markPublished,
  markSuperseded,
  moveRefHead,
  readCurrentPublishedLayer,
  readLayerById,
  readLayerPathsPage,
  type LayerScope,
  type RefHeadRow,
} from '../db/layers.js';
import { BIND_TENANT_SQL } from '../server/binding.js';

/** Hashes per existence statement, and path rows per page, unless the caller says otherwise. */
export const EXISTENCE_BATCH_SIZE = 500;

/** The ref a publish moves, or none. */
export interface PublishRef {
  readonly name: string;
  readonly isDefaultBranch: boolean;
}

/** What publishing is handed. The commit is read from the layer, never passed. */
export interface PublishInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly repositoryId: string;
  readonly layerId: string;
  readonly ref: PublishRef | null;
}

export interface PublishOptions {
  /** Distinct hashes per existence statement and path rows per page; default 500. */
  readonly batchSize?: number;
}

/** The layer a publish made (or found) current. */
export interface PublishedLayer {
  readonly layerId: string;
  readonly commitSha: string;
  readonly publishedAt: Date;
  /** The ref head written, or null when no ref was given. */
  readonly refHead: RefHeadRow | null;
  /** The layer this publish retired, or null. */
  readonly retired: { readonly layerId: string; readonly supersededAt: Date } | null;
}

/** A non-tombstone path names a blob the tenant does not hold. Nothing was written. */
export class UnstoredBlobsError extends Error {
  /** The lowest missing path in byte-wise path order. */
  readonly path: string;
  readonly gitBlobHash: string;
  /** How many distinct blobs of the layer are missing. */
  readonly missingCount: number;

  constructor(path: string, gitBlobHash: string, missingCount: number) {
    super(
      `${String(missingCount)} blob(s) of the layer are not stored; the first is ${path} (${gitBlobHash}).`,
    );
    this.name = 'UnstoredBlobsError';
    this.path = path;
    this.gitBlobHash = gitBlobHash;
    this.missingCount = missingCount;
  }
}

/**
 * `not_found`: no layer of this id in this tenant and repository.
 * `superseded`: a published layer that was retired; making it current again
 * would undo a compaction.
 * `not_staged`: neither staged nor its commit's current layer (it was
 * published concurrently by another call).
 */
export type NotPublishableReason = 'not_found' | 'superseded' | 'not_staged';

export class LayerNotPublishableError extends Error {
  readonly reason: NotPublishableReason;
  readonly layerId: string;

  constructor(reason: NotPublishableReason, layerId: string) {
    super(`Layer ${layerId} cannot be published: ${reason}.`);
    this.name = 'LayerNotPublishableError';
    this.reason = reason;
    this.layerId = layerId;
  }
}

/** The transaction could not be bound to the tenant (no live grant for the client). */
export class PublishUnboundError extends Error {
  readonly tenantId: string;
  readonly clientId: string;

  constructor(tenantId: string, clientId: string) {
    super(`Client ${clientId} could not be bound to tenant ${tenantId}; nothing was published.`);
    this.name = 'PublishUnboundError';
    this.tenantId = tenantId;
    this.clientId = clientId;
  }
}

const BOUND_TENANT_SQL = 'SELECT codegraph.codegraph_bound_tenant() AS tenant';

/**
 * The hashes of one batch the tenant holds no blob row for. A blob row is
 * "stored" whatever its outcome: binary and size-refused blobs keep no contents
 * by design, so this reads `codegraph.blob`, never the contents table.
 */
const MISSING_BLOBS_SQL = `SELECT h AS hash FROM unnest($2::text[]) AS h
  WHERE NOT EXISTS (
    SELECT 1 FROM codegraph.blob b WHERE b.tenant_id = $1 AND b.git_blob_hash = h)`;

/**
 * Pages the layer's own path rows in byte-wise order and checks each page's
 * not-yet-checked hashes in ONE statement. Answers the refusal, or null when
 * every non-tombstone path's blob is stored.
 */
async function findUnstored(
  client: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
  tenantId: string,
  batchSize: number,
): Promise<UnstoredBlobsError | null> {
  const checked = new Set<string>();
  const missing = new Set<string>();
  let first: { path: string; hash: string } | null = null;
  let after: string | null = null;
  do {
    const page = await readLayerPathsPage(client, scope, layerId, { after, limit: batchSize });
    const fresh = [
      ...new Set(
        page.entries
          .map((e) => e.gitBlobHash)
          .filter((h): h is string => h !== null && !checked.has(h)),
      ),
    ];
    if (fresh.length > 0) {
      const { rows } = await client.query<{ hash: string }>(MISSING_BLOBS_SQL, [tenantId, fresh]);
      for (const hash of fresh) checked.add(hash);
      for (const { hash } of rows) missing.add(hash);
    }
    if (first === null) {
      const entry = page.entries.find((e) => e.gitBlobHash !== null && missing.has(e.gitBlobHash));
      if (entry !== undefined) first = { path: entry.path, hash: entry.gitBlobHash as string };
    }
    after = page.next;
  } while (after !== null);
  return first === null ? null : new UnstoredBlobsError(first.path, first.hash, missing.size);
}

/**
 * Publishes a staged layer on its own transaction from `pool`: binds the client
 * and tenant, proves every blob stored, retires the commit's current layer if
 * there is another, flips this one and writes the given ref head. The commit's
 * current layer answers idempotently (only the ref head is written). Throws
 * `PublishUnboundError`, `LayerNotPublishableError` or `UnstoredBlobsError`
 * with nothing written.
 */
export async function publishLayer(
  pool: pg.Pool,
  input: PublishInput,
  options: PublishOptions = {},
): Promise<PublishedLayer> {
  const batchSize = options.batchSize ?? EXISTENCE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  const scope: LayerScope = { tenantId: input.tenantId, repositoryId: input.repositoryId };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const published = await publishInTransaction(client, input, scope, batchSize);
      await client.query('COMMIT');
      return published;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

async function publishInTransaction(
  client: pg.ClientBase,
  input: PublishInput,
  scope: LayerScope,
  batchSize: number,
): Promise<PublishedLayer> {
  await client.query(BIND_TENANT_SQL, [input.clientId, input.tenantId]);
  const { rows } = await client.query<{ tenant: string | null }>(BOUND_TENANT_SQL);
  if (rows[0]?.tenant !== input.tenantId) {
    throw new PublishUnboundError(input.tenantId, input.clientId);
  }

  const layer = await readLayerById(client, scope, input.layerId);
  if (layer === null) throw new LayerNotPublishableError('not_found', input.layerId);
  if (layer.state === 'published') {
    if (layer.supersededAt !== null) {
      throw new LayerNotPublishableError('superseded', input.layerId);
    }
    // Already the commit's current layer: a retry. Write only the ref head.
    return {
      layerId: layer.id,
      commitSha: layer.commitSha,
      publishedAt: layer.publishedAt as Date,
      refHead: await writeRef(client, scope, layer.id, input.ref),
      retired: null,
    };
  }

  const unstored = await findUnstored(client, scope, layer.id, input.tenantId, batchSize);
  if (unstored !== null) throw unstored;

  // Serialise with a concurrent publish or compaction of the same commit.
  const current = await readCurrentPublishedLayer(client, scope, layer.commitSha, {
    forUpdate: true,
  });
  // Retire BEFORE the flip: a commit holds one current published layer.
  const retired = current === null ? null : await markSuperseded(client, scope, current.id);
  let flipped;
  try {
    flipped = await markPublished(client, scope, layer.id);
  } catch (error) {
    if (error instanceof LayerNotStagedError) {
      throw new LayerNotPublishableError('not_staged', layer.id);
    }
    throw error;
  }
  // Every ref head that named the retired layer follows the commit to its new
  // current layer, as compaction's switch does: a ref head never names a
  // retired layer, so a release can never find a kept chain under it.
  if (retired !== null) {
    for (const ref of await listRefHeadsNamingLayer(client, scope, retired.id)) {
      await moveRefHead(client, {
        ...scope,
        refName: ref.refName,
        layerId: flipped.id,
        isDefaultBranch: ref.isDefaultBranch,
      });
    }
  }
  return {
    layerId: flipped.id,
    commitSha: flipped.commitSha,
    publishedAt: flipped.publishedAt as Date,
    refHead: await writeRef(client, scope, flipped.id, input.ref),
    retired:
      retired === null ? null : { layerId: retired.id, supersededAt: retired.supersededAt as Date },
  };
}

/** The ref head AFTER the flip: a ref head names a current published layer. */
async function writeRef(
  client: pg.ClientBase,
  scope: LayerScope,
  layerId: string,
  ref: PublishRef | null,
): Promise<RefHeadRow | null> {
  if (ref === null) return null;
  return moveRefHead(client, {
    ...scope,
    refName: ref.name,
    layerId,
    isDefaultBranch: ref.isDefaultBranch,
  });
}
