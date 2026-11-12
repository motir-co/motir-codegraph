/**
 * The store library: one fetched file in, one stored outcome out.
 *
 * `storeBlob` decides a file's outcome, stores exactly what that outcome
 * allows, and answers the outcome it stored. All of one blob's rows — the
 * blob, its contents, its facts — are written in one transaction it opens on
 * the connection it is handed, bound to the tenant and the client before its
 * first statement. The path is used to pick a language and for nothing else:
 * no row written here carries a path or a repository.
 */
import type pg from 'pg';

import { perFileCapBytes } from '../config.js';
import {
  getBlob,
  insertBlobIfAbsent,
  insertContents,
  insertContentsIfAbsent,
  setBlobClassification,
  type BlobOutcome,
  type BlobRow,
  type NewBlob,
} from '../db/blobs.js';
import { insertFacts, replaceFactsForBlob } from '../db/facts.js';
import { extract } from '../extract/extract.js';
import { TREE_SITTER_PRODUCER, type Fact } from '../extract/types.js';
import { languageForPath, unavailableLanguageForPath } from '../indexer/registry.js';
import { BIND_TENANT_SQL } from '../server/binding.js';

export type { BlobOutcome } from '../db/blobs.js';

/** One file to store. */
export interface StoreBlobInput {
  readonly tenantId: string;
  /** The client the tenant is bound with: the policy admits a row only under its live grant. */
  readonly clientId: string;
  readonly gitBlobHash: string;
  /** Picks the language; never written to a row. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** What one store answers: the stored row's own fields, and whether it was already there. */
export interface StoredBlob {
  readonly outcome: BlobOutcome;
  readonly alreadyStored: boolean;
  readonly sizeBytes: number;
  readonly parsedWithErrors: boolean | null;
  readonly lossy: boolean | null;
  readonly refusedCapBytes: number | null;
  /** Null for an outcome that yields no facts, except an unsupported file of a language the registry knows. */
  readonly language: string | null;
  readonly extractorVersion: string | null;
}

export interface StoreBlobOptions {
  /** The per-file cap in force; `perFileCapBytes()` when omitted. */
  readonly capBytes?: number;
}

/** Git's binary heuristic looks this far into a file for a NUL. */
export const BINARY_SNIFF_BYTES = 8_000;

/** The bytes presented for a stored blob are not that blob's: their length differs from its recorded size. */
export class BlobBytesMismatchError extends Error {
  readonly gitBlobHash: string;
  readonly recordedSizeBytes: number;
  readonly presentedSizeBytes: number;

  constructor(gitBlobHash: string, recordedSizeBytes: number, presentedSizeBytes: number) {
    super(
      `Blob ${gitBlobHash} is recorded at ${String(recordedSizeBytes)} bytes but ${String(presentedSizeBytes)} were presented; nothing was written.`,
    );
    this.name = 'BlobBytesMismatchError';
    this.gitBlobHash = gitBlobHash;
    this.recordedSizeBytes = recordedSizeBytes;
    this.presentedSizeBytes = presentedSizeBytes;
  }
}

/** What classification decided, before anything is decoded. */
type Classification =
  | { readonly outcome: 'refused'; readonly capBytes: number }
  | { readonly outcome: 'binary' }
  | { readonly outcome: 'text' };

/**
 * The ordered rule, cheapest first: over the cap is refused on the length
 * alone; then a NUL anywhere is binary — the first 8,000 bytes are git's own
 * look and checked first, but the test covers the whole payload, because the
 * contents column is `text` and could not store a later NUL; everything else is
 * text, whose language the registry decides.
 */
export function classify(bytes: Uint8Array, capBytes: number): Classification {
  if (bytes.byteLength > capBytes) return { outcome: 'refused', capBytes };
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { outcome: 'binary' };
  if (bytes.subarray(BINARY_SNIFF_BYTES).includes(0)) return { outcome: 'binary' };
  return { outcome: 'text' };
}

/** A decoded file and whether decoding lost any of its bytes. */
export interface Decoded {
  readonly text: string;
  readonly lossy: boolean;
}

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * Decodes UTF-8, keeping a leading byte order mark (the default decoder drops
 * it, and the file would be stored a mark short), then measures itself: the
 * text is lossy exactly when re-encoding it does not give back the input.
 * Invalid sequences become U+FFFD, so grep still reaches the rest.
 */
export function decode(bytes: Uint8Array): Decoded {
  const text = decoder.decode(bytes);
  const again = encoder.encode(text);
  const lossy = again.byteLength !== bytes.byteLength || !again.every((b, i) => b === bytes[i]);
  return { text, lossy };
}

/** What the ordered rule decided for one file, with everything its outcome writes. */
type Planned =
  | { readonly outcome: 'refused'; readonly blob: NewBlob }
  | { readonly outcome: 'binary'; readonly blob: NewBlob }
  | {
      readonly outcome: 'unsupported';
      readonly blob: NewBlob;
      readonly contents: string;
      readonly lossy: boolean;
      readonly language: string | null;
    }
  | {
      readonly outcome: 'indexed';
      readonly blob: NewBlob;
      readonly contents: string;
      readonly lossy: boolean;
      readonly language: string;
      readonly extractorVersion: string;
      readonly parsedWithErrors: boolean;
      readonly facts: readonly Fact[];
    };

function plan(input: StoreBlobInput, capBytes: number): Planned {
  const key = {
    tenantId: input.tenantId,
    gitBlobHash: input.gitBlobHash,
    sizeBytes: input.bytes.byteLength,
  };
  const classification = classify(input.bytes, capBytes);
  if (classification.outcome === 'refused') {
    return {
      outcome: 'refused',
      blob: { ...key, outcome: 'refused', refusedCapBytes: classification.capBytes },
    };
  }
  if (classification.outcome === 'binary') {
    return { outcome: 'binary', blob: { ...key, outcome: 'binary' } };
  }
  const { text, lossy } = decode(input.bytes);
  const entry = languageForPath(input.path);
  if (entry === null) {
    const language = unavailableLanguageForPath(input.path);
    return {
      outcome: 'unsupported',
      blob: { ...key, outcome: 'unsupported', lossy, language },
      contents: text,
      lossy,
      language,
    };
  }
  const { facts, parsedWithErrors } = extract(entry, text);
  const stamp = {
    lossy,
    parsedWithErrors,
    language: entry.language,
    extractorVersion: entry.extractorVersion,
  };
  return {
    outcome: 'indexed',
    blob: { ...key, outcome: 'indexed', ...stamp },
    contents: text,
    facts,
    ...stamp,
  };
}

function answer(row: BlobRow, alreadyStored: boolean): StoredBlob {
  return {
    outcome: row.outcome,
    alreadyStored,
    sizeBytes: row.sizeBytes,
    parsedWithErrors: row.parsedWithErrors,
    lossy: row.lossy,
    refusedCapBytes: row.refusedCapBytes,
    language: row.language,
    extractorVersion: row.extractorVersion,
  };
}

/**
 * The already-stored path's one correction: a stored outcome the configuration
 * in force would now decide differently, rebuilt from the bytes in hand. Only
 * two rows qualify (each other stale row has its own writer, or none):
 *
 * - `refused`, and its size now fits the cap: re-classified by the same ordered
 *   rule a first store applies, to binary, unsupported or indexed;
 * - `unsupported` with no language recorded, whose path now resolves: to
 *   indexed when the registry can extract it, or to unsupported with the
 *   language recorded when it knows the language but has no grammar — which
 *   puts the row within that language's re-extraction sweep.
 *
 * It never writes `refused` (an unsupported row over a lowered cap stays as it
 * is). An `unsupported` row that records a language is the sweep's, and an
 * `indexed` or `binary` row nobody's here. Answers the corrected row, or null
 * when the row stands.
 */
async function correct(
  db: pg.ClientBase,
  input: StoreBlobInput,
  stored: BlobRow,
  capBytes: number,
): Promise<BlobRow | null> {
  const fits = stored.sizeBytes <= capBytes;
  if (stored.outcome === 'refused' && fits) {
    return await promoteRefused(db, input, capBytes);
  }
  if (stored.outcome === 'unsupported' && stored.language === null && fits) {
    return await resolveUnsupported(db, input, stored);
  }
  return null;
}

async function promoteRefused(
  db: pg.ClientBase,
  input: StoreBlobInput,
  capBytes: number,
): Promise<BlobRow | null> {
  const planned = plan(input, capBytes);
  const key = { tenantId: input.tenantId, gitBlobHash: input.gitBlobHash };
  if (planned.outcome === 'refused' || planned.outcome === 'binary') {
    // Only binary is reachable: the caller checked the size fits the cap.
    return await setBlobClassification(db, key.tenantId, key.gitBlobHash, {
      outcome: 'binary',
      language: null,
      lossy: null,
      refusedCapBytes: null,
    });
  }
  // The contents insert is where two workers correcting one blob meet: the
  // second waits for the first to end, then writes nothing, and answers the
  // row as the first one left it rather than writing over it.
  if (!(await insertContentsIfAbsent(db, { ...key, contents: planned.contents }))) {
    return await getBlob(db, key.tenantId, key.gitBlobHash);
  }
  // Unsupported first: the outcome check admits no refused cap beside an
  // indexed outcome and no indexed row without a version, so an indexed result
  // passes through unsupported inside this transaction and never leaves it so.
  const unsupported = await setBlobClassification(db, key.tenantId, key.gitBlobHash, {
    outcome: 'unsupported',
    language: planned.language,
    lossy: planned.lossy,
    refusedCapBytes: null,
  });
  if (planned.outcome === 'unsupported') return unsupported;
  return await promoteToIndexed(db, input, planned);
}

async function resolveUnsupported(
  db: pg.ClientBase,
  input: StoreBlobInput,
  stored: BlobRow,
): Promise<BlobRow | null> {
  const planned = plan(input, Number.POSITIVE_INFINITY);
  if (planned.outcome === 'indexed') return await promoteToIndexed(db, input, planned);
  // A stored unsupported row's bytes hold no NUL, so the rule answers unsupported here.
  if (planned.outcome !== 'unsupported' || planned.language === null) return null;
  return await setBlobClassification(db, input.tenantId, input.gitBlobHash, {
    outcome: 'unsupported',
    language: planned.language,
    lossy: stored.lossy,
    refusedCapBytes: null,
  });
}

/** Replaces the tree-sitter facts and moves the row to indexed in one locked move. */
async function promoteToIndexed(
  db: pg.ClientBase,
  input: StoreBlobInput,
  planned: Extract<Planned, { outcome: 'indexed' }>,
): Promise<BlobRow | null> {
  const key = { tenantId: input.tenantId, gitBlobHash: input.gitBlobHash };
  await replaceFactsForBlob(db, key, TREE_SITTER_PRODUCER, planned.facts, {
    extractorVersion: planned.extractorVersion,
    parsedWithErrors: planned.parsedWithErrors,
    language: planned.language,
    outcome: 'indexed',
  });
  return await getBlob(db, key.tenantId, key.gitBlobHash);
}

/**
 * Stores one file for one tenant, once, and answers its outcome.
 *
 * Opens a transaction on `db` (BEGIN … COMMIT, ROLLBACK on any failure, which
 * is then raised), binds the tenant and client with `BIND_TENANT_SQL`, and
 * reads the blob row. A blob already stored answers the outcome on record and
 * writes nothing — unless the configuration in force would now decide it
 * differently in the one way only these bytes can fix (see `correct`), when it
 * is corrected in this same transaction; bytes whose length is not the row's
 * recorded size raise `BlobBytesMismatchError` first. Otherwise it classifies, decodes and extracts, and
 * `insertBlobIfAbsent` decides: only a create writes contents and facts, so a
 * worker that lost a race to the same blob writes neither and answers the
 * winner's outcome. The caller keeps the connection; it must be at READ
 * COMMITTED, which `createAppPool` leaves in place.
 */
export async function storeBlob(
  db: pg.ClientBase,
  input: StoreBlobInput,
  options: StoreBlobOptions = {},
): Promise<StoredBlob> {
  const capBytes = options.capBytes ?? perFileCapBytes();
  await db.query('BEGIN');
  try {
    await db.query(BIND_TENANT_SQL, [input.clientId, input.tenantId]);
    const existing = await getBlob(db, input.tenantId, input.gitBlobHash);
    if (existing !== null) {
      if (existing.sizeBytes !== input.bytes.byteLength) {
        throw new BlobBytesMismatchError(
          input.gitBlobHash,
          existing.sizeBytes,
          input.bytes.byteLength,
        );
      }
      const corrected = await correct(db, input, existing, capBytes);
      await db.query('COMMIT');
      return answer(corrected ?? existing, true);
    }
    const planned = plan(input, capBytes);
    const { created, blob } = await insertBlobIfAbsent(db, planned.blob);
    if (created && (planned.outcome === 'unsupported' || planned.outcome === 'indexed')) {
      const key = { tenantId: input.tenantId, gitBlobHash: input.gitBlobHash };
      await insertContents(db, { ...key, contents: planned.contents });
      if (planned.outcome === 'indexed') await insertFacts(db, key, planned.facts);
    }
    await db.query('COMMIT');
    return answer(blob, !created);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
