-- 0002: the database decides which tenant a request sees.
--
-- A request binds two transaction-local settings, the way motir-core binds its
-- own (set_config(..., true)):
--   app.client_id  the authenticated client
--   app.tenant_id  the tenant this transaction acts for
-- codegraph_bound_tenant() returns that tenant only while the client holds an
-- unrevoked grant to it, and every tenant-owned table admits a row to
-- codegraph_app only when its tenant column equals that value. A request bound
-- to an ungranted tenant, a revoked grant, a malformed value or nothing at all
-- sees nothing and can write nothing.
--
-- Every function here is SECURITY DEFINER, owned by codegraph_owner, with
-- search_path pinned to `codegraph, pg_temp` so a caller cannot shadow a table
-- with a temporary one. Postgres grants EXECUTE to PUBLIC by default, so it is
-- revoked from PUBLIC on every function and granted back only where needed.

-- ── the binding ────────────────────────────────────────────────────────────

CREATE FUNCTION codegraph.codegraph_bound_tenant()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
DECLARE
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  raw_tenant text := current_setting('app.tenant_id', true);
  raw_client text := current_setting('app.client_id', true);
BEGIN
  -- Unset, empty and malformed all read as unbound: deny, never raise.
  IF raw_tenant IS NULL OR raw_client IS NULL
     OR raw_tenant !~ uuid_shape OR raw_client !~ uuid_shape THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT g.tenant_id
    FROM codegraph.grants g
    WHERE g.client_id = raw_client::uuid
      AND g.tenant_id = raw_tenant::uuid
      AND g.revoked_at IS NULL
  );
END
$$;

-- The operator check every operator function makes first. It reads the kind
-- only: the API checks the credential is live when it authenticates, before it
-- binds app.client_id.
CREATE FUNCTION codegraph.codegraph_require_operator()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
DECLARE
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  raw_client text := current_setting('app.client_id', true);
  operator_id uuid;
BEGIN
  IF raw_client IS NOT NULL AND raw_client ~ uuid_shape THEN
    SELECT c.id INTO operator_id
    FROM codegraph.clients c
    WHERE c.id = raw_client::uuid AND c.kind = 'operator';
  END IF;
  IF operator_id IS NULL THEN
    RAISE EXCEPTION 'an operator client must be bound in app.client_id'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN operator_id;
END
$$;

-- ── row-level security ─────────────────────────────────────────────────────
-- FORCE makes the policies bind the table owner too. The owner policy keeps
-- the owner-run definer functions, migrations and owner sessions working;
-- codegraph_app cannot reach it because it is not a member of the owner. No
-- policy names PUBLIC, so any other login is denied by default.
--
-- `(SELECT codegraph.codegraph_bound_tenant())` is an uncorrelated sub-select:
-- Postgres plans it as an InitPlan evaluated once per query, not once per row.

ALTER TABLE codegraph.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant ON codegraph.tenants
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY tenants_owner ON codegraph.tenants
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

ALTER TABLE codegraph.repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY repositories_tenant ON codegraph.repositories
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY repositories_owner ON codegraph.repositories
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

ALTER TABLE codegraph.content_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.content_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY content_access_log_tenant ON codegraph.content_access_log
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY content_access_log_owner ON codegraph.content_access_log
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

-- ── authentication: the read before any tenant is bound ────────────────────

CREATE FUNCTION codegraph.codegraph_authenticate(token_hash bytea)
RETURNS TABLE (client_id uuid, client_kind text, tenant_ids uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
  SELECT
    c.id,
    c.kind,
    ARRAY(
      SELECT g.tenant_id
      FROM codegraph.grants g
      WHERE g.client_id = c.id AND g.revoked_at IS NULL
      ORDER BY g.tenant_id
    )
  FROM codegraph.credentials cr
  JOIN codegraph.clients c ON c.id = cr.client_id
  WHERE octet_length(codegraph_authenticate.token_hash) = 32
    AND cr.token_hash = codegraph_authenticate.token_hash
    AND cr.revoked_at IS NULL
$$;

-- ── operator functions ─────────────────────────────────────────────────────
-- The only way codegraph_app creates tenants, repositories, clients,
-- credentials or grants: it holds no INSERT on those tables.

CREATE FUNCTION codegraph.codegraph_create_tenant(display_name text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
DECLARE
  created uuid;
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  INSERT INTO codegraph.tenants (display_name)
  VALUES (codegraph_create_tenant.display_name)
  RETURNING id INTO created;
  RETURN created;
END
$$;

CREATE FUNCTION codegraph.codegraph_register_repository(tenant_id uuid, display_name text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
DECLARE
  created uuid;
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  INSERT INTO codegraph.repositories (tenant_id, display_name)
  VALUES (codegraph_register_repository.tenant_id, codegraph_register_repository.display_name)
  RETURNING id INTO created;
  RETURN created;
END
$$;

CREATE FUNCTION codegraph.codegraph_create_client(name text, kind text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
DECLARE
  created uuid;
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  INSERT INTO codegraph.clients (name, kind)
  VALUES (codegraph_create_client.name, codegraph_create_client.kind)
  RETURNING id INTO created;
  RETURN created;
END
$$;

-- Takes the HASH of a token, never the token: the caller hashes it.
CREATE FUNCTION codegraph.codegraph_issue_credential(
  client_id uuid,
  token_hash bytea,
  display_prefix text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
DECLARE
  created uuid;
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  INSERT INTO codegraph.credentials (client_id, token_hash, display_prefix)
  VALUES (
    codegraph_issue_credential.client_id,
    codegraph_issue_credential.token_hash,
    codegraph_issue_credential.display_prefix
  )
  RETURNING id INTO created;
  RETURN created;
END
$$;

-- True when this call revoked a live credential; false when it was already
-- revoked or does not exist.
CREATE FUNCTION codegraph.codegraph_revoke_credential(credential_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  UPDATE codegraph.credentials cr
  SET revoked_at = now()
  WHERE cr.id = codegraph_revoke_credential.credential_id AND cr.revoked_at IS NULL;
  RETURN FOUND;
END
$$;

-- Returns the live grant, creating it when there is none.
CREATE FUNCTION codegraph.codegraph_grant_access(client_id uuid, tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
-- ON CONFLICT names columns that share the parameters' names.
#variable_conflict use_column
DECLARE
  live uuid;
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  INSERT INTO codegraph.grants AS g (client_id, tenant_id)
  VALUES (codegraph_grant_access.client_id, codegraph_grant_access.tenant_id)
  ON CONFLICT (client_id, tenant_id) WHERE revoked_at IS NULL DO NOTHING
  RETURNING g.id INTO live;
  IF live IS NULL THEN
    SELECT g.id INTO live
    FROM codegraph.grants g
    WHERE g.client_id = codegraph_grant_access.client_id
      AND g.tenant_id = codegraph_grant_access.tenant_id
      AND g.revoked_at IS NULL;
  END IF;
  RETURN live;
END
$$;

-- True when this call revoked a live grant; false when there was none.
CREATE FUNCTION codegraph.codegraph_revoke_access(client_id uuid, tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  UPDATE codegraph.grants g
  SET revoked_at = now()
  WHERE g.client_id = codegraph_revoke_access.client_id
    AND g.tenant_id = codegraph_revoke_access.tenant_id
    AND g.revoked_at IS NULL;
  RETURN FOUND;
END
$$;

-- ── the first operator ─────────────────────────────────────────────────────
-- Owner-only: it creates an operator before any operator can be bound. The
-- API's bootstrap command and the deployment's release task call it as
-- codegraph_owner.
CREATE FUNCTION codegraph.codegraph_bootstrap_operator(
  name text,
  token_hash bytea,
  display_prefix text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
DECLARE
  created uuid;
BEGIN
  INSERT INTO codegraph.clients (name, kind)
  VALUES (codegraph_bootstrap_operator.name, 'operator')
  RETURNING id INTO created;
  INSERT INTO codegraph.credentials (client_id, token_hash, display_prefix)
  VALUES (created, codegraph_bootstrap_operator.token_hash, codegraph_bootstrap_operator.display_prefix);
  RETURN created;
END
$$;

-- ── EXECUTE ────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION
  codegraph.codegraph_bound_tenant(),
  codegraph.codegraph_require_operator(),
  codegraph.codegraph_authenticate(bytea),
  codegraph.codegraph_create_tenant(text),
  codegraph.codegraph_register_repository(uuid, text),
  codegraph.codegraph_create_client(text, text),
  codegraph.codegraph_issue_credential(uuid, bytea, text),
  codegraph.codegraph_revoke_credential(uuid),
  codegraph.codegraph_grant_access(uuid, uuid),
  codegraph.codegraph_revoke_access(uuid, uuid),
  codegraph.codegraph_bootstrap_operator(text, bytea, text)
FROM PUBLIC;

-- A policy expression runs as the querying role, so codegraph_app needs
-- EXECUTE on the binding it is filtered by. It reveals only the tenant the
-- transaction is already bound to.
GRANT EXECUTE ON FUNCTION
  codegraph.codegraph_bound_tenant(),
  codegraph.codegraph_authenticate(bytea),
  codegraph.codegraph_create_tenant(text),
  codegraph.codegraph_register_repository(uuid, text),
  codegraph.codegraph_create_client(text, text),
  codegraph.codegraph_issue_credential(uuid, bytea, text),
  codegraph.codegraph_revoke_credential(uuid),
  codegraph.codegraph_grant_access(uuid, uuid),
  codegraph.codegraph_revoke_access(uuid, uuid)
TO codegraph_app;
