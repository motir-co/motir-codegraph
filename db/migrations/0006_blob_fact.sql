-- 0006: one table for every fact a file yields. A definition, a reference such
-- as a call, an import and an inheritance are four kinds of one row, told apart
-- by `kind`, so a query across kinds, languages or producers stays one scan and
-- a second producer ships rows rather than a schema.
--
-- A fact names no repository, no path, no commit and no blob but its own: a
-- called name, an imported module and a parent class stay unresolved text, to
-- be joined when a query runs. So a blob's facts are the same whichever
-- repository, path or commit first carried it, and every commit, branch and
-- fork with the same bytes reuses them (docs/schema-contract.md §10).
--
-- The producer is part of a row's identity, as the kind is: a second
-- producer's facts about a blob sit beside tree-sitter's and neither replaces
-- the other. The extractor version is not: it belongs to the run, not to the
-- fact, so a replacement deletes one producer's rows and inserts the new set
-- in the caller's transaction, and the same fact re-inserted under a newer
-- version is refused.
--
-- Ranges are the extractor's own numbers, stored unchanged: 1-based lines and
-- columns with an exclusive end. The rows cascade from codegraph.blob, and so
-- from the tenant through it; there is no second path to keep in step.
--
-- Row-level security and the two policies follow §4, with the foundation's
-- policy text from 0002 repeated verbatim; grants follow §5, per verb.

CREATE TABLE codegraph.blob_fact (
  tenant_id         uuid    NOT NULL,
  git_blob_hash     text    NOT NULL,  -- the type the blob table declares its key with
  kind              text    NOT NULL,
  language          text    NOT NULL,
  producer          text    NOT NULL,
  extractor_version text    NOT NULL,
  name              text,
  start_line        integer,
  start_column      integer,
  end_line          integer,
  end_column        integer,
  enclosing_name    text,
  definition_kind   text,
  reference_kind    text,
  module_specifier  text,
  imported_names    text[],
  parent_name       text,
  relation          text,

  CONSTRAINT blob_fact_kind_check
    CHECK (kind IN ('definition', 'reference', 'import', 'inheritance')),

  -- Per kind, the columns it requires and the columns of the other kinds it
  -- must leave absent. A range is required except on an inheritance.
  CONSTRAINT blob_fact_kind_columns_check CHECK (CASE kind
    WHEN 'definition' THEN
      name IS NOT NULL AND definition_kind IS NOT NULL
      AND reference_kind IS NULL AND module_specifier IS NULL AND imported_names IS NULL
      AND parent_name IS NULL AND relation IS NULL
      AND start_line IS NOT NULL AND start_column IS NOT NULL
      AND end_line IS NOT NULL AND end_column IS NOT NULL
    WHEN 'reference' THEN
      name IS NOT NULL AND reference_kind IS NOT NULL
      AND definition_kind IS NULL AND module_specifier IS NULL AND imported_names IS NULL
      AND parent_name IS NULL AND relation IS NULL
      AND start_line IS NOT NULL AND start_column IS NOT NULL
      AND end_line IS NOT NULL AND end_column IS NOT NULL
    WHEN 'import' THEN
      module_specifier IS NOT NULL
      AND name IS NULL AND definition_kind IS NULL AND reference_kind IS NULL
      AND parent_name IS NULL AND relation IS NULL
      AND start_line IS NOT NULL AND start_column IS NOT NULL
      AND end_line IS NOT NULL AND end_column IS NOT NULL
    WHEN 'inheritance' THEN
      name IS NOT NULL AND parent_name IS NOT NULL AND relation IS NOT NULL
      AND definition_kind IS NULL AND reference_kind IS NULL
      AND module_specifier IS NULL AND imported_names IS NULL
    ELSE false
  END),

  -- All four range columns or none; 1-based; the start not after the end.
  CONSTRAINT blob_fact_range_check CHECK (
    num_nulls(start_line, start_column, end_line, end_column) IN (0, 4)
    AND (start_line IS NULL
         OR (start_line >= 1 AND start_column >= 1
             AND end_line >= 1 AND end_column >= 1
             AND (start_line, start_column) <= (end_line, end_column)))
  ),

  CONSTRAINT blob_fact_relation_check
    CHECK (relation IS NULL OR relation IN ('extends', 'implements')),

  CONSTRAINT blob_fact_text_nonempty_check CHECK (
    btrim(language) <> '' AND btrim(producer) <> '' AND btrim(extractor_version) <> ''
    AND (name IS NULL OR btrim(name) <> '')
    AND (enclosing_name IS NULL OR btrim(enclosing_name) <> '')
    AND (definition_kind IS NULL OR btrim(definition_kind) <> '')
    AND (reference_kind IS NULL OR btrim(reference_kind) <> '')
    AND (module_specifier IS NULL OR btrim(module_specifier) <> '')
    AND (parent_name IS NULL OR btrim(parent_name) <> '')
  ),

  CONSTRAINT blob_fact_blob_fkey
    FOREIGN KEY (tenant_id, git_blob_hash)
    REFERENCES codegraph.blob (tenant_id, git_blob_hash) ON DELETE CASCADE
);

-- A row's identity, the extractor version aside: the producer, the kind, the
-- range and the text that names the fact. NULLS NOT DISTINCT (PostgreSQL 15+):
-- under the default, two rows differing only in a column their kind leaves
-- NULL would both be accepted, and duplicate facts with them.
--
-- Every column in a btree entry must fit one index tuple (2,704 bytes), and a
-- name, an enclosing name, a module specifier or a parent name is source text
-- of any length. So those four go into the key as one fixed-size md5 over
-- their quoted values, quote_nullable keeping a NULL apart from the text
-- 'NULL'; the fixed-size columns go in as they are. md5 is a digest here, not
-- a security boundary: a crafted collision could only make its own tenant's
-- file fail to store. imported_names is not part of the identity: an import is
-- one per specifier at one range, and the extractor merges the names of two
-- matches of one statement into it (src/extract/buildFacts.ts).
CREATE UNIQUE INDEX blob_fact_identity_key ON codegraph.blob_fact (
  tenant_id, git_blob_hash, producer, kind,
  start_line, start_column, end_line, end_column,
  definition_kind, reference_kind, relation,
  md5(quote_nullable(name) || ',' || quote_nullable(enclosing_name) || ','
      || quote_nullable(module_specifier) || ',' || quote_nullable(parent_name))
) NULLS NOT DISTINCT;

-- A lookup by name within a tenant, leading with the tenant. A name is source
-- text of any length, so the index holds its md5, as the identity key does; a
-- lookup says `tenant_id = $1 AND md5(name) = md5($2) AND name = $2`, the last
-- term ruling out a collision. One blob's facts are read through the identity
-- key's index, which leads with (tenant_id, git_blob_hash).
CREATE INDEX blob_fact_name_idx ON codegraph.blob_fact (tenant_id, md5(name), kind);

-- ── row-level security ─────────────────────────────────────────────────────
ALTER TABLE codegraph.blob_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.blob_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_fact_tenant ON codegraph.blob_fact
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY blob_fact_owner ON codegraph.blob_fact
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

-- ── codegraph_app's least grants ───────────────────────────────────────────
-- No UPDATE: a fact is replaced (delete, then insert), never edited in place.
GRANT SELECT, INSERT, DELETE ON codegraph.blob_fact TO codegraph_app;
