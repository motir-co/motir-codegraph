/**
 * Dart: `tree-sitter-dart-orchard` 0.7.1, `tree-sitter-dart_orchard.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-dart-orchard@0.7.1; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const dart: LanguageDefinition = {
  id: 'dart',
  d5Name: 'Dart',
  grammarPackage: 'tree-sitter-dart-orchard',
  grammarFile: 'tree-sitter-dart_orchard.wasm',
  grammarVersion: '0.7.1',
  queryRevision: 1,
  extensions: ['.dart'],
  filenames: [],
  query: `
; ── tree-sitter-dart-orchard@0.7.1 queries/tags.scm, verbatim ──

(class_definition
  name: (identifier) @name) @definition.class

(method_signature
  (function_signature)) @definition.method

(type_alias
  (type_identifier) @name) @definition.type

(method_signature
(getter_signature
  name: (identifier) @name)) @definition.method

(method_signature
(setter_signature
  name: (identifier) @name)) @definition.method

(method_signature
  (function_signature
  name: (identifier) @name)) @definition.method

(method_signature
  (factory_constructor_signature
    (identifier) @name)) @definition.method

(method_signature
  (constructor_signature
  name: (identifier) @name)) @definition.method

(method_signature
  (operator_signature)) @definition.method

(method_signature) @definition.method

(mixin_declaration
  (mixin)
  (identifier) @name) @definition.mixin

(extension_declaration
  name: (identifier) @name) @definition.extension


(new_expression
  (type_identifier) @name) @reference.class

(enum_declaration
  name: (identifier) @name) @definition.enum

(function_signature
  name: (identifier) @name) @definition.function

; The uppercase check skips ordinary values like \`var x = y;\`.
((initialized_variable_definition
   name: (identifier)
   value: (identifier) @name)
 (#match? @name "^_?[A-Z]")) @reference.class

(assignment_expression
  left: (assignable_expression
          (unconditional_assignable_selector
            (assignable_operator)
            (identifier) @name .))) @reference.call

(assignment_expression
  left: (assignable_expression
          (conditional_assignable_selector
            (assignable_operator)
            (identifier) @name .))) @reference.call

; Treat \`SomeClass(...)\` as a reference to a class (a constructor call), not an
; ordinary function call.
((method_invocation
  function: (identifier) @name)
 (#match? @name "^_?[A-Z]")) @reference.class

; A \`selector\` now only ever holds an \`argument_part\`; member access, \`!\` and
; type arguments fold their receiver in instead (see the grammar).
((identifier) @name
 (selector
    (argument_part
      (arguments
        (argument)*)))*) @reference.call

; A cascade call section \`obj..method()\` folds into a method_invocation whose
; callee is the cascade_selector.
(method_invocation
  function: (cascade_selector
    (identifier) @name)) @reference.call

; ── imports (this service's captures) ──
(library_import
  (import_specification
    (configurable_uri (uri (string_literal) @import.module))
    (combinator . "show" (identifier) @import.name)))

(library_import
  (import_specification
    (configurable_uri (uri (string_literal) @import.module))))

(library_export
  (configurable_uri (uri (string_literal) @import.module)))

; ── inheritance (this service's captures) ──
; A mixin (\`with\`) is neither relation and is not captured.
(class_definition
  name: (identifier) @name
  superclass: (superclass . [(type_identifier) @inheritance.extends]))

(class_definition
  name: (identifier) @name
  interfaces: (interfaces (type_identifier) @inheritance.implements))
`,
};
