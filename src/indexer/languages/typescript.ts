/**
 * TypeScript: `tree-sitter-typescript` 0.23.2, `tree-sitter-typescript.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-javascript@0.25.0, tree-sitter-typescript@0.23.2; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const typescript: LanguageDefinition = {
  id: 'typescript',
  d5Name: 'TypeScript',
  grammarPackage: 'tree-sitter-typescript',
  grammarFile: 'tree-sitter-typescript.wasm',
  grammarVersion: '0.23.2',
  queryRevision: 1,
  extensions: ['.ts', '.mts', '.cts'],
  filenames: [],
  query: `
; ── tree-sitter-javascript@0.25.0 queries/tags.scm, verbatim ──
(
  (comment)* @doc
  .
  (method_definition
    name: (property_identifier) @name) @definition.method
  (#not-eq? @name "constructor")
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  [
    (class
      name: (_) @name)
    (class_declaration
      name: (_) @name)
  ] @definition.class
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  [
    (function_expression
      name: (identifier) @name)
    (function_declaration
      name: (identifier) @name)
    (generator_function
      name: (identifier) @name)
    (generator_function_declaration
      name: (identifier) @name)
  ] @definition.function
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(assignment_expression
  left: [
    (identifier) @name
    (member_expression
      property: (property_identifier) @name)
  ]
  right: [(arrow_function) (function_expression)]
) @definition.function

(pair
  key: (property_identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function

(
  (call_expression
    function: (identifier) @name) @reference.call
  (#not-match? @name "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name)
  arguments: (_) @reference.call)

(new_expression
  constructor: (_) @name) @reference.class

(export_statement value: (assignment_expression left: (identifier) @name right: ([
 (number)
 (string)
 (identifier)
 (undefined)
 (null)
 (new_expression)
 (binary_expression)
 (call_expression)
]))) @definition.constant

; ── tree-sitter-typescript@0.23.2 queries/tags.scm, verbatim ──
(function_signature
  name: (identifier) @name) @definition.function

(method_signature
  name: (property_identifier) @name) @definition.method

(abstract_method_signature
  name: (property_identifier) @name) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(module
  name: (identifier) @name) @definition.module

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_annotation
  (type_identifier) @name) @reference.type

(new_expression
  constructor: (identifier) @name) @reference.class

; ── imports (this service's captures) ──
(import_statement
  (import_clause
    [
      (identifier) @import.name
      (named_imports (import_specifier name: (_) @import.name))
    ])
  source: (string) @import.module)

(import_statement
  source: (string) @import.module)

(export_statement
  source: (string) @import.module)

(call_expression
  function: (identifier) @_require
  arguments: (arguments . (string) @import.module .)
  (#eq? @_require "require"))

(call_expression
  function: (import)
  arguments: (arguments . (string) @import.module))

; ── inheritance (this service's captures) ──
(class_declaration
  name: (type_identifier) @name
  (class_heritage
    (extends_clause value: [(identifier) (member_expression)] @inheritance.extends)))

(abstract_class_declaration
  name: (type_identifier) @name
  (class_heritage
    (extends_clause value: [(identifier) (member_expression)] @inheritance.extends)))

(class_declaration
  name: (type_identifier) @name
  (class_heritage
    (implements_clause
      [
        (type_identifier) @inheritance.implements
        (nested_type_identifier) @inheritance.implements
        (generic_type name: (_) @inheritance.implements)
      ])))

(abstract_class_declaration
  name: (type_identifier) @name
  (class_heritage
    (implements_clause
      [
        (type_identifier) @inheritance.implements
        (nested_type_identifier) @inheritance.implements
        (generic_type name: (_) @inheritance.implements)
      ])))

(interface_declaration
  name: (type_identifier) @name
  (extends_type_clause
    type: [
      (type_identifier) @inheritance.extends
      (nested_type_identifier) @inheritance.extends
      (generic_type name: (_) @inheritance.extends)
    ]))
`,
};
