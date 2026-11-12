/**
 * Re-extraction: the indexing library's second entry point, beside
 * `storeBlob`. It rebuilds one language's stale blobs from their stored
 * contents — no fetch, no path — after that language's extractor version moved
 * (a grammar pin bumped, a query revised) or the language gained a grammar.
 *
 * It runs on the owner login, whose policy is unconditional, so one call
 * reaches every tenant's stale blobs; a tenant-bound session would sweep one
 * tenant and report the language drained. It binds nothing. Every statement
 * that touches a row goes through the two repositories; this module owns only
 * transaction control and the run lock.
 */
import type pg from 'pg';

import { requireEnv } from '../config.js';
import { readContents } from '../db/blobs.js';
import { OWNER_LOGIN } from '../db/connection.js';
import {
  findBlobsBelowExtractorVersion,
  replaceFactsForBlob,
  type StaleBlob,
} from '../db/facts.js';
import { extract } from '../extract/extract.js';
import { TREE_SITTER_PRODUCER, type LanguageEntry } from '../extract/types.js';
import { listLanguages } from '../indexer/registry.js';
import { createAppPool } from '../server/pool.js';

/** Stale blobs per page when no `batchSize` is passed. Not a deployment setting. */
export const DEFAULT_REEXTRACT_BATCH_SIZE = 100;

/**
 * The advisory-lock namespace of a re-extraction run (the two-key form's first
 * key, 'cgrx'); the second key is `hashtext(language)`. The two-key space never
 * meets the migration runner's single-key lock.
 */
export const REEXTRACT_LOCK_CLASS = 0x63_67_72_78;

export interface ReextractOptions {
  /** The owner login's URL; `DATABASE_URL` when omitted. */
  readonly connectionString?: string;
  /** Stale blobs per page; `DEFAULT_REEXTRACT_BATCH_SIZE` when omitted. */
  readonly batchSize?: number;
  /** The entries to resolve the language in; the shipped registry when omitted. */
  readonly registry?: readonly LanguageEntry[];
}

/** One re-extracted blob. */
export interface ReextractedBlob {
  readonly tenantId: string;
  readonly gitBlobHash: string;
  /** The tree-sitter facts now recorded for it. */
  readonly factCount: number;
}

/** One page's worth of re-extracted blobs. */
export interface ReextractBatch {
  /** 1-based. */
  readonly ordinal: number;
  readonly blobs: readonly ReextractedBlob[];
}

export interface ReextractReport {
  readonly language: string;
  /** The version re-extracted to; null when the language has no grammar, and nothing was written. */
  readonly extractorVersion: string | null;
  /** Another run held this language's lock, so this one wrote nothing. */
  readonly anotherRunInProgress: boolean;
  readonly batches: readonly ReextractBatch[];
  readonly blobCount: number;
  readonly factCount: number;
}

/** A stale blob the sweep could not re-extract; the blobs before it stay committed. */
export class ReextractError extends Error {
  readonly gitBlobHash: string;
  readonly tenantId: string;
  /** Blobs this call re-extracted and committed before it. */
  readonly reextractedBefore: number;

  constructor(blob: StaleBlob, reextractedBefore: number, reason: string) {
    super(
      `Blob ${blob.gitBlobHash} (tenant ${blob.tenantId}) cannot be re-extracted: ${reason}. ` +
        `${String(reextractedBefore)} blob(s) were re-extracted before it.`,
    );
    this.name = 'ReextractError';
    this.gitBlobHash = blob.gitBlobHash;
    this.tenantId = blob.tenantId;
    this.reextractedBefore = reextractedBefore;
  }
}

function emptyReport(
  language: string,
  extractorVersion: string | null,
  anotherRunInProgress: boolean,
): ReextractReport {
  return {
    language,
    extractorVersion,
    anotherRunInProgress,
    batches: [],
    blobCount: 0,
    factCount: 0,
  };
}

/** Re-extracts one blob in its own transaction: read contents, extract, replace. */
async function reextractBlob(
  pool: pg.Pool,
  entry: LanguageEntry,
  blob: StaleBlob,
  done: number,
): Promise<ReextractedBlob> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const source = await readContents(client, blob.tenantId, blob.gitBlobHash);
      if (source === null) {
        throw new ReextractError(blob, done, 'it has no stored contents');
      }
      const { facts, parsedWithErrors } = extract(entry, source);
      await replaceFactsForBlob(client, blob, TREE_SITTER_PRODUCER, facts, {
        extractorVersion: entry.extractorVersion,
        parsedWithErrors,
        language: entry.language,
        outcome: 'indexed',
      });
      await client.query('COMMIT');
      return { tenantId: blob.tenantId, gitBlobHash: blob.gitBlobHash, factCount: facts.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Re-extracts every stale blob of `language`, across every tenant, from stored
 * contents, to the registry entry's current `extractorVersion`.
 *
 * Takes the language's run lock (`pg_try_advisory_lock`, session-level, on the
 * sweep's own connection — a run that dies leaves no key behind) and reports
 * `anotherRunInProgress` without writing when it is held. Then pages over the
 * stale blobs and re-extracts each in a transaction of its own, so a blob's
 * facts and its recorded version always move together and progress is the
 * version column itself: a call that stops part-way leaves the next one exactly
 * the blobs still stale. A blob with no stored contents raises
 * `ReextractError`. The lock is released in a `finally`.
 *
 * Opens its own pool from the owner connection string and raises before its
 * first page if that login is not the owner.
 */
export async function reextractLanguage(
  language: string,
  options: ReextractOptions = {},
): Promise<ReextractReport> {
  const batchSize = options.batchSize ?? DEFAULT_REEXTRACT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  const entry = (options.registry ?? listLanguages()).find((e) => e.language === language);
  if (entry === undefined) return emptyReport(language, null, false);

  // The service's pool factory: bounded connect and statement timeouts, and a
  // listener for idle-connection errors. The URL is the owner's, checked below.
  const pool = createAppPool(options.connectionString ?? requireEnv('DATABASE_URL'), { max: 2 });
  try {
    const session = await pool.connect();
    try {
      const login = await session.query<{ login: string }>('SELECT current_user AS login');
      const user = login.rows[0]?.login;
      if (user !== OWNER_LOGIN) {
        throw new Error(
          `Re-extraction must run as ${OWNER_LOGIN}, whose policy reaches every tenant, not as ${String(user)}.`,
        );
      }
      const locked = await session.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
        [REEXTRACT_LOCK_CLASS, language],
      );
      if (locked.rows[0]?.locked !== true) {
        return emptyReport(language, entry.extractorVersion, true);
      }
      try {
        return await sweep(pool, session, entry, batchSize);
      } finally {
        await session.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
          REEXTRACT_LOCK_CLASS,
          language,
        ]);
      }
    } finally {
      session.release();
    }
  } finally {
    await pool.end();
  }
}

async function sweep(
  pool: pg.Pool,
  session: pg.PoolClient,
  entry: LanguageEntry,
  batchSize: number,
): Promise<ReextractReport> {
  const batches: ReextractBatch[] = [];
  let blobCount = 0;
  let factCount = 0;
  let after: StaleBlob | null = null;
  for (;;) {
    const page = await findBlobsBelowExtractorVersion(
      session,
      null,
      entry.language,
      entry.extractorVersion,
      batchSize,
      after,
    );
    if (page.blobs.length === 0) break;
    const blobs: ReextractedBlob[] = [];
    for (const blob of page.blobs) {
      const done = await reextractBlob(pool, entry, blob, blobCount);
      blobs.push(done);
      blobCount += 1;
      factCount += done.factCount;
    }
    batches.push({ ordinal: batches.length + 1, blobs });
    if (page.nextAfter === null) break;
    after = page.nextAfter;
  }
  return {
    language: entry.language,
    extractorVersion: entry.extractorVersion,
    anotherRunInProgress: false,
    batches,
    blobCount,
    factCount,
  };
}
