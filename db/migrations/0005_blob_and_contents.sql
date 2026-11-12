-- 0005: the first tables that hold code. A blob is one file's content, keyed
-- by the tenant and its git blob hash, and stored once per tenant however many
-- repositories, paths, commits, branches or forks carry it.
--
-- Both tables are content-addressed (docs/schema-contract.md §10): they carry
-- tenant_id and no repository_id, no path and no column naming another blob,
-- so a blob's rows are identical whichever repository it was stored from.
-- codegraph.blob cascades from codegraph.tenants; codegraph.blob_contents
-- cascades from codegraph.blob, and so from the tenant through it.
--
-- Row-level security and the two policies follow §4, with the foundation's
-- policy text from 0002 repeated verbatim; grants follow §5, per verb.

-- ── pg_trgm ────────────────────────────────────────────────────────────────
-- A trusted extension: codegraph_owner owns this database (src/db/bootstrap.ts),
-- so it may install it. Into schema codegraph, and the index below names its
-- operator class schema-qualified, so it resolves whatever search_path a later
-- reader carries.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA codegraph;

-- ── blob ───────────────────────────────────────────────────────────────────
-- One row per (tenant, git blob hash), carrying the file's size and its ONE
-- per-file outcome:
--   indexed      extracted: language, extractor_version, parsed_with_errors
--                and lossy are set; contents are stored.
--   unsupported  a text file whose language has no grammar: lossy is set and
--                contents are stored; language is set when the registry knows
--                the language and has no grammar for it, so its blobs can be
--                re-classified from their contents when one arrives.
--   binary       a NUL byte in the file: only the size is recorded.
--   refused      over the per-file cap: the size and the cap are recorded.
-- blob_outcome_columns_check forbids, per outcome, every column that outcome
-- does not use, so a row cannot half-declare two outcomes.
CREATE TABLE codegraph.blob (
  tenant_id uuid NOT NULL,
  git_blob_hash text NOT NULL,
  size_bytes integer NOT NULL,
  outcome text NOT NULL,
  parsed_with_errors boolean,
  lossy boolean,
  refused_cap_bytes integer,
  language text,
  extractor_version text,
  CONSTRAINT blob_pkey PRIMARY KEY (tenant_id, git_blob_hash),
  CONSTRAINT blob_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES codegraph.tenants (id) ON DELETE CASCADE,
  -- A SHA-1 (40) or SHA-256 (64) git object id, lowercase: a shortened or an
  -- uppercase id would silently be a second key for the same blob.
  CONSTRAINT blob_git_blob_hash_check
    CHECK (git_blob_hash ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT blob_outcome_check
    CHECK (outcome IN ('indexed', 'unsupported', 'binary', 'refused')),
  CONSTRAINT blob_size_bytes_check CHECK (size_bytes >= 0),
  CONSTRAINT blob_refused_cap_check CHECK (refused_cap_bytes IS NULL OR refused_cap_bytes > 0),
  CONSTRAINT blob_outcome_columns_check CHECK (
    CASE outcome
      WHEN 'indexed' THEN
        language IS NOT NULL
        AND extractor_version IS NOT NULL
        AND parsed_with_errors IS NOT NULL
        AND lossy IS NOT NULL
        AND refused_cap_bytes IS NULL
      WHEN 'unsupported' THEN
        extractor_version IS NULL
        AND parsed_with_errors IS NULL
        AND lossy IS NOT NULL
        AND refused_cap_bytes IS NULL
      WHEN 'binary' THEN
        language IS NULL
        AND extractor_version IS NULL
        AND parsed_with_errors IS NULL
        AND lossy IS NULL
        AND refused_cap_bytes IS NULL
      WHEN 'refused' THEN
        language IS NULL
        AND extractor_version IS NULL
        AND parsed_with_errors IS NULL
        AND lossy IS NULL
        AND refused_cap_bytes IS NOT NULL
      ELSE false
    END
  )
);

-- ── blob_contents ──────────────────────────────────────────────────────────
-- One text row per blob that stores contents (indexed and unsupported), for
-- grep and file reads. lz4 compression is the column's own setting: TOAST
-- compresses a value once it is stored out of line, and the trigram index
-- reads the decompressed text. A text column cannot hold a NUL character, so
-- the column refuses what it cannot store. Insert-once: a blob's bytes never
-- change.
CREATE TABLE codegraph.blob_contents (
  tenant_id uuid NOT NULL,
  git_blob_hash text NOT NULL,
  contents text COMPRESSION lz4 NOT NULL,
  CONSTRAINT blob_contents_pkey PRIMARY KEY (tenant_id, git_blob_hash),
  CONSTRAINT blob_contents_blob_fkey
    FOREIGN KEY (tenant_id, git_blob_hash)
    REFERENCES codegraph.blob (tenant_id, git_blob_hash) ON DELETE CASCADE
);

-- ── indexes ────────────────────────────────────────────────────────────────
-- Re-extraction and re-classification page a tenant's blobs of one language
-- by extractor version: indexed blobs at an older version, and unsupported
-- blobs of a language that has since gained a grammar.
CREATE INDEX blob_language_version_idx
  ON codegraph.blob (tenant_id, language, extractor_version);

CREATE INDEX blob_contents_contents_trgm_idx
  ON codegraph.blob_contents USING gin (contents codegraph.gin_trgm_ops);

-- ── row-level security ─────────────────────────────────────────────────────
ALTER TABLE codegraph.blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.blob FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_tenant ON codegraph.blob
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY blob_owner ON codegraph.blob
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

ALTER TABLE codegraph.blob_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.blob_contents FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_contents_tenant ON codegraph.blob_contents
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY blob_contents_owner ON codegraph.blob_contents
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

-- ── codegraph_app's least grants ───────────────────────────────────────────
GRANT SELECT, INSERT, DELETE ON codegraph.blob TO codegraph_app;
-- The six columns a stored blob row is ever rewritten in, by two writers:
--   - a producer's fact replacement (re-extraction) moves extractor_version
--     and parsed_with_errors;
--   - a re-classification, when the per-file cap or a language's grammar
--     changes what the configuration decides for the same bytes, moves
--     outcome, language, lossy and refused_cap_bytes.
-- Any other column is fixed once stored; rewriting one is a new migration.
GRANT UPDATE (outcome, language, extractor_version, parsed_with_errors, lossy, refused_cap_bytes)
  ON codegraph.blob TO codegraph_app;

-- No UPDATE at all: a blob's stored bytes never change.
GRANT SELECT, INSERT, DELETE ON codegraph.blob_contents TO codegraph_app;
