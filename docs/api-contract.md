# API contract

The rules every route of motir-codegraph follows: the read API, indexing and
SCIP routes later epics add, and the routes already here. It does for routes
what [`docs/schema-contract.md`](schema-contract.md) does for tables, and it
describes the code as it is: each section names the source file that does what
it says and the test that fails if it stops. The story's integration gate
checks the shipped routes against this document.

This is an internal engineering document, not public API documentation.

## 1. Why the contract exists

Tenant isolation is enforced by the database: row-level security admits a row
to `codegraph_app` only for the tenant bound to the transaction, and only while
the bound client holds a live grant to it (schema contract §4). The API's job is
to bind that the same way on every route. A route that skips a rule here does
not fail loudly: it either answers from no tenant (an empty answer that looks
like "nothing there") or refuses a caller who should have been let in. So every
route goes through one path, and the tests below fail on a route that does not.

## 2. Versioning

Every route sits under `/v1`. `GET /health` is the only route outside it.

A breaking change to a route is a new prefix (`/v2`), never a change under
`/v1`. Adding a field to an answer is not breaking; renaming or removing one
is.

- Source: `src/server/app.ts` (`buildApp` records every route), `src/server/v1.ts`
  (the `/v1` plugin and `V1_ROUTE_MODULES`).
- Test: `tests/server/routes.test.ts` enumerates the routes of the app `main.ts`
  builds and fails on any route outside `/v1` but `/health`.

## 3. One authentication and binding path

Every `/v1` route, and every unknown `/v1` path, goes through the hooks of the
`/v1` plugin. No route opens its own connection or authenticates by itself.

1. **The credential.** `Authorization: Bearer <token>`, the scheme in any case.
   A missing or malformed header, an empty token, a token with whitespace or a
   token over 512 characters answers 401 `unauthenticated` with no query run.
2. **One transaction.** The request takes one connection from the pool and
   runs `BEGIN`. No connection within 3 s answers 503 `service_unavailable`.
3. **Authentication.** The token is hashed with SHA-256 and passed to one
   `codegraph.codegraph_authenticate($1)` call, which returns the client, its
   kind (`client` or `operator`) and its live grants. No row answers 401
   `unauthenticated`, the transaction rolls back, and nothing else runs.
4. **The binding.** One statement binds the transaction:
   `set_config('app.client_id', …, true)` and, for a route naming `:tenantId`,
   `set_config('app.tenant_id', …, true)`. Both are transaction-local. A path
   tenant the client holds no grant on is refused before the binding (§5).
5. **The route** runs its queries on the request's connection, inside that
   transaction.
6. **The end.** A success answer (status below 400) commits before it is sent,
   so an answer the caller sees is one the database kept. An error answer rolls
   back. A connection whose COMMIT fails is discarded, never returned to the
   pool, and the request fails.

Nothing is cached between requests: a revoked credential or grant takes effect
on the next request, with no restart.

- Source: `src/server/auth.ts` (`parseBearer`, `hashToken`, `authenticate`,
  `finishRequestDb`), `src/server/binding.ts` (`bind`, `BIND_TENANT_SQL`,
  `BIND_CLIENT_SQL`, `commitOrRollback`, `releaseRequestDb`), `src/server/v1.ts`
  (the hooks).
- Tests: `tests/server/auth.test.ts` (401 before any other query, 503),
  `tests/server/transaction.test.ts` (commit on success, rollback on error, no
  module-level cache in `src/server`), `tests/server/requestDb.test.ts` (a failed
  COMMIT discards the connection), `tests/server/revoke.test.ts` (revoke and
  re-grant take effect on the next call), `tests/server/isolation.test.ts`.

## 4. Path parameters

A route naming a tenant names it `:tenantId`; a route naming a repository names
it `:repositoryId`, under `/tenants/:tenantId/`. The binding hook reads them by
those names: a route that calls its tenant anything else is not bound to it,
and row-level security then admits nothing.

Tenant and repository ids are uuids, accepted in any case and answered in lower
case.

Operator routes carry tenant and client ids in the request body or under
`:clientId` / `:credentialId`, never under `:tenantId`, because an operator
holds no grant on a tenant it has just created (§6).

- Source: `src/server/binding.ts` (`TENANT_PARAM`, `REPOSITORY_PARAM`,
  `resolveRepository`).
- Test: `tests/server/isolation.test.ts`.

## 5. Refusals and the error body

Every refusal and failure answers one body:

```json
{ "error": { "code": "<code>", "message": "<a sentence for a person>" } }
```

A caller branches on `code`; the status is derived from it. The codes, as
`ERROR_STATUS` in `src/server/errors.ts` maps them:

| `code`                 | HTTP status | when                                                                    |
| ---------------------- | ----------- | ----------------------------------------------------------------------- |
| `invalid_request`      | 400         | a body or parameter fails its schema, or the database refuses the value |
| `unauthenticated`      | 401         | no valid bearer credential                                              |
| `permission_denied`    | 403         | an ungranted tenant, an operator call by a client, a Postgres `42501`   |
| `repository_not_found` | 404         | no such repository under the bound tenant                               |
| `tenant_not_found`     | 404         | no such tenant (operator calls and the delete routes)                   |
| `client_not_found`     | 404         | no such client (operator calls)                                         |
| `route_not_found`      | 404         | no route answers the method and path                                    |
| `rate_limited`         | 429         | the caller is over its request limit (§11); `Retry-After` says when     |
| `internal_error`       | 500         | anything else; its message and stack never reach the caller             |
| `service_unavailable`  | 503         | the database cannot be reached                                          |

The rules:

- **A caller over its request limit is 429 before anything else**, credential
  or not (§11).
- **The order is 401, then 403, then 404.** An unknown `/v1` path without a
  credential is 401; with one, `route_not_found`.
- **An ungranted tenant is 403 whether or not it exists**, so a client cannot
  probe which tenant ids exist. The one exception is the two delete routes
  (§7).
- **A repository named under a granted tenant it is not in is 404**
  `repository_not_found`: under the binding, it is not there. A malformed
  repository id is 404 with no query.
- **A Postgres `42501`** (an operator function refusing a client) is 403
  `permission_denied`. A check, not-null or type violation is 400
  `invalid_request`; a foreign-key violation naming a tenant or a client is 404
  `tenant_not_found` / `client_not_found`.
- **A refusal is never an empty answer.** A route never answers 200 with an
  empty list or object for something the caller may not see.

- Source: `src/server/errors.ts` (`ERROR_STATUS`, `ApiError`, `handleError`,
  `handleNotFound`), `src/server/binding.ts` (`checkTenantAccess`,
  `requireOperator`, `resolveRepository`).
- Tests: `tests/server/errors.test.ts` (each code, the body, database errors),
  `tests/server/isolation.test.ts`, `tests/server/auth.test.ts`.

## 6. Operator calls and credentials

The calls that set the service up, under `/v1/operator/`. Each refuses a
`client` credential with 403 `permission_denied` before its body is validated
or any query of its own runs, and each SQL function it calls refuses again with
`codegraph_require_operator()`.

| method | path                                            | body                        | success                                                                                                         |
| ------ | ----------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/operator/tenants`                          | `{ displayName }`           | 201 `{ tenantId }`                                                                                              |
| POST   | `/v1/operator/repositories`                     | `{ tenantId, displayName }` | 201 `{ tenantId, repositoryId }`                                                                                |
| POST   | `/v1/operator/clients`                          | `{ name, kind }`            | 201 `{ clientId, name, kind }`                                                                                  |
| GET    | `/v1/operator/clients/:clientId`                | —                           | 200 `{ clientId, name, kind, createdAt, credentials: [{ credentialId, displayPrefix, createdAt, revokedAt }] }` |
| POST   | `/v1/operator/clients/:clientId/credentials`    | —                           | 201 `{ credentialId, clientId, token, displayPrefix }`                                                          |
| POST   | `/v1/operator/credentials/:credentialId/revoke` | —                           | 200 `{ credentialId, revoked }`                                                                                 |
| POST   | `/v1/operator/grants`                           | `{ clientId, tenantId }`    | 200 `{ grantId, clientId, tenantId }`                                                                           |
| POST   | `/v1/operator/grants/revoke`                    | `{ clientId, tenantId }`    | 200 `{ clientId, tenantId, revoked }`                                                                           |

`displayName` and `name` are 1–200 characters and not blank; `kind` is `client`
or `operator`; ids are uuids. A body with an unknown field is 400
`invalid_request`, as is a malformed id or value. A call with no body (the issue and revoke calls) sends no
`Content-Type: application/json`: an empty JSON body is 400 `invalid_request`.

- **A token is shown once.** The server mints it (`cgk_` and 32 random bytes in
  base64url, 47 characters) and returns it only in the 201 answer of the issue
  call, with `Cache-Control: no-store`. It is never logged and never returned
  again: the client read lists credentials without it.
- **The database holds its SHA-256 hash and a 12-character display prefix**,
  never the token.
- **Retries are safe.** Granting a live grant again returns the same
  `grantId`. Revoking a credential or grant that is already revoked, or does
  not exist, answers 200 with `revoked: false`.
- **The first operator** is made with `pnpm operator:bootstrap`, run with the
  owner login (`DATABASE_URL`). It prints the token once, on stdout, and refuses
  once any operator exists. Later operators are created with
  `POST /v1/operator/clients` and `kind: "operator"`.
- The client read goes through `codegraph_get_client(id)` (migration 0003),
  because `codegraph_app` holds nothing on `clients` or `credentials`.

- Source: `src/server/operator.ts`, `src/server/tokens.ts`, `src/db/operator.ts`,
  `src/cli/bootstrap-operator.ts`, `db/migrations/0003_operator_client_read.sql`.
- Tests: `tests/server/operator.test.ts`, `tests/server/credentials.test.ts`
  (the token once, hash and prefix stored, absent from the log),
  `tests/cli/bootstrap-operator.test.ts`, `tests/db/getClient.test.ts`.

## 7. Deletes

| method | path                                               | success |
| ------ | -------------------------------------------------- | ------- |
| DELETE | `/v1/tenants/:tenantId`                            | 204     |
| DELETE | `/v1/tenants/:tenantId/repositories/:repositoryId` | 204     |

- **The cascade removes what each owns.** A repository delete removes its
  access-log rows; a tenant delete removes its repositories, their rows and its
  grants. Clients and credentials are not a tenant's and remain.
- **A client deletes only inside its granted tenants**, as `codegraph_app` under
  row-level security. Outside them it is refused 403 and nothing is deleted.
- **An operator deletes any tenant or repository**, granted or not, through the
  operator-only definer functions `codegraph_delete_tenant_as_operator` and
  `codegraph_delete_repository_as_operator` (migration 0004).
- **A second delete answers 404**, `repository_not_found` or
  `tenant_not_found`, for either kind, so a retry can treat 404 as done. A
  malformed id is 404 of its kind with no query.
- **The one exception to "an ungranted tenant is 403":** on these two routes
  only, a tenant the client holds no grant on that does not exist answers 404
  `tenant_not_found` (checked with `codegraph_tenant_exists`, migration 0004).
  A client that deletes its own tenant loses its grant in the same statement,
  and its retry must still read as done. A tenant that exists is still 403.

- Source: `src/server/routes/deletes.ts` (`DELETE_ROUTE_CONFIG`),
  `src/server/binding.ts` (`checkTenantAccess`, `TenantRouteConfig`),
  `db/migrations/0004_delete_functions.sql`.
- Tests: `tests/server/deletes.test.ts`, `tests/db/deleteFunctions.test.ts`,
  `tests/integration/deletion.test.ts`.

## 8. Content access log

Every route that returns stored file contents writes one
`codegraph.content_access_log` row for the reading client: tenant, repository,
client, time and `content_ref` (what was read). It writes it in the request's
own bound transaction, before it answers, so a read the caller sees is a read
the log holds. `codegraph_app` may only append to that table (schema contract
§9).

No route in this story returns stored contents. The read API epic implements
the rule; a content read with no row is a defect.

- Source: `db/migrations/0001_tenancy.sql` (the table),
  `db/migrations/0002_row_level_security.sql` (its policy).
- Test: the read API epic's routes add theirs; the table's isolation is in
  `tests/integration/isolation.test.ts`.

## 9. Status

`GET /v1/tenants/:tenantId/repositories/:repositoryId/status` answers one
shape, exported as `RepositoryStatus` and pinned by `REPOSITORY_STATUS_KEYS`:

```json
{
  "tenantId": "<uuid>",
  "repositoryId": "<uuid>",
  "state": "not_indexed",
  "indexedCommit": null,
  "inProgressJob": null,
  "lastFailure": null,
  "languages": []
}
```

- `state` is `not_indexed`, the literal motir-ai's read boundary uses. With no
  index, every registered repository reads it, with `indexedCommit`,
  `inProgressJob` and `lastFailure` null and `languages` `[]`.
- When filled: `indexedCommit` is a commit sha; `inProgressJob` is
  `{ jobId, commit, startedAt }`; `lastFailure` is `{ reason, commit, failedAt }`;
  each `languages` entry is `{ language, precision }` with `precision`
  `precise` (SCIP) or `tree_sitter`.
- **Later epics fill fields, add `state` values and add nested fields; they
  never rename or remove a top-level key.**
- Its refusals are the one path's (§5); its only read is the repository row.

- Source: `src/server/status.ts`, `src/server/routes/status.ts`.
- Test: `tests/server/status.test.ts` (the keys, the refusals, two copies).

## 10. Health

`GET /health` needs no credential: the load balancer calls it. It answers
`Cache-Control: no-store` and:

```json
{ "status": "ok", "process": { "up": true, "uptimeSeconds": 42 }, "database": { "up": true } }
```

with 200 when `SELECT 1` answers within 3 s, and `status: "unavailable"`,
`database.up: false` with 503 when it fails or does not answer in time.

- Source: `src/server/health.ts`.
- Test: `tests/server/health.test.ts`.

## 11. Statelessness and cost

A copy of the server holds no state between requests: no module-level cache,
no session. Any number of copies can run behind a load balancer against one
database, and a call answers the same on each.

Authentication and binding cost one `codegraph_authenticate()` call and one
binding statement per request, whatever the number of grants the client holds.
The pre-launch design target for that fixed cost is about 10 ms at p95, inside
the 200 ms read target (node, callers, callees).

Two limits on `/v1` refuse a call 429 `rate_limited`, with `Retry-After`,
before authentication runs, and neither applies to `/health`. Both are
`@fastify/rate-limit` counters in each copy's memory, so behind N copies a
caller's real ceiling is up to N times the setting: they are protective caps,
not state a call's answer depends on.

- **Per caller.** Each caller may make `RATE_LIMIT_PER_MINUTE` requests a
  minute (1200 when unset). A caller is its `Authorization` header (held as a
  SHA-256 hash), or its address when it sends none. This is the plugin's first
  hook, so a flood that reuses one credential takes no connection and runs no
  statement. It does **not** stop a caller who sends a new made-up credential
  on every request: each one is a new caller.
- **Failed authentications, per address.** An address may make
  `FAILED_AUTH_LIMIT_PER_MINUTE` attempts a minute (60 when unset) with a
  credential that has not authenticated on this copy within the last minute.
  Each such request is counted before it authenticates, so concurrent requests
  cannot overshoot the limit, and one over it is refused before the
  `codegraph_authenticate()` call: it takes no connection and runs no
  statement. A credential that authenticates is remembered and passes
  uncounted while it keeps succeeding, so in practice the count is the
  address's failures plus one for each credential's first success. That is
  what keeps a working caller served while another caller at the same address
  floods made-up tokens; a remembered credential that then fails is forgotten.
  A missing or malformed credential counts too. A caller whose credential has
  not authenticated yet is refused with the flood when they share an address.

The client address is the TCP peer unless the peer is a proxy named in
`TRUST_PROXY` (comma-separated addresses and CIDR ranges: the load balancer's
subnets), whose `X-Forwarded-For` is then read. Unset, every caller behind a
load balancer shares its address, so the failed-authentication limit is one
bucket per copy for every caller that has not authenticated. A hop count is
not accepted, since it cannot tell a proxy from a caller that writes its own
`X-Forwarded-For`.

So the database work a flood of made-up credentials can cause is bounded per
copy: at most `FAILED_AUTH_LIMIT_PER_MINUTE` `codegraph_authenticate()` calls
per address per minute, however many requests arrive at once.

- Source: `src/server/auth.ts`, `src/server/binding.ts`, `src/server/v1.ts`
  (both limits), `src/server/authLimit.ts` (the failed-authentication limit),
  `src/server/run.ts` (the settings).
- Tests: `tests/server/rate-limit.test.ts`, `tests/server/authLimit.test.ts`, `tests/server/query-count.test.ts` (the statement count, unchanged
  with 25 more grants), `tests/server/copies.test.ts`,
  `tests/server/transaction.test.ts` (no module-level cache).

## 12. Indexing requests

Three calls ask the service to index a repository at a commit. Each writes ONE
`queued` job and answers `202` with its id, and nothing else:

```json
{ "jobId": "<uuid>" }
```

| call                                                                | body                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/tenants/:tenantId/repositories/:repositoryId/first-index` | `{ commit, ref, isDefaultBranch, fetchUrl }`                             |
| `POST /v1/tenants/:tenantId/repositories/:repositoryId/push`        | `{ commit, ref, isDefaultBranch, previousHead, changedPaths, fetchUrl }` |
| `POST /v1/tenants/:tenantId/repositories/:repositoryId/refresh`     | `{ commit, ref, isDefaultBranch, fetchUrl }`                             |

- **No indexing work happens in the request.** The call writes the job row in
  the request's transaction, which commits before the `202` leaves (§3), and
  returns: no fetch, no hash, no layer, no blob. A worker runs the job later.
  A caller answered `202` holds a job the database kept; a caller answered a
  refusal holds none.
- **Every field is required**, `isDefaultBranch` on all three: the service
  holds nothing about refs, and publishing writes the ref head with this flag.
- **`commit` and `previousHead` are 40 lowercase hex**, the SHA-1 object
  format the service indexes. A 64-character (SHA-256) id is refused.
- **A `ref` is stored exactly as sent**: no `refs/heads/` prefix is required
  and nothing is normalised, so a client uses one spelling of a branch. It is
  non-blank and at most 1024 characters.
- **A push supersedes the still-queued pushes of its ref.** In the same
  transaction, before its own row is written, every `queued` push of the same
  repository and the same ref becomes `superseded` and loses its fetch URL. A
  push of another ref, or of another repository, is left queued.
- **A push's `previousHead`** is the job's one candidate ancestor, and its
  `changedPaths` (at most 10,000 non-empty paths of at most 4096 characters,
  possibly none) are carried onto the row as sent and never trusted: the
  worker hashes the whole tree. A first-index and a refresh carry neither; a
  refresh is accepted whether or not the commit is new.
- **`fetchUrl` is checked for shape only**: an absolute `http` or `https` URL
  of at most 8192 characters, or `400 invalid_request` with a fixed sentence
  that never repeats the value. The address is not resolved or screened here;
  a refused address fails the JOB, with its reason (the fetcher's rule).
- **Refusals** are the one path's codes (§5): `unauthenticated` 401,
  `permission_denied` 403, `repository_not_found` 404 and `invalid_request`
  400 (an unknown or missing field, a value outside its schema, a fetch URL
  that fails its shape check). The repository resolves first, so a call on a
  repository the caller cannot see is 404 whatever its body's fetch URL is.

- Source: `src/server/routes/indexing.ts`, `src/db/indexJobs.ts`
  (`enqueueJob`, `supersedeQueuedPushes`).
- Test: `tests/server/indexing.test.ts`.

## 13. Adding a route

- [ ] Register it in a route module listed in `V1_ROUTE_MODULES`
      (`src/server/v1.ts`), never on the app itself.
- [ ] Name a tenant `:tenantId` and a repository `:repositoryId` under it; get
      the repository with `resolveRepository`.
- [ ] Run its queries on the request's connection (`requestDb`), never a
      connection of its own.
- [ ] Refuse by throwing `ApiError` with a code from §5; add a code to
      `ERROR_STATUS` and to this document together.
- [ ] Give its body and parameters a JSON schema with
      `additionalProperties: false`.
- [ ] If it returns stored contents, write the access log row (§8).
- [ ] If it reports status, fill `RepositoryStatus`; never rename or remove a
      top-level key.
- [ ] Hold no module-level state.
- [ ] Add it to its tests, and to this document; the route-enumeration test
      and the integration gate will run against it.
