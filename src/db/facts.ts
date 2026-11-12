/**
 * The database-client layer over `codegraph.blob_fact`
 * (db/migrations/0006_blob_fact.sql): the only module in the service that
 * writes or reads a fact row.
 *
 * Every function takes the caller's connection, inside a transaction the
 * caller owns and has already bound (`BIND_TENANT_SQL`); none of them begins,
 * commits, rolls back or binds. A write the policy, a key or a check refuses
 * fails loudly on its own. A read does not — a wrongly bound session sees no
 * rows and answers a plausible empty result — so the two reads here compare
 * the tenant they are handed with `codegraph_bound_tenant()` first and raise
 * `TenantBindingMismatchError` rather than answer.
 *
 * A fact names no repository, commit, path or other blob: the only key a row
 * carries beyond its own fields is the blob it hangs from.
 */
import type pg from 'pg';

import type { Fact, InheritanceRelation, SourceRange } from '../extract/types.js';

/**
 * A fact as stored: the extractor's union, whose every member already carries
 * the language, producer and extractor version the row records beside it.
 */
export type StoredFact = Fact;

/** The blob a fact set hangs from. */
export interface BlobKey {
  readonly tenantId: string;
  readonly gitBlobHash: string;
}

/**
 * The four blob columns a replacement moves with the facts. The outcome is
 * always `indexed`: the move is both a re-extraction at a new version and the
 * promotion of a blob stored `unsupported` before its language had a grammar.
 */
export interface BlobState {
  readonly extractorVersion: string;
  readonly parsedWithErrors: boolean;
  readonly language: string;
  readonly outcome: 'indexed';
}

/** One stale blob, named by its tenant and hash. */
export interface StaleBlob {
  readonly tenantId: string;
  readonly gitBlobHash: string;
}

/** One keyset page of stale blobs. */
export interface StaleBlobPage {
  readonly blobs: readonly StaleBlob[];
  /** The last row of a full page, to resume after; null once the language is drained. */
  readonly nextAfter: StaleBlob | null;
}

/** Facts per INSERT statement: 500 rows × 17 parameters stays far inside the protocol's 65,535. */
export const FACT_INSERT_CHUNK = 500;

/** The page size `findBlobsBelowExtractorVersion` uses when none is passed. */
export const DEFAULT_STALE_PAGE_SIZE = 500;

/** `replaceFactsForBlob` named a blob the bound tenant holds no row for. */
export class UnknownBlobFactsError extends Error {
  readonly tenantId: string;
  readonly gitBlobHash: string;

  constructor(blob: BlobKey) {
    super(`Tenant ${blob.tenantId} holds no blob ${blob.gitBlobHash} to replace facts for.`);
    this.name = 'UnknownBlobFactsError';
    this.tenantId = blob.tenantId;
    this.gitBlobHash = blob.gitBlobHash;
  }
}

/** A read named a tenant other than the one the session is bound to. */
export class TenantBindingMismatchError extends Error {
  readonly requested: string | null;
  readonly bound: string | null;

  constructor(requested: string | null, bound: string | null) {
    super(
      `The read names tenant ${requested ?? '(none)'} but the session is bound to ${bound ?? '(none)'}.`,
    );
    this.name = 'TenantBindingMismatchError';
    this.requested = requested;
    this.bound = bound;
  }
}

/** A stored row whose kind this module does not map. */
export class UnrecognizedFactKindError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`Fact kind ${JSON.stringify(kind)} is not one this service maps.`);
    this.name = 'UnrecognizedFactKindError';
    this.kind = kind;
  }
}

/**
 * The fact table's columns, in insert order, after the blob key. This list and
 * the two mappings below are the only place they are named.
 */
const FACT_COLUMNS = [
  'kind',
  'language',
  'producer',
  'extractor_version',
  'name',
  'start_line',
  'start_column',
  'end_line',
  'end_column',
  'enclosing_name',
  'definition_kind',
  'reference_kind',
  'module_specifier',
  'imported_names',
  'parent_name',
  'relation',
] as const;

type FactColumn = (typeof FACT_COLUMNS)[number];
type FactValue = string | number | readonly string[] | null;

/** A fact row as the table holds it, keyed by column name. */
export type FactRow = Record<FactColumn, FactValue>;

/** Forward: one fact onto its row's columns, each kind writing its own and no others. */
export function factToRow(fact: StoredFact): FactRow {
  const row: FactRow = {
    kind: fact.kind,
    language: fact.language,
    producer: fact.producer,
    extractor_version: fact.extractorVersion,
    name: null,
    start_line: fact.range.startLine,
    start_column: fact.range.startColumn,
    end_line: fact.range.endLine,
    end_column: fact.range.endColumn,
    enclosing_name: fact.enclosingName,
    definition_kind: null,
    reference_kind: null,
    module_specifier: null,
    imported_names: null,
    parent_name: null,
    relation: null,
  };
  switch (fact.kind) {
    case 'definition':
      return { ...row, name: fact.name, definition_kind: fact.definitionKind };
    case 'reference':
      return { ...row, name: fact.name, reference_kind: fact.referenceKind };
    case 'import':
      return {
        ...row,
        module_specifier: fact.moduleSpecifier,
        imported_names: [...fact.importedNames],
      };
    case 'inheritance':
      return { ...row, name: fact.name, parent_name: fact.parentName, relation: fact.relation };
  }
}

/** A column's value as text, or a loud failure: the kind check makes these present. */
function text(row: Record<string, unknown>, column: FactColumn): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Fact column ${column} holds ${JSON.stringify(value)}, not text.`);
  }
  return value;
}

function rangeOf(row: Record<string, unknown>): SourceRange {
  const [startLine, startColumn, endLine, endColumn] = (
    ['start_line', 'start_column', 'end_line', 'end_column'] as const
  ).map((column) => row[column]);
  if (
    typeof startLine !== 'number' ||
    typeof startColumn !== 'number' ||
    typeof endLine !== 'number' ||
    typeof endColumn !== 'number'
  ) {
    // Only an inheritance may be stored without a range, and only by another
    // writer: the extractor's union always carries one.
    throw new Error('A fact row without a source range has no shape in the fact union.');
  }
  return { startLine, startColumn, endLine, endColumn };
}

/**
 * Reverse: one stored row back into a fact. A kind outside the four raises
 * `UnrecognizedFactKindError`: the set is closed by the table's check, not by
 * the compiler, so a kind a later migration admits must never be relabelled.
 */
export function rowToFact(row: Record<string, unknown>): StoredFact {
  const common = {
    language: text(row, 'language'),
    producer: text(row, 'producer'),
    extractorVersion: text(row, 'extractor_version'),
    enclosingName: (row.enclosing_name as string | null) ?? null,
  };
  const kind = row.kind;
  switch (kind) {
    case 'definition':
      return {
        kind,
        ...common,
        range: rangeOf(row),
        name: text(row, 'name'),
        definitionKind: text(row, 'definition_kind'),
      };
    case 'reference':
      return {
        kind,
        ...common,
        range: rangeOf(row),
        name: text(row, 'name'),
        referenceKind: text(row, 'reference_kind'),
      };
    case 'import':
      return {
        kind,
        ...common,
        range: rangeOf(row),
        moduleSpecifier: text(row, 'module_specifier'),
        importedNames: (row.imported_names as string[] | null) ?? [],
      };
    case 'inheritance':
      return {
        kind,
        ...common,
        range: rangeOf(row),
        name: text(row, 'name'),
        parentName: text(row, 'parent_name'),
        relation: text(row, 'relation') as InheritanceRelation,
      };
    default:
      throw new UnrecognizedFactKindError(String(kind));
  }
}

/** One multi-row INSERT for a chunk of facts, every value a parameter. */
function insertStatement(blob: BlobKey, facts: readonly StoredFact[]): [string, unknown[]] {
  const width = 2 + FACT_COLUMNS.length;
  const params: unknown[] = [];
  const tuples = facts.map((fact, index) => {
    const row = factToRow(fact);
    params.push(blob.tenantId, blob.gitBlobHash, ...FACT_COLUMNS.map((column) => row[column]));
    const base = index * width;
    return `(${Array.from({ length: width }, (_, offset) => `$${String(base + offset + 1)}`).join(', ')})`;
  });
  const sql = `INSERT INTO codegraph.blob_fact (tenant_id, git_blob_hash, ${FACT_COLUMNS.join(', ')})
  VALUES ${tuples.join(',\n    ')}`;
  return [sql, params];
}

/**
 * Inserts one producer's facts for one blob, in statements of at most
 * `FACT_INSERT_CHUNK` rows. Insert-only, no conflict clause: a second set for
 * the same producer raises on the identity key rather than doubling. Writes no
 * blob row and opens no transaction; a chunk the table refuses aborts the
 * caller's transaction, so none of the set survives it.
 */
export async function insertFacts(
  db: pg.ClientBase,
  blob: BlobKey,
  facts: readonly StoredFact[],
): Promise<void> {
  for (let start = 0; start < facts.length; start += FACT_INSERT_CHUNK) {
    const [sql, params] = insertStatement(blob, facts.slice(start, start + FACT_INSERT_CHUNK));
    await db.query(sql, params);
  }
}

/**
 * The blob's row lock and existence check, in one statement: an UPDATE that
 * sets a column the app login is granted to itself. It takes the row lock any
 * second replace of the same blob must wait on, changes nothing a reader can
 * see, and its row count says whether the bound tenant holds the blob.
 */
const LOCK_BLOB_SQL = `UPDATE codegraph.blob SET extractor_version = extractor_version
  WHERE tenant_id = $1 AND git_blob_hash = $2`;

const DELETE_PRODUCER_FACTS_SQL = `DELETE FROM codegraph.blob_fact
  WHERE tenant_id = $1 AND git_blob_hash = $2 AND producer = $3`;

const RECORD_STATE_SQL = `UPDATE codegraph.blob
  SET extractor_version = $3, parsed_with_errors = $4, language = $5, outcome = $6,
      refused_cap_bytes = NULL
  WHERE tenant_id = $1 AND git_blob_hash = $2`;

/**
 * Replaces one producer's facts for one blob and records the blob's new state,
 * in the caller's transaction: lock the blob row (raising
 * `UnknownBlobFactsError`, before any write, when there is none), delete that
 * producer's facts, insert the new set, and move `extractor_version`,
 * `parsed_with_errors`, `language` and `outcome` (clearing the refused cap) so
 * the stale page and the facts can never disagree. Another producer's facts
 * are never touched. Two concurrent replaces of one blob serialise on the row
 * lock, so the blob ends with exactly one of the two sets. Opens no
 * transaction.
 */
export async function replaceFactsForBlob(
  db: pg.ClientBase,
  blob: BlobKey,
  producer: string,
  facts: readonly StoredFact[],
  state: BlobState,
): Promise<void> {
  const foreign = facts.find((fact) => fact.producer !== producer);
  if (foreign !== undefined) {
    throw new Error(
      `A ${producer} replacement was handed a fact produced by ${foreign.producer}; nothing was written.`,
    );
  }
  const locked = await db.query(LOCK_BLOB_SQL, [blob.tenantId, blob.gitBlobHash]);
  if (locked.rowCount !== 1) throw new UnknownBlobFactsError(blob);
  await db.query(DELETE_PRODUCER_FACTS_SQL, [blob.tenantId, blob.gitBlobHash, producer]);
  await insertFacts(db, blob, facts);
  await db.query(RECORD_STATE_SQL, [
    blob.tenantId,
    blob.gitBlobHash,
    state.extractorVersion,
    state.parsedWithErrors,
    state.language,
    state.outcome,
  ]);
}

/** The tenant the session is bound to, or null. */
async function boundTenant(db: pg.ClientBase): Promise<string | null> {
  const { rows } = await db.query<{ tenant: string | null }>(
    'SELECT codegraph.codegraph_bound_tenant()::text AS tenant',
  );
  return rows[0]?.tenant ?? null;
}

/** Raises unless `tenantId` is exactly the bound tenant (null meaning none is bound). */
async function requireBinding(db: pg.ClientBase, tenantId: string | null): Promise<void> {
  const bound = await boundTenant(db);
  if ((tenantId?.toLowerCase() ?? null) !== bound) {
    throw new TenantBindingMismatchError(tenantId, bound);
  }
}

const SELECT_FACTS_SQL = `SELECT ${FACT_COLUMNS.join(', ')} FROM codegraph.blob_fact
  WHERE tenant_id = $1 AND git_blob_hash = $2 AND ($3::text IS NULL OR producer = $3)
  ORDER BY producer, start_line NULLS FIRST, start_column, end_line, end_column, kind,
    name, module_specifier, parent_name, relation, enclosing_name, definition_kind,
    reference_kind, imported_names`;

/**
 * A blob's facts — every producer's, or one producer's — in a deterministic
 * order: producer, then source position, then kind and name. Raises
 * `TenantBindingMismatchError` when `blob.tenantId` is not the bound tenant.
 * Opens no transaction.
 */
export async function factsForBlob(
  db: pg.ClientBase,
  blob: BlobKey,
  producer?: string,
): Promise<StoredFact[]> {
  await requireBinding(db, blob.tenantId);
  const { rows } = await db.query<Record<string, unknown>>(SELECT_FACTS_SQL, [
    blob.tenantId,
    blob.gitBlobHash,
    producer ?? null,
  ]);
  return rows.map(rowToFact);
}

const STALE_PAGE_SQL = `SELECT tenant_id::text AS "tenantId", git_blob_hash AS "gitBlobHash"
  FROM codegraph.blob
  WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
    AND language = $2
    AND ((outcome = 'indexed' AND extractor_version IS DISTINCT FROM $3) OR outcome = 'unsupported')
    AND ($4::uuid IS NULL OR (tenant_id, git_blob_hash) > ($4::uuid, $5::text))
  ORDER BY tenant_id, git_blob_hash
  LIMIT $6`;

/**
 * One keyset page of one language's stale blobs: `indexed` blobs recorded at
 * any version other than `version` (IS DISTINCT FROM — the composite version
 * has no order, and a NULL is stale too), and `unsupported` blobs of the
 * language, which now has a grammar. Of `tenantId`'s blobs, or of every
 * tenant's when it is null — admitted only on a session with no tenant bound
 * (the owner login); a bound session must pass its own tenant, and any
 * mismatch raises `TenantBindingMismatchError`.
 *
 * Ordered and resumed on the pair (tenant id, git blob hash), so a caller that
 * replaces each blob it is handed — moving it out of the predicate — still
 * meets every stale blob exactly once, across tenant boundaries too.
 * `nextAfter` is the last row of a full page and null on a short one. Opens no
 * transaction.
 */
export async function findBlobsBelowExtractorVersion(
  db: pg.ClientBase,
  tenantId: string | null,
  language: string,
  version: string,
  batchSize: number = DEFAULT_STALE_PAGE_SIZE,
  after: StaleBlob | null = null,
): Promise<StaleBlobPage> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${String(batchSize)}.`);
  }
  await requireBinding(db, tenantId);
  const { rows } = await db.query<StaleBlob>(STALE_PAGE_SQL, [
    tenantId,
    language,
    version,
    after?.tenantId ?? null,
    after?.gitBlobHash ?? null,
    batchSize,
  ]);
  const last = rows.at(-1);
  return { blobs: rows, nextAfter: rows.length === batchSize && last !== undefined ? last : null };
}
