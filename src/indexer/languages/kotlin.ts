/**
 * Kotlin: `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0, `tree-sitter-kotlin.wasm`.
 *
 * The grammar ships no tags query, so the whole query is this service's own.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const kotlin: LanguageDefinition = {
  id: 'kotlin',
  d5Name: 'Kotlin',
  grammarPackage: '@tree-sitter-grammars/tree-sitter-kotlin',
  grammarFile: 'tree-sitter-kotlin.wasm',
  grammarVersion: '1.1.0',
  queryRevision: 1,
  extensions: ['.kt', '.kts'],
  filenames: [],
  query: `
; The grammar ships no tags query, so the definitions and references here are
; this service's own, written in the code-navigation convention.

; ── definitions ──
(class_declaration
  "interface"
  name: (identifier) @name) @definition.interface

(class_declaration
  "class"
  name: (identifier) @name) @definition.class

(object_declaration
  name: (identifier) @name) @definition.object

(class_body
  (function_declaration
    name: (identifier) @name) @definition.method)

(source_file
  (function_declaration
    name: (identifier) @name) @definition.function)

(type_alias
  type: (identifier) @name) @definition.type

; ── references ──
(call_expression
  . (identifier) @name) @reference.call

(call_expression
  . (navigation_expression
    (identifier) @name .)) @reference.call

(user_type
  . (identifier) @name) @reference.type

; ── imports (this service's captures) ──
; \`import a.b.*\` has no named node for its \`*\`, so the wildcard is told
; apart by the statement's text.
((import
  (qualified_identifier
    (identifier) @import.name .) @import.module
  .) @_import
  (#not-match? @_import "\\\\*\\\\s*$"))

((import
  (qualified_identifier) @import.module
  .) @_import
  (#match? @_import "\\\\*\\\\s*$"))

(import
  (qualified_identifier
    (identifier) @import.name .) @import.module
  (identifier))

; ── inheritance (this service's captures) ──
; A supertype called as a constructor is the superclass; a bare one is an
; interface, except that an interface's supertypes are interfaces it extends.
(class_declaration
  "class"
  name: (identifier) @name
  (delegation_specifiers
    (delegation_specifier
      (constructor_invocation
        (user_type . (identifier) @inheritance.extends)))))

(class_declaration "class"
  name: (identifier) @name
  (delegation_specifiers
    (delegation_specifier
      (user_type . (identifier) @inheritance.implements))))

(object_declaration
  name: (identifier) @name
  (delegation_specifiers
    (delegation_specifier
      (user_type . (identifier) @inheritance.implements))))

(object_declaration
  name: (identifier) @name
  (delegation_specifiers
    (delegation_specifier
      (constructor_invocation
        (user_type . (identifier) @inheritance.extends)))))

(class_declaration
  "interface"
  name: (identifier) @name
  (delegation_specifiers
    (delegation_specifier
      (user_type . (identifier) @inheritance.extends))))
`,
};
