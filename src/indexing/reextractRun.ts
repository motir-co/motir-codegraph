/**
 * The `pnpm reextract` decision: which registered languages have stale blobs,
 * and what sweeping each of them through `reextractLanguage` came to. The
 * entry in `src/cli/reextract.ts` only parses, prints and sets the exit code.
 *
 * Staleness is never re-derived here. The plan asks the shipped predicate,
 * `findBlobsBelowExtractorVersion`, with a null tenant, so it carries both of
 * the predicate's arms (an `indexed` blob at another version, and a blob stored
 * `unsupported` under a language that now has a grammar) and agrees with the
 * sweep by construction. A null tenant reaches every tenant only on the owner
 * login: on any other login the tenant policy denies every row without
 * raising, the probe answers an empty page and the run would report a clean
 * queue. So the login is checked before the first probe.
 */
import pg from 'pg';

import { OWNER_LOGIN } from '../db/connection.js';
import { findBlobsBelowExtractorVersion } from '../db/facts.js';
import type { LanguageEntry } from '../extract/types.js';
import { listLanguages } from '../indexer/registry.js';
import { DEFAULT_CONNECTION_TIMEOUT_MS } from '../server/pool.js';
import { reextractLanguage, type ReextractReport } from './reextract.js';

/** A probe asks whether a language has at least one stale blob, never how many. */
export const STALE_PROBE_PAGE_SIZE = 1;

/** One language the predicate reported stale, and the version it is rebuilt to. */
export interface ReextractionPlanEntry {
  readonly language: string;
  readonly extractorVersion: string;
}

/**
 * - `swept`: at least one blob was rebuilt and the language came back drained.
 * - `not_stale`: planned, but drained before its own sweep began (another run
 *   finished it in between), so nothing moved.
 * - `skipped`: another run held the language's lock; nothing moved.
 * - `failed`: the sweep threw; the blobs it rebuilt before the throw stay rebuilt.
 */
export type ReextractionStatus = 'swept' | 'not_stale' | 'skipped' | 'failed';

/** One page of a language's sweep, as counts. */
export interface ReextractionBatchCount {
  /** 1-based. */
  readonly ordinal: number;
  readonly blobCount: number;
  readonly factCount: number;
}

/** What sweeping one planned language came to. */
export interface ReextractionOutcome {
  readonly language: string;
  readonly extractorVersion: string;
  readonly status: ReextractionStatus;
  readonly blobCount: number;
  readonly factCount: number;
  readonly batches: readonly ReextractionBatchCount[];
  /** Why the language was skipped or failed; null otherwise. */
  readonly reason: string | null;
}

/** A whole run: every planned language's outcome, in plan order, and the totals. */
export interface ReextractionRun {
  readonly plan: readonly ReextractionPlanEntry[];
  readonly outcomes: readonly ReextractionOutcome[];
  readonly blobCount: number;
  readonly factCount: number;
  readonly counts: Readonly<Record<ReextractionStatus, number>>;
  /** True only when every planned language is confirmed drained: none skipped, none failed. */
  readonly drained: boolean;
}

export interface ReextractionInput {
  /** The owner login's URL. Never printed: it carries the owner's password. */
  readonly connectionString: string;
  /** Narrows the plan to these language ids; every registered language when omitted. */
  readonly languages?: readonly string[];
  /** The entries to plan over; the shipped registry when omitted. */
  readonly registry?: readonly LanguageEntry[];
  /** Passed through to `reextractLanguage`; its own default when omitted. */
  readonly batchSize?: number;
}

/** The run cannot start: a login that is not the owner, or a language id the registry does not answer. */
export class ReextractionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReextractionRefusedError';
  }
}

/**
 * One probe per registry entry, in the registry's own order (`listLanguages()`
 * ascends by id): the entry is planned when the shipped predicate's first page
 * is not empty. `db` must be the owner login, unbound; see the module comment.
 */
export async function planReextraction(
  db: pg.ClientBase,
  registry: readonly LanguageEntry[] = listLanguages(),
): Promise<ReextractionPlanEntry[]> {
  const plan: ReextractionPlanEntry[] = [];
  for (const { language, extractorVersion } of registry) {
    const page = await findBlobsBelowExtractorVersion(
      db,
      null,
      language,
      extractorVersion,
      STALE_PROBE_PAGE_SIZE,
    );
    if (page.blobs.length > 0) plan.push({ language, extractorVersion });
  }
  return plan;
}

/** The registry narrowed to `languages`, refusing an id it does not answer. */
function narrow(
  registry: readonly LanguageEntry[],
  languages: readonly string[] | undefined,
): readonly LanguageEntry[] {
  if (languages === undefined) return registry;
  const known = new Set(registry.map((entry) => entry.language));
  const unknown = languages.filter((language) => !known.has(language));
  if (unknown.length > 0) {
    throw new ReextractionRefusedError(
      `Unknown language ${unknown.join(', ')}: listLanguages() answers no such id.`,
    );
  }
  const wanted = new Set(languages);
  return registry.filter((entry) => wanted.has(entry.language));
}

function outcomeOf(entry: ReextractionPlanEntry, report: ReextractReport): ReextractionOutcome {
  const batches = report.batches.map((batch) => ({
    ordinal: batch.ordinal,
    blobCount: batch.blobs.length,
    factCount: batch.blobs.reduce((sum, blob) => sum + blob.factCount, 0),
  }));
  if (report.anotherRunInProgress) {
    return {
      ...entry,
      status: 'skipped',
      blobCount: 0,
      factCount: 0,
      batches: [],
      reason: `another run holds the ${entry.language} re-extraction lock`,
    };
  }
  return {
    ...entry,
    status: report.blobCount > 0 ? 'swept' : 'not_stale',
    blobCount: report.blobCount,
    factCount: report.factCount,
    batches,
    reason: null,
  };
}

async function sweepOne(
  entry: ReextractionPlanEntry,
  input: ReextractionInput,
  registry: readonly LanguageEntry[],
): Promise<ReextractionOutcome> {
  try {
    const report = await reextractLanguage(entry.language, {
      connectionString: input.connectionString,
      registry,
      ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
    });
    return outcomeOf(entry, report);
  } catch (error) {
    // `ReextractError` among them: the blobs before it are committed and the
    // blob it names stays stale, so the next language is swept regardless.
    return {
      ...entry,
      status: 'failed',
      blobCount: 0,
      factCount: 0,
      batches: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Checks the login, plans, then sweeps each planned language in plan order,
 * one at a time. A language that is skipped or fails is recorded and the run
 * carries on; `drained` reports whether every planned language is confirmed
 * drained. Refuses, before any probe, a language id the registry does not
 * answer and a login that is not `OWNER_LOGIN` (naming the login it found,
 * never the connection string).
 */
export async function runReextraction(input: ReextractionInput): Promise<ReextractionRun> {
  const registry = input.registry ?? listLanguages();
  const candidates = narrow(registry, input.languages);
  const client = new pg.Client({
    connectionString: input.connectionString,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
  });
  let plan: ReextractionPlanEntry[];
  try {
    await client.connect();
    const login = await client.query<{ login: string }>('SELECT current_user AS login');
    const user = login.rows[0]?.login;
    if (user !== OWNER_LOGIN) {
      throw new ReextractionRefusedError(
        `Re-extraction must run as ${OWNER_LOGIN}, whose policy reaches every tenant, ` +
          `not as ${String(user)}. On any other login every probe answers nothing stale.`,
      );
    }
    plan = await planReextraction(client, candidates);
  } finally {
    await client.end();
  }

  const outcomes: ReextractionOutcome[] = [];
  for (const entry of plan) outcomes.push(await sweepOne(entry, input, registry));

  const counts: Record<ReextractionStatus, number> = {
    swept: 0,
    not_stale: 0,
    skipped: 0,
    failed: 0,
  };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return {
    plan,
    outcomes,
    blobCount: outcomes.reduce((sum, outcome) => sum + outcome.blobCount, 0),
    factCount: outcomes.reduce((sum, outcome) => sum + outcome.factCount, 0),
    counts,
    drained: counts.skipped === 0 && counts.failed === 0,
  };
}
