/**
 * A test double: a TypeScript tags query covering every capture family the
 * extractor reads — a class and a method definition, a call reference, a named
 * import and class inheritance. It is not the production query for the
 * language; the language registry ships that.
 */
export const TYPESCRIPT_TAGS_QUERY = `
; definitions
(class_declaration
  name: (type_identifier) @name) @definition.class

(method_definition
  name: (property_identifier) @name) @definition.method

; references
(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.call

; imports: one match per statement
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.name)+))
  source: (string) @import.module)

(import_statement
  (import_clause
    (identifier) @import.name)
  source: (string) @import.module)

; inheritance: the relation rides on the parent type's own capture
(class_declaration
  name: (type_identifier) @name
  (class_heritage
    (extends_clause
      value: (identifier) @inheritance.extends)))

(class_declaration
  name: (type_identifier) @name
  (class_heritage
    (implements_clause
      (type_identifier) @inheritance.implements)))
`;
