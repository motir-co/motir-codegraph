/**
 * Python: `tree-sitter-python` 0.25.0, `tree-sitter-python.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-python@0.25.0; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const python: LanguageDefinition = {
  id: 'python',
  d5Name: 'Python',
  grammarPackage: 'tree-sitter-python',
  grammarFile: 'tree-sitter-python.wasm',
  grammarVersion: '0.25.0',
  queryRevision: 1,
  extensions: ['.py', '.pyi'],
  filenames: [],
  query: `
; ── tree-sitter-python@0.25.0 queries/tags.scm, verbatim ──
(module (expression_statement (assignment left: (identifier) @name) @definition.constant))

(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(call
  function: [
      (identifier) @name
      (attribute
        attribute: (identifier) @name)
  ]) @reference.call

; ── imports (this service's captures) ──
(import_statement name: (dotted_name) @import.module)

(import_statement name: (aliased_import name: (dotted_name) @import.module))

(import_from_statement
  module_name: (_) @import.module
  name: [
    (dotted_name) @import.name
    (aliased_import name: (dotted_name) @import.name)
  ])

(import_from_statement
  module_name: (_) @import.module
  (wildcard_import))

; ── inheritance (this service's captures) ──
(class_definition
  name: (identifier) @name
  superclasses: (argument_list [(identifier) (attribute)] @inheritance.extends))
`,
};
