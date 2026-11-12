/**
 * C: `tree-sitter-c` 0.24.1, `tree-sitter-c.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-c@0.24.1; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const c: LanguageDefinition = {
  id: 'c',
  d5Name: 'C',
  grammarPackage: 'tree-sitter-c',
  grammarFile: 'tree-sitter-c.wasm',
  grammarVersion: '0.24.1',
  queryRevision: 1,
  extensions: ['.c'],
  filenames: [],
  query: `
; ── tree-sitter-c@0.24.1 queries/tags.scm, verbatim ──
(struct_specifier name: (type_identifier) @name body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class

(function_declarator declarator: (identifier) @name) @definition.function

(type_definition declarator: (type_identifier) @name) @definition.type

(enum_specifier name: (type_identifier) @name) @definition.type

; ── imports (this service's captures) ──
; A system include keeps its angle brackets, so it stays told apart from a
; local one.
(preproc_include path: (_) @import.module)

; C has no inheritance.
`,
};
