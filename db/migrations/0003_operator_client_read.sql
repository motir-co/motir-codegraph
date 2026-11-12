-- 0003: the one read of clients and credentials open to codegraph_app.
--
-- codegraph_app holds nothing on clients or credentials (0001), so an operator
-- reading a client back, to find a credential to revoke or to check what was
-- issued, goes through this definer function. It returns each credential's id,
-- display prefix and times, and has no column for a token or its hash: a token
-- is shown once, when it is issued, and never again.
--
-- One row per credential of the client, or one row with null credential
-- columns for a client with none; no row for a client that does not exist.

CREATE FUNCTION codegraph.codegraph_get_client(id uuid)
RETURNS TABLE (
  client_id uuid,
  name text,
  kind text,
  created_at timestamptz,
  credential_id uuid,
  display_prefix text,
  credential_created_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
BEGIN
  PERFORM codegraph.codegraph_require_operator();
  RETURN QUERY
    SELECT c.id, c.name, c.kind, c.created_at,
           cr.id, cr.display_prefix, cr.created_at, cr.revoked_at
    FROM codegraph.clients c
    LEFT JOIN codegraph.credentials cr ON cr.client_id = c.id
    WHERE c.id = codegraph_get_client.id
    ORDER BY cr.created_at, cr.id;
END
$$;

REVOKE EXECUTE ON FUNCTION codegraph.codegraph_get_client(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION codegraph.codegraph_get_client(uuid) TO codegraph_app;
