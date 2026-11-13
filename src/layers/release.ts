// Release: the sweep that frees a tenant's storage nothing still reads.
//
// Two passes, in this order, each to exhaustion: first the layers no live chain
// and no ref head names (their path rows go by cascade), then the blobs no path
// row of the tenant names (their contents and facts go by cascade), handed to
// the blob layer's `deleteBlobBatch` inside the batch's own transaction.
// Removing layers is what makes their blobs unreferenced, so one call clears
// what the first pass freed.
//
// One transaction per batch: bind, read the binding back and refuse a session
// bound to no tenant or another, take the tenant's layer lock EXCLUSIVE, read
// the candidates under it, delete them (no delete is issued when there are
// none), commit. The lock is transaction-scoped, so it is taken per
// batch; between batches a staging writer (shared) may run, and its pins are
// visible to the next batch's re-read. A batch that fails rolls back and leaves
// its predecessors committed; both passes are idempotent, so a re-run resumes.
//
// Deliberately not: no staged layer is touched (that is discard's), nothing is
// retired here (that is publish's and compaction's), nothing is logged.

import type pg from 'pg';

import { deleteBlobBatch } from '../db/blobs.js';
import { lockTenantExclusive } from '../db/layers.js';
import {
  deleteSupersededLayers,
  listSupersededLayerIds,
  listUnreferencedBlobHashes,
  readBoundTenant,
} from '../db/release.js';
import { BIND_TENANT_SQL } from '../server/binding.js';

/** Layers or blobs per batch transaction unless the caller says otherwise. */
export const RELEASE_BATCH_SIZE = 500;

export interface ReleaseRequest {
  /** The client each batch is bound as; it must hold a live grant on the tenant. */
  readonly clientId: string;
  readonly tenantId: string;
  /** Narrow the LAYER pass to one repository; the blob pass is always tenant-wide. */
  readonly repositoryId?: string;
  readonly batchSize?: number;
}

export interface ReleaseReport {
  /** The layers released, in batch order; deepest first, then by id, within a batch. */
  readonly layerIds: string[];
  /** The blobs released, in hash order. */
  readonly blobHashes: string[];
  /** Batch transactions the layer pass committed; a pass ends on a batch short of the size. */
  readonly layerBatches: number;
  /** Batch transactions the blob pass committed, counted the same way. */
  readonly blobBatches: number;
}

/** The binding admits no tenant, or another one: a sweep would release nothing and report success. */
export class ReleaseTenantUnboundError extends Error {
  readonly tenantId: string;
  readonly clientId: string;

  constructor(tenantId: string, clientId: string) {
    super(`Client ${clientId} is not bound to tenant ${tenantId}; nothing was released.`);
    this.name = 'ReleaseTenantUnboundError';
    this.tenantId = tenantId;
    this.clientId = clientId;
  }
}

/**
 * Releases the tenant's releasable layers, then its unreferenced blobs, one
 * bounded batch per transaction under the exclusive per-tenant lock. Refuses a
 * batch size that is not a positive integer before any statement, and an
 * unbound session with `ReleaseTenantUnboundError` before reading a candidate.
 * Never touches a staged layer.
 */
export async function releaseTenant(
  pool: pg.Pool,
  request: ReleaseRequest,
): Promise<ReleaseReport> {
  const batchSize = request.batchSize ?? RELEASE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  const scope = { repositoryId: request.repositoryId ?? null };

  const layerIds: string[] = [];
  let layerBatches = 0;
  for (;;) {
    const removed = await inBatch(pool, request, async (c) => {
      const candidates = await listSupersededLayerIds(c, request.tenantId, batchSize, scope);
      return candidates.length === 0
        ? []
        : deleteSupersededLayers(c, request.tenantId, batchSize, scope);
    });
    layerBatches += 1;
    layerIds.push(...removed);
    if (removed.length < batchSize) break;
  }

  const blobHashes: string[] = [];
  let blobBatches = 0;
  for (;;) {
    const removed = await inBatch(pool, request, async (c) => {
      const hashes = await listUnreferencedBlobHashes(c, request.tenantId, batchSize);
      if (hashes.length === 0) return [];
      // The delete answers in no order; keep the read's hash order.
      const removed = new Set(await deleteBlobBatch(c, request.tenantId, hashes));
      return hashes.filter((hash) => removed.has(hash));
    });
    blobBatches += 1;
    blobHashes.push(...removed);
    if (removed.length < batchSize) break;
  }

  return { layerIds, blobHashes, layerBatches, blobBatches };
}

/** One batch: bind, verify the binding, lock exclusive, run `fn`, commit. */
async function inBatch<T>(
  pool: pg.Pool,
  request: ReleaseRequest,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(BIND_TENANT_SQL, [request.clientId, request.tenantId]);
      if ((await readBoundTenant(client)) !== request.tenantId) {
        throw new ReleaseTenantUnboundError(request.tenantId, request.clientId);
      }
      await lockTenantExclusive(client, request.tenantId);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
