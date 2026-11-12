# motir-codegraph

motir-codegraph is Motir's code graph service, built as a product of its own: a
multi-tenant index of source repositories that answers questions about code
(definitions, references, file contents) for the clients it has issued
credentials to. Motir is one such client. The service has its own repository,
its own Postgres database and its own logins, and it **runs with no Motir service
present**: nothing in it needs motir-core or motir-ai to start, migrate or test.

License: **GPL-3.0-only** (see [LICENSE](LICENSE)).

Postgres is the service's store of record. Its schema holds **no Motir
organisation, project or workspace id**: tenants, repositories and clients are
the service's own UUIDs, and Motir, as a client, maps its own ids onto them.
Tenants are kept apart by the database itself, through forced row-level
security, not by the service remembering to filter.

## Prerequisites

- Node 22 or later, and pnpm (the version `packageManager` in `package.json` pins).
- Postgres 16 or later, and `psql` 15 or later (the walk below uses `\getenv`). CI
  runs Postgres 18; to start the same locally on port 5432:

  ```sh
  docker run --name codegraph-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:18
  ```

## Configure

```sh
cp .env.example .env
```

`.env` holds three connection URLs, all on `localhost`:

| Variable             | Login             | What it is for                                                                                                                |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_ADMIN_URL` | a superuser       | Used **only** by `pnpm db:bootstrap`, locally and in CI, to create the two logins and the database. Production never sets it. |
| `DATABASE_URL`       | `codegraph_owner` | Owns schema `codegraph` and every table. The only login migrations run as; the tests use it too.                              |
| `DATABASE_APP_URL`   | `codegraph_app`   | The login the service runs as. Owns nothing, cannot run DDL, and is held to one tenant per transaction by row-level security. |

`db:bootstrap` sets each login's password from the password in its own URL, so
the URLs are the only place the passwords are written.

## Bring up

```sh
pnpm install --frozen-lockfile
pnpm db:bootstrap
pnpm db:migrate
pnpm db:migrate
pnpm test
```

`pnpm db:bootstrap` creates (or re-asserts) both logins and the database:

```text
bootstrapped codegraph_owner and codegraph_app; database codegraph created
```

The first `pnpm db:migrate` applies every file in [`db/migrations/`](db/migrations)
in filename order, each in its own transaction, as `codegraph_owner`:

```text
applied 0001_tenancy.sql
applied 0002_row_level_security.sql
applied 0003_operator_client_read.sql
applied 0004_delete_functions.sql
```

The second applies nothing:

```text
nothing to apply (4 already applied)
```

`pnpm test` then runs the suite against the same Postgres; every test creates and
drops a database of its own. An applied migration file is never edited: the
runner records each file's checksum and refuses to run while an applied file's
checksum has changed, naming the file. A change is a new file.

## Watch tenant isolation

With the database brought up above, this psql walk creates two tenants and a
client granted one of them, then shows the database refusing the other. Load
`.env` into the shell and start psql as the owner:

```sh
set -a; . ./.env; set +a
psql "$DATABASE_URL"
```

Then paste each block. The token hashes are computed in psql with `sha256()`,
so no real credential appears; the ids in the outputs are the ones one run
printed and will differ in yours.

**1. As `codegraph_owner`, create the first operator, then use it.**
`codegraph_bootstrap_operator()` is the one function only the owner may call;
every other write goes through an operator function, which refuses unless
`app.client_id` names an operator.

```sql
\getenv app_url DATABASE_APP_URL
\getenv owner_url DATABASE_URL
SELECT codegraph.codegraph_bootstrap_operator('walk-operator', sha256('walk-operator-token'), 'cg_walk') AS operator_id \gset
BEGIN;
SELECT set_config('app.client_id', :'operator_id', true);
SELECT codegraph.codegraph_create_tenant('Acme') AS acme \gset
SELECT codegraph.codegraph_create_tenant('Globex') AS globex \gset
SELECT codegraph.codegraph_register_repository(:'acme', 'acme-web') AS acme_repo \gset
SELECT codegraph.codegraph_register_repository(:'globex', 'globex-core') AS globex_repo \gset
SELECT codegraph.codegraph_create_client('reader', 'client') AS reader \gset
SELECT codegraph.codegraph_issue_credential(:'reader', sha256('walk-reader-token'), 'cg_read');
SELECT codegraph.codegraph_grant_access(:'reader', :'acme');
COMMIT;
```

The last two calls print the new credential's id and the grant's id. Two
tenants now exist, Acme and Globex, with one repository each, and `reader` is
granted Acme only.

**2. As `codegraph_app`, bound to Acme, see Acme's repository.** A request binds
`app.client_id` and `app.tenant_id` with `set_config(..., true)`, which lasts
for one transaction:

```sql
\connect :app_url
BEGIN;
SELECT set_config('app.client_id', :'reader', true), set_config('app.tenant_id', :'acme', true);
SELECT display_name FROM codegraph.repositories;
COMMIT;
```

```text
 display_name
--------------
 acme-web
(1 row)
```

**3. Bound to Globex, which `reader` is not granted, see nothing.**

```sql
BEGIN;
SELECT set_config('app.client_id', :'reader', true), set_config('app.tenant_id', :'globex', true);
SELECT display_name FROM codegraph.repositories;
COMMIT;
```

```text
 display_name
--------------
(0 rows)
```

**4. With nothing bound, see nothing.**

```sql
BEGIN;
SELECT display_name FROM codegraph.repositories;
COMMIT;
```

```text
 display_name
--------------
(0 rows)
```

**5. The app login cannot switch row-level security off, or read credentials.**

```sql
ALTER TABLE codegraph.repositories DISABLE ROW LEVEL SECURITY;
SELECT * FROM codegraph.credentials;
```

```text
ERROR:  must be owner of table repositories
ERROR:  permission denied for table credentials
```

Both are SQLSTATE `42501`, insufficient privilege.

**6. As `codegraph_owner`, delete Acme.** Its repository and its grant go with
it; the client stays, because a client is not owned by a tenant.

```sql
\connect :owner_url
DELETE FROM codegraph.tenants WHERE display_name = 'Acme';
SELECT count(*) AS acme_repositories FROM codegraph.repositories WHERE tenant_id = :'acme';
SELECT count(*) AS acme_grants FROM codegraph.grants WHERE tenant_id = :'acme';
SELECT name, kind FROM codegraph.clients WHERE id = :'reader';
```

```text
DELETE 1
 acme_repositories
-------------------
                 0
(1 row)

 acme_grants
-------------
           0
(1 row)

  name  |  kind
--------+--------
 reader | client
(1 row)
```

## Run the server

The HTTP server is the only way into the service: every route sits under `/v1`,
except `GET /health`, which the load balancer calls and needs no credential.
The server connects as `codegraph_app` (`DATABASE_APP_URL`) and keeps no state
between requests, so any number of copies can run against one database.

With the database brought up above (Postgres running, `pnpm db:bootstrap` and
`pnpm db:migrate` done), start it:

```sh
pnpm serve
```

It listens on `PORT` (8080 in `.env.example`, and when `PORT` is unset). In
another shell:

```sh
curl -i http://localhost:8080/health
```

```text
HTTP/1.1 200 OK
cache-control: no-store
content-type: application/json; charset=utf-8

{"status":"ok","process":{"up":true,"uptimeSeconds":4},"database":{"up":true}}
```

When the database cannot be reached, the same call answers `503` with
`"status":"unavailable"` and `"database":{"up":false}` within a few seconds.
Every error the server answers carries one body,
`{"error":{"code":"…","message":"…"}}`; an unknown path answers `404`
`route_not_found`.

`pnpm build` compiles the server to `dist/`, and `pnpm start` runs the compiled
`dist/server/main.js`. `SIGTERM` or `SIGINT` closes the listener, letting
in-flight requests finish, and then the database pool.

## Bootstrap an operator

Every `/v1` call needs a credential the service issued, and only an operator
can issue one, so the first operator is made by a command run with the owner
login (`DATABASE_URL`) rather than through the API:

```sh
pnpm operator:bootstrap
```

It prints the new operator's token, once, on stdout (a line on stderr names the
client and the token's display prefix). Only the token's SHA-256 is stored, so
it cannot be shown again: keep it. The command refuses, prints no token and
exits 1 once any operator exists; later operators are created with
`POST /v1/operator/clients` and `"kind": "operator"`.

### From a deploy: `OPERATOR_TOKEN`

A deploy that runs the command on every release sets `OPERATOR_TOKEN` to a
token it generated and keeps in its own secret store (`cgk_` and at least 9
more characters; on AWS, motir-infra's `<namePrefix>/codegraph-v2/operator-token`):

```sh
OPERATOR_TOKEN=cgk_... pnpm operator:bootstrap
```

The command then registers that token as the first operator's credential
instead of minting one (only its SHA-256 and its first 12 characters are
stored) and prints nothing on stdout. Once any operator exists it changes
nothing, notes so on stderr and exits 0, so a second release passes. A value
without the `cgk_` prefix is refused: it exits 1 and creates nothing. An empty
`OPERATOR_TOKEN` counts as unset, so the command mints and prints as above.

With the server running (`pnpm serve`), use the token for an operator call:

```sh
export OPERATOR_TOKEN=<the printed token>   # unset it before running the bootstrap again
curl -s -X POST http://localhost:8080/v1/operator/tenants \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"displayName":"Acme"}'
```

```text
{"tenantId":"6f1c2c0e-3a4b-4f7d-9c55-0b8f2f0e7a11"}
```

## Try the API

The whole journey a client and an operator take, on this machine, with no
motir-core, motir-ai or AWS anywhere: the story's verification recipe.
`tests/integration/api-journey.test.ts` runs the same steps against two copies
of the server on every pull request. The calls use `curl` 7.82 or later
(`--json`) and `jq`.

1. Start Postgres (see [Prerequisites](#prerequisites)), then create the logins
   and the schema, and start the server:

   ```sh
   pnpm db:bootstrap
   pnpm db:migrate
   pnpm serve
   ```

2. In another shell, make the first operator and keep its token:

   ```sh
   export OPERATOR_TOKEN=$(pnpm --silent operator:bootstrap)
   export API=http://localhost:8080
   op() { curl -s -H "Authorization: Bearer $OPERATOR_TOKEN" "$@"; }
   ```

3. As the operator, create two tenants with a repository each, a client, its
   credential (the token is in this one answer and never again), and a grant
   to the first tenant only:

   ```sh
   A=$(op $API/v1/operator/tenants --json '{"displayName":"Acme"}' | jq -r .tenantId)
   B=$(op $API/v1/operator/tenants --json '{"displayName":"Globex"}' | jq -r .tenantId)
   RA=$(op $API/v1/operator/repositories --json "{\"tenantId\":\"$A\",\"displayName\":\"acme-web\"}" | jq -r .repositoryId)
   RB=$(op $API/v1/operator/repositories --json "{\"tenantId\":\"$B\",\"displayName\":\"globex-core\"}" | jq -r .repositoryId)
   CLIENT=$(op $API/v1/operator/clients --json '{"name":"motir-ai","kind":"client"}' | jq -r .clientId)
   export CLIENT_TOKEN=$(op -X POST $API/v1/operator/clients/$CLIENT/credentials | jq -r .token)
   op $API/v1/operator/grants --json "{\"clientId\":\"$CLIENT\",\"tenantId\":\"$A\"}"
   op $API/v1/operator/clients/$CLIENT
   ```

   The last call lists the credential's id and display prefix, and no token.

4. As the client, read the first repository's status:

   ```sh
   cl() { curl -s -H "Authorization: Bearer $CLIENT_TOKEN" "$@"; }
   cl $API/v1/tenants/$A/repositories/$RA/status
   ```

   ```text
   {"tenantId":"…","repositoryId":"…","state":"not_indexed","indexedCommit":null,"inProgressJob":null,"lastFailure":null,"languages":[]}
   ```

5. The client is refused the other tenant (403) and an unknown repository
   (404), each in the one error body:

   ```sh
   cl $API/v1/tenants/$B/repositories/$RB/status
   cl $API/v1/tenants/$A/repositories/00000000-0000-4000-8000-000000000000/status
   ```

   ```text
   {"error":{"code":"permission_denied","message":"The credential may not use this tenant."}}
   {"error":{"code":"repository_not_found","message":"No such repository."}}
   ```

6. No credential, or a made-up one, is 401; the client on an operator call is
   403:

   ```sh
   curl -s $API/v1/tenants/$A/repositories/$RA/status
   curl -s -H 'Authorization: Bearer cgk_made_up' $API/v1/tenants/$A/repositories/$RA/status
   cl $API/v1/operator/tenants --json '{"displayName":"Sneaky"}'
   ```

7. Revoke the grant; the client's next call is refused, with no restart:

   ```sh
   op $API/v1/operator/grants/revoke --json "{\"clientId\":\"$CLIENT\",\"tenantId\":\"$A\"}"
   cl $API/v1/tenants/$A/repositories/$RA/status
   ```

8. Grant it again; the client deletes its repository (204, then 404 on a
   second try), and the operator deletes the other tenant:

   ```sh
   op $API/v1/operator/grants --json "{\"clientId\":\"$CLIENT\",\"tenantId\":\"$A\"}"
   cl -o /dev/null -w '%{http_code}\n' -X DELETE $API/v1/tenants/$A/repositories/$RA
   cl -X DELETE $API/v1/tenants/$A/repositories/$RA
   op -o /dev/null -w '%{http_code}\n' -X DELETE $API/v1/tenants/$B
   ```

   ```text
   204
   {"error":{"code":"repository_not_found","message":"No such repository."}}
   204
   ```

9. Stop Postgres and `curl -i $API/health` answers `503`. Then run the suite:

   ```sh
   pnpm test
   ```

The rules every route follows are in [`docs/api-contract.md`](docs/api-contract.md).

## Where to go next

Adding a table? Read [`docs/schema-contract.md`](docs/schema-contract.md): the
rules every per-repository table follows so it is isolated, deleted and checked
like the foundation tables.

Adding a route? Read [`docs/api-contract.md`](docs/api-contract.md): the one
authentication and binding path, the refusal codes, the status shape and the
content access log every route follows.
