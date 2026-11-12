/**
 * Java: `tree-sitter-java` 0.23.5, `tree-sitter-java.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-java@0.23.5; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const java: LanguageDefinition = {
  id: 'java',
  d5Name: 'Java',
  grammarPackage: 'tree-sitter-java',
  grammarFile: 'tree-sitter-java.wasm',
  grammarVersion: '0.23.5',
  queryRevision: 1,
  extensions: ['.java'],
  filenames: [],
  query: `
; ── tree-sitter-java@0.23.5 queries/tags.scm, verbatim ──
(class_declaration
  name: (identifier) @name) @definition.class

(method_declaration
  name: (identifier) @name) @definition.method

(method_invocation
  name: (identifier) @name
  arguments: (argument_list) @reference.call)

(interface_declaration
  name: (identifier) @name) @definition.interface

(type_list
  (type_identifier) @name) @reference.implementation

(object_creation_expression
  type: (type_identifier) @name) @reference.class

(superclass (type_identifier) @name) @reference.class

; ── imports (this service's captures) ──
(import_declaration
  (scoped_identifier name: (identifier) @import.name) @import.module .)

(import_declaration
  [(identifier) (scoped_identifier)] @import.module
  (asterisk))

; ── inheritance (this service's captures) ──
(class_declaration
  name: (identifier) @name
  superclass: (superclass
    [
      (type_identifier) @inheritance.extends
      (scoped_type_identifier) @inheritance.extends
      (generic_type [(type_identifier) (scoped_type_identifier)] @inheritance.extends)
    ]))

(class_declaration
  name: (identifier) @name
  interfaces: (super_interfaces
    (type_list
      [
        (type_identifier) @inheritance.implements
        (scoped_type_identifier) @inheritance.implements
        (generic_type [(type_identifier) (scoped_type_identifier)] @inheritance.implements)
      ])))

(enum_declaration
  name: (identifier) @name
  interfaces: (super_interfaces
    (type_list
      [
        (type_identifier) @inheritance.implements
        (scoped_type_identifier) @inheritance.implements
        (generic_type [(type_identifier) (scoped_type_identifier)] @inheritance.implements)
      ])))

(record_declaration
  name: (identifier) @name
  interfaces: (super_interfaces
    (type_list
      [
        (type_identifier) @inheritance.implements
        (scoped_type_identifier) @inheritance.implements
        (generic_type [(type_identifier) (scoped_type_identifier)] @inheritance.implements)
      ])))

(interface_declaration
  name: (identifier) @name
  (extends_interfaces
    (type_list
      [
        (type_identifier) @inheritance.extends
        (scoped_type_identifier) @inheritance.extends
        (generic_type [(type_identifier) (scoped_type_identifier)] @inheritance.extends)
      ])))
`,
};
