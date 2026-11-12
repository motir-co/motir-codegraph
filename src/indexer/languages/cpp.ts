/**
 * C++: `tree-sitter-cpp` 0.23.4, `tree-sitter-cpp.wasm`.
 *
 * Its tags query is the grammar's own `queries/tags.scm`, copied verbatim
 * (tree-sitter-cpp@0.23.4; MIT), followed by this service's import and inheritance captures.
 * Bump `queryRevision` whenever the query text changes, and `grammarVersion`
 * with the pin in package.json: either moves this language's extractor version
 * and re-extracts its blobs, and no other language's.
 */
import type { LanguageDefinition } from '../registry.js';

export const cpp: LanguageDefinition = {
  id: 'cpp',
  d5Name: 'C++',
  grammarPackage: 'tree-sitter-cpp',
  grammarFile: 'tree-sitter-cpp.wasm',
  grammarVersion: '0.23.4',
  queryRevision: 1,
  extensions: [
    '.h',
    '.cc',
    '.cpp',
    '.cxx',
    '.c++',
    '.hh',
    '.hpp',
    '.hxx',
    '.h++',
    '.ipp',
    '.tpp',
    '.inl',
  ],
  filenames: [],
  query: `
; ── tree-sitter-cpp@0.23.4 queries/tags.scm, verbatim ──
(struct_specifier name: (type_identifier) @name body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class

(function_declarator declarator: (identifier) @name) @definition.function

(function_declarator declarator: (field_identifier) @name) @definition.function

(function_declarator declarator: (qualified_identifier scope: (namespace_identifier) @local.scope name: (identifier) @name)) @definition.method

(type_definition declarator: (type_identifier) @name) @definition.type

(enum_specifier name: (type_identifier) @name) @definition.type

(class_specifier name: (type_identifier) @name) @definition.class

; ── imports (this service's captures) ──
(preproc_include path: (_) @import.module)

; ── inheritance (this service's captures) ──
(class_specifier
  name: (_) @name
  (base_class_clause
    [
      (type_identifier) @inheritance.extends
      (qualified_identifier) @inheritance.extends
      (template_type name: (_) @inheritance.extends)
    ]))

(struct_specifier
  name: (_) @name
  (base_class_clause
    [
      (type_identifier) @inheritance.extends
      (qualified_identifier) @inheritance.extends
      (template_type name: (_) @inheritance.extends)
    ]))
`,
};
