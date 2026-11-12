import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A section of a Markdown file: from its `## <title>` heading to the next. */
export function markdownSection(path: string, title: RegExp): string {
  const text = readFileSync(`${ROOT}${path}`, 'utf8');
  const sections = text.split(/^(?=## )/m);
  const section = sections.find((part) => title.test(part.split('\n', 1)[0] ?? ''));
  if (section === undefined) {
    throw new Error(`${path} has no section matching ${String(title)}`);
  }
  return section;
}

/**
 * The refusal code table of `docs/api-contract.md` §5, as `{ code: status }`:
 * every row of the form `` | `code` | 400 | … ``.
 */
export function documentedErrorCodes(): Record<string, number> {
  const section = markdownSection('docs/api-contract.md', /^## 5\. /);
  const codes: Record<string, number> = {};
  for (const match of section.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*(\d{3})\s*\|/gm)) {
    codes[match[1] as string] = Number(match[2]);
  }
  return codes;
}
