// Open a commit's layer: the write side's first half.
//
// `openLayer` writes ONE staged layer for a commit, with its path rows, in one
// transaction that holds the tenant's layer lock SHARED from before its first
// read until commit. The path rows are the pins that stop a concurrent release
// deleting a blob this layer names, so they exist before the caller stores a
// single blob. Nothing reads a staged layer: publish makes it readable.
//
// Three shapes come out of it: a base when no candidate ancestor has a
// published layer; a base when the ancestor's chain is already at the hard
// ceiling; otherwise a delta holding exactly the paths that are new or changed
// against the ancestor's RESOLVED map, plus one tombstone per deleted path.

import type pg from 'pg';

import type { LayerSettings } from '../config.js';
import {
  appendLayerPaths,
  deleteLayerById,
  findNearestPublishedAncestor,
  insertLayer,
  listStagedLayersOfCommit,
  lockTenantShared,
  readCurrentPublishedLayer,
  readLayerById,
  readLayerPathsByLayerIds,
  type LayerKind,
  type LayerRow,
  type LayerScope,
  type NewLayer,
  type PathEntry,
} from '../db/layers.js';
import { BIND_TENANT_SQL } from '../server/binding.js';
import { resolveCommit } from './resolution.js';

/** Path rows per append statement unless the caller says otherwise. */
export const STAGE_BATCH_SIZE = 1_000;

/** What opening a commit's layer is handed. */
export interface OpenLayerInput {
  /** The client the transaction is bound as; it must hold a live grant on the tenant. */
  readonly clientId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  /** The ref the commit was indexed for; carried to the answer, steers nothing. */
  readonly refName: string;
  readonly isDefaultBranch: boolean;
  /** Ancestor commits from git, nearest first. */
  readonly candidateAncestors: readonly string[];
  /**
   * The commit's WHOLE tree, path → git blob hash. Blobs only: a gitlink
   * (submodule) entry is a commit id and must be left out by the caller.
   */
  readonly paths: ReadonlyMap<string, string>;
  /** The settings the host read with `readLayerSettings()`; `hardCeiling` is used. */
  readonly settings: Pick<LayerSettings, 'hardCeiling'>;
}

export interface OpenLayerOptions {
  /** Path rows per statement; default `STAGE_BATCH_SIZE`. */
  readonly batchSize?: number;
}

/** The layer `openLayer` wrote, or the published one it found and kept. */
export interface OpenedLayer {
  readonly layerId: string;
  readonly kind: LayerKind;
  readonly parentLayerId: string | null;
  readonly depth: number;
  /** The layer's own id, then its parent's chain: nearest first. */
  readonly chain: readonly string[];
  /** `staged` when written now; `published` when the commit already had a current layer. */
  readonly state: 'staged' | 'published';
  /** The commit of the parent layer; null for a base. */
  readonly ancestorCommit: string | null;
  readonly refName: string;
  readonly isDefaultBranch: boolean;
  /** The layer's own path rows in byte-wise path order; a null hash is a tombstone. */
  readonly entries: readonly PathEntry[];
}

/** An input path or blob hash that would sit in a layer, wrong, for the life of the commit. */
export class LayerInputRefused extends Error {
  readonly path: string;
  readonly value: string;

  constructor(path: string, value: string, why: string) {
    super(`Refused path ${JSON.stringify(path)} → ${JSON.stringify(value)}: ${why}.`);
    this.name = 'LayerInputRefused';
    this.path = path;
    this.value = value;
  }
}

const BLOB_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Refuses an empty, absolute or `..`-carrying path, and a malformed hash. */
function checkInput(paths: ReadonlyMap<string, string>): void {
  for (const [path, hash] of paths) {
    if (path === '') throw new LayerInputRefused(path, hash, 'the path is empty');
    if (path.startsWith('/')) throw new LayerInputRefused(path, hash, 'the path is absolute');
    if (path.split('/').includes('..')) {
      throw new LayerInputRefused(path, hash, 'the path carries a ".." segment');
    }
    if (!BLOB_HASH.test(hash)) {
      throw new LayerInputRefused(path, hash, 'the hash is not 40 or 64 lowercase hex characters');
    }
  }
}

/** Byte-wise (UTF-8) order, the order git and `COLLATE "C"` sort paths in. */
export function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The whole map as entries, in byte-wise path order: what a base holds. */
function wholeMap(paths: ReadonlyMap<string, string>): PathEntry[] {
  return [...paths]
    .map(([path, gitBlobHash]) => ({ path, gitBlobHash }))
    .sort((x, y) => compareBytewise(x.path, y.path));
}

/**
 * Exactly the paths `paths` carries that `ancestor` does not, or carries with a
 * different hash, plus a tombstone for each path `ancestor` carries and
 * `paths` does not — in byte-wise path order.
 */
export function diffAgainst(
  ancestor: ReadonlyMap<string, string>,
  paths: ReadonlyMap<string, string>,
): PathEntry[] {
  const entries: PathEntry[] = [];
  for (const [path, gitBlobHash] of paths) {
    if (ancestor.get(path) !== gitBlobHash) entries.push({ path, gitBlobHash });
  }
  for (const path of ancestor.keys()) {
    if (!paths.has(path)) entries.push({ path, gitBlobHash: null });
  }
  return entries.sort((x, y) => compareBytewise(x.path, y.path));
}

/**
 * The reusable staged write, inside the caller's client and transaction: the
 * layer row once, then its path rows in statements of at most `batchSize`.
 * Answers the layer row. Opens nothing and takes no lock — the caller holds
 * the shared tenant lock across it.
 */
export async function stageLayer(
  client: pg.ClientBase,
  layer: NewLayer,
  entries: readonly PathEntry[],
  options: OpenLayerOptions = {},
): Promise<LayerRow> {
  const batchSize = options.batchSize ?? STAGE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  const row = await insertLayer(client, layer);
  const scope: LayerScope = { tenantId: layer.tenantId, repositoryId: layer.repositoryId };
  for (let start = 0; start < entries.length; start += batchSize) {
    await appendLayerPaths(client, scope, row.id, entries.slice(start, start + batchSize), {
      batchSize,
    });
  }
  return row;
}

interface Decision {
  readonly layer: NewLayer;
  readonly entries: PathEntry[];
  readonly ancestorCommit: string | null;
}

/** Base or delta, and the entries, from the nearest published ancestor. */
async function decide(
  client: pg.ClientBase,
  input: OpenLayerInput,
  scope: LayerScope,
): Promise<Decision> {
  const base: Decision = {
    layer: { ...scope, commitSha: input.commitSha, kind: 'base' },
    entries: wholeMap(input.paths),
    ancestorCommit: null,
  };
  const ancestor = await findNearestPublishedAncestor(client, scope, input.candidateAncestors);
  if (ancestor === null) return base;
  const resolved = await resolveCommit(
    client,
    input.tenantId,
    input.repositoryId,
    ancestor.commitSha,
  );
  // Two reads disagreeing (the layer went between them) costs a full write.
  if (resolved.state !== 'indexed') return base;
  const parent = (await readLayerById(client, scope, resolved.layerId)) as LayerRow;
  // The parent's chain is its depth plus one; a delta over a chain already at
  // the ceiling would pass it, so that commit is written as a base.
  if (parent.depth + 1 >= input.settings.hardCeiling) return base;
  return {
    layer: {
      ...scope,
      commitSha: input.commitSha,
      kind: 'delta',
      parentLayerId: parent.id,
    },
    entries: diffAgainst(resolved.paths, input.paths),
    ancestorCommit: ancestor.commitSha,
  };
}

/**
 * Writes one staged layer for `input.commitSha`, with its path rows, in one
 * transaction on `pool`: bind the client and tenant, take the tenant's layer
 * lock shared, then read and write. A commit that already has a current
 * published layer is answered with it and nothing is written; a commit with
 * only staged layers has them removed and one fresh staged layer written.
 * Refuses a malformed path or hash with `LayerInputRefused` before connecting.
 * Reads no blob and writes no ref head.
 */
export async function openLayer(
  pool: pg.Pool,
  input: OpenLayerInput,
  options: OpenLayerOptions = {},
): Promise<OpenedLayer> {
  checkInput(input.paths);
  const scope: LayerScope = { tenantId: input.tenantId, repositoryId: input.repositoryId };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(BIND_TENANT_SQL, [input.clientId, input.tenantId]);
      await lockTenantShared(client, input.tenantId);
      const opened =
        (await keepPublished(client, input, scope)) ??
        (await writeStaged(client, input, scope, options));
      await client.query('COMMIT');
      return opened;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

function answer(
  layer: LayerRow,
  input: OpenLayerInput,
  ancestorCommit: string | null,
  entries: readonly PathEntry[],
): OpenedLayer {
  return {
    layerId: layer.id,
    kind: layer.kind,
    parentLayerId: layer.parentLayerId,
    depth: layer.depth,
    chain: layer.chain,
    state: layer.state,
    ancestorCommit,
    refName: input.refName,
    isDefaultBranch: input.isDefaultBranch,
    entries,
  };
}

/** The commit's current published layer, answered as stored; null when it has none. */
async function keepPublished(
  client: pg.ClientBase,
  input: OpenLayerInput,
  scope: LayerScope,
): Promise<OpenedLayer | null> {
  const current = await readCurrentPublishedLayer(client, scope, input.commitSha);
  if (current === null) return null;
  const parent =
    current.parentLayerId === null
      ? null
      : await readLayerById(client, scope, current.parentLayerId);
  const rows = await readLayerPathsByLayerIds(client, scope, [current.id]);
  const entries = rows
    .map(({ path, gitBlobHash }) => ({ path, gitBlobHash }))
    .sort((x, y) => compareBytewise(x.path, y.path));
  return answer(current, input, parent?.commitSha ?? null, entries);
}

/** Replaces any staged layer of the commit with one fresh staged layer. */
async function writeStaged(
  client: pg.ClientBase,
  input: OpenLayerInput,
  scope: LayerScope,
  options: OpenLayerOptions,
): Promise<OpenedLayer> {
  for (const stale of await listStagedLayersOfCommit(client, scope, input.commitSha)) {
    await deleteLayerById(client, scope, stale.id);
  }
  const decision = await decide(client, input, scope);
  const row = await stageLayer(client, decision.layer, decision.entries, options);
  return answer(row, input, decision.ancestorCommit, decision.entries);
}
