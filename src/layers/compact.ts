// Compaction: copy a deep commit's whole map into a new base, then switch it.
//
// A commit whose current published layer sits deeper than the compaction
// threshold is rewritten as a base holding its whole resolved map. The copy is
// many short transactions — the staged base row first, then one transaction
// per batch of path rows, each under the tenant's layer lock taken shared —
// because the commit's current layer stays current (and keeps every blob of
// the map referenced) until the switch. The switch is one transaction: re-read
// the current layer under a row lock, retire it by its supersession time,
// publish the base, and move every ref head that named the retired layer.
//
// Every row is read and written through the repository module; the map comes
// from resolution. This module deletes nothing: a compaction that stops before
// its switch leaves its staged base for the discard sweep.

import type pg from 'pg';

import type { LayerSettings } from '../config.js';
import {
  appendLayerPaths,
  insertLayer,
  listRefHeadsNamingLayer,
  lockTenantShared,
  markPublished,
  markSuperseded,
  moveRefHead,
  readCurrentPublishedLayer,
  type LayerScope,
  type PathEntry,
} from '../db/layers.js';
import { BIND_TENANT_SQL } from '../server/binding.js';
import { compareBytewise } from './openLayer.js';
import { resolveCommit } from './resolution.js';

/** Path rows per copy transaction unless the caller says otherwise. */
export const COMPACTION_BATCH_SIZE = 1_000;

export interface CompactRequest {
  readonly tenantId: string;
  /** The client the transactions are bound as; it must hold a live grant on the tenant. */
  readonly clientId: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  /** The settings the host read with `readLayerSettings()`; `compactionThreshold` is used. */
  readonly settings: Pick<LayerSettings, 'compactionThreshold'>;
  /** Path rows per copy transaction; default `COMPACTION_BATCH_SIZE`. */
  readonly batchSize?: number;
}

export interface Compacted {
  readonly outcome: 'compacted';
  readonly baseLayerId: string;
  readonly replacedLayerId: string;
  readonly supersededAt: Date;
  readonly pathsWritten: number;
}

export interface NotDue {
  readonly outcome: 'not_due';
  readonly depth: number;
  readonly threshold: number;
}

export interface NotIndexed {
  readonly outcome: 'not_indexed';
}

/** The switch found another layer current (or none); nothing was switched. */
export interface NoLongerCurrent {
  readonly outcome: 'no_longer_current';
  /** The staged base this run wrote, left for the discard sweep. */
  readonly baseLayerId: string;
  readonly copiedLayerId: string;
  readonly currentLayerId: string | null;
}

export type CompactionResult = Compacted | NotDue | NotIndexed | NoLongerCurrent;

/**
 * The due rule, written once: a current published layer (no supersession time)
 * is due when its depth is strictly greater than the threshold.
 */
export function isCompactionDue(depth: number, threshold: number): boolean {
  return depth > threshold;
}

/** Runs `fn` in one transaction on its own pooled connection, bound to the tenant. */
async function inBound<T>(
  pool: pg.Pool,
  request: CompactRequest,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(BIND_TENANT_SQL, [request.clientId, request.tenantId]);
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

interface Copy {
  readonly copiedLayerId: string;
  readonly baseLayerId: string;
  readonly entries: PathEntry[];
}

/**
 * Compacts `request.commitSha` when it is due. Answers `not_indexed` when the
 * commit has no current published layer in the bound view (an unbound session
 * sees none), `not_due` when its depth is at or below the threshold,
 * `no_longer_current` when the switch finds another layer current, and
 * `compacted` otherwise. Stores, deletes and releases no blob.
 */
export async function compactLayer(
  pool: pg.Pool,
  request: CompactRequest,
): Promise<CompactionResult> {
  const batchSize = request.batchSize ?? COMPACTION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  const scope: LayerScope = { tenantId: request.tenantId, repositoryId: request.repositoryId };
  const threshold = request.settings.compactionThreshold;

  // 1. Due check, the whole map, and the staged base row — before any path row.
  const start = await inBound(pool, request, async (c): Promise<Copy | NotDue | NotIndexed> => {
    const current = await readCurrentPublishedLayer(c, scope, request.commitSha);
    if (current === null) return { outcome: 'not_indexed' };
    if (!isCompactionDue(current.depth, threshold)) {
      return { outcome: 'not_due', depth: current.depth, threshold };
    }
    const resolved = await resolveCommit(
      c,
      request.tenantId,
      request.repositoryId,
      request.commitSha,
    );
    if (resolved.state !== 'indexed') return { outcome: 'not_indexed' };
    const base = await insertLayer(c, { ...scope, commitSha: request.commitSha, kind: 'base' });
    const entries = [...resolved.paths]
      .map(([path, gitBlobHash]) => ({ path, gitBlobHash }))
      .sort((x, y) => compareBytewise(x.path, y.path));
    return { copiedLayerId: resolved.layerId, baseLayerId: base.id, entries };
  });
  if ('outcome' in start) return start;

  // 2. The copy: one bounded batch per transaction, under the shared lock.
  for (let at = 0; at < start.entries.length; at += batchSize) {
    await inBound(pool, request, async (c) => {
      await lockTenantShared(c, request.tenantId);
      await appendLayerPaths(c, scope, start.baseLayerId, start.entries.slice(at, at + batchSize), {
        batchSize,
      });
    });
  }

  // 3. The switch: retire, publish, repoint — all or nothing.
  return inBound(pool, request, async (c): Promise<Compacted | NoLongerCurrent> => {
    await lockTenantShared(c, request.tenantId);
    const current = await readCurrentPublishedLayer(c, scope, request.commitSha, {
      forUpdate: true,
    });
    if (current?.id !== start.copiedLayerId) {
      return {
        outcome: 'no_longer_current',
        baseLayerId: start.baseLayerId,
        copiedLayerId: start.copiedLayerId,
        currentLayerId: current?.id ?? null,
      };
    }
    // Retire BEFORE publishing: a commit holds one current published layer.
    const retired = await markSuperseded(c, scope, current.id);
    await markPublished(c, scope, start.baseLayerId);
    for (const ref of await listRefHeadsNamingLayer(c, scope, current.id)) {
      await moveRefHead(c, {
        ...scope,
        refName: ref.refName,
        layerId: start.baseLayerId,
        isDefaultBranch: ref.isDefaultBranch,
      });
    }
    return {
      outcome: 'compacted',
      baseLayerId: start.baseLayerId,
      replacedLayerId: current.id,
      supersededAt: retired.supersededAt as Date,
      pathsWritten: start.entries.length,
    };
  });
}
