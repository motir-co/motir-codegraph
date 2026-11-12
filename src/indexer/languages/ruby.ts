/**
 * Ruby: `tree-sitter-ruby` 0.23.1, `tree-sitter-ruby.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-ruby@0.23.1; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const ruby: LanguageDefinition = {
  id: 'ruby',
  d5Name: 'Ruby',
  grammarPackage: 'tree-sitter-ruby',
  grammarFile: 'tree-sitter-ruby.wasm',
  grammarVersion: '0.23.1',
  queryRevision: 1,
  extensions: ['.rb', '.rake', '.gemspec', '.ru', '.rbw'],
  filenames: [
    'Gemfile',
    'Rakefile',
    'Guardfile',
    'Capfile',
    'Vagrantfile',
    'Podfile',
    'Fastfile',
    'Brewfile',
    'Dangerfile',
    'Berksfile',
    'Thorfile',
  ],
  query: `
; ── tree-sitter-ruby@0.23.1 queries/tags.scm, verbatim ──
; Method definitions

(
  (comment)* @doc
  .
  [
    (method
      name: (_) @name) @definition.method
    (singleton_method
      name: (_) @name) @definition.method
  ]
  (#strip! @doc "^#\\\\s*")
  (#select-adjacent! @doc @definition.method)
)

(alias
  name: (_) @name) @definition.method

(setter
  (identifier) @ignore)

; Class definitions

(
  (comment)* @doc
  .
  [
    (class
      name: [
        (constant) @name
        (scope_resolution
          name: (_) @name)
      ]) @definition.class
    (singleton_class
      value: [
        (constant) @name
        (scope_resolution
          name: (_) @name)
      ]) @definition.class
  ]
  (#strip! @doc "^#\\\\s*")
  (#select-adjacent! @doc @definition.class)
)

; Module definitions

(
  (module
    name: [
      (constant) @name
      (scope_resolution
        name: (_) @name)
    ]) @definition.module
)

; Calls

(call method: (identifier) @name) @reference.call

(
  [(identifier) (constant)] @name @reference.call
  (#is-not? local)
  (#not-match? @name "^(lambda|load|require|require_relative|__FILE__|__LINE__)$")
)

; ── imports (this service's captures) ──
(call
  method: (identifier) @_require
  arguments: (argument_list . (string) @import.module .)
  (#any-of? @_require "require" "require_relative" "load" "autoload"))

; ── inheritance (this service's captures) ──
; A mixin (\`include\`, \`extend\`, \`prepend\`) is neither relation and is not
; captured.
(class
  name: [(constant) (scope_resolution)] @name
  superclass: (superclass [(constant) (scope_resolution)] @inheritance.extends))
`,
};
