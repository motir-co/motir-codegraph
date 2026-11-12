/**
 * The capture-name vocabulary a tags query is written in, and what each name
 * means to the extractor. One vocabulary for every language: the language
 * registry's query text uses these names, and nothing else reads a capture.
 *
 * Three families:
 * - the code-navigation convention's `@definition.<kind>` and
 *   `@reference.<kind>` on the whole node, with `@name` on its identifier;
 * - imports: one pattern per import statement, `@import.module` on the module
 *   specifier and zero or more `@import.name` on the imported names;
 * - inheritance: `@inheritance.extends` or `@inheritance.implements` on the
 *   parent type node, with `@name` on the inheriting symbol.
 *
 * `@name` means the same thing in every pattern — the name the match is
 * about — and the role capture beside it decides which role that is.
 */

/** The prefix of a definition capture; what follows the dot is its kind. */
export const DEFINITION_PREFIX = 'definition.';
/** The prefix of a reference capture; what follows the dot is its kind. */
export const REFERENCE_PREFIX = 'reference.';
/** The name the match is about. */
export const NAME_CAPTURE = 'name';
/** An import's module specifier. */
export const IMPORT_MODULE_CAPTURE = 'import.module';
/** One name an import brings in. */
export const IMPORT_NAME_CAPTURE = 'import.name';
/** A parent type the `@name` symbol extends. */
export const INHERITANCE_EXTENDS_CAPTURE = 'inheritance.extends';
/** A parent type the `@name` symbol implements. */
export const INHERITANCE_IMPLEMENTS_CAPTURE = 'inheritance.implements';

/** The role a capture plays in its match. */
export type CaptureRole =
  | { readonly role: 'definition'; readonly kind: string }
  | { readonly role: 'reference'; readonly kind: string }
  | { readonly role: 'name' }
  | { readonly role: 'importModule' }
  | { readonly role: 'importName' }
  | { readonly role: 'inheritance'; readonly relation: 'extends' | 'implements' }
  | { readonly role: 'ignored' };

const IGNORED: CaptureRole = { role: 'ignored' };

/**
 * Maps a capture name (without its `@`) to its role. A name outside the
 * vocabulary — including a definition or reference with no kind after the
 * dot — is ignored, so a query may capture more than the extractor reads.
 */
export function parseCaptureName(name: string): CaptureRole {
  switch (name) {
    case NAME_CAPTURE:
      return { role: 'name' };
    case IMPORT_MODULE_CAPTURE:
      return { role: 'importModule' };
    case IMPORT_NAME_CAPTURE:
      return { role: 'importName' };
    case INHERITANCE_EXTENDS_CAPTURE:
      return { role: 'inheritance', relation: 'extends' };
    case INHERITANCE_IMPLEMENTS_CAPTURE:
      return { role: 'inheritance', relation: 'implements' };
  }
  if (name.startsWith(DEFINITION_PREFIX)) {
    const kind = name.slice(DEFINITION_PREFIX.length);
    return kind === '' ? IGNORED : { role: 'definition', kind };
  }
  if (name.startsWith(REFERENCE_PREFIX)) {
    const kind = name.slice(REFERENCE_PREFIX.length);
    return kind === '' ? IGNORED : { role: 'reference', kind };
  }
  return IGNORED;
}
