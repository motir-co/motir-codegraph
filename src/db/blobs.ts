/**
 * The database-client layer over `codegraph.blob` and `codegraph.blob_contents`
 * (db/migrations/0005_blob_and_contents.sql): the only module in the service
 * that writes either table.
 *
 * Every function but `deleteBlobs` runs its statements on the client it is
 * handed, inside a transaction the caller owns and has bound to its tenant;
 * none of them begins, commits or rolls back, so storing a blob, its contents
 * and its facts stays the caller's single unit. Row-level security decides
 * what a statement sees: a row another tenant holds, or any row under a
 * binding the policy admits nothing for, reads as absent and is never an
 * error. Every value reaches the database as a parameter.
 *
 * ISOLATION. `insertBlobIfAbsent` is correct only at READ COMMITTED, the
 * PostgreSQL default and what `createAppPool` leaves in place: the select that
 * follows a conflicting insert takes a fresh snapshot and so sees the row the
 * concurrent winner committed. At REPEATABLE READ or SERIALIZABLE that select
 * would answer empty. A caller must not raise the isolation level of a
 * transaction it passes here.
 */
import type pg from 'pg';

import { BIND_TENANT_SQL } from '../server/binding.js';

/**
 * A blob's one per-file outcome: the four values `blob_outcome_check` admits,
 * declared once, here, beside the row that stores it.
 */
export type BlobOutcome = 'indexed' | 'unsupported' | 'binary' | 'refused';

/** One stored blob row, as the table declares it. */
export interface BlobRow {
  readonly tenantId: string;
  readonly gitBlobHash: string;
  readonly sizeBytes: number;
  readonly outcome: BlobOutcome;
  readonly parsedWithErrors: boolean | null;
  readonly lossy: boolean | null;
  readonly refusedCapBytes: number | null;
  readonly language: string | null;
  readonly extractorVersion: string | null;
}

/** What a caller supplies to store one blob row. */
export interface NewBlob {
  readonly tenantId: string;
  readonly gitBlobHash: string;
  readonly sizeBytes: number;
  readonly outcome: BlobOutcome;
  readonly parsedWithErrors?: boolean | null;
  readonly lossy?: boolean | null;
  readonly refusedCapBytes?: number | null;
  readonly language?: string | null;
  readonly extractorVersion?: string | null;
}

/** Whether this call created the row, and the row as it is stored. */
export interface InsertedBlob {
  readonly created: boolean;
  readonly blob: BlobRow;
}

/** The four columns a re-classification moves. */
export interface BlobClassification {
  readonly outcome: BlobOutcome;
  readonly language: string | null;
  readonly lossy: boolean | null;
  readonly refusedCapBytes: number | null;
}

/** One blob's text, to store beside its row. */
export interface BlobContents {
  readonly tenantId: string;
  readonly gitBlobHash: string;
  readonly contents: string;
}

/** What `deleteBlobs` binds in each transaction it opens. */
export interface TenantBinding {
  readonly clientId: string;
  readonly tenantId: string;
}

/** The hashes `deleteBlobs` actually removed, one list per committed batch. */
export interface DeleteBlobsResult {
  readonly batches: readonly (readonly string[])[];
}

/** Where `deleteBlobs` takes its connections from: a `pg.Pool`. */
export interface ConnectionSource {
  connect(): Promise<pg.PoolClient>;
}

export interface DeleteBlobsOptions {
  /** Hashes per transaction; `DELETE_BATCH_SIZE` when omitted. */
  readonly batchSize?: number;
}

/**
 * Hashes per delete transaction. One deleted blob cascades into a contents row
 * holding a whole file, and every statement is bounded by the pool's ten-second
 * statement timeout; 500 keeps a batch well inside it while a release of tens
 * of thousands of blobs still drains in tens of batches.
 */
export const DELETE_BATCH_SIZE = 500;

/** `setBlobClassification` named a blob the bound tenant does not hold. */
export class UnknownBlobError extends Error {
  readonly tenantId: string;
  readonly gitBlobHash: string;

  constructor(tenantId: string, gitBlobHash: string) {
    super(`Tenant ${tenantId} holds no blob ${gitBlobHash} to re-classify.`);
    this.name = 'UnknownBlobError';
    this.tenantId = tenantId;
    this.gitBlobHash = gitBlobHash;
  }
}

/** The table's columns, aliased to `BlobRow`'s names: the one place they are listed. */
const BLOB_COLUMNS = `tenant_id AS "tenantId",
  git_blob_hash AS "gitBlobHash",
  size_bytes AS "sizeBytes",
  outcome,
  parsed_with_errors AS "parsedWithErrors",
  lossy,
  refused_cap_bytes AS "refusedCapBytes",
  language,
  extractor_version AS "extractorVersion"`;

const INSERT_BLOB_SQL = `INSERT INTO codegraph.blob
  (tenant_id, git_blob_hash, size_bytes, outcome, parsed_with_errors, lossy,
   refused_cap_bytes, language, extractor_version)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (tenant_id, git_blob_hash) DO NOTHING
  RETURNING ${BLOB_COLUMNS}`;

const SELECT_BLOB_SQL = `SELECT ${BLOB_COLUMNS} FROM codegraph.blob
  WHERE tenant_id = $1 AND git_blob_hash = $2`;

const CLASSIFY_BLOB_SQL = `UPDATE codegraph.blob
  SET outcome = $3, language = $4, lossy = $5, refused_cap_bytes = $6
  WHERE tenant_id = $1 AND git_blob_hash = $2
  RETURNING ${BLOB_COLUMNS}`;

const INSERT_CONTENTS_SQL = `INSERT INTO codegraph.blob_contents (tenant_id, git_blob_hash, contents)
  VALUES ($1, $2, $3)`;

const INSERT_CONTENTS_IF_ABSENT_SQL = `${INSERT_CONTENTS_SQL}
  ON CONFLICT (tenant_id, git_blob_hash) DO NOTHING`;

const SELECT_CONTENTS_SQL = `SELECT contents FROM codegraph.blob_contents
  WHERE tenant_id = $1 AND git_blob_hash = $2`;

const DELETE_BLOBS_SQL = `DELETE FROM codegraph.blob
  WHERE tenant_id = $1 AND git_blob_hash = ANY($2::text[])
  RETURNING git_blob_hash AS "gitBlobHash"`;

/**
 * Stores one blob row unless the tenant already holds one for the hash, and
 * answers which happened together with the row on record. Opens no
 * transaction.
 *
 * Idempotency is the conflict clause's: a second writer of the same pair waits
 * for the first one's transaction and then inserts nothing, and the select that
 * follows the empty answer returns the row that transaction left — committed
 * by a concurrent winner, or already there (see ISOLATION above).
 */
export async function insertBlobIfAbsent(db: pg.ClientBase, blob: NewBlob): Promise<InsertedBlob> {
  const inserted = await db.query<BlobRow>(INSERT_BLOB_SQL, [
    blob.tenantId,
    blob.gitBlobHash,
    blob.sizeBytes,
    blob.outcome,
    blob.parsedWithErrors ?? null,
    blob.lossy ?? null,
    blob.refusedCapBytes ?? null,
    blob.language ?? null,
    blob.extractorVersion ?? null,
  ]);
  const created = inserted.rows[0];
  if (created !== undefined) return { created: true, blob: created };
  const existing = await getBlob(db, blob.tenantId, blob.gitBlobHash);
  if (existing === null) {
    // The conflict named a row this session cannot read back: only possible
    // above READ COMMITTED, or if the row was deleted between the statements.
    throw new Error(
      `Blob ${blob.gitBlobHash} conflicted on insert but could not be read back for tenant ${blob.tenantId}.`,
    );
  }
  return { created: false, blob: existing };
}

/** The bound tenant's row for the hash, or null. Opens no transaction. */
export async function getBlob(
  db: pg.ClientBase,
  tenantId: string,
  gitBlobHash: string,
): Promise<BlobRow | null> {
  const { rows } = await db.query<BlobRow>(SELECT_BLOB_SQL, [tenantId, gitBlobHash]);
  return rows[0] ?? null;
}

/**
 * Moves the four classification columns of an existing row of the bound
 * tenant — `outcome`, `language`, `lossy`, `refused_cap_bytes` — and answers
 * the row as it now stands. Creates nothing and moves no other column; the
 * extractor version and parse flag belong to a fact replacement. Raises
 * `UnknownBlobError` when the bound tenant holds no such row. Opens no
 * transaction.
 */
export async function setBlobClassification(
  db: pg.ClientBase,
  tenantId: string,
  gitBlobHash: string,
  classification: BlobClassification,
): Promise<BlobRow> {
  const { rows } = await db.query<BlobRow>(CLASSIFY_BLOB_SQL, [
    tenantId,
    gitBlobHash,
    classification.outcome,
    classification.language,
    classification.lossy,
    classification.refusedCapBytes,
  ]);
  const row = rows[0];
  if (row === undefined) throw new UnknownBlobError(tenantId, gitBlobHash);
  return row;
}

/**
 * Stores one blob's text. No conflict clause and no update path: the hash
 * addresses the bytes, so a second contents row for one blob is a broken
 * invariant and fails with a unique violation (23505). Opens no transaction.
 */
export async function insertContents(db: pg.ClientBase, contents: BlobContents): Promise<void> {
  await db.query(INSERT_CONTENTS_SQL, [contents.tenantId, contents.gitBlobHash, contents.contents]);
}

/**
 * Stores one blob's text unless it is already stored, and answers whether it
 * wrote. Only for a re-classification that may be racing a second worker over
 * the same blob; a first store uses `insertContents`. Opens no transaction.
 */
export async function insertContentsIfAbsent(
  db: pg.ClientBase,
  contents: BlobContents,
): Promise<boolean> {
  const { rowCount } = await db.query(INSERT_CONTENTS_IF_ABSENT_SQL, [
    contents.tenantId,
    contents.gitBlobHash,
    contents.contents,
  ]);
  return rowCount === 1;
}

/** The bound tenant's stored text for the hash, or null. Opens no transaction. */
export async function readContents(
  db: pg.ClientBase,
  tenantId: string,
  gitBlobHash: string,
): Promise<string | null> {
  const { rows } = await db.query<{ contents: string }>(SELECT_CONTENTS_SQL, [
    tenantId,
    gitBlobHash,
  ]);
  return rows[0]?.contents ?? null;
}

/**
 * Deletes the named hashes of the bound tenant in one statement and answers the
 * hashes it removed. Their contents and fact rows go with them through the
 * cascading keys. An absent hash, or one only another tenant holds, removes
 * nothing and is not an error. Opens no transaction.
 */
export async function deleteBlobBatch(
  db: pg.ClientBase,
  tenantId: string,
  hashes: readonly string[],
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const { rows } = await db.query<{ gitBlobHash: string }>(DELETE_BLOBS_SQL, [tenantId, hashes]);
  return rows.map((row) => row.gitBlobHash);
}

/**
 * Releases a set of a tenant's blobs in batches that each commit. THE ONE
 * FUNCTION HERE THAT OPENS TRANSACTIONS: it de-duplicates the hashes, cuts them
 * into `batchSize` chunks, and for each chunk takes a connection from `pool`,
 * begins, binds the client and tenant with `BIND_TENANT_SQL`, deletes through
 * `deleteBlobBatch` and commits. The binding is transaction-local, so every
 * batch binds again; inheriting it would leave the next batch unbound and
 * deleting nothing.
 *
 * A batch that fails is rolled back and the error is raised; the batches
 * before it stay committed, so calling again with the same set resumes.
 */
export async function deleteBlobs(
  pool: ConnectionSource,
  binding: TenantBinding,
  hashes: readonly string[],
  options: DeleteBlobsOptions = {},
): Promise<DeleteBlobsResult> {
  const batchSize = options.batchSize ?? DELETE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  const unique = [...new Set(hashes)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += batchSize) {
    const chunk = unique.slice(start, start + batchSize);
    batches.push(await deleteInOwnTransaction(pool, binding, chunk));
  }
  return { batches };
}

async function deleteInOwnTransaction(
  pool: ConnectionSource,
  binding: TenantBinding,
  hashes: readonly string[],
): Promise<string[]> {
  const client = await pool.connect();
  let removed: string[];
  try {
    await client.query('BEGIN');
    await client.query(BIND_TENANT_SQL, [binding.clientId, binding.tenantId]);
    removed = await deleteBlobBatch(client, binding.tenantId, hashes);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      // A connection that cannot roll back is discarded, not returned to the pool.
      client.release(rollbackError instanceof Error ? rollbackError : true);
    }
    throw error;
  }
  client.release();
  return removed;
}
