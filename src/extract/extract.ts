/**
 * The extractor's whole surface: one synchronous call per file.
 */
import { buildFacts } from './buildFacts.js';
import { parseAndProject } from './runtime.js';
import type { ExtractionResult, LanguageEntry } from './types.js';

/**
 * Extracts the facts of one decoded source with one language's entry.
 *
 * It never loads a grammar, reads a file, opens a connection or writes a row.
 * A source with syntax errors is not a failure: the parser recovers what it
 * can, the facts it recovered come back as ordinary facts, and
 * `parsedWithErrors` is read from the tree. What genuinely fails — a query that
 * does not compile, a parser that returns no tree — throws and names the
 * language; nothing here is caught, because an empty fact list must never be
 * the answer to a broken query.
 */
export function extract(entry: LanguageEntry, source: string): ExtractionResult {
  const parsed = parseAndProject(entry, source);
  return { facts: buildFacts(entry, parsed.matches, source), parsedWithErrors: parsed.hasError };
}
