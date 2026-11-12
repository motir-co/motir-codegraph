/**
 * PHP: `tree-sitter-php` 0.24.2, `tree-sitter-php.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-php@0.24.2; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const php: LanguageDefinition = {
  id: 'php',
  d5Name: 'PHP',
  grammarPackage: 'tree-sitter-php',
  grammarFile: 'tree-sitter-php.wasm',
  grammarVersion: '0.24.2',
  queryRevision: 1,
  extensions: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php7', '.phps'],
  filenames: [],
  query: `
; ── tree-sitter-php@0.24.2 queries/tags.scm, verbatim ──
(namespace_definition
  name: (namespace_name) @name) @definition.module

(interface_declaration
  name: (name) @name) @definition.interface

(trait_declaration
  name: (name) @name) @definition.interface

(class_declaration
  name: (name) @name) @definition.class

(class_interface_clause [(name) (qualified_name)] @name) @reference.implementation

(property_declaration
  (property_element (variable_name (name) @name))) @definition.field

(function_definition
  name: (name) @name) @definition.function

(method_declaration
  name: (name) @name) @definition.function

(object_creation_expression
  [
    (qualified_name (name) @name)
    (variable_name (name) @name)
  ]) @reference.class

(function_call_expression
  function: [
    (qualified_name (name) @name)
    (variable_name (name)) @name
  ]) @reference.call

(scoped_call_expression
  name: (name) @name) @reference.call

(member_call_expression
  name: (name) @name) @reference.call

; ── imports (this service's captures) ──
(namespace_use_declaration
  (namespace_use_clause
    [
      (qualified_name (name) @import.name .) @import.module
      (name) @import.module @import.name
    ]))

(namespace_use_declaration
  (namespace_name) @import.module
  body: (namespace_use_group
    (namespace_use_clause
      .
      [
        (name) @import.name
        (qualified_name) @import.name
      ])))

(require_expression
  (string) @import.module)

(require_once_expression
  (string) @import.module)

(include_expression
  (string) @import.module)

(include_once_expression
  (string) @import.module)

; ── inheritance (this service's captures) ──
(class_declaration
  name: (name) @name
  (base_clause [(name) (qualified_name)] @inheritance.extends))

(class_declaration
  name: (name) @name
  (class_interface_clause [(name) (qualified_name)] @inheritance.implements))

(enum_declaration
  name: (name) @name
  (class_interface_clause [(name) (qualified_name)] @inheritance.implements))

(interface_declaration
  name: (name) @name
  (base_clause [(name) (qualified_name)] @inheritance.extends))
`,
};
