-- 0001: the tenancy tables, keyed by the service's own UUIDs only.
--
-- Applied by `pnpm db:migrate` as codegraph_owner, which owns every object
-- created here. No column anywhere holds a Motir organisation, project or
-- workspace id: Motir is a client of this service and maps its own ids.
--
-- Grants to codegraph_app are written per table and per verb. There are no
-- default privileges, so a table added later gets nothing until its own
-- migration grants it.
--
-- Row-level security is NOT enabled here; 0002 enables and forces it.

-- Every login could create objects in `public` on older Postgres versions.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA codegraph FROM PUBLIC;

-- ── tenants ────────────────────────────────────────────────────────────────
CREATE TABLE codegraph.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── repositories ───────────────────────────────────────────────────────────
-- UNIQUE (tenant_id, id) is the pair every per-repository row references, so a
-- repository id can never sit under another tenant. It also indexes tenant_id.
CREATE TABLE codegraph.repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES codegraph.tenants (id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repositories_tenant_id_id_key UNIQUE (tenant_id, id)
);

-- ── clients ────────────────────────────────────────────────────────────────
-- Not tenant-owned: authentication reads them before any tenant is bound, and
-- a client outlives a tenant it was granted.
CREATE TABLE codegraph.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  kind text NOT NULL CHECK (kind IN ('client', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── credentials ────────────────────────────────────────────────────────────
-- Only the SHA-256 of a token is stored (tokens are high-entropy random values,
-- so a fast hash is enough), with a short prefix to recognise it by.
CREATE TABLE codegraph.credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES codegraph.clients (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  display_prefix text NOT NULL CHECK (char_length(display_prefix) BETWEEN 1 AND 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT credentials_token_hash_key UNIQUE (token_hash),
  CONSTRAINT credentials_revoked_after_created CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX credentials_client_id_idx ON codegraph.credentials (client_id);

-- ── grants ─────────────────────────────────────────────────────────────────
-- client → tenant. A revoked grant is kept as history; at most one live grant
-- exists per client and tenant.
CREATE TABLE codegraph.grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES codegraph.clients (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES codegraph.tenants (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT grants_revoked_after_created CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE UNIQUE INDEX grants_one_live_per_client_tenant
  ON codegraph.grants (client_id, tenant_id) WHERE revoked_at IS NULL;
CREATE INDEX grants_tenant_id_idx ON codegraph.grants (tenant_id);

-- ── content_access_log ─────────────────────────────────────────────────────
-- One row per read of stored file contents (the read API fills it). The
-- composite key to the repository pair means a row can never name another
-- tenant's repository, and a repository or tenant delete removes its rows.
-- client_id does not cascade: a client that has read contents is revoked, never
-- deleted, so its access history stays.
CREATE TABLE codegraph.content_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES codegraph.clients (id),
  read_at timestamptz NOT NULL DEFAULT now(),
  content_ref text NOT NULL CHECK (btrim(content_ref) <> ''),
  CONSTRAINT content_access_log_repository_fkey
    FOREIGN KEY (tenant_id, repository_id)
    REFERENCES codegraph.repositories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX content_access_log_tenant_repository_idx
  ON codegraph.content_access_log (tenant_id, repository_id);
CREATE INDEX content_access_log_client_id_idx ON codegraph.content_access_log (client_id);

-- ── codegraph_app's least grants ───────────────────────────────────────────
-- Creating tenants, registering repositories, issuing credentials and granting
-- access are owner functions (0002); codegraph_app holds no INSERT for them.
GRANT USAGE ON SCHEMA codegraph TO codegraph_app;

GRANT SELECT, DELETE ON codegraph.tenants TO codegraph_app;
GRANT UPDATE (display_name) ON codegraph.tenants TO codegraph_app;

GRANT SELECT, DELETE ON codegraph.repositories TO codegraph_app;
GRANT UPDATE (display_name) ON codegraph.repositories TO codegraph_app;

-- Append-only for the application: it writes access rows and never reads,
-- changes or removes them.
GRANT INSERT ON codegraph.content_access_log TO codegraph_app;

-- Nothing on clients, credentials, grants or schema_migrations.
