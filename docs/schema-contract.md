# Schema contract

The rules every table added to motir-codegraph follows: the per-file indexing
tables (blobs, commit layers, file contents, the queue), the read API's tables,
and the SCIP tables. The foundation tables in
[`db/migrations/0001_tenancy.sql`](../db/migrations/0001_tenancy.sql) and
[`0002_row_level_security.sql`](../db/migrations/0002_row_level_security.sql)
already follow them; copy their shape. The rules for the routes that read and
write these tables are in [`docs/api-contract.md`](api-contract.md).

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

A content-addressed table (§10) is the one shape that carries `tenant_id`
without `repository_id`.

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

A content-addressed table has no pair to reference: it cascades from
`codegraph.tenants` instead, as §10 states.

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

Migration 0004 adds the delete routes' functions. An operator deletes a tenant
or a repository through `codegraph.codegraph_delete_tenant_as_operator(tenant_id)`
and `codegraph.codegraph_delete_repository_as_operator(tenant_id, repository_id)`,
both operator-only, because the tenant policy admits no row of a tenant the
bound client holds no grant on. A client deletes as `codegraph_app` under that
policy instead. `codegraph.codegraph_tenant_exists(tenant_id)` returns only
whether the tenant exists; the two delete routes use it so a retried delete of
a tenant that is gone answers 404 rather than 403.

Migrations 0010 and 0011 add the indexing queue's two cross-tenant reads, both
callable by `codegraph_app` with nothing bound, because a worker pool serves
every tenant. `codegraph.codegraph_claim_index_job(lease_ms, max_attempts)`
(0010) claims one job or batch and answers ids and the token it minted, never a
row a tenant wrote. `codegraph.codegraph_index_queue_metrics(p_failed_window_ms)`
(0011) is `STABLE` and answers one row of four whole numbers (queued jobs,
queued or running batches, the oldest queued job's age in seconds, and the jobs
that failed inside the window) with no identifier at all. They are the only two:
any other read of the queue runs bound to one tenant. In `src/`,
`src/db/workerJobs.ts` names the first and `src/db/queueMetrics.ts` alone names
the second.

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
  rows. For a content-addressed table (§10) the deletion cases are the tenant
  delete and the delete-blobs call, not the repository delete;
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
The route side of this rule is [`docs/api-contract.md`](api-contract.md) §8.

## 10. Content-addressed tables

Some rows belong to a file's content rather than to a repository: the bytes of
one git blob, and what was extracted from them. Such a table is
**content-addressed**, and it is a licensed shape of its own, not a relaxation
of §2 or §3.

- **What it is.** Its rows belong to one tenant and one file's git blob (the
  git object id), and to no repository. The same bytes stored twice within a
  tenant are one row, so storing them again is a no-op. A row that named a
  repository, a path or a commit would give identical bytes two rows, which is
  the duplication the blob model exists to prevent.
- **What it carries.** `tenant_id`, and the blob's git object id column that
  says which blob the row belongs to. No `repository_id`, and no column naming
  a repository, a path or a commit. The table's own key adds whatever the table
  is for: one row per blob for its contents, many rows per blob for its facts.
  §2's rule that no column holds a Motir organisation, project or workspace id
  applies unchanged.
- **Sections 2 and 3 still stand for per-repository rows.** A table holding
  anything that belongs to one repository keeps `repository_id` and the pair
  foreign key. A content-addressed table is the only shape this document
  licenses without them.
- **No links between content-addressed rows.** No column references another
  content-addressed row as the target of a name. A name that refers to another
  file (a called function, an imported module, a parent class) stays
  unresolved in the row and is joined when a query runs, so a blob's rows are
  identical however and wherever it was stored.
- **Removal.** A foreign key to `codegraph.tenants` on its `id`, with ON DELETE
  CASCADE, and no repository foreign key. Deleting a tenant removes every one
  of its rows; deleting a repository removes none of them. The rows of a
  tenant's blobs that nothing references any more are removed by the
  delete-blobs call, in bounded batches. A table whose rows belong to a blob
  row may cascade from that row instead, and so from the tenant through it.
- **Row-level security.** Exactly what §4 requires: enabled and forced, the two
  policies §4 defines, named for the table as §4 names them (the tenant policy
  for `codegraph_app` comparing the row's `tenant_id` to the uncorrelated
  `codegraph_bound_tenant()` sub-select in both USING and WITH CHECK, and the
  owner policy for `codegraph_owner`), and no policy for PUBLIC.
- **Grants.** §5's rule unchanged: per table and per verb, the least the
  service needs, never a default privilege. The table's own migration names
  exactly the verbs it grants.
- **Tests.** §8's catalogue case already applies, because the scan derives its
  population from the `tenant_id` column: there is nothing for a migration to
  register. The isolation and policy-shape cases apply as they do to every
  table carrying `tenant_id`. The deletion cases that apply are the tenant
  delete and the delete-blobs call; §8's repository-deletion case is not one of
  them.
- **Content reads.** §9 stands unchanged: a read of a blob's stored contents
  still appends one `content_access_log` row naming the tenant, the repository
  the read is attributed to, the client, the time and what was read. The blob's
  row carries no repository id; the read of it still names one.
- **The first instances.** The blob table, its contents table and the fact
  table, which the per-file indexing work's first two migrations create. This
  section settles no column type, constraint name, index or migration file
  number for them: those belong to the migrations that create the tables.
