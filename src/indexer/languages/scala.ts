/**
 * Scala: `tree-sitter-scala` 0.24.0, `tree-sitter-scala.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-scala@0.24.0; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const scala: LanguageDefinition = {
  id: 'scala',
  d5Name: 'Scala',
  grammarPackage: 'tree-sitter-scala',
  grammarFile: 'tree-sitter-scala.wasm',
  grammarVersion: '0.24.0',
  queryRevision: 1,
  extensions: ['.scala', '.sc'],
  filenames: [],
  query: `
; ── tree-sitter-scala@0.24.0 queries/tags.scm, verbatim ──
; Definitions

(package_clause
  name: (package_identifier) @name) @definition.module

(trait_definition
  name: (identifier) @name) @definition.interface

(enum_definition
  name: (identifier) @name) @definition.enum

(simple_enum_case
  name: (identifier) @name) @definition.class

(full_enum_case
  name: (identifier) @name) @definition.class

(class_definition
  name: (identifier) @name) @definition.class

(object_definition
  name: (identifier) @name) @definition.object

(function_definition
  name: (identifier) @name) @definition.function

(val_definition
  pattern: (identifier) @name) @definition.variable

(given_definition
  name: (identifier) @name) @definition.variable

(var_definition
  pattern: (identifier) @name) @definition.variable

(val_declaration
  name: (identifier) @name) @definition.variable

(var_declaration
  name: (identifier) @name) @definition.variable

(type_definition
  name: (type_identifier) @name) @definition.type

(class_parameter
  name: (identifier) @name) @definition.property

; References 

(call_expression
  (identifier) @name) @reference.call

(instance_expression
  (type_identifier) @name) @reference.interface

(instance_expression
  (generic_type
    (type_identifier) @name)) @reference.interface

(extends_clause
  (type_identifier) @name) @reference.class

(extends_clause
  (generic_type
    (type_identifier) @name)) @reference.class

; ── imports (this service's captures) ──
; A path is several identifiers; the extractor anchors a match's module
; captures at their whole span, so \`a.b.C\` is one specifier.
(import_declaration
  .
  ((identifier) @import.module "."?)*
  (identifier) @import.module @import.name
  .)

(import_declaration
  .
  ((identifier) @import.module "."?)+
  (namespace_selectors
    [
      (identifier) @import.name
      (arrow_renamed_identifier name: (_) @import.name)
      (as_renamed_identifier name: (_) @import.name)
    ]))

(import_declaration
  .
  ((identifier) @import.module "."?)+
  (namespace_wildcard))

; ── inheritance (this service's captures) ──
; The first type is the superclass (or first trait); every later one is mixed in.
(class_definition
  name: (_) @name
  extend: (extends_clause
    .
    type: [
      (type_identifier) @inheritance.extends
      (stable_type_identifier) @inheritance.extends
      (generic_type type: (_) @inheritance.extends)
    ]))

(trait_definition
  name: (_) @name
  extend: (extends_clause
    .
    type: [
      (type_identifier) @inheritance.extends
      (stable_type_identifier) @inheritance.extends
      (generic_type type: (_) @inheritance.extends)
    ]))

(object_definition
  name: (_) @name
  extend: (extends_clause
    .
    type: [
      (type_identifier) @inheritance.extends
      (stable_type_identifier) @inheritance.extends
      (generic_type type: (_) @inheritance.extends)
    ]))

(enum_definition
  name: (_) @name
  extend: (extends_clause
    .
    type: [
      (type_identifier) @inheritance.extends
      (stable_type_identifier) @inheritance.extends
      (generic_type type: (_) @inheritance.extends)
    ]))

(class_definition
  name: (_) @name
  extend: (extends_clause
    (_)
    [
      (type_identifier) @inheritance.implements
      (stable_type_identifier) @inheritance.implements
      (generic_type type: (_) @inheritance.implements)
    ]))

(trait_definition
  name: (_) @name
  extend: (extends_clause
    (_)
    [
      (type_identifier) @inheritance.implements
      (stable_type_identifier) @inheritance.implements
      (generic_type type: (_) @inheritance.implements)
    ]))

(object_definition
  name: (_) @name
  extend: (extends_clause
    (_)
    [
      (type_identifier) @inheritance.implements
      (stable_type_identifier) @inheritance.implements
      (generic_type type: (_) @inheritance.implements)
    ]))

(enum_definition
  name: (_) @name
  extend: (extends_clause
    (_)
    [
      (type_identifier) @inheritance.implements
      (stable_type_identifier) @inheritance.implements
      (generic_type type: (_) @inheritance.implements)
    ]))
`,
};
