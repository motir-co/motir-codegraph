/**
 * The fan-out of a job too large to store in one pass: the seam between the
 * run that opened a commit's layer and the batch claimants that store its
 * blobs.
 *
 * - `fanOutJob` keeps a job whose missing blobs fit one pass in its own run,
 *   writing nothing; otherwise it partitions them into batch rows and releases
 *   the job's lease, in ONE transaction. The job stays running, with its fetch
 *   URL, owned by its batches.
 * - `runBatch` runs one claimed batch: it re-fetches the job's source, stores
 *   only its slice through `storeBlob` (one transaction per blob), and marks
 *   the batch stored through `markBatchStoredAndLockJob`, which makes exactly
 *   one claimant of a job the finaliser.
 * - `finaliseJob` publishes the commit's staged layer once and ends the job.
 *   A publish refusal is settled by reading the commit's current layer: one
 *   there means the work is readable (a concurrent publish or a compaction),
 *   none means the job failed and the repository still resolves where it did.
 *
 * What a crash leaves: a batch that loses its lease stops without marking
 * itself stored, and the claim re-queues it; a finaliser that dies leaves its
 * lease to expire, the job returns to the queue, and the ordinary run opens
 * the layer again, stores what is still missing and publishes. The fetch URL
 * is a secret here as in the run: no log line or recorded message carries it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ClaimLostError,
  finishBatch,
  insertJobBatches,
  JobNotWritableError,
  markBatchStoredAndLockJob,
  readBatch,
  readJob,
  renewBatchLease,
  type BatchRow,
  type JobRow,
  type NewBatch,
} from '../db/indexJobs.js';
import { listStagedLayersOfCommit, readCurrentPublishedLayer } from '../db/layers.js';
import { GrantLostError, inClaimTransaction, releaseLease, type Claim } from '../db/workerJobs.js';
import { storeBlob } from '../indexing/storeBlob.js';
import type { OpenedLayer } from '../layers/openLayer.js';
import {
  LayerNotPublishableError,
  publishLayer,
  PublishUnboundError,
  UnstoredBlobsError,
} from '../layers/publish.js';
import {
  checkpoint,
  discardScratch,
  endJobSucceeded,
  failureOf,
  fetchJobTree,
  idsOf,
  JobFailure,
  LeaseLostError,
  readClaimedJob,
  redactFetchUrl,
  requestJob,
  scopeOf,
  settle,
  type ClaimedJob,
  type FetchedSource,
  type RunJobDeps,
  type RunResult,
} from './runJob.js';

/** One blob the tenant lacks, and the one path of the layer it is read from. */
export interface MissingBlob {
  readonly path: string;
  readonly hash: string;
}

/** `fanOutJob`'s verdict: the store stays in this run, or the job is now its batches'. */
export type FanOutVerdict =
  { readonly fannedOut: false } | { readonly fannedOut: true; readonly batches: number };

/** A batch's slice names a blob its re-fetched tree holds at another hash, or not at all. */
export const SOURCE_MISMATCH = 'source_mismatch';

/**
 * Cuts `missing` into slices of at most `size`, in order, numbered from 1:
 * every blob in exactly one slice, each as a whole path-and-hash pair.
 */
export function partitionMissing(missing: readonly MissingBlob[], size: number): NewBatch[] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`A slice holds a positive whole number of blobs, not ${String(size)}.`);
  }
  const slices: NewBatch[] = [];
  for (let i = 0; i < missing.length; i += size) {
    const slice = missing.slice(i, i + size);
    slices.push({
      ordinal: slices.length + 1,
      paths: slice.map((m) => m.path),
      gitBlobHashes: slice.map((m) => m.hash),
    });
  }
  return slices;
}

/**
 * Decides whether the job's missing blobs fit one pass. No more than
 * `BLOB_STORE_BATCH_SIZE` answers `fannedOut: false` and writes nothing: the
 * run stores them itself and pays no second fetch. More are written as one
 * batch row per slice, in the transaction that also releases the job's lease,
 * so the job is never both leased and fanned out. Raises `LeaseLostError`,
 * writing nothing, when the claim no longer holds the job.
 */
export async function fanOutJob(
  deps: RunJobDeps,
  claim: Claim,
  opened: Pick<OpenedLayer, 'layerId'>,
  missing: readonly MissingBlob[],
): Promise<FanOutVerdict> {
  const size = deps.settings.blobStoreBatchSize;
  if (missing.length <= size) return { fannedOut: false };
  const slices = partitionMissing(missing, size);
  const scope = scopeOf(claim);
  const released = await inClaimTransaction(deps.pool, claim, async (db) => {
    if (!(await releaseLease(db, scope, claim.jobId, claim.claimedBy))) return false;
    await insertJobBatches(db, scope, claim.jobId, slices);
    return true;
  });
  if (!released) throw new LeaseLostError(claim.jobId);
  deps.log.info(
    { ...idsOf(claim), layerId: opened.layerId, missing: missing.length, batches: slices.length },
    'job store fanned out into batches',
  );
  return { fannedOut: true, batches: slices.length };
}

/** A batch's scratch directory: one per batch, under `SCRATCH_DIR`. */
export function batchScratchDirFor(
  settings: Pick<RunJobDeps['settings'], 'scratchDir'>,
  batchId: string,
): string {
  return join(settings.scratchDir, `batch-${batchId}`);
}

function batchIdOf(claim: Claim): string {
  if (claim.batchId === null) {
    throw new TypeError(`Claim of job ${claim.jobId} is not a batch claim.`);
  }
  return claim.batchId;
}

function batchIds(claim: Claim, job?: JobRow | null): Record<string, unknown> {
  return { ...idsOf(claim, job), batchId: claim.batchId };
}

/**
 * The claimed batch and its job, read under the claim's binding. Raises
 * `GrantLostError` when the binding reads unbound, and `LeaseLostError` when
 * the batch is not running under this claim's token.
 */
async function readClaimedBatch(
  deps: RunJobDeps,
  claim: Claim,
): Promise<{ batch: BatchRow; job: ClaimedJob }> {
  const batchId = batchIdOf(claim);
  const scope = scopeOf(claim);
  const read = await inClaimTransaction(deps.pool, claim, async (db) => ({
    batch: await readBatch(db, scope, batchId),
    job: await readJob(db, scope, claim.jobId),
  }));
  if (
    read.batch?.state !== 'running' ||
    read.batch.claimedBy !== claim.claimedBy ||
    read.job?.state !== 'running'
  ) {
    throw new LeaseLostError(claim.jobId);
  }
  return { batch: read.batch, job: requestJob(read.job) };
}

/** Moves the batch's lease on, or raises `LeaseLostError`. */
async function renewBatch(deps: RunJobDeps, claim: Claim): Promise<void> {
  try {
    await inClaimTransaction(deps.pool, claim, (db) =>
      renewBatchLease(
        db,
        scopeOf(claim),
        batchIdOf(claim),
        claim.claimedBy,
        deps.settings.jobLeaseMs,
      ),
    );
  } catch (error) {
    if (error instanceof ClaimLostError) throw new LeaseLostError(claim.jobId);
    throw error;
  }
}

/**
 * Stores the batch's slice and no other blob, one `storeBlob` transaction per
 * blob, renewing the batch's lease whenever a third of it has passed. A slice
 * entry the re-fetched tree does not hold at the same hash ends the batch
 * `source_mismatch`. Answers how many blobs it created.
 */
async function storeSlice(
  deps: RunJobDeps,
  claim: Claim,
  batch: BatchRow,
  tree: FetchedSource,
): Promise<number> {
  const renewEvery = deps.settings.jobLeaseMs / 3;
  let renewedAt = Date.now();
  let created = 0;
  const client = await deps.pool.connect();
  try {
    for (const [i, path] of batch.paths.entries()) {
      const hash = batch.gitBlobHashes[i] as string;
      if (tree.paths.get(path) !== hash) {
        throw new JobFailure(
          SOURCE_MISMATCH,
          `The fetched tree does not hold ${path} at ${hash}; the commit's source changed.`,
        );
      }
      if (Date.now() - renewedAt >= renewEvery) {
        await renewBatch(deps, claim);
        renewedAt = Date.now();
      }
      const bytes = await readFile(join(tree.root, ...path.split('/')));
      const stored = await storeBlob(
        client,
        { tenantId: claim.tenantId, clientId: claim.clientId, gitBlobHash: hash, path, bytes },
        deps.storeOptions,
      );
      if (!stored.alreadyStored) created += 1;
    }
  } finally {
    client.release();
  }
  return created;
}

/**
 * Runs one claimed batch to its recorded outcome: reads the job's fetch URL
 * and ref under the job's binding, re-fetches the commit's source into the
 * batch's own scratch, stores its slice, and marks it stored. The claimant the
 * mark names the finaliser then publishes through `finaliseJob`. Never throws
 * for the batch's own failure: a refusal or an error ends the batch `failed`
 * with its reason, which ends the job `failed` with the same code; a lost
 * lease or grant writes nothing. The scratch directory is deleted on every
 * exit.
 */
export async function runBatch(deps: RunJobDeps, claim: Claim): Promise<RunResult> {
  const batchId = batchIdOf(claim);
  const dir = batchScratchDirFor(deps.settings, batchId);
  let job: ClaimedJob | null = null;
  try {
    try {
      const read = await readClaimedBatch(deps, claim);
      job = read.job;
      deps.log.info({ ...batchIds(claim, job), blobs: read.batch.paths.length }, 'batch started');
      const tree = await fetchJobTree(deps, job, dir);
      await renewBatch(deps, claim);
      const storedBlobs = await storeSlice(deps, claim, read.batch, tree);
      const marked = await inClaimTransaction(deps.pool, claim, (db) =>
        markBatchStoredAndLockJob(
          db,
          scopeOf(claim),
          batchId,
          claim.claimedBy,
          read.batch.paths.length,
          deps.settings.jobLeaseMs,
        ),
      );
      deps.log.info(
        { ...batchIds(claim, job), storedBlobs, unstoredBatches: marked.unstoredBatches },
        'batch stored',
      );
      if (marked.finaliserToken === null) {
        return { outcome: 'batch_stored', storedBlobs, finalised: null };
      }
      const finalised = await finaliseJob(deps, {
        ...claim,
        kind: 'job',
        batchId: null,
        claimedBy: marked.finaliserToken,
      });
      return { outcome: 'batch_stored', storedBlobs, finalised };
    } catch (error) {
      return await settleBatch(deps, claim, job, error);
    }
  } finally {
    await discardScratch(dir);
  }
}

/** The reason code a thrown error ends a batch with. */
export function batchFailureOf(error: unknown): { reasonCode: string; message: string } {
  if (error instanceof JobNotWritableError) {
    return { reasonCode: 'binding_refused', message: error.message };
  }
  return failureOf(error);
}

async function settleBatch(
  deps: RunJobDeps,
  claim: Claim,
  job: ClaimedJob | null,
  error: unknown,
): Promise<RunResult> {
  if (error instanceof GrantLostError) {
    deps.log.warn(batchIds(claim, job), 'batch abandoned: its client holds no live grant');
    return { outcome: 'grant_lost' };
  }
  if (error instanceof LeaseLostError || error instanceof ClaimLostError) {
    deps.log.warn(batchIds(claim, job), 'batch abandoned: its lease was lost to another claim');
    return { outcome: 'lease_lost' };
  }
  const failure = batchFailureOf(error);
  const message = redactFetchUrl(failure.message, job?.fetchUrl ?? null);
  try {
    await inClaimTransaction(deps.pool, claim, (db) =>
      finishBatch(db, scopeOf(claim), batchIdOf(claim), claim.claimedBy, {
        state: 'failed',
        reasonCode: failure.reasonCode,
        message,
      }),
    );
  } catch (endError) {
    if (endError instanceof GrantLostError || endError instanceof ClaimLostError) {
      return await settleBatch(deps, claim, job, endError);
    }
    throw endError;
  }
  deps.log.error(
    { ...batchIds(claim, job), reasonCode: failure.reasonCode, message },
    'batch failed; its job failed with it',
  );
  return { outcome: 'failed', reasonCode: failure.reasonCode };
}

/** The refusals `publishLayer` answers with nothing written. */
function isPublishRefusal(error: unknown): boolean {
  return (
    error instanceof UnstoredBlobsError ||
    error instanceof LayerNotPublishableError ||
    error instanceof PublishUnboundError
  );
}

/** The layer to publish: the commit's newest staged layer, else its current one (a resend). */
async function layerToPublish(
  deps: RunJobDeps,
  claim: Claim,
  commitSha: string,
): Promise<string | null> {
  const scope = scopeOf(claim);
  return await inClaimTransaction(deps.pool, claim, async (db) => {
    const staged = await listStagedLayersOfCommit(db, scope, commitSha);
    const newest = staged.at(-1);
    if (newest !== undefined) return newest.id;
    return (await readCurrentPublishedLayer(db, scope, commitSha))?.id ?? null;
  });
}

/**
 * Publishes a fanned-out job's commit once and ends the job, under the
 * finaliser's claim (the lease `markBatchStoredAndLockJob` took). The layer is
 * read now, not carried: opening a commit again replaces its staged layer.
 * `publishLayer` itself proves every blob stored, and publishing a commit's
 * current layer writes only the ref head, so a resend is harmless. After a
 * refusal one bound read of the commit's current layer decides: present ends
 * the job `succeeded`; absent ends it `failed` with the refusal's reason, and
 * for unstored blobs their count. Never throws for the job's own failure.
 */
export async function finaliseJob(deps: RunJobDeps, claim: Claim): Promise<RunResult> {
  let job: JobRow | null = null;
  try {
    job = await readClaimedJob(deps, claim);
    const request = requestJob(job);
    const layerId = await layerToPublish(deps, claim, request.commitSha);
    if (layerId === null) {
      throw new JobFailure(
        'layer_unpublishable',
        `Commit ${request.commitSha} has no staged or current layer to publish.`,
      );
    }
    await checkpoint(deps, claim);
    try {
      await publishLayer(deps.pool, {
        tenantId: claim.tenantId,
        clientId: claim.clientId,
        repositoryId: claim.repositoryId,
        layerId,
        ref: { name: request.refName, isDefaultBranch: request.isDefaultBranch },
      });
    } catch (error) {
      if (!isPublishRefusal(error)) throw error;
      const current = await inClaimTransaction(deps.pool, claim, (db) =>
        readCurrentPublishedLayer(db, scopeOf(claim), request.commitSha),
      );
      if (current === null) {
        throw error instanceof UnstoredBlobsError
          ? new JobFailure('layer_unpublishable', error.message)
          : error;
      }
      deps.log.warn(
        { ...idsOf(claim, job), layerId: current.id, refusal: (error as Error).name },
        'publish refused, but the commit has a current layer: the job succeeded',
      );
    }
    if (!(await endJobSucceeded(deps, claim, job))) {
      throw new LeaseLostError(claim.jobId);
    }
    deps.log.info(idsOf(claim, job), 'job succeeded');
    return { outcome: 'succeeded', storedBlobs: 0 };
  } catch (error) {
    return await settle(deps, claim, job, error);
  }
}
