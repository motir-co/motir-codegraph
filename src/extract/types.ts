/**
 * The extractor's shapes: one fact schema for every language and every
 * producer, the entry a language is extracted with, and what an extraction
 * returns.
 *
 * No shape here names a blob, a commit, a repository or a path. A fact says
 * only what a file's bytes mean, so whoever stores it supplies the blob key
 * from its own argument, and one blob reached by two paths yields one fact set.
 */
import type { Grammar } from './runtime.js';

/** The producer every fact this module emits is stamped with. */
export const TREE_SITTER_PRODUCER = 'tree-sitter';

/**
 * A span of source text. Lines and columns are 1-based; the end points just
 * past the span's last character, so a one-character span on line 1, column 1
 * ends at line 1, column 2. Columns count UTF-16 code units, the unit a
 * JavaScript string is indexed in.
 */
export interface SourceRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** What every fact carries, whichever kind it is. */
interface FactCommon {
  /** The language the fact was extracted from, as the entry names it. */
  readonly language: string;
  /** Which producer emitted it: {@link TREE_SITTER_PRODUCER} for this module. */
  readonly producer: string;
  /** The entry's extractor version at the time of extraction. */
  readonly extractorVersion: string;
  /** Where the fact sits in the source. */
  readonly range: SourceRange;
  /** The name of the innermost definition strictly enclosing the fact, if any. */
  readonly enclosingName: string | null;
}

/** A named thing the file defines: a class, a method, a function, a trait… */
export interface DefinitionFact extends FactCommon {
  readonly kind: 'definition';
  readonly name: string;
  /** The grammar's own word for it, carried through verbatim (open vocabulary). */
  readonly definitionKind: string;
}

/** A use of a name: a call, a type reference, an instantiation… */
export interface ReferenceFact extends FactCommon {
  readonly kind: 'reference';
  /** The referenced name, unresolved: no fact names another file. */
  readonly name: string;
  /** The grammar's own word for it, carried through verbatim (open vocabulary). */
  readonly referenceKind: string;
}

/** One import statement: the module it names and the names it brings in. */
export interface ImportFact extends FactCommon {
  readonly kind: 'import';
  /** The module specifier, with one pair of surrounding quotes stripped. */
  readonly moduleSpecifier: string;
  /** The imported names, in source order; empty when the statement names none. */
  readonly importedNames: readonly string[];
}

/** How an inheritance relates the defining symbol to its parent. */
export type InheritanceRelation = 'extends' | 'implements';

/** One parent of one defining symbol. */
export interface InheritanceFact extends FactCommon {
  readonly kind: 'inheritance';
  /** The inheriting symbol. */
  readonly name: string;
  /** The parent's name, unresolved. */
  readonly parentName: string;
  readonly relation: InheritanceRelation;
}

/** The four facts, a closed union: a fifth kind is a compile error, not a dropped row. */
export type Fact = DefinitionFact | ReferenceFact | ImportFact | InheritanceFact;

/** The four kind strings, exactly the values the fact table's kind check admits. */
export type FactKind = Fact['kind'];

/** Everything extraction needs to know about one language, and nothing else. */
export interface LanguageEntry {
  /** The language's name, stamped on every fact. */
  readonly language: string;
  /** The file extensions the language claims, with their leading dot. */
  readonly extensions: readonly string[];
  /** The exact filenames the language claims (e.g. `Makefile`). */
  readonly filenames: readonly string[];
  /** The grammar, already loaded: extraction never loads one. */
  readonly grammar: Grammar;
  /** The grammar package's version. */
  readonly grammarVersion: string;
  /** The version of {@link LanguageEntry.query}, bumped whenever its text changes. */
  readonly queryVersion: string;
  /** The tags query, written in the capture vocabulary of `captures.ts`. */
  readonly query: string;
  /** `composeExtractorVersion(grammarVersion, queryVersion)`. */
  readonly extractorVersion: string;
}

/** What `extract` returns for one source. */
export interface ExtractionResult {
  /** Stamped, de-duplicated and in text order. */
  readonly facts: readonly Fact[];
  /** Whether the parse tree marks any part of the source as an error. */
  readonly parsedWithErrors: boolean;
}
