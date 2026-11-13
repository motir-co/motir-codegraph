// Resolution: a commit's whole path-to-blob map, in one statement.
//
// A commit's layer holds only the paths it changed or deleted over its parent,
// so its map is spread across a chain of layers in which a nearer entry hides a
// farther one. `resolveCommit` answers the whole map with ONE statement whose
// text and count do not move with the chain's depth: the commit's current
// layer, the nearest entry for every path, and the chain-completeness count all
// come from the same snapshot, so a compaction switch or a release cannot land
// between a layer lookup and a path read.
//
// It runs on the caller's client, inside the transaction the caller has already
// bound to a tenant (src/server/binding.ts). It opens no transaction, takes no
// lock and keeps no cache.

import type pg from 'pg';

import { OWNER_LOGIN } from '../db/connection.js';
import type { StatusState } from '../server/status.js';

/**
 * The one resolving statement. $1 tenant, $2 repository, $3 commit sha.
 *
 * - `current_layer` is the commit's CURRENT layer: published AND carrying no
 *   supersession time. A layer a compaction retired stays `published` (other
 *   chains still read it), so the timestamp predicate is what keeps a compacted
 *   commit to one row; the partial unique index
 *   `commit_layers_current_published_key` guarantees at most one survives.
 * - `nearest` picks, per path, the entry of the layer nearest the commit: the
 *   chain is stored nearest-first, so its position IS the precedence. A
 *   tombstone wins its path like any other entry and is dropped only after, in
 *   the final join — dropping it earlier would resurrect the farther entry.
 * - `chain_rows` counts the layer rows the chain still names, whatever their
 *   own state, because a retired ancestor is a legitimate chain member.
 * - The one-row spine keeps the three outcomes apart in one round trip: no
 *   layer ⇒ a null layer id; a layer with an empty map ⇒ one row, null path.
 * - The bound tenant and the session role travel with the answer so an empty
 *   result under a mis-bound session is refused rather than trusted.
 */
export const RESOLVE_COMMIT_SQL = `WITH current_layer AS (
  SELECT l.id, l.chain, cardinality(l.chain) AS chain_length
  FROM codegraph.commit_layers l
  WHERE l.tenant_id = $1 AND l.repository_id = $2
    AND l.commit_sha = $3 AND l.state = 'published'
    AND l.superseded_at IS NULL
),
nearest AS (
  SELECT DISTINCT ON (p.path) p.path, p.git_blob_hash
  FROM current_layer c
  JOIN codegraph.layer_paths p
    ON p.tenant_id = $1 AND p.repository_id = $2 AND p.layer_id = ANY (c.chain)
  ORDER BY p.path, array_position(c.chain, p.layer_id)
),
chain_rows AS (
  SELECT count(*)::int AS present
  FROM current_layer c
  JOIN codegraph.commit_layers d
    ON d.tenant_id = $1 AND d.repository_id = $2 AND d.id = ANY (c.chain)
)
SELECT (SELECT codegraph.codegraph_bound_tenant()) AS bound_tenant,
       current_user AS session_role,
       c.id AS layer_id,
       c.chain_length,
       (SELECT present FROM chain_rows) AS chain_present,
       n.path,
       n.git_blob_hash
FROM (SELECT 1) AS one
LEFT JOIN current_layer c ON true
LEFT JOIN nearest n ON n.git_blob_hash IS NOT NULL
ORDER BY n.path`;

/** The answer for a commit with no current published layer. */
export interface NotIndexed {
  readonly state: Extract<StatusState, 'not_indexed'>;
}

/** The answer for a commit with a current published layer. */
export interface Indexed {
  readonly state: 'indexed';
  /** The current layer the map was resolved through. */
  readonly layerId: string;
  /** Path → git blob hash, ascending by path; tombstoned paths are absent. */
  readonly paths: Map<string, string>;
}

export type Resolution = NotIndexed | Indexed;

export type ResolutionRefusal = 'tenant_not_bound' | 'chain_incomplete';

/**
 * The answer is missing, not empty: `tenant_not_bound` when the session is not
 * bound to the tenant asked for (row-level security would have answered an
 * empty map), `chain_incomplete` when the current layer's chain names a layer
 * row that no longer exists (the map would be silently short).
 */
export class ResolutionRefusedError extends Error {
  readonly reason: ResolutionRefusal;

  constructor(reason: ResolutionRefusal, message: string) {
    super(message);
    this.name = 'ResolutionRefusedError';
    this.reason = reason;
  }
}

interface ResolveRow {
  bound_tenant: string | null;
  session_role: string;
  layer_id: string | null;
  chain_length: number | null;
  chain_present: number | null;
  path: string | null;
  git_blob_hash: string | null;
}

/**
 * Resolves `commitSha` of a repository to its whole path-to-blob map, in one
 * statement on `db`. Requires a transaction bound to `tenantId` (or the owner
 * login, whose policy admits every row). Writes nothing. Refuses with
 * `ResolutionRefusedError` rather than answer a map it cannot vouch for.
 */
export async function resolveCommit(
  db: pg.ClientBase,
  tenantId: string,
  repositoryId: string,
  commitSha: string,
): Promise<Resolution> {
  const { rows } = await db.query<ResolveRow>(RESOLVE_COMMIT_SQL, [
    tenantId,
    repositoryId,
    commitSha,
  ]);
  // The spine guarantees at least one row.
  const head = rows[0] as ResolveRow;
  if (head.session_role !== OWNER_LOGIN && head.bound_tenant !== tenantId) {
    throw new ResolutionRefusedError(
      'tenant_not_bound',
      `The session is not bound to tenant ${tenantId}; its rows are invisible, so no answer is given.`,
    );
  }
  if (head.layer_id === null) {
    return { state: 'not_indexed' };
  }
  // Both counts are set whenever a layer row is.
  if ((head.chain_present as number) < (head.chain_length as number)) {
    throw new ResolutionRefusedError(
      'chain_incomplete',
      `Layer ${head.layer_id} names ${String(head.chain_length)} layers in its chain, ` +
        `but only ${String(head.chain_present)} exist; its map would be incomplete.`,
    );
  }
  const paths = new Map<string, string>();
  for (const row of rows) {
    if (row.path !== null && row.git_blob_hash !== null) {
      paths.set(row.path, row.git_blob_hash);
    }
  }
  return { state: 'indexed', layerId: head.layer_id, paths };
}
