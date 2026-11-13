// Discard: the sweep that removes staged layers a dead job left behind.
//
// The worker's order is open the layer, store the missing blobs, publish. A job
// that dies or is refused between the first step and the last leaves a staged
// layer whose path rows go on pinning blobs nothing will read again. Past the
// staleness window this sweep removes such layers with their path rows, so the
// blobs only they referenced stop counting as referenced. It releases no blob
// itself: that is the release sweep's decision.
//
// One transaction per batch: bind, verify the binding, take the tenant's layer
// lock SHARED, read candidates past the cursor, and delete them under a guard
// re-stated in the delete itself — still staged, still past the cutoff, named
// by no ref head — so a layer that published since the read survives.

import type pg from 'pg';

import type { LayerSettings } from '../config.js';
import { lockTenantShared } from '../db/layers.js';
import { BIND_TENANT_SQL } from '../server/binding.js';

/** Layers per batch transaction unless the caller says otherwise. */
export const DISCARD_BATCH_SIZE = 500;

export interface DiscardRequest {
  /** The client each batch is bound as; it must hold a live grant on the tenant. */
  readonly clientId: string;
  readonly tenantId: string;
  /** The settings the host read with `readLayerSettings()`; the window is used. */
  readonly settings: Pick<LayerSettings, 'stagedLayerStaleness'>;
  /** Narrow the sweep to one repository; omitted, every repository of the tenant. */
  readonly repositoryId?: string;
  readonly batchSize?: number;
  /** The clock; defaults to now. The cutoff is `now − stagedLayerStaleness`. */
  readonly now?: Date;
}

export interface DiscardResult {
  readonly cutoff: Date;
  /** The layers removed, oldest staged first. */
  readonly layerIds: string[];
  /** The path rows removed with them. */
  readonly pathCount: number;
}

/** The binding admits no tenant, or another one: a sweep would see nothing and report success. */
export class TenantNotBoundError extends Error {
  readonly tenantId: string;
  readonly clientId: string;

  constructor(tenantId: string, clientId: string) {
    super(`Client ${clientId} is not bound to tenant ${tenantId}; nothing was discarded.`);
    this.name = 'TenantNotBoundError';
    this.tenantId = tenantId;
    this.clientId = clientId;
  }
}

const BOUND_TENANT_SQL = 'SELECT codegraph.codegraph_bound_tenant() AS tenant';

// The keyset cursor is the last candidate SEEN, as (staged_at text, id): text
// keeps the timestamp's microseconds, which a JavaScript Date would drop.
const CANDIDATES_SQL = `SELECT id, staged_at::text AS "stagedAt"
  FROM codegraph.commit_layers
  WHERE tenant_id = $1
    AND ($2::uuid IS NULL OR repository_id = $2)
    AND state = 'staged' AND staged_at < $3
    AND ($4::timestamptz IS NULL OR (staged_at, id) > ($4::timestamptz, $5::uuid))
  ORDER BY staged_at, id
  LIMIT $6`;

// The guard is re-stated here, not trusted from the read; FOR UPDATE makes a
// concurrent publish of a candidate either finish first (and fail the guard)
// or wait. Path rows go in the same statement as their layers.
const DELETE_SQL = `WITH doomed AS (
    SELECT l.id, l.staged_at FROM codegraph.commit_layers l
    WHERE l.tenant_id = $1 AND l.id = ANY ($2::uuid[])
      AND l.state = 'staged' AND l.staged_at < $3
      AND NOT EXISTS (
        SELECT 1 FROM codegraph.ref_heads r
        WHERE r.tenant_id = l.tenant_id AND r.repository_id = l.repository_id
          AND r.layer_id = l.id)
    FOR UPDATE
  ),
  paths AS (
    DELETE FROM codegraph.layer_paths p USING doomed d
    WHERE p.tenant_id = $1 AND p.layer_id = d.id
    RETURNING 1
  ),
  layers AS (
    DELETE FROM codegraph.commit_layers l USING doomed d
    WHERE l.tenant_id = $1 AND l.id = d.id
    RETURNING l.id, l.staged_at
  )
  SELECT (SELECT coalesce(array_agg(id ORDER BY staged_at, id), '{}') FROM layers) AS "layerIds",
         (SELECT count(*)::int FROM paths) AS "pathCount"`;

interface Batch {
  readonly seen: { id: string; stagedAt: string }[];
  readonly layerIds: string[];
  readonly pathCount: number;
}

/**
 * Removes the tenant's layers still staged since before `now − window`, with
 * their path rows, one bounded batch per transaction. Refuses an unbound
 * session with `TenantNotBoundError` before reading anything, and a batch size
 * that is not a positive integer before any statement. Deletes no blob and
 * moves no ref head.
 */
export async function discardStaleLayers(
  pool: pg.Pool,
  request: DiscardRequest,
): Promise<DiscardResult> {
  const batchSize = request.batchSize ?? DISCARD_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  const now = request.now ?? new Date();
  const cutoff = new Date(now.getTime() - request.settings.stagedLayerStaleness);
  const layerIds: string[] = [];
  let pathCount = 0;
  let cursor: { id: string; stagedAt: string } | null = null;
  for (;;) {
    const batch = await discardBatch(pool, request, cutoff, cursor, batchSize);
    layerIds.push(...batch.layerIds);
    pathCount += batch.pathCount;
    const last = batch.seen[batch.seen.length - 1];
    // Past every candidate SEEN, deleted or not, so the run always ends.
    if (last === undefined || batch.seen.length < batchSize) break;
    cursor = last;
  }
  return { cutoff, layerIds, pathCount };
}

async function discardBatch(
  pool: pg.Pool,
  request: DiscardRequest,
  cutoff: Date,
  cursor: { id: string; stagedAt: string } | null,
  batchSize: number,
): Promise<Batch> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(BIND_TENANT_SQL, [request.clientId, request.tenantId]);
      const bound = await client.query<{ tenant: string | null }>(BOUND_TENANT_SQL);
      if (bound.rows[0]?.tenant !== request.tenantId) {
        throw new TenantNotBoundError(request.tenantId, request.clientId);
      }
      await lockTenantShared(client, request.tenantId);
      const { rows: seen } = await client.query<{ id: string; stagedAt: string }>(CANDIDATES_SQL, [
        request.tenantId,
        request.repositoryId ?? null,
        cutoff,
        cursor?.stagedAt ?? null,
        cursor?.id ?? null,
        batchSize,
      ]);
      let removed = { layerIds: [] as string[], pathCount: 0 };
      if (seen.length > 0) {
        const { rows } = await client.query<{ layerIds: string[]; pathCount: number }>(DELETE_SQL, [
          request.tenantId,
          seen.map((s) => s.id),
          cutoff,
        ]);
        removed = rows[0] as { layerIds: string[]; pathCount: number };
      }
      await client.query('COMMIT');
      return { seen, ...removed };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
