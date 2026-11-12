/**
 * Rust: `tree-sitter-rust` 0.24.0, `tree-sitter-rust.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-rust@0.24.0; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const rust: LanguageDefinition = {
  id: 'rust',
  d5Name: 'Rust',
  grammarPackage: 'tree-sitter-rust',
  grammarFile: 'tree-sitter-rust.wasm',
  grammarVersion: '0.24.0',
  queryRevision: 1,
  extensions: ['.rs'],
  filenames: [],
  query: `
; ── tree-sitter-rust@0.24.0 queries/tags.scm, verbatim ──
; ADT definitions

(struct_item
    name: (type_identifier) @name) @definition.class

(enum_item
    name: (type_identifier) @name) @definition.class

(union_item
    name: (type_identifier) @name) @definition.class

; type aliases

(type_item
    name: (type_identifier) @name) @definition.class

; method definitions

(declaration_list
    (function_item
        name: (identifier) @name) @definition.method)

; function definitions

(function_item
    name: (identifier) @name) @definition.function

; trait definitions
(trait_item
    name: (type_identifier) @name) @definition.interface

; module definitions
(mod_item
    name: (identifier) @name) @definition.module

; macro definitions

(macro_definition
    name: (identifier) @name) @definition.macro

; references

(call_expression
    function: (identifier) @name) @reference.call

(call_expression
    function: (field_expression
        field: (field_identifier) @name)) @reference.call

(macro_invocation
    macro: (identifier) @name) @reference.call

; implementations

(impl_item
    trait: (type_identifier) @name) @reference.implementation

(impl_item
    type: (type_identifier) @name
    !trait) @reference.implementation

; ── imports (this service's captures) ──
(use_declaration
  argument: [(identifier) (crate) (self) (super)] @import.module)

(use_declaration
  argument: (scoped_identifier name: (_) @import.name) @import.module)

(use_declaration
  argument: (use_as_clause
    path: [
      (identifier) @import.module
      (scoped_identifier name: (_) @import.name) @import.module
    ]))

(use_declaration
  argument: (scoped_use_list
    path: (_) @import.module
    list: (use_list
      [
        (identifier) @import.name
        (scoped_identifier) @import.name
        (use_as_clause path: (_) @import.name)
      ])))

(use_declaration
  argument: (use_wildcard . (_) @import.module))

(extern_crate_declaration name: (identifier) @import.module)

; ── inheritance (this service's captures) ──
; A supertrait is extended; a trait implemented for a type is implemented.
(trait_item
  name: (type_identifier) @name
  bounds: (trait_bounds
    [
      (type_identifier) @inheritance.extends
      (scoped_type_identifier) @inheritance.extends
      (generic_type type: (_) @inheritance.extends)
    ]))

(impl_item
  trait: [
    (type_identifier) @inheritance.implements
    (scoped_type_identifier) @inheritance.implements
    (generic_type type: (_) @inheritance.implements)
  ]
  type: [
    (type_identifier) @name
    (scoped_type_identifier name: (_) @name)
    (generic_type type: (_) @name)
  ])
`,
};
