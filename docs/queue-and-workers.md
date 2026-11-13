# The indexing queue and its workers

The contract of the write path above the commit-layer library: what a job is,
how a `/v1` call writes one, how a worker claims and runs it, what each way it
can fail means for a caller, and every setting that tunes it. Each section
names the source file that does what it says and closes with the tests that
fail if it stops, so a stale sentence here can be told from a current one
without running anything. Where this page and a file disagree, the file is
right.

## 1. Who this is for, and what it is not

Three readers, in the order they arrive:

- **the engineer adding a job kind or a fourth call**, who needs the row, the
  claim and the states in one place rather than spread across a migration, a
  route module and a worker;
- **the engineer reading a repository's status off these rows**, who needs
  what each state and each failure reason means;
- **whoever is on call when a repository keeps resolving to an older commit
  than the one just pushed, or the queue stops draining**, who needs to know
  which step a killed job could have stopped between and what the next attempt
  does with the layer it left.

What this page does not hold, and where it is instead:

- **The tables' keys, foreign keys, policies and grants, and the rules a
  `SECURITY DEFINER` function follows** are in
  [`docs/schema-contract.md`](schema-contract.md) §6 and §7.
- **The request bodies, every answer beyond the job id, and the HTTP refusal
  codes** are in [`docs/api-contract.md`](api-contract.md); its §5 fixes the
  code set.
- **The calls a worker makes on the layers** — open, publish, resolve,
  compact, discard, release — with their arguments and refusals are in
  [`docs/commit-layers.md`](commit-layers.md).
- **What storing one file does** — its outcome, its facts, the per-file cap —
  is in [`docs/indexing-library.md`](indexing-library.md).

What lives here and nowhere else is the job's own vocabulary: its states, its
failure reasons, its supersede rule, and the order one worker performs a job
in.

- Tests: `tests/integration/queue-recipe.test.ts` walks the whole page once,
  from a call to a resolved commit, through a real API and real workers.

## 2. The job row — [`db/migrations/0010_index_queue.sql`](../db/migrations/0010_index_queue.sql)

`codegraph.index_jobs` holds one row per unit of queued work. The queue is
this table in the service's own database: there is no external broker.

| column                | what a reader may take from it                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | the job id a `/v1` call answers with.                                                                                                                      |
| `tenant_id`           | the tenant the job belongs to; every read and write of the row outside the claim is bound to it.                                                           |
| `repository_id`       | the repository; with `tenant_id` it references the repository pair and is deleted with it.                                                                 |
| `client_id`           | the client that enqueued. The worker runs the job's library calls bound as this client, so a grant revoked since the call fails the job `binding_refused`. |
| `kind`                | a request kind — `first_index`, `push`, `refresh` — or a maintenance kind — `compact`, `discard_stale`, `release` (§9).                                    |
| `commit_sha`          | the commit a request kind indexes, or the commit `compact` compacts; empty for `discard_stale` and `release`.                                              |
| `ref_name`            | the ref a request kind publishes the commit on; empty for every maintenance kind.                                                                          |
| `is_default_branch`   | whether that ref is the repository's default branch, as the call said.                                                                                     |
| `candidate_ancestors` | on a push, the previous head the call named, and nothing more.                                                                                             |
| `changed_paths`       | on a push, the paths the call said changed. The worker never trusts it: it hashes the whole fetched tree (§6).                                             |
| `fetch_url`           | present exactly while a request kind is `queued` or `running`, and cleared by every end (§11).                                                             |
| `state`               | one of the five values below.                                                                                                                              |
| `attempts`            | how many times a lease expired under this job. A job that fails cleanly consumes none.                                                                     |
| `lease_expires_at`    | when the running claim's lease ends. A running job fanned out to its batches holds none: its batches do.                                                   |
| `claimed_by`          | the token the claim minted for the run holding the lease.                                                                                                  |
| `failure_reason_code` | on `failed` only: one snake_case reason (§7).                                                                                                              |
| `failure_message`     | on `failed` only: a sentence for a person. It never holds the fetch URL.                                                                                   |
| `enqueued_at`         | when the call wrote the row. A re-queued job keeps it, so a job's age is its real age.                                                                     |
| `started_at`          | when the current run claimed it; set while `running`, kept by an end, cleared by a re-queue.                                                               |
| `ended_at`            | when it ended; set on every terminal state, never before `started_at`.                                                                                     |

| state        | what it means for the repository                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queued`     | waiting for a worker. No start and no end. The repository still resolves where it did before the call.                                                                                                                                                                         |
| `running`    | a worker holds it under a lease (or its batches do). Nothing is readable yet: a commit becomes readable only at the publish that ends the run.                                                                                                                                 |
| `succeeded`  | terminal. The commit was published: the job's ref resolves to it, the fetch URL is cleared, `attempts` shows how many runs died under it before this one finished.                                                                                                             |
| `failed`     | terminal. Nothing was published: the ref still resolves to the commit it resolved to before, the fetch URL is cleared, `failure_reason_code` says why (§7) and `attempts` shows how many leases expired first (equal to `MAX_ATTEMPTS` when the code is `attempts_exhausted`). |
| `superseded` | terminal. A queued push replaced by a newer push of the same ref before any worker took it. It never ran — no start time — its fetch URL is cleared, it holds no reason, and the ref will resolve to the newer push's commit once that one succeeds.                           |

At most one job of a repository is `running` at a time: a unique index on
`(tenant_id, repository_id) WHERE state = 'running'` makes that a schema fact,
and the claim's advisory lock keeps two claims from racing for it.

- Tests: `tests/db/indexQueueSchema.test.ts`, `tests/db/indexJobs.test.ts`.

## 3. The batch row — [`db/migrations/0010_index_queue.sql`](../db/migrations/0010_index_queue.sql)

`codegraph.index_job_batches` holds one row per slice of ONE job's missing
blobs: `paths` and `git_blob_hashes`, position for position, numbered by
`ordinal` from 1. A batch has no existence apart from its job, so deleting the
job deletes its batches.

- `state` is `queued` → `running` → `stored` or `failed`.
- `lease_expires_at` and `claimed_by` are the batch's own lease and token,
  separate from the job's: while its batches run, the job holds none.
- `stored_count` is how many of the slice's blobs its run stored.
- `attempts` counts the leases that expired under the batch;
  `failure_reason_code` and `failure_message` are set on `failed` only.

A batch is claimed through the same function a job is (§5): the claim prefers
a queued batch of a running job before it takes a new job.

- Tests: `tests/db/indexQueueSchema.test.ts`, `tests/db/claimIndexJob.test.ts`.

## 4. What a request writes — [`src/server/routes/indexing.ts`](../src/server/routes/indexing.ts)

| route                                                               | job kind      |
| ------------------------------------------------------------------- | ------------- |
| `POST /v1/tenants/:tenantId/repositories/:repositoryId/first-index` | `first_index` |
| `POST /v1/tenants/:tenantId/repositories/:repositoryId/push`        | `push`        |
| `POST /v1/tenants/:tenantId/repositories/:repositoryId/refresh`     | `refresh`     |

Each writes exactly ONE `queued` job, bound to the caller's tenant, and answers
`202` with `{ "jobId": "…" }`. Nothing is fetched, hashed or indexed in the
request: the transaction commits before the answer leaves, and a worker does
the rest.

**The supersede rule.** A push first ends every still-`queued` push of the
same repository and the same ref `superseded` — clearing each one's fetch URL
and setting its end time — and then inserts the new row, in the same
transaction, so the new row is never among those it supersedes. A push that a
worker has already claimed is never superseded: it runs to its end, and the
newer push waits behind it. A first-index or a refresh supersedes nothing.

The request bodies and the HTTP refusals are
[`docs/api-contract.md`](api-contract.md)'s.

- Tests: `tests/server/indexing.test.ts`.

## 5. Claiming — [`db/migrations/0010_index_queue.sql`](../db/migrations/0010_index_queue.sql), [`src/db/workerJobs.ts`](../src/db/workerJobs.ts)

A worker asks for work by calling `codegraph.codegraph_claim_index_job(lease_ms,
max_attempts)` on a connection with nothing bound, in its own short
transaction. One call does three things, in order:

1. **Ends stale rows.** A running batch whose lease expired goes back to
   `queued` with one more attempt. A running job whose lease expired goes back
   to `queued` with one more attempt and its start, lease and token cleared —
   or, when that attempt reaches `max_attempts`, ends `failed`
   `attempts_exhausted`; a job whose client lost its grant ends `failed`
   `binding_refused`.
2. **Claims at most one queued batch** of a running job, oldest first. Batch
   claims take no repository lock: parallel slices of one job are the point
   of a batch.
3. **Failing that, claims at most one queued job**, oldest first, of a
   repository with no running job, under a try-only advisory lock on that
   repository.

Rows are taken `FOR UPDATE SKIP LOCKED`, so two claims never wait on each
other. The answer is a closed list of ids and the token the claim minted: no
fetch URL, commit, path or failure text crosses the tenant boundary.

This function is the queue's ONLY cross-tenant read of job rows, and
`codegraph.codegraph_index_queue_metrics()` (§10) its only aggregate one. Every
other read and write of a job — the enqueue, the run, every end — runs in a
transaction bound to the job's own tenant and client under row-level security.
The rules both functions follow are [`docs/schema-contract.md`](schema-contract.md) §6's.

- Tests: `tests/db/claimIndexJob.test.ts`, `tests/db/queueMetrics.test.ts`,
  `tests/db/operatorFunctions.test.ts`.

## 6. The worker's turn — [`src/worker/runJob.ts`](../src/worker/runJob.ts)

The loop ([`src/worker/loop.ts`](../src/worker/loop.ts)) claims, runs one job,
and claims again, waiting `WORKER_POLL_MS` when there is nothing to do. One
request job is run in this order:

1. **Fetch** the source tarball from the row's fetch URL into the job's own
   scratch directory — [`src/fetch/fetchTree.ts`](../src/fetch/fetchTree.ts),
   [`src/fetch/download.ts`](../src/fetch/download.ts),
   [`src/fetch/extract.ts`](../src/fetch/extract.ts).
2. **Hash** every file of the extracted tree to its git blob id —
   [`src/fetch/hashTree.ts`](../src/fetch/hashTree.ts). The whole tree, never
   the push's `changed_paths`: a partial map would be a commit that deleted
   every path it left out.
3. **Run the pre-layer checks** — [`src/worker/preLayerCheck.ts`](../src/worker/preLayerCheck.ts).
4. **Open the layer** with the whole map —
   [`src/layers/openLayer.ts`](../src/layers/openLayer.ts).
5. **Store the blobs the tenant lacks**, one `storeBlob` transaction each —
   [`src/indexing/storeBlob.ts`](../src/indexing/storeBlob.ts), called from
   `runJob.ts`; or, when more are missing than one pass stores, fan out (§8).
6. **Publish** the layer on the job's ref —
   [`src/layers/publish.ts`](../src/layers/publish.ts) — and end the job
   `succeeded`.
7. **Delete the fetched source**: every exit path removes the job's scratch
   directory, `succeeded`, `failed` or a lost lease alike — `runJob.ts`.

**The pre-layer hook.** `PRE_LAYER_CHECKS` is the list of `PreLayerCheck`
functions every job runs after the hash and before any layer is opened, so a
refusal writes nothing. A check is given the job's tenant, repository, commit,
ref and default-branch flag, and the fetched tree: its path → blob id map, its
path → size map, its file count and its total bytes. It answers pass
(`{ ok: true }`) or ONE refusal, `{ ok: false, reasonCode, message }`, which
ends the job `failed` with that code and message. No check is registered in
this story; the per-repository size refusals plug in here.

- Tests: `tests/worker/runJob.test.ts`, `tests/worker/loop.test.ts`,
  `tests/fetch/fetchTree.test.ts`, `tests/fetch/hashTree.test.ts`.

## 7. Failing — [`src/worker/runJob.ts`](../src/worker/runJob.ts), [`src/fetch/errors.ts`](../src/fetch/errors.ts)

A failed job publishes nothing, so in every row below **the ref still resolves
to the commit it resolved to before the call** — or to nothing, for a first
index.

| `failure_reason_code` | recorded by        | what a caller may conclude                                                                                                  |
| --------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `not_https`           | the fetcher        | the fetch URL (or a redirect it followed) is not https. Send an https URL.                                                  |
| `address_refused`     | the fetcher        | the URL's host resolves to a private, loopback, link-local or metadata address. Not retryable with the same URL.            |
| `source_too_large`    | the fetcher        | the archive is past `FETCH_BYTE_CAP_BYTES` compressed, or extracts past `TAR_BYTE_CAP_BYTES`.                               |
| `fetch_timeout`       | the fetcher        | the whole fetch — redirects, download, extraction, hash — did not finish in `FETCH_TIMEOUT_MS`. A retry may succeed.        |
| `fetch_failed`        | the fetcher        | the source answered an error, closed early, or sent something that is not a gzip tarball. A fresh URL may succeed.          |
| `binding_refused`     | the worker / claim | the client that enqueued no longer holds a live grant on the tenant. Re-grant it, or call again as a granted client.        |
| `layer_unpublishable` | the worker         | the layer could not be published (a blob it names is not stored, or the layer was discarded under it). A retry may succeed. |
| `source_mismatch`     | a batch            | a batch re-fetched the source and a file hashed differently from the job's own fetch: the URL served two different trees.   |
| `attempts_exhausted`  | the claim          | the job (or one of its batches) lost its lease `MAX_ATTEMPTS` times: workers died under it, or it outlives `JOB_LEASE_MS`.  |
| `internal_error`      | the worker         | anything else. The message is for the operator, not the caller.                                                             |

A pre-layer check, when one is registered, adds its own code. A failed batch
ends its job `failed` with the batch's own code and ends the job's other
unfinished batches `failed` with `job_failed`, a batch-only code.

**When a worker dies mid-job.** Its lease stops being renewed. The next claim
after `lease_expires_at` returns the job to `queued` with `attempts` raised by
one and its start, lease and token cleared; the next worker runs it from the
start. Once the attempt that expires reaches `MAX_ATTEMPTS`, the claim ends it
`failed` `attempts_exhausted` instead. The layer the dead run staged is never
published: the next run's open removes a staged layer of the same commit
before it opens its own, and a staged layer nobody reopens is removed by the
stale-layer discard (§9) once it is older than `STAGED_LAYER_STALENESS_MS`.

- Tests: `tests/worker/runJob.test.ts`, `tests/db/claimIndexJob.test.ts`,
  `tests/fetch/addressScreen.test.ts`, `tests/fetch/extract.test.ts`,
  `tests/integration/queue-recipe.test.ts` (the killed worker).

## 8. Batch fan-out — [`src/worker/fanOut.ts`](../src/worker/fanOut.ts)

A job splits when, after its layer is opened, more blobs are missing than
`BLOB_STORE_BATCH_SIZE`. In one transaction the run writes one batch row per
slice of at most `BLOB_STORE_BATCH_SIZE` missing blobs and releases the job's
lease; the job stays `running`, with its fetch URL, owned by its batches.

Each batch is claimed on its own (§5), by any worker. A batch gets the
commit's bytes by fetching the job's source again from the job's fetch URL
into its own scratch directory, and stores only its slice, checking each file
against the hash its slice names (`source_mismatch` when one differs).

The commit is published **exactly once, after every batch is stored**: the
batch that stores the last unstored slice locks the job, finds no unstored
batch left, takes the job's lease, and publishes; every other batch ends
`stored` and publishes nothing.

- Tests: `tests/worker/fanOut.test.ts`, `tests/integration/fanOut.test.ts`.

## 9. Maintenance — [`src/worker/maintenance.ts`](../src/worker/maintenance.ts)

Three repository-scoped kinds run as jobs of the same queue, claimed like any
other, each calling its library bound as the client the row carries:

| kind            | library call                                                               | enqueued when                                                                                                                        |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `compact`       | `compactLayer` ([`src/layers/compact.ts`](../src/layers/compact.ts))       | a request job's successful end leaves the commit's current layer deeper than `COMPACTION_THRESHOLD`.                                 |
| `discard_stale` | `discardStaleLayers` ([`src/layers/discard.ts`](../src/layers/discard.ts)) | the worker's maintenance tick for the repository of the job it just ran finds a staged layer older than `STAGED_LAYER_STALENESS_MS`. |
| `release`       | `releaseTenant` ([`src/layers/release.ts`](../src/layers/release.ts))      | the same tick finds a releasable (superseded) layer in the repository.                                                               |

A tick looks at a repository at most once per `MAINTENANCE_INTERVAL_MS` and
enqueues at most `MAINTENANCE_JOBS_PER_TICK` jobs; an enqueue is skipped when a
job of the same kind is already pending for the repository (and, for
`compact`, the same commit).

**Re-extraction is not one of the queue's kinds.** It runs on the owner login
as a per-language sweep across every tenant (`pnpm reextract`), which no
tenant-bound job row could carry, so nothing enqueues one.

- Tests: `tests/worker/maintenance.test.ts`.

## 10. Metrics — [`src/worker/metrics.ts`](../src/worker/metrics.ts)

Every `METRICS_INTERVAL_MS`, each worker reads the queue's four numbers through
`codegraph.codegraph_index_queue_metrics()` and writes them to stdout as one
CloudWatch embedded-metric-format line, in the namespace
`Codegraph/IndexQueue`:

| metric                      | unit    | what it counts                                                          |
| --------------------------- | ------- | ----------------------------------------------------------------------- |
| `QueuedJobs`                | Count   | jobs in `queued`.                                                       |
| `QueuedBatches`             | Count   | batches in `queued` or `running`: the work the fleet still owes.        |
| `OldestQueuedJobAgeSeconds` | Seconds | whole seconds since the oldest queued job's `enqueued_at`, 0 when none. |
| `FailedJobsRecent`          | Count   | jobs that ended `failed` within the last `FAILED_JOBS_WINDOW_MS`.       |

The metrics carry no dimension: every task publishes the same gauge of the
same queue, so the scaling policy and the alarms read the **average**, not one
series per task. A tick whose read fails publishes nothing and logs one
warning. The scaling policy and the alarm thresholds that read these metrics
are the infrastructure's, not this repository's.

- Tests: `tests/worker/metrics.test.ts`, `tests/db/queueMetrics.test.ts`.

## 11. The fetch URL — [`src/worker/runJob.ts`](../src/worker/runJob.ts), [`src/fetch/addressScreen.ts`](../src/fetch/addressScreen.ts)

A fetch URL is a secret, often a pre-signed link. It is never logged, never
written into a failure message and never in an error body: the fetcher's
refusals are fixed sentences that never quote it, and the worker redacts the
URL and its query string from every message it records or logs
(`redactFetchUrl`). It lives only on the
job row, and only while the job is `queued` or `running`; every end —
`succeeded`, `failed`, `superseded` — clears it, and a check constraint makes
a row that ended holding one impossible.

The route checks its SHAPE only: an absolute `http` or `https` URL. The
ADDRESS is screened by the fetcher, which refuses a private, loopback,
link-local or instance-metadata address — on every redirect hop — unless the
host is named in `FETCH_ALLOWED_HOSTS`, which never exempts link-local or
metadata ranges. So such a URL is answered `202` and ends as a `failed` job
with `address_refused`, not a refused request.

- Tests: `tests/fetch/addressScreen.test.ts`, `tests/worker/runJob.test.ts`,
  `tests/integration/queue-recipe.test.ts` (step 7).

## 12. Settings — [`src/config.ts`](../src/config.ts)

Every variable the worker and the queue read. Each is service configuration,
read once by the process: none is per tenant and none is overridable per
repository. A value that is not a whole number of 1 or more is refused at
start, naming the variable.

| variable                    | default                | what it decides                                                                                       |
| --------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_APP_URL`          | none — required        | the `codegraph_app` connection the worker runs as ([`src/worker/main.ts`](../src/worker/main.ts)).    |
| `SCRATCH_DIR`               | none — required        | the existing, writable directory each job's source is fetched under; the only path the worker writes. |
| `WORKER_POLL_MS`            | 1,000                  | how long an idle worker waits before claiming again.                                                  |
| `JOB_LEASE_MS`              | 300,000 (five minutes) | a claim's lease, from each renewal.                                                                   |
| `MAX_ATTEMPTS`              | 3                      | the expired lease at which a job or batch ends `attempts_exhausted`.                                  |
| `BLOB_STORE_BATCH_SIZE`     | 500                    | the most missing blobs one run stores itself, and one batch's slice (§8).                             |
| `FETCH_BYTE_CAP_BYTES`      | 268,435,456 (256 MiB)  | the largest compressed source archive, declared or streamed.                                          |
| `TAR_BYTE_CAP_BYTES`        | 1,073,741,824 (1 GiB)  | the most bytes an archive's regular files may extract to.                                             |
| `FETCH_TIMEOUT_MS`          | 120,000                | the deadline of a whole fetch: every redirect, the download, the extraction and the hash.             |
| `FETCH_ALLOWED_HOSTS`       | empty                  | bare host names whose loopback or private addresses a fetch may reach; never link-local or metadata.  |
| `PER_FILE_CAP_BYTES`        | 1,048,576 (1 MiB)      | the largest file the store indexes ([`docs/indexing-library.md`](indexing-library.md)).               |
| `COMPACTION_THRESHOLD`      | 8                      | the layer depth past which a commit is due a `compact` job.                                           |
| `HARD_CEILING`              | 32                     | the depth at which a commit is written as a base ([`docs/commit-layers.md`](commit-layers.md) §10).   |
| `STAGED_LAYER_STALENESS_MS` | 7,200,000 (two hours)  | the age past which a staged layer is due a `discard_stale` job.                                       |
| `MAINTENANCE_INTERVAL_MS`   | 60,000                 | the least time between two maintenance ticks of one repository.                                       |
| `MAINTENANCE_JOBS_PER_TICK` | 3                      | the most maintenance jobs one tick enqueues.                                                          |
| `METRICS_INTERVAL_MS`       | 30,000                 | how often a worker publishes the queue's four numbers.                                                |
| `FAILED_JOBS_WINDOW_MS`     | 300,000                | the trailing window `FailedJobsRecent` counts failures over.                                          |

- Tests: `tests/config.test.ts`.
