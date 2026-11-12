/**
 * Elixir: `tree-sitter-elixir` 0.3.5, `tree-sitter-elixir.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-elixir@0.3.5; Apache-2.0), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const elixir: LanguageDefinition = {
  id: 'elixir',
  d5Name: 'Elixir',
  grammarPackage: 'tree-sitter-elixir',
  grammarFile: 'tree-sitter-elixir.wasm',
  grammarVersion: '0.3.5',
  queryRevision: 1,
  extensions: ['.ex', '.exs'],
  filenames: [],
  query: `
; ── tree-sitter-elixir@0.3.5 queries/tags.scm, verbatim ──
; Definitions

; * modules and protocols
(call
  target: (identifier) @ignore
  (arguments (alias) @name)
  (#any-of? @ignore "defmodule" "defprotocol")) @definition.module

; * functions/macros
(call
  target: (identifier) @ignore
  (arguments
    [
      ; zero-arity functions with no parentheses
      (identifier) @name
      ; regular function clause
      (call target: (identifier) @name)
      ; function clause with a guard clause
      (binary_operator
        left: (call target: (identifier) @name)
        operator: "when")
    ])
  (#any-of? @ignore "def" "defp" "defdelegate" "defguard" "defguardp" "defmacro" "defmacrop" "defn" "defnp")) @definition.function

; References

; ignore calls to kernel/special-forms keywords
(call
  target: (identifier) @ignore
  (#any-of? @ignore "def" "defp" "defdelegate" "defguard" "defguardp" "defmacro" "defmacrop" "defn" "defnp" "defmodule" "defprotocol" "defimpl" "defstruct" "defexception" "defoverridable" "alias" "case" "cond" "else" "for" "if" "import" "quote" "raise" "receive" "require" "reraise" "super" "throw" "try" "unless" "unquote" "unquote_splicing" "use" "with"))

; ignore module attributes
(unary_operator
  operator: "@"
  operand: (call
    target: (identifier) @ignore))

; * function call
(call
  target: [
   ; local
   (identifier) @name
   ; remote
   (dot
     right: (identifier) @name)
  ]) @reference.call

; * pipe into function call
(binary_operator
  operator: "|>"
  right: (identifier) @name) @reference.call

; * modules
(alias) @name @reference.module

; ── imports (this service's captures) ──
(call
  target: (identifier) @_directive
  (arguments . (alias) @import.module)
  (#any-of? @_directive "alias" "import" "require" "use"))

; ── inheritance (this service's captures) ──
; A module adopting a behaviour implements it.
(call
  target: (identifier) @_defmodule
  (arguments . (alias) @name)
  (do_block
    (unary_operator
      operator: "@"
      operand: (call
        target: (identifier) @_behaviour
        (arguments . (alias) @inheritance.implements))))
  (#eq? @_defmodule "defmodule")
  (#eq? @_behaviour "behaviour"))
`,
};
