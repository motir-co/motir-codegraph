/**
 * Go: `tree-sitter-go` 0.25.0, `tree-sitter-go.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-go@0.25.0; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const go: LanguageDefinition = {
  id: 'go',
  d5Name: 'Go',
  grammarPackage: 'tree-sitter-go',
  grammarFile: 'tree-sitter-go.wasm',
  grammarVersion: '0.25.0',
  queryRevision: 1,
  extensions: ['.go'],
  filenames: [],
  query: `
; ── tree-sitter-go@0.25.0 queries/tags.scm, verbatim ──
(
  (comment)* @doc
  .
  (function_declaration
    name: (identifier) @name) @definition.function
  (#strip! @doc "^//\\\\s*")
  (#set-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (method_declaration
    name: (field_identifier) @name) @definition.method
  (#strip! @doc "^//\\\\s*")
  (#set-adjacent! @doc @definition.method)
)

(call_expression
  function: [
    (identifier) @name
    (parenthesized_expression (identifier) @name)
    (selector_expression field: (field_identifier) @name)
    (parenthesized_expression (selector_expression field: (field_identifier) @name))
  ]) @reference.call

(type_spec
  name: (type_identifier) @name) @definition.type

(type_identifier) @name @reference.type

(package_clause "package" (package_identifier) @name)

(type_declaration (type_spec name: (type_identifier) @name type: (interface_type)))

(type_declaration (type_spec name: (type_identifier) @name type: (struct_type)))

(import_declaration (import_spec) @name)

(var_declaration (var_spec name: (identifier) @name))

(const_declaration (const_spec name: (identifier) @name))

; ── imports (this service's captures) ──
(import_spec path: (_) @import.module)

; ── inheritance (this service's captures) ──
; An interface embedding another interface extends it. A struct embedding a
; type is composition, not inheritance, and is not captured.
(type_spec
  name: (type_identifier) @name
  type: (interface_type
    (type_elem
      [(type_identifier) (qualified_type)] @inheritance.extends .)))
`,
};
