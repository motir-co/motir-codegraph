/**
 * The single derivation of a language's extractor version.
 *
 * The version is an identity, not an ordering: a blob is stale when its
 * recorded version differs from the language's current one, so nothing ever
 * compares two versions by magnitude. The result is `<grammar>/q<query>`: it
 * changes whenever either input changes, equals neither alone, and — because
 * the grammar version may not contain `/` — two different pairs can never
 * compose to the same string.
 */
export function composeExtractorVersion(grammarVersion: string, queryVersion: string): string {
  if (grammarVersion.trim() === '' || queryVersion.trim() === '') {
    throw new Error('A grammar version and a query version are both required.');
  }
  if (grammarVersion.includes('/')) {
    throw new Error(`A grammar version may not contain "/": ${grammarVersion}`);
  }
  return `${grammarVersion}/q${queryVersion}`;
}
