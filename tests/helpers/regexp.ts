/** `text` as a regular-expression source that matches it literally, every metacharacter escaped. */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}
