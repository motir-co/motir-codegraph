/**
 * Haskell: `tree-sitter-haskell` 0.23.1, `tree-sitter-haskell.wasm`.
 *
 * The grammar ships no tags query, so the whole query is this service's own.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const haskell: LanguageDefinition = {
  id: 'haskell',
  d5Name: 'Haskell',
  grammarPackage: 'tree-sitter-haskell',
  grammarFile: 'tree-sitter-haskell.wasm',
  grammarVersion: '0.23.1',
  queryRevision: 1,
  extensions: ['.hs', '.lhs'],
  filenames: [],
  query: `
; The grammar ships no tags query, so the definitions and references here are
; this service's own, written in the code-navigation convention.

; ── definitions ──
(header module: (module) @name) @definition.module

(declarations (function name: (variable) @name) @definition.function)
(declarations (bind name: (variable) @name) @definition.function)
(declarations (signature name: (variable) @name) @definition.function)

(declarations (data_type name: (name) @name) @definition.type)
(declarations (newtype name: (name) @name) @definition.type)
(declarations (type_synomym name: (name) @name) @definition.type)
(declarations (type_family name: (name) @name) @definition.type)

(declarations (class name: (name) @name) @definition.interface)
(class_declarations (signature name: (variable) @name) @definition.method)

(data_constructor constructor: (prefix name: (constructor) @name) @definition.constructor)
(data_constructor constructor: (record name: (constructor) @name) @definition.constructor)

; ── references ──
(apply function: (variable) @name) @reference.call
(apply function: (qualified (variable) @name)) @reference.call

; ── imports (this service's captures) ──
(import
  module: (module) @import.module
  names: (import_list
    name: (import_name [(variable) (name) (constructor)] @import.name)))

(import module: (module) @import.module)

; ── inheritance (this service's captures) ──
; A class's superclass constraints are what it extends; an instance is a type
; implementing a class.
(class
  context: (context context: (apply constructor: (name) @inheritance.extends))
  name: (name) @name)

(class
  context: (context context: (tuple (apply constructor: (name) @inheritance.extends)))
  name: (name) @name)

(instance
  name: (name) @inheritance.implements
  patterns: (type_patterns . (name) @name))
`,
};
