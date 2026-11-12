/**
 * Solidity: `tree-sitter-solidity` 1.2.13, `tree-sitter-solidity.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-solidity@1.2.13; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const solidity: LanguageDefinition = {
  id: 'solidity',
  d5Name: 'Solidity',
  grammarPackage: 'tree-sitter-solidity',
  grammarFile: 'tree-sitter-solidity.wasm',
  grammarVersion: '1.2.13',
  queryRevision: 1,
  extensions: ['.sol'],
  filenames: [],
  query: `
; ── tree-sitter-solidity@1.2.13 queries/tags.scm, verbatim ──
;; Method and Function declarations
(contract_declaration (_
    (function_definition
        name: (identifier) @name) @definition.method))

(source_file
    (function_definition
        name: (identifier) @name) @definition.function)

;; Contract, struct, enum and interface declarations
(contract_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(library_declaration
  name: (identifier) @name) @definition.interface

(struct_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.class
(event_definition name: (identifier) @name) @definition.class

;; Function calls
(call_expression (expression (identifier)) @name ) @reference.call

(call_expression
    (expression (member_expression
        property: (_) @name ))) @reference.call

;; Log emit
(emit_statement name: (_) @name) @reference.class


;; Inheritance

(inheritance_specifier
    ancestor: (user_defined_type (_) @name . )) @reference.class


;; Imports ( note that unknown is not standardised )
(import_directive
  import_name: (_) @name ) @reference.unknown

; ── imports (this service's captures) ──
(import_directive
  import_name: (identifier) @import.name
  source: (string) @import.module)

(import_directive source: (string) @import.module)

; ── inheritance (this service's captures) ──
; \`is\` lists every base contract or interface; Solidity calls all of it
; inheritance, so each is extended.
(contract_declaration
  name: (identifier) @name
  (inheritance_specifier
    ancestor: (user_defined_type) @inheritance.extends))

(interface_declaration
  name: (identifier) @name
  (inheritance_specifier
    ancestor: (user_defined_type) @inheritance.extends))
`,
};
