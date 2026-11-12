# Schema contract

The rules every table added to motir-codegraph follows: the per-file indexing
tables (blobs, commit layers, file contents, the queue), the read API's tables,
and the SCIP tables. The foundation tables in
[`db/migrations/0001_tenancy.sql`](../db/migrations/0001_tenancy.sql) and
[`0002_row_level_security.sql`](../db/migrations/0002_row_level_security.sql)
already follow them; copy their shape.

## 1. Why the contract exists

Tenant isolation is enforced by the database, not by the service's queries. A
table that skips one of these rules is not "slightly less safe": it is a table
every tenant can read, or one a tenant delete leaves behind. The integration
tests (rule 8) fail on a table that breaks the rules, so a gap is caught on the
pull request that opens it.

## 2. Keys

A per-repository table lives in schema `codegraph` and carries two columns:

- `tenant_id uuid NOT NULL`
- `repository_id uuid NOT NULL`

Both are the service's own ids, from `codegraph.tenants` and
`codegraph.repositories`. **No column holds a Motir organisation, project or
workspace id**, under any name: Motir is a client, and maps its own ids onto
the service's. The catalogue test rejects a column whose name contains such a
word.

## 3. The foreign key

Reference the (tenant, repository) PAIR, never the repository id alone:

```sql
CONSTRAINT <table>_repository_fkey
  FOREIGN KEY (tenant_id, repository_id)
  REFERENCES codegraph.repositories (tenant_id, id)
  ON DELETE CASCADE
```

`repositories` is unique on `(tenant_id, id)` for this purpose. The pair means a
row can never name another tenant's repository, and the cascade means deleting
a repository, or the tenant that owns it, removes the row. Index the
foreign-key columns.

## 4. Row-level security

Enable it **and force it**, then write exactly two policies, in the shape the
foundation uses:

```sql
ALTER TABLE codegraph.<table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.<table> FORCE ROW LEVEL SECURITY;
CREATE POLICY <table>_tenant ON codegraph.<table>
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY <table>_owner ON codegraph.<table>
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);
```

- The tenant policy is `TO codegraph_app`. `codegraph_bound_tenant()` returns the
  tenant bound in `app.tenant_id` only while the client bound in `app.client_id`
  holds a live grant to it, and NULL otherwise, so an unbound, ungranted,
  revoked or malformed binding admits no row.
- Keep the comparison an **uncorrelated sub-select**, `(SELECT
codegraph.codegraph_bound_tenant())`, with no reference to the row inside it.
  Postgres then evaluates it once per query, not once per row.
- The owner policy is `TO codegraph_owner`. FORCE binds the owner too, and
  without this policy the owner's migrations and definer functions would see
  nothing. `codegraph_app` is not a member of `codegraph_owner`, so it cannot
  reach this policy.
- **No policy for PUBLIC.** Any other login is denied by default.

## 5. Grants

Grant `codegraph_app` explicitly, per table and per verb, the least the service
needs, and nothing more. The foundation's grants are:

| Table                | `codegraph_app` holds                   |
| -------------------- | --------------------------------------- |
| `tenants`            | SELECT, DELETE, UPDATE (`display_name`) |
| `repositories`       | SELECT, DELETE, UPDATE (`display_name`) |
| `content_access_log` | INSERT only                             |
| `clients`            | nothing                                 |
| `credentials`        | nothing                                 |
| `grants`             | nothing                                 |
| `schema_migrations`  | nothing                                 |

Never use `ALTER DEFAULT PRIVILEGES`: a default grant is one no reviewer sees.
A table that is not tenant-owned gets no grant to `codegraph_app` at all, and is
reached only through an owner function (rule 6).

## 6. Functions

A new `SECURITY DEFINER` function:

- is owned by `codegraph_owner` (a migration creates it, so it is);
- pins `SET search_path = codegraph, pg_temp`, so a caller cannot shadow a
  table with a temporary one;
- has EXECUTE **revoked from PUBLIC**, because Postgres grants EXECUTE to PUBLIC
  by default and a definer function left that way is callable by any login;
- has EXECUTE granted only to the login that needs it. A function a policy
  expression calls needs EXECUTE for `codegraph_app`, because Postgres checks it
  against the querying role, not the table owner: `codegraph_bound_tenant()` is
  granted to `codegraph_app` for exactly this reason.

A function that writes on an operator's behalf calls
`codegraph.codegraph_require_operator()` first, as the foundation's operator
functions do.

`codegraph_app` holds no privilege on `clients` or `credentials`. The one read
of them open to it is `codegraph.codegraph_get_client(id)` (migration
0003), an operator-only definer function that returns the client and each of
its credentials' id, display prefix and times. It returns **no token and no
token hash**: a token is shown once, in the answer that issues it, and the
database never holds it in readable form.

## 7. Migrations

A schema change is one new plain-SQL file under [`db/migrations/`](../db/migrations),
named `NNNN_<snake_case>.sql` with the next number, applied by `pnpm db:migrate`
as `codegraph_owner`. **Never edit a file once it has been applied**: the runner
records each file's checksum and refuses to run, naming the file, when an
applied one changes. A correction is another new file.

## 8. Tests

A new tenant-owned table joins the tests the foundation runs against a real
Postgres:

- **isolation**: a session bound to one tenant reads and writes only that
  tenant's rows, and an ungranted, revoked or missing binding reads and writes
  nothing;
- **deletion**: deleting the repository, and the tenant, removes the table's
  rows;
- **catalogue**: the scan of schema `codegraph` finds `tenant_id`, forced
  row-level security and both policies on every table that carries a
  `tenant_id`, and no Motir id column anywhere. It fails for a tenant-owned table
  that is not forced;
- **policy shape**: the tenant policy's USING and WITH CHECK are exactly the
  sub-select above, and the owner policy is `TO codegraph_owner`.

## 9. Content reads

Every read of stored file contents appends one row to
`codegraph.content_access_log`: the tenant, the repository, the client, the
time and what was read (`content_ref`). The read API epic writes those rows.
`codegraph_app` may only **append** to that table: it holds INSERT and nothing
else, so it can neither read the log back nor change or remove a row, and the
tenant policy's WITH CHECK refuses a row for any tenant but the bound one.
