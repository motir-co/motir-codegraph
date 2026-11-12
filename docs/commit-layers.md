# Commit layers

The caller's contract for the commit-layer library: the calls an indexing
worker makes once it has fetched and hashed a commit's files, the order it must
make them in, and what it is left holding when one of them stops. Each section
names the source file that does what it says and the test that fails if it
stops, so a stale sentence here can be told from a current one without running
anything.

## 1. Who this is for, and what it is not

Three readers, in the order they arrive:

- **the engineer writing an indexing worker**, who needs the order of the calls
  and what each one does when it stops before writing a job;
- **the engineer writing a read over the layers**, who needs to know that
  resolving a commit is one call, and what that call answers for a commit
  nobody ever indexed;
- **whoever is on call when a repository keeps resolving to an older commit
  than the one just pushed**, who needs to know which steps a killed job could
  have stopped between.

What this page does not cover, and where it is instead:

- **The tables** behind these calls — their columns, keys, policies and
  indexes, and why a layer's path carries no foreign key to a blob — are in
  [`docs/schema-contract.md`](schema-contract.md) and in the comments of
  [`db/migrations/0007_commit_layers.sql`](../db/migrations/0007_commit_layers.sql).
  Nothing here restates them.
- **The routes** are in [`docs/api-contract.md`](api-contract.md). This library
  adds none.
- **The queue** that runs these calls, the calls that enqueue its jobs, the
  workers and their scaling, and per-repository status are documented where
  they are built. This page says of them only what a caller of the library
  must do.

The blob library these calls are used beside — storing a blob, and deleting
blobs — is documented in [`docs/indexing-library.md`](indexing-library.md).
This page names its calls where the order needs them and documents neither.

## 2. The three steps, in order

**The rule: open the layer, store the missing blobs through the blob library,
publish.** Publish is the only step after which anything reads the layer. A
caller that skips a step or swaps two of them has written nothing readable:
publishing before the blobs are stored is refused, and a layer that is opened
and never published is never read and is discarded later (§8).

### Step 1 — `openLayer(pool, input, options?)` — [`src/layers/openLayer.ts`](../src/layers/openLayer.ts)

| Parameter                  | What it is                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pool`                     | A `pg.Pool` of the `codegraph_app` login. The call takes one connection and opens its own transaction. |
| `input.clientId`           | The client the transaction is bound as. It must hold a live grant on the tenant.                       |
| `input.tenantId`           | The tenant.                                                                                            |
| `input.repositoryId`       | The repository.                                                                                        |
| `input.commitSha`          | The commit being indexed.                                                                              |
| `input.refName`            | The ref the commit was indexed for. It is carried to the answer and steers nothing.                    |
| `input.isDefaultBranch`    | Whether that ref is the default branch. Carried to the answer.                                         |
| `input.candidateAncestors` | Ancestor commits from git, nearest first (§4).                                                         |
| `input.paths`              | The commit's **whole** tree, path → git blob hash. Blobs only: leave a submodule (gitlink) entry out.  |
| `input.settings`           | The settings read with `readLayerSettings()` (§10); `hardCeiling` is used.                             |
| `options.batchSize`        | Path rows per write statement; `STAGE_BATCH_SIZE` (1,000) when omitted.                                |

It answers an `OpenedLayer`:

| Field             | What it holds                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `layerId`         | The layer to publish in step 3.                                                                                    |
| `kind`            | `'base'` or `'delta'`.                                                                                             |
| `parentLayerId`   | The layer it sits on; `null` for a base.                                                                           |
| `depth`           | Layers above its base; `0` for a base.                                                                             |
| `chain`           | The layer's own id, then its parent's chain: nearest first.                                                        |
| `state`           | `'staged'` when written now; `'published'` when the commit already had a current layer.                            |
| `ancestorCommit`  | The commit of the parent layer; `null` for a base.                                                                 |
| `refName`         | The input's, unchanged.                                                                                            |
| `isDefaultBranch` | The input's, unchanged.                                                                                            |
| `entries`         | The layer's own `PathEntry` rows (`{ path, gitBlobHash }`), in byte-wise path order. A `null` hash is a tombstone. |

What it does, in one transaction: it binds the client and tenant, takes the
tenant's layer lock **shared** (§9), and then:

- if the commit already has a current published layer, answers it with
  `state: 'published'` and writes nothing;
- otherwise removes any staged layer the commit already has, and writes one
  fresh staged layer with its path rows — a base or a delta (§4, §5).

Those path rows are the **pins**: they exist, and a release respects them, before
the caller stores a single blob. It reads no blob and writes no ref head.

It refuses with `LayerInputRefused` (`path`, `value`), before connecting, a path
that is empty, absolute or carries a `..` segment, and a hash that is not 40 or
64 lowercase hex characters.

**What a caller must not do at this step:** pass only the paths it believes
changed. `input.paths` is the whole tree; a partial map is read as a commit that
deleted every path it left out (§5).

### Step 2 — store the missing blobs

Every non-tombstone entry the layer names must have a blob row for the tenant
before step 3. The caller stores them through the blob library's
`storeBlob`, as [`docs/indexing-library.md`](indexing-library.md) §1 states.
For a delta, `entries` is exactly the set the layer added, so a caller that
stores only those has stored enough: every other path of the map was already
proved stored when its own layer was published. A blob counts as stored
whatever its outcome — `refused`, `binary` and `unsupported` blobs keep no
contents, and publish does not ask for any.

### Step 3 — `publishLayer(pool, input, options?)` — [`src/layers/publish.ts`](../src/layers/publish.ts)

| Parameter            | What it is                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `pool`               | A `pg.Pool` of the `codegraph_app` login. The call opens its own transaction.                          |
| `input.tenantId`     | The tenant.                                                                                            |
| `input.clientId`     | The client the transaction is bound as.                                                                |
| `input.repositoryId` | The repository.                                                                                        |
| `input.layerId`      | The layer step 1 answered. The commit is read from the layer, never passed.                            |
| `input.ref`          | `{ name, isDefaultBranch }` to move that ref to this layer, or `null` to move no ref.                  |
| `options.batchSize`  | Distinct hashes per existence check and path rows per page; `EXISTENCE_BATCH_SIZE` (500) when omitted. |

In one transaction it proves that every non-tombstone path's blob is stored,
retires the commit's current published layer if it has another one (a
supersession time, never a delete — other commits' chains still name it),
flips this layer to published and writes the ref head. Neither half lands
without the other. It answers a `PublishedLayer`: `layerId`, `commitSha`,
`publishedAt`, `refHead` (the `RefHeadRow` written, or `null` when no ref was
given) and `retired` (`{ layerId, supersededAt }` of the layer it retired, or
`null`).

Publishing the commit's current layer again is a retry: it writes only the ref
head and retires nothing.

It refuses, with nothing written:

| Refusal                    | When                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnstoredBlobsError`       | A blob is missing. `path` and `gitBlobHash` name the lowest missing path; `missingCount` counts them.                                                                                                             |
| `LayerNotPublishableError` | `reason` is `'not_found'` (no such layer — it was replaced or discarded), `'superseded'` (a retired layer; making it current would undo a compaction) or `'not_staged'` (another call published it concurrently). |
| `PublishUnboundError`      | The client could not be bound to the tenant.                                                                                                                                                                      |

It takes no tenant lock: the staged path rows are the pins a release respects,
so the set this transaction proves stored is a set no release deletes.

**What a caller must not do at this step:** treat `UnstoredBlobsError` as final.
It means step 2 is not finished; store the named blobs and publish again.

- Tests: `tests/layers/openLayer.test.ts`, `tests/layers/publish.test.ts`,
  `tests/integration/commitLayers.test.ts` (`write → resolve`, `publish`).

## 3. A job that stops between two steps

A job killed, refused or crashed anywhere between step 1 and the end of step 3
leaves the repository exactly where it was:

- **What the repository resolves to.** The previous published commit, throughout.
  Only publish moves a ref head or makes a layer current, and it does both in
  one transaction ([`src/layers/publish.ts`](../src/layers/publish.ts)). A
  repository resolving to an older commit than the one just pushed is a job
  that has not reached the end of step 3.
- **What becomes of the staged layer and its pins.** It stays, with its path
  rows, and those rows go on pinning the blobs they name, until the staleness
  window passes. Then `discardStaleLayers` removes it with its path rows (§8,
  [`src/layers/discard.ts`](../src/layers/discard.ts)).
- **What becomes of the blobs it pinned.** They are released only after that,
  and only if no other layer of the tenant names them, by `releaseTenant` (§9,
  [`src/layers/release.ts`](../src/layers/release.ts)).

What a caller must therefore not assume about a layer an earlier run opened:

- **That it can be resumed.** Opening the same commit again removes the earlier
  run's staged layer and writes a fresh one, so the earlier `layerId` now
  answers `LayerNotPublishableError` (`'not_found'`). A retry starts at step 1
  and publishes the `layerId` that call answers.
- **That it still exists.** Past the staleness window it may have been
  discarded, with the same refusal at publish.
- **That its blobs are still stored.** Once the layer is discarded and a release
  has run, a blob only it named may be gone. Step 2 of the retry stores what
  the new layer names; it never relies on an earlier run's stores.

- Tests: `tests/layers/publish.test.ts` (`publishLayer — refusals`),
  `tests/layers/openLayer.test.ts` (`openLayer — re-opening a commit`),
  `tests/integration/commitLayers.test.ts` (`publish`, `discard → release`).

## 4. Where the nearest ancestor comes from — [`src/layers/openLayer.ts`](../src/layers/openLayer.ts)

The caller supplies `candidateAncestors`: commits from git's history of this
commit, **nearest first**. The library holds no git history, so it cannot
derive that list itself; a caller that passes an empty list always gets a
base.

The first candidate that has a **current published layer** wins; candidates
with only a staged layer, or none, are passed over. Then:

- **no candidate has one** — the commit is written as a base holding its whole
  map;
- **the winner's chain is already at the hard ceiling** (its depth plus one
  reaches `hardCeiling`) — the commit is written as a base, so no chain is ever
  longer than the ceiling;
- **otherwise** — the commit is written as a delta over the winner's layer, one
  deeper than it.

- Tests: `tests/layers/openLayer.test.ts` (`openLayer — a base`,
  `openLayer — a delta`).

## 5. The diff is computed for you — [`src/layers/openLayer.ts`](../src/layers/openLayer.ts)

A delta holds exactly the paths of `input.paths` that are new or whose blob
differs from the ancestor's **resolved** map, plus one tombstone (a `null`
hash) for each path the ancestor's map holds and `input.paths` does not. The
writer computes this itself from the whole tree it was given (the exported
`diffAgainst` is that computation), so a caller's own changed-path list is
neither trusted nor needed — there is no argument to pass one.

What that means for a caller whose own list is wrong: nothing, as long as
`input.paths` is the whole tree. What it means for a caller that passes a
partial tree: every path left out is tombstoned, and the commit resolves to the
partial map.

- Tests: `tests/layers/openLayer.test.ts` (`openLayer — a delta`).

## 6. Reading a commit — `resolveCommit(db, tenantId, repositoryId, commitSha)` — [`src/layers/resolution.ts`](../src/layers/resolution.ts)

Resolving a commit is **one call** that answers its **whole** path-to-blob map,
in one statement whose count does not grow with the chain. No caller walks the
chain or issues a query per layer.

**Precondition:** `db` is the caller's own connection, already inside the
caller's own transaction, bound to `tenantId` with `BIND_TENANT_SQL`
([`src/server/binding.ts`](../src/server/binding.ts)). The call opens no
transaction, takes no lock, keeps no cache and writes nothing.

It answers a `Resolution`, one of two **answers**:

| Answer                                                         | Means                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `{ state: 'indexed', layerId, paths }`                         | The commit has a current published layer. `paths` is a `Map` of path → git blob hash, ascending by path; tombstoned paths are absent. |
| `{ state: 'indexed', layerId, paths }` with `paths.size === 0` | The commit is indexed and its tree is empty.                                                                                          |
| `{ state: 'not_indexed' }`                                     | The commit has no current published layer: it was never indexed, or its job has not published yet.                                    |

Or it throws one of two **refusals**, both `ResolutionRefusedError`, told apart
by `reason`:

| `reason`             | When                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `'tenant_not_bound'` | The session is not bound to the tenant asked for. Row-level security would have answered an empty map. |
| `'chain_incomplete'` | The current layer's chain names a layer that no longer exists. The map would be silently short.        |

A refusal is an answer that is **missing**, not empty. A caller that catches it
and carries on with an empty map has lost a whole file list without a trace;
let it propagate, or report it as a failure.

- Tests: `tests/layers/resolution.test.ts`, `tests/integration/isolation.test.ts`
  (commit layers), `tests/integration/commitLayers.test.ts` (`write → resolve`).

## 7. Compaction — `compactLayer(pool, request)` — [`src/layers/compact.ts`](../src/layers/compact.ts)

**When a layer is due:** its commit's current published layer is deeper than
`compactionThreshold` (§10) — strictly. `isCompactionDue(depth, threshold)` is
that rule, written once.

**Running it is the caller's job.** No call of this library compacts on its
own. A worker calls `compactLayer` for a commit after publishing it; the call
answers `not_due` cheaply when there is nothing to do.

| Field                  | What it is                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `request.tenantId`     | The tenant.                                                                   |
| `request.clientId`     | The client each transaction is bound as.                                      |
| `request.repositoryId` | The repository.                                                               |
| `request.commitSha`    | The commit to compact.                                                        |
| `request.settings`     | The settings read with `readLayerSettings()`; `compactionThreshold` is used.  |
| `request.batchSize`    | Path rows per copy transaction; `COMPACTION_BATCH_SIZE` (1,000) when omitted. |

**What it does:** it copies the commit's whole resolved map into a new staged
base in bounded batches, one short transaction each under the shared tenant
lock, then switches in one transaction: it retires the current layer by its
supersession time, publishes the base, and moves every ref head that named the
retired layer to the base.

**What a reader sees while it runs:** the commit resolves through its old layer
until the switch commits, and through the base after. The map is the same
either way.

**What becomes of the layer it replaces:** it keeps its paths and is retired by
a supersession time, not deleted, because other commits' chains may still
name it. It is released only once no live chain names it (§9).

It answers a `CompactionResult`, by `outcome`:

| `outcome`             | Fields                                                           | Means                                                                                                         |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `'compacted'`         | `baseLayerId`, `replacedLayerId`, `supersededAt`, `pathsWritten` | Switched.                                                                                                     |
| `'not_due'`           | `depth`, `threshold`                                             | Nothing written.                                                                                              |
| `'not_indexed'`       | —                                                                | The commit has no current published layer in the bound view. Nothing written.                                 |
| `'no_longer_current'` | `baseLayerId`, `copiedLayerId`, `currentLayerId`                 | Another layer became current during the copy. Nothing switched; the staged base is left for the discard (§8). |

It stores, deletes and releases no blob.

- Tests: `tests/layers/compact.test.ts`, `tests/integration/commitLayers.test.ts`
  (`compaction`).

## 8. Discarding a staged layer — `discardStaleLayers(pool, request)` — [`src/layers/discard.ts`](../src/layers/discard.ts)

Removes the tenant's layers still **staged** since before
`now − stagedLayerStaleness` (§10), with their path rows, so the blobs only they
pinned stop counting as referenced.

| Field                  | What it is                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `request.clientId`     | The client each batch is bound as.                                            |
| `request.tenantId`     | The tenant.                                                                   |
| `request.settings`     | The settings read with `readLayerSettings()`; `stagedLayerStaleness` is used. |
| `request.repositoryId` | Narrows the sweep to one repository; omitted, every repository of the tenant. |
| `request.batchSize`    | Layers per batch transaction; `DISCARD_BATCH_SIZE` (500) when omitted.        |
| `request.now`          | The clock; now when omitted.                                                  |

It answers a `DiscardResult`: `cutoff`, `layerIds` (oldest staged first) and
`pathCount`. It refuses a session not bound to the tenant with
`TenantNotBoundError` before reading anything.

**The window** must be longer than the longest an index job may run, so a live
job's staged layer is never discarded under it. If it is, that job's publish
answers `LayerNotPublishableError` (`'not_found'`) and the job starts again at
step 1.

**A published layer is never touched**, nor a staged layer a ref head names.
The guard is re-checked in the delete itself, so a layer that published between
the read and the delete survives. Each batch takes the tenant lock **shared**.

**What discarding releases:** the pins, not the blobs. It deletes no blob and
moves no ref head; the blobs it unpinned go at the next release (§9).

- Tests: `tests/layers/discard.test.ts`, `tests/integration/commitLayers.test.ts`
  (`discard → release`).

## 9. Release — `releaseTenant(pool, request)` — [`src/layers/release.ts`](../src/layers/release.ts)

Frees what nothing still reads, in two passes, in this order, each to
exhaustion:

1. **A layer** goes once it is not staged, and no live chain names it (a live
   layer is one that is staged, or published and not retired; its own chain
   counts), and no ref head names it. Its path rows go with it. A retired layer
   is therefore released only once no live chain names it.
2. **A blob** goes once no staged or published layer path of the tenant
   references it. Release deletes it through the blob library's batch delete
   inside its own transaction; the blob's contents and facts go with it.

Removing layers is what makes their blobs unreferenced, so one call clears what
its first pass freed.

| Field                  | What it is                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `request.clientId`     | The client each batch is bound as.                                                 |
| `request.tenantId`     | The tenant.                                                                        |
| `request.repositoryId` | Narrows the **layer** pass to one repository; the blob pass is always tenant-wide. |
| `request.batchSize`    | Layers or blobs per batch transaction; `RELEASE_BATCH_SIZE` (500) when omitted.    |

It answers a `ReleaseReport`: `layerIds`, `blobHashes`, `layerBatches` and
`blobBatches`. It refuses a session not bound to the tenant with
`ReleaseTenantUnboundError` before reading a candidate. It never touches a
staged layer.

**The per-tenant lock rule.** Every call that writes pins takes the tenant's
layer lock **shared** — opening a layer, each compaction copy and switch, and
the discard — so any number of jobs stage at once. Release takes it
**exclusively**, per batch, and reads its candidates under it. A release batch
therefore waits for every staging transaction in flight and sees the pins they
committed, so **a blob an in-flight job has pinned is never released**. That is
also why a caller must not delete blobs it believes unreferenced through the
blob library's `deleteBlobs` itself: that call takes no layer lock and checks no
pin.

- Tests: `tests/layers/release.test.ts` (including the staging writer under the
  shared lock), `tests/db/release.test.ts`,
  `tests/integration/commitLayers.test.ts` (`discard → release`,
  `repository delete → release`).

## 10. The three knobs — [`src/config.ts`](../src/config.ts)

| Variable                    | `LayerSettings` field  | Default                                                    | What it decides                                                       |
| --------------------------- | ---------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `COMPACTION_THRESHOLD`      | `compactionThreshold`  | `DEFAULT_COMPACTION_THRESHOLD`, 8                          | A published layer deeper than this is due for compaction (§7).        |
| `HARD_CEILING`              | `hardCeiling`          | `DEFAULT_HARD_CEILING`, 32                                 | A commit whose ancestor's chain reaches it is written as a base (§4). |
| `STAGED_LAYER_STALENESS_MS` | `stagedLayerStaleness` | `DEFAULT_STAGED_LAYER_STALENESS_MS`, 7,200,000 (two hours) | A staged layer older than this is discarded (§8).                     |

They are **service configuration**: one value for the whole service, with no
per-tenant or per-repository override. `readLayerSettings()` is the one way to
obtain them; it refuses a value that is not a whole number of 1 or more, and a
threshold that is not below the ceiling minus one (compaction could never fire).
The host process reads them once and hands the `LayerSettings` to each call. A
caller never keeps its own copy of a value or of a default.

- Test: `tests/config.test.ts` (`readLayerSettings`).

## 11. One push, end to end

For one pushed commit, a worker holding a `pg.Pool` of the `codegraph_app`
login, the tenant, client and repository ids, and `settings` from
`readLayerSettings()`:

1. **Open.** `openLayer(pool, { clientId, tenantId, repositoryId, commitSha,
refName, isDefaultBranch, candidateAncestors, paths, settings })`, with the
   whole tree in `paths` and git's ancestors nearest first. On
   `LayerInputRefused`, fix the input; nothing was written.
   - If the answer's `state` is `'published'`, the commit is already indexed:
     skip step 2 and go to step 3, which only moves the ref.
2. **Store.** For each entry of the answer's `entries` with a non-null
   `gitBlobHash`, store the blob through `storeBlob`
   ([`docs/indexing-library.md`](indexing-library.md)). On a failure, retry the
   store; the layer's pins hold its blobs meanwhile.
3. **Publish.** `publishLayer(pool, { tenantId, clientId, repositoryId,
layerId, ref: { name: refName, isDefaultBranch } })`.
   - `UnstoredBlobsError` — back to step 2 for the named blobs.
   - `LayerNotPublishableError` with `'not_found'` — the layer was replaced or
     discarded: back to step 1.
   - Any other failure — the repository still resolves to its previous commit;
     the job fails, and its staged layer is discarded after the window.
4. **Compact.** `compactLayer(pool, { tenantId, clientId, repositoryId,
commitSha, settings })`. `not_due` is the usual answer. `no_longer_current`
   needs nothing: its base is discarded later.

Housekeeping, on the host's own schedule rather than per push, for each tenant:
`discardStaleLayers(pool, { clientId, tenantId, settings })`, then
`releaseTenant(pool, { clientId, tenantId })`.

A read of the commit afterwards is
`resolveCommit(db, tenantId, repositoryId, commitSha)` on the reader's own
bound transaction (§6).
