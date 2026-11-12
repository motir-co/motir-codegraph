-- 0007: which blobs make up a commit. A commit is a map from paths to blobs,
-- stored as a stack of layers: a BASE layer holds the commit's whole map, a
-- DELTA layer over its nearest indexed ancestor holds only the paths that
-- commit adds or changes and a tombstone per path it deletes. Resolving a
-- commit reads its layer's chain and takes, per path, the entry of the nearest
-- layer that carries it.
--
-- Three tables, all per-repository (docs/schema-contract.md §2 and §3): each
-- carries tenant_id and repository_id, references the repository PAIR with ON
-- DELETE CASCADE, and is removed with its repository or its tenant. Row-level
-- security and the two policies follow §4, with the foundation's policy text
-- from 0002 repeated verbatim; grants follow §5, per verb, with no default
-- privilege.
--
-- The three service knobs — the compaction threshold, the hard ceiling and
-- the staged-layer staleness — appear nowhere here on purpose: they are
-- service configuration (src/config.ts), and a check that baked one in would
-- disagree with it the first time it changed.
--
-- No function and no trigger. Making a layer current and retiring the one it
-- replaces happen in the caller's transaction (src/db/layers.ts); a trigger
-- that rewrote a row there would act inside another module's unit of work.

-- ── commit_layers ──────────────────────────────────────────────────────────
-- One row per layer a commit was written as.
--
--   kind      'base' holds the commit's whole map: depth 0, no parent.
--             'delta' holds only what changed over its parent layer: depth
--             one more than the parent's, a parent named.
--   chain     the layer ids from this layer back to its base, NEAREST FIRST:
--             chain[1] is the layer itself, chain[2] its parent, and the last
--             element its base, so cardinality(chain) = depth + 1. Resolution
--             reads precedence from the position in this array, so a chain
--             stored parent-first would resolve a changed path to an
--             ancestor's blob with no error anywhere. No foreign key can hold
--             an array to account; commit_layers_kind_shape_check pins the
--             membership and the direction it can (self first, parent second,
--             the length), and the writer builds the rest from the parent's
--             own checked chain.
--   state     exactly 'staged' or 'published'. A staged layer is being
--             written: nothing resolves through it, and its paths pin their
--             blobs against release. Publish flips it.
--   superseded_at
--             replacement is a TIMESTAMP, not a third state. A published
--             layer that is no longer its commit's current layer (compaction
--             wrote a new base for the commit, or the commit was re-indexed)
--             keeps state 'published' and gains superseded_at: it stays
--             readable inside the chains of the commits written over it, is
--             skipped by every current-layer read (which filters on
--             superseded_at IS NULL), and is never taken by the stale-layer
--             sweep, which reads staged rows only. Deleting it instead would
--             silently shorten those other commits' resolved maps.
--
-- Delete actions:
--   - the pair key to repositories CASCADES: a repository or tenant delete
--     takes every layer with it (§3);
--   - a delta's key to its parent layer takes NO ACTION: a lone delete of a
--     layer another layer is written over fails loudly, while the repository
--     cascade, which removes both in the same statement, still succeeds
--     because the action is not RESTRICT.
CREATE TABLE codegraph.commit_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  commit_sha text NOT NULL,
  kind text NOT NULL,
  parent_layer_id uuid,
  depth integer NOT NULL,
  chain uuid[] NOT NULL,
  state text NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT commit_layers_repository_fkey
    FOREIGN KEY (tenant_id, repository_id)
    REFERENCES codegraph.repositories (tenant_id, id) ON DELETE CASCADE,
  -- The key layer_paths and ref_heads point at, so neither can name a layer of
  -- another repository of the same tenant (the pair key to repositories only
  -- proves the repository is the tenant's). It leads with the pair, so it is
  -- also the index §3 asks for on the foreign-key columns.
  CONSTRAINT commit_layers_tenant_repository_id_key UNIQUE (tenant_id, repository_id, id),
  CONSTRAINT commit_layers_parent_fkey
    FOREIGN KEY (tenant_id, repository_id, parent_layer_id)
    REFERENCES codegraph.commit_layers (tenant_id, repository_id, id),
  -- A SHA-1 (40) or SHA-256 (64) git object id, lowercase, as the blob key.
  CONSTRAINT commit_layers_commit_sha_check
    CHECK (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT commit_layers_kind_check CHECK (kind IN ('base', 'delta')),
  CONSTRAINT commit_layers_state_check CHECK (state IN ('staged', 'published')),
  -- kind, depth, parent and chain agree: a base is depth 0 with no parent, a
  -- delta is deeper with one; the chain is one-dimensional, has no NULL,
  -- starts with the layer itself, names the parent second, and is depth + 1
  -- long.
  CONSTRAINT commit_layers_kind_shape_check CHECK (
    array_ndims(chain) = 1
    AND array_position(chain, NULL) IS NULL
    AND chain[1] = id
    AND cardinality(chain) = depth + 1
    AND CASE kind
      WHEN 'base' THEN depth = 0 AND parent_layer_id IS NULL
      WHEN 'delta' THEN depth >= 1 AND parent_layer_id IS NOT NULL AND chain[2] = parent_layer_id
      ELSE false
    END
  ),
  -- state and the three timestamps agree: a staged layer carries neither a
  -- publication nor a supersession time; a published one carries its
  -- publication time, not before it was staged, and a supersession time, if
  -- any, not before it was published.
  CONSTRAINT commit_layers_state_times_check CHECK (
    CASE state
      WHEN 'staged' THEN published_at IS NULL AND superseded_at IS NULL
      WHEN 'published' THEN
        published_at IS NOT NULL
        AND published_at >= staged_at
        AND (superseded_at IS NULL OR superseded_at >= published_at)
      ELSE false
    END
  )
);

-- A commit has at most ONE current layer: published and not superseded. Any
-- number of staged layers for one commit may coexist (a killed job's and its
-- retry's), and any number of superseded ones, so this is a partial index and
-- not a table constraint. Making a second layer current without first
-- stamping superseded_at on the one it replaces is refused here, which is
-- what forces a switch to record what it replaced. It also answers "the
-- commit's current layer" and the nearest-published-ancestor lookup.
CREATE UNIQUE INDEX commit_layers_current_published_key
  ON codegraph.commit_layers (tenant_id, repository_id, commit_sha)
  WHERE state = 'published' AND superseded_at IS NULL;

-- Release's "does any live chain still name this layer": chain @> ARRAY[id].
CREATE INDEX commit_layers_chain_idx ON codegraph.commit_layers USING gin (chain);

-- The stale-layer sweep: a tenant's staged layers, oldest first.
CREATE INDEX commit_layers_staged_idx
  ON codegraph.commit_layers (tenant_id, staged_at)
  WHERE state = 'staged';

-- ── layer_paths ────────────────────────────────────────────────────────────
-- One row per path a layer carries: the path and the git blob hash it
-- resolves to, or a NULL hash for a TOMBSTONE (a path the commit deletes,
-- hiding the ancestor's entry). A changed or added path in a delta hides the
-- ancestor's entry by precedence.
--
-- NO foreign key to codegraph.blob, deliberately: a staged layer writes its
-- paths BEFORE the missing blobs are stored, so that its rows pin every blob
-- it will use against release; the blob does not exist yet at write time.
-- The hash keeps the blob key's shape check so the two compare without one,
-- and publish is where existence is checked.
--
-- A path has no existence apart from its layer, so the key to commit_layers
-- CASCADES, as the pair key to repositories does.
CREATE TABLE codegraph.layer_paths (
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  layer_id uuid NOT NULL,
  path text NOT NULL,
  git_blob_hash text,
  CONSTRAINT layer_paths_pkey PRIMARY KEY (tenant_id, repository_id, layer_id, path),
  CONSTRAINT layer_paths_repository_fkey
    FOREIGN KEY (tenant_id, repository_id)
    REFERENCES codegraph.repositories (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT layer_paths_layer_fkey
    FOREIGN KEY (tenant_id, repository_id, layer_id)
    REFERENCES codegraph.commit_layers (tenant_id, repository_id, id) ON DELETE CASCADE,
  -- Only non-empty here; an absolute path or a `..` segment is the writer's
  -- typed refusal, which names the path.
  CONSTRAINT layer_paths_path_check CHECK (path <> ''),
  CONSTRAINT layer_paths_git_blob_hash_check
    CHECK (git_blob_hash IS NULL OR git_blob_hash ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
);

-- Release's "which of a tenant's blobs does any layer still reference".
CREATE INDEX layer_paths_blob_idx
  ON codegraph.layer_paths (tenant_id, git_blob_hash)
  WHERE git_blob_hash IS NOT NULL;

-- ── ref_heads ──────────────────────────────────────────────────────────────
-- A repository's ref name → the commit and the layer it currently points at,
-- and whether that ref is the default branch. Publish inserts or moves a row
-- in the transaction that flips its layer. The status answer reads the
-- default branch's row as the repository's indexed commit.
--
-- The key to commit_layers takes NO ACTION rather than cascading: a cascade
-- would let a lone layer delete silently remove the row that answers which
-- commit a ref points at, so such a delete fails loudly instead, while the
-- same-statement repository cascade still succeeds because the action is not
-- RESTRICT.
CREATE TABLE codegraph.ref_heads (
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  ref_name text NOT NULL,
  commit_sha text NOT NULL,
  layer_id uuid NOT NULL,
  is_default_branch boolean NOT NULL DEFAULT false,
  CONSTRAINT ref_heads_pkey PRIMARY KEY (tenant_id, repository_id, ref_name),
  CONSTRAINT ref_heads_repository_fkey
    FOREIGN KEY (tenant_id, repository_id)
    REFERENCES codegraph.repositories (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ref_heads_layer_fkey
    FOREIGN KEY (tenant_id, repository_id, layer_id)
    REFERENCES codegraph.commit_layers (tenant_id, repository_id, id),
  CONSTRAINT ref_heads_commit_sha_check
    CHECK (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT ref_heads_ref_name_check CHECK (btrim(ref_name) <> '')
);

-- At most one default-branch row per repository: the status answer reads it
-- as a single row.
CREATE UNIQUE INDEX ref_heads_one_default_per_repository
  ON codegraph.ref_heads (tenant_id, repository_id)
  WHERE is_default_branch;

-- Which refs name a layer: compaction moves them, release must not drop one.
CREATE INDEX ref_heads_layer_idx ON codegraph.ref_heads (tenant_id, repository_id, layer_id);

-- ── row-level security ─────────────────────────────────────────────────────
ALTER TABLE codegraph.commit_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.commit_layers FORCE ROW LEVEL SECURITY;
CREATE POLICY commit_layers_tenant ON codegraph.commit_layers
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY commit_layers_owner ON codegraph.commit_layers
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

ALTER TABLE codegraph.layer_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.layer_paths FORCE ROW LEVEL SECURITY;
CREATE POLICY layer_paths_tenant ON codegraph.layer_paths
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY layer_paths_owner ON codegraph.layer_paths
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

ALTER TABLE codegraph.ref_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.ref_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY ref_heads_tenant ON codegraph.ref_heads
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY ref_heads_owner ON codegraph.ref_heads
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

-- ── codegraph_app's least grants ───────────────────────────────────────────
-- Layers are inserted when opened, deleted by a staged-layer replacement, the
-- stale-layer discard and release, and updated in exactly three columns:
-- publish flips state and stamps published_at, a switch stamps superseded_at.
-- Every other column is fixed once written.
GRANT SELECT, INSERT, DELETE ON codegraph.commit_layers TO codegraph_app;
GRANT UPDATE (state, published_at, superseded_at) ON codegraph.commit_layers TO codegraph_app;

-- A path is written once and never edited. DELETE is granted although the
-- layer's cascade removes its rows, so a caller that removes a layer with its
-- paths does not depend on which of the two forms it writes.
GRANT SELECT, INSERT, DELETE ON codegraph.layer_paths TO codegraph_app;

-- A ref is inserted, then moved; nothing deletes one but the repository
-- cascade, which needs no application privilege.
GRANT SELECT, INSERT ON codegraph.ref_heads TO codegraph_app;
GRANT UPDATE (commit_sha, layer_id, is_default_branch) ON codegraph.ref_heads TO codegraph_app;
