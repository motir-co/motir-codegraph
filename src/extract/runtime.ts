/**
 * The one module that names the tree-sitter runtime (web-tree-sitter, pinned
 * by docs/tree-sitter-runtime.md). Everything runtime-specific — initialising
 * the WASM module, loading a grammar, creating the parser, compiling a query
 * and walking its matches — lives here, and what leaves is plain data. If the
 * runtime is swapped, this file changes and no fact shape moves.
 */
import { Language, Parser, Query } from 'web-tree-sitter';

import type { LanguageEntry } from './types.js';

/** A loaded grammar, as an entry carries it. */
export type Grammar = Language;

/** A 0-based row and column, as the runtime reports them. */
export interface RuntimePoint {
  readonly row: number;
  readonly column: number;
}

/** One capture of one match, projected out of the runtime's tree. */
export interface ProjectedCapture {
  /** The capture's name, without its `@`. */
  readonly name: string;
  /** The captured node's text. */
  readonly text: string;
  /** Start offset into the source string (UTF-16 code units). */
  readonly startIndex: number;
  /** End offset, exclusive. */
  readonly endIndex: number;
  readonly startPoint: RuntimePoint;
  readonly endPoint: RuntimePoint;
}

/** One query match: the captures that matched one pattern together. */
export interface ProjectedMatch {
  readonly captures: readonly ProjectedCapture[];
}

/** A parse, reduced to what the fact mapper reads. */
export interface ProjectedParse {
  readonly matches: readonly ProjectedMatch[];
  /** The tree's own error indication: an ERROR or MISSING node anywhere. */
  readonly hasError: boolean;
}

let initialised: Promise<void> | undefined;

/** Initialises the runtime once per process; later calls share the first. */
export function initRuntime(): Promise<void> {
  initialised ??= Parser.init();
  return initialised;
}

/**
 * Loads a grammar from its `.wasm` file. This is the entry-building side of
 * the seam: it is asynchronous and reads a file, and `extract` never calls it.
 */
export async function loadGrammar(wasmPath: string): Promise<Grammar> {
  await initRuntime();
  return Language.load(wasmPath);
}

const queries = new Map<string, { readonly extractorVersion: string; readonly query: Query }>();

/**
 * The compiled query for an entry, compiled once per language version: two
 * calls with the same language and extractor version return the same object,
 * and a new version compiles afresh and frees the one it replaces. A query
 * that does not compile throws, naming the language.
 */
export function compileQuery(entry: LanguageEntry): Query {
  const cached = queries.get(entry.language);
  if (cached !== undefined && cached.extractorVersion === entry.extractorVersion) {
    return cached.query;
  }
  let query: Query;
  try {
    query = new Query(entry.grammar, entry.query);
  } catch (cause) {
    throw new Error(`The tags query for ${entry.language} does not compile.`, { cause });
  }
  queries.set(entry.language, { extractorVersion: entry.extractorVersion, query });
  cached?.query.delete();
  return query;
}

let parser: Parser | undefined;

/**
 * Parses a source with the entry's grammar and projects the query's matches
 * into plain data. The tree is freed before returning, so nothing the caller
 * holds points into the runtime's memory.
 */
export function parseAndProject(entry: LanguageEntry, source: string): ProjectedParse {
  const query = compileQuery(entry);
  parser ??= new Parser();
  parser.setLanguage(entry.grammar);
  const tree = parser.parse(source);
  if (tree === null) {
    throw new Error(`The ${entry.language} parser returned no tree.`);
  }
  try {
    const matches = query.matches(tree.rootNode).map((match) => ({
      captures: match.captures.map(({ name, node }) => ({
        name,
        text: node.text,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        startPoint: { row: node.startPosition.row, column: node.startPosition.column },
        endPoint: { row: node.endPosition.row, column: node.endPosition.column },
      })),
    }));
    return { matches, hasError: tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}
