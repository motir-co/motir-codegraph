/**
 * The language registry: every language D5 names, either as a registered entry
 * the extractor can run, or as a record saying why it has none.
 *
 * The table is static — every language module is imported here by name — so
 * any process that imports this module sees all of it. Each registered
 * language's grammar is loaded once, when the module is first imported; the
 * registry creates no parser, compiles no query, reads no source file and
 * opens no connection.
 */
import { createRequire } from 'node:module';

import { loadGrammar } from '../extract/runtime.js';
import type { LanguageEntry } from '../extract/types.js';
import { composeExtractorVersion } from '../extract/version.js';
import { c } from './languages/c.js';
import { cpp } from './languages/cpp.js';
import { csharp } from './languages/csharp.js';
import { dart } from './languages/dart.js';
import { elixir } from './languages/elixir.js';
import { go } from './languages/go.js';
import { haskell } from './languages/haskell.js';
import { java } from './languages/java.js';
import { javascript } from './languages/javascript.js';
import { kotlin } from './languages/kotlin.js';
import { lua } from './languages/lua.js';
import { php } from './languages/php.js';
import { python } from './languages/python.js';
import { ruby } from './languages/ruby.js';
import { rust } from './languages/rust.js';
import { scala } from './languages/scala.js';
import { solidity } from './languages/solidity.js';
import { tsx } from './languages/tsx.js';
import { typescript } from './languages/typescript.js';
import { UNAVAILABLE_LANGUAGES } from './languages/unavailable.js';

/** How a file is recognised as a language. */
interface PathDeclaration {
  /** The language id: lowercase, the value a blob and a fact row record. */
  readonly id: string;
  /** The language's name as D5 lists it (`tsx` is TypeScript's JSX variant). */
  readonly d5Name: string;
  /** Lowercase, with the leading dot. */
  readonly extensions: readonly string[];
  /** Exact basenames that are this language whatever their extension. */
  readonly filenames: readonly string[];
}

/** One registered language, as its module writes it. */
export interface LanguageDefinition extends PathDeclaration {
  /** The npm package the grammar comes from, pinned exactly in package.json. */
  readonly grammarPackage: string;
  /** The `.wasm` file inside that package. */
  readonly grammarFile: string;
  /** The pinned package's version, as a literal. */
  readonly grammarVersion: string;
  /** Incremented whenever `query` changes. */
  readonly queryRevision: number;
  /** The tags query, in the extractor's capture vocabulary. */
  readonly query: string;
}

/** A D5 language with no grammar this service can load. */
export interface UnavailableLanguage extends PathDeclaration {
  /** Why it has none. */
  readonly reason: string;
}

/** A registered language: the extractor's entry, plus its D5 name. */
export interface RegisteredLanguage extends LanguageEntry {
  readonly d5Name: string;
}

/** Every registered language's definition, in ascending id order. */
export const LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  c,
  cpp,
  csharp,
  dart,
  elixir,
  go,
  haskell,
  java,
  javascript,
  kotlin,
  lua,
  php,
  python,
  ruby,
  rust,
  scala,
  solidity,
  tsx,
  typescript,
].sort((a, b) => compareIds(a.id, b.id));

const resolve = createRequire(import.meta.url).resolve;

/** Builds one entry, loading its grammar; a failure names the language. */
export async function registerLanguage(
  definition: LanguageDefinition,
): Promise<RegisteredLanguage> {
  let grammar: LanguageEntry['grammar'];
  try {
    grammar = await loadGrammar(resolve(`${definition.grammarPackage}/${definition.grammarFile}`));
  } catch (cause) {
    throw new Error(`The ${definition.id} grammar did not load.`, { cause });
  }
  const queryVersion = String(definition.queryRevision);
  return {
    language: definition.id,
    d5Name: definition.d5Name,
    extensions: definition.extensions,
    filenames: definition.filenames,
    grammar,
    grammarVersion: definition.grammarVersion,
    queryVersion,
    query: definition.query,
    extractorVersion: composeExtractorVersion(definition.grammarVersion, queryVersion),
  };
}

const ENTRIES: readonly RegisteredLanguage[] = await Promise.all(
  LANGUAGE_DEFINITIONS.map(registerLanguage),
);

/** What a path resolves to: a registered entry, or a language with no grammar. */
export interface Claim {
  readonly entry: RegisteredLanguage | null;
  readonly unavailable: UnavailableLanguage | null;
}

/** A path's lookup keys, as a language declares them. */
interface PathKeys {
  readonly extensions: readonly string[];
  readonly filenames: readonly string[];
}

/**
 * Builds the path lookup over both lists. A filename or extension declared
 * twice throws, naming it, so no answer ever depends on declaration order.
 * The basename decides: an exact filename first, then the longest declared
 * extension, both case-insensitively.
 */
export function buildPathLookup(
  declarations: readonly (readonly [PathKeys, Claim])[],
): (path: string) => Claim | null {
  const byFilename = new Map<string, Claim>();
  const byExtension = new Map<string, Claim>();
  for (const [keys, value] of declarations) {
    for (const filename of keys.filenames) {
      const key = filename.toLowerCase();
      if (byFilename.has(key)) throw new Error(`Filename ${filename} is declared twice.`);
      byFilename.set(key, value);
    }
    for (const extension of keys.extensions) {
      const key = extension.toLowerCase();
      if (byExtension.has(key)) throw new Error(`Extension ${extension} is declared twice.`);
      byExtension.set(key, value);
    }
  }
  // Longest first, so a longer suffix always wins.
  const extensions = [...byExtension].sort(([a], [b]) => b.length - a.length || compareIds(a, b));
  return (path) => {
    const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (basename === '') return null;
    const byName = byFilename.get(basename);
    if (byName !== undefined) return byName;
    for (const [extension, value] of extensions) {
      if (basename.length > extension.length && basename.endsWith(extension)) return value;
    }
    return null;
  };
}

const claimFor = buildPathLookup([
  ...ENTRIES.map((entry) => [entry, { entry, unavailable: null }] as const),
  ...UNAVAILABLE_LANGUAGES.map((record) => [record, { entry: null, unavailable: record }] as const),
]);

/**
 * The registered language a path is extracted with, or null when this service
 * does not extract it.
 */
export function languageForPath(path: string): RegisteredLanguage | null {
  return claimFor(path)?.entry ?? null;
}

/**
 * The id of the D5 language a path belongs to when the registry knows that
 * language and has no grammar for it, or null — including for every path a
 * registered entry claims, so the two lookups never both answer.
 */
export function unavailableLanguageForPath(path: string): string | null {
  return claimFor(path)?.unavailable?.id ?? null;
}

/** Every registered language with its current extractor version, ascending by id. */
export function listLanguages(): readonly RegisteredLanguage[] {
  return ENTRIES;
}

/** Every D5 language with no grammar, ascending by id. */
export function unavailableLanguages(): readonly UnavailableLanguage[] {
  return [...UNAVAILABLE_LANGUAGES].sort((a, b) => compareIds(a.id, b.id));
}

/** A locale-independent order. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
