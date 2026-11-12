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
  type BlobOutcome,
  type BlobRow,
  type NewBlob,
} from '../db/blobs.js';
import { insertFacts } from '../db/facts.js';
import { extract } from '../extract/extract.js';
import type { Fact } from '../extract/types.js';
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

/** What a first store writes beyond the blob row. */
interface Planned {
  readonly blob: NewBlob;
  readonly contents: string | null;
  readonly facts: readonly Fact[];
}

function plan(input: StoreBlobInput, capBytes: number): Planned {
  const key = {
    tenantId: input.tenantId,
    gitBlobHash: input.gitBlobHash,
    sizeBytes: input.bytes.byteLength,
  };
  const classification = classify(input.bytes, capBytes);
  if (classification.outcome === 'refused') {
    return {
      blob: { ...key, outcome: 'refused', refusedCapBytes: classification.capBytes },
      contents: null,
      facts: [],
    };
  }
  if (classification.outcome === 'binary') {
    return { blob: { ...key, outcome: 'binary' }, contents: null, facts: [] };
  }
  const { text, lossy } = decode(input.bytes);
  const entry = languageForPath(input.path);
  if (entry === null) {
    return {
      blob: {
        ...key,
        outcome: 'unsupported',
        lossy,
        language: unavailableLanguageForPath(input.path),
      },
      contents: text,
      facts: [],
    };
  }
  const extraction = extract(entry, text);
  return {
    blob: {
      ...key,
      outcome: 'indexed',
      lossy,
      parsedWithErrors: extraction.parsedWithErrors,
      language: entry.language,
      extractorVersion: entry.extractorVersion,
    },
    contents: text,
    facts: extraction.facts,
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
 * Stores one file for one tenant, once, and answers its outcome.
 *
 * Opens a transaction on `db` (BEGIN … COMMIT, ROLLBACK on any failure, which
 * is then raised), binds the tenant and client with `BIND_TENANT_SQL`, and
 * reads the blob row: a blob already stored answers the outcome on record and
 * writes nothing. Otherwise it classifies, decodes and extracts, and
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
      await db.query('COMMIT');
      return answer(existing, true);
    }
    const planned = plan(input, capBytes);
    const { created, blob } = await insertBlobIfAbsent(db, planned.blob);
    if (created) {
      const key = { tenantId: input.tenantId, gitBlobHash: input.gitBlobHash };
      if (planned.contents !== null) {
        await insertContents(db, { ...key, contents: planned.contents });
      }
      await insertFacts(db, key, planned.facts);
    }
    await db.query('COMMIT');
    return answer(blob, !created);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
