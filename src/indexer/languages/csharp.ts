/**
 * C#: `tree-sitter-c-sharp` 0.23.5, `tree-sitter-c_sharp.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-c-sharp@0.23.5; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const csharp: LanguageDefinition = {
  id: 'csharp',
  d5Name: 'C#',
  grammarPackage: 'tree-sitter-c-sharp',
  grammarFile: 'tree-sitter-c_sharp.wasm',
  grammarVersion: '0.23.5',
  queryRevision: 1,
  extensions: ['.cs', '.csx'],
  filenames: [],
  query: `
; ── tree-sitter-c-sharp@0.23.5 queries/tags.scm, verbatim ──
(class_declaration name: (identifier) @name) @definition.class

(class_declaration (base_list (_) @name)) @reference.class

(interface_declaration name: (identifier) @name) @definition.interface

(interface_declaration (base_list (_) @name)) @reference.interface

(method_declaration name: (identifier) @name) @definition.method

(object_creation_expression type: (identifier) @name) @reference.class

(type_parameter_constraints_clause (identifier) @name) @reference.class

(type_parameter_constraint (type type: (identifier) @name)) @reference.class

(variable_declaration type: (identifier) @name) @reference.class

(invocation_expression function: (member_access_expression name: (identifier) @name)) @reference.send

(namespace_declaration name: (identifier) @name) @definition.module

(namespace_declaration name: (identifier) @name) @module

; ── imports (this service's captures) ──
(using_directive [(identifier) (qualified_name)] @import.module .)

; ── inheritance (this service's captures) ──
; C# lists a base class, if any, first, so a class's first base reads as
; extends and every later one as implements. The grammar cannot tell a first
; interface from a base class, so a class implementing only interfaces
; records its first one as extends. A struct or record struct only implements;
; an interface extends.
(class_declaration
  name: (identifier) @name
  (base_list
    .
    [
      (identifier) @inheritance.extends
      (qualified_name) @inheritance.extends
      (generic_name (identifier) @inheritance.extends)
      (primary_constructor_base_type type: (_) @inheritance.extends)
    ]))

(record_declaration
  name: (identifier) @name
  (base_list
    .
    [
      (identifier) @inheritance.extends
      (qualified_name) @inheritance.extends
      (generic_name (identifier) @inheritance.extends)
      (primary_constructor_base_type type: (_) @inheritance.extends)
    ]))

(class_declaration
  name: (identifier) @name
  (base_list
    (_)
    [
      (identifier) @inheritance.implements
      (qualified_name) @inheritance.implements
      (generic_name (identifier) @inheritance.implements)
    ]))

(record_declaration
  name: (identifier) @name
  (base_list
    (_)
    [
      (identifier) @inheritance.implements
      (qualified_name) @inheritance.implements
      (generic_name (identifier) @inheritance.implements)
    ]))

(struct_declaration
  name: (identifier) @name
  (base_list
    [
      (identifier) @inheritance.implements
      (qualified_name) @inheritance.implements
      (generic_name (identifier) @inheritance.implements)
    ]))

(interface_declaration
  name: (identifier) @name
  (base_list
    [
      (identifier) @inheritance.extends
      (qualified_name) @inheritance.extends
      (generic_name (identifier) @inheritance.extends)
    ]))
`,
};
