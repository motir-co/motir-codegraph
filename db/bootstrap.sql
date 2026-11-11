-- The two logins motir-codegraph runs with. Run by `pnpm db:bootstrap` as a
-- superuser (DATABASE_ADMIN_URL), locally and in CI only: creating a role needs
-- SUPERUSER or CREATEROLE, which codegraph_owner must not hold, so this is not a
-- migration. In production the data stack's role bootstrap creates both roles.
--
-- Idempotent: a role that exists has its attributes RE-ASSERTED, so a second run
-- changes nothing and a drifted role is put back.
--
-- Passwords and the database are set by the bootstrap script after this file,
-- from DATABASE_URL and DATABASE_APP_URL.

DO $bootstrap$
DECLARE
  login text;
BEGIN
  FOREACH login IN ARRAY ARRAY['codegraph_owner', 'codegraph_app'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = login) THEN
      EXECUTE format('CREATE ROLE %I', login);
    END IF;
    -- codegraph_owner owns the schema and every table; codegraph_app owns
    -- nothing. Neither may bypass row-level security, create roles or
    -- databases, or replicate.
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
      login
    );
    EXECUTE format('ALTER ROLE %I SET search_path = codegraph', login);
  END LOOP;

  -- codegraph_app must never be able to SET ROLE codegraph_owner, so it is
  -- never a member of it (and the owner is never a member of the app login).
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = m.member
    WHERE r.rolname = 'codegraph_owner' AND u.rolname = 'codegraph_app'
  ) THEN
    REVOKE codegraph_owner FROM codegraph_app;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = m.member
    WHERE r.rolname = 'codegraph_app' AND u.rolname = 'codegraph_owner'
  ) THEN
    REVOKE codegraph_app FROM codegraph_owner;
  END IF;
END
$bootstrap$;
