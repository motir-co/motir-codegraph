/**
 * Lua: `@tree-sitter-grammars/tree-sitter-lua` 0.4.1, `tree-sitter-lua.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (@tree-sitter-grammars/tree-sitter-lua@0.4.1; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const lua: LanguageDefinition = {
  id: 'lua',
  d5Name: 'Lua',
  grammarPackage: '@tree-sitter-grammars/tree-sitter-lua',
  grammarFile: 'tree-sitter-lua.wasm',
  grammarVersion: '0.4.1',
  queryRevision: 1,
  extensions: ['.lua'],
  filenames: [],
  query: `
; ── @tree-sitter-grammars/tree-sitter-lua@0.4.1 queries/tags.scm, verbatim ──
(function_declaration
  name: [
    (identifier) @name
    (dot_index_expression
      field: (identifier) @name)
  ]) @definition.function

(function_declaration
  name: (method_index_expression
    method: (identifier) @name)) @definition.method

(assignment_statement
  (variable_list
    .
    name: [
      (identifier) @name
      (dot_index_expression
        field: (identifier) @name)
    ])
  (expression_list
    .
    value: (function_definition))) @definition.function

(table_constructor
  (field
    name: (identifier) @name
    value: (function_definition))) @definition.function

(function_call
  name: [
    (identifier) @name
    (dot_index_expression
      field: (identifier) @name)
    (method_index_expression
      method: (identifier) @name)
  ]) @reference.call

; ── imports (this service's captures) ──
; \`require "m"\` and \`require("m")\` both parse with an arguments node.
(function_call
  name: (identifier) @_require
  arguments: (arguments . (string) @import.module .)
  (#eq? @_require "require"))

; Lua has no inheritance syntax.
`,
};
