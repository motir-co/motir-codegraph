-- 0004: the operator's deletes, and the one existence check the delete routes use.
--
-- A client deletes as codegraph_app under row-level security, so it can only
-- ever reach the tenant it is bound and granted. An operator may delete any
-- tenant or repository, granted or not; codegraph_bound_tenant() admits no row
-- of a tenant the bound client holds no grant on, so the operator's deletes
-- are definer functions that check codegraph_require_operator() first, as every
-- operator write is (docs/schema-contract.md §6). The schema's ON DELETE
-- CASCADE removes the repositories, access-log rows and grants beneath.
--
-- codegraph_tenant_exists() lets the two delete routes answer a retried delete
-- of a tenant that is gone 404 rather than 403: a client that deletes its
-- granted tenant loses the grant in the same statement. It reads tenants by id
-- and returns a boolean, nothing more.

CREATE FUNCTION codegraph.codegraph_delete_tenant_as_operator(tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  DELETE FROM codegraph.tenants t
   WHERE t.id = codegraph_delete_tenant_as_operator.tenant_id;
  RETURN FOUND;
END
$$;

CREATE FUNCTION codegraph.codegraph_delete_repository_as_operator(tenant_id uuid, repository_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  DELETE FROM codegraph.repositories r
   WHERE r.tenant_id = codegraph_delete_repository_as_operator.tenant_id
     AND r.id = codegraph_delete_repository_as_operator.repository_id;
  RETURN FOUND;
END
$$;

CREATE FUNCTION codegraph.codegraph_tenant_exists(tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM codegraph.tenants t WHERE t.id = codegraph_tenant_exists.tenant_id
  );
$$;

REVOKE EXECUTE ON FUNCTION codegraph.codegraph_delete_tenant_as_operator(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION codegraph.codegraph_delete_repository_as_operator(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION codegraph.codegraph_tenant_exists(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION codegraph.codegraph_delete_tenant_as_operator(uuid) TO codegraph_app;
GRANT EXECUTE ON FUNCTION codegraph.codegraph_delete_repository_as_operator(uuid, uuid) TO codegraph_app;
GRANT EXECUTE ON FUNCTION codegraph.codegraph_tenant_exists(uuid) TO codegraph_app;
