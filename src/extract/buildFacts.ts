/**
 * The pure mapper from a parse's projected matches to the fact list: role
 * dispatch, the enclosing-definition pass, range conversion, de-duplication,
 * ordering and stamping. It touches no runtime, no grammar and no database, so
 * it is tested over hand-built matches.
 */
import { parseCaptureName } from './captures.js';
import type { ProjectedCapture, ProjectedMatch, RuntimePoint } from './runtime.js';
import { TREE_SITTER_PRODUCER } from './types.js';
import type { Fact, FactKind, InheritanceRelation, LanguageEntry, SourceRange } from './types.js';

/** What a fact is before the stamp and the enclosing name are added. */
type Draft =
  | { readonly kind: 'definition'; readonly name: string; readonly definitionKind: string }
  | { readonly kind: 'reference'; readonly name: string; readonly referenceKind: string }
  | {
      readonly kind: 'import';
      readonly moduleSpecifier: string;
      readonly importedNames: readonly string[];
    }
  | {
      readonly kind: 'inheritance';
      readonly name: string;
      readonly parentName: string;
      readonly relation: InheritanceRelation;
    };

interface Located {
  readonly draft: Draft;
  /** The node the fact is anchored at. */
  readonly node: ProjectedCapture;
}

/** The runtime's 0-based point, as a 1-based position. The one conversion. */
function toPosition(point: RuntimePoint): { line: number; column: number } {
  return { line: point.row + 1, column: point.column + 1 };
}

/** A captured node's span, 1-based with an exclusive end. */
export function toSourceRange(node: ProjectedCapture): SourceRange {
  const start = toPosition(node.startPoint);
  const end = toPosition(node.endPoint);
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

/** Strips one matching pair of surrounding quotes, as every module specifier is a string. */
export function stripQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '"' || first === "'" || first === '`') && text.endsWith(first)) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** The facts one match yields; none when its role capture has no `@name` to name it. */
function draftsOf(match: ProjectedMatch): Located[] {
  let name: string | undefined;
  for (const capture of match.captures) {
    if (parseCaptureName(capture.name).role === 'name') {
      name = capture.text;
      break;
    }
  }
  const out: Located[] = [];
  let importModule: ProjectedCapture | undefined;
  const importedNames: string[] = [];
  for (const capture of match.captures) {
    const role = parseCaptureName(capture.name);
    switch (role.role) {
      case 'definition':
        if (name !== undefined) {
          out.push({
            draft: { kind: 'definition', name, definitionKind: role.kind },
            node: capture,
          });
        }
        break;
      case 'reference':
        if (name !== undefined) {
          out.push({ draft: { kind: 'reference', name, referenceKind: role.kind }, node: capture });
        }
        break;
      case 'inheritance':
        if (name !== undefined) {
          out.push({
            draft: { kind: 'inheritance', name, parentName: capture.text, relation: role.relation },
            node: capture,
          });
        }
        break;
      case 'importModule':
        importModule ??= capture;
        break;
      case 'importName':
        importedNames.push(capture.text);
        break;
      case 'name':
      case 'ignored':
        break;
    }
  }
  if (importModule !== undefined) {
    out.push({
      draft: { kind: 'import', moduleSpecifier: stripQuotes(importModule.text), importedNames },
      node: importModule,
    });
  }
  // A name with nothing to say (whitespace only) is no fact, matching the
  // fact table's non-empty checks.
  return out.filter(({ draft }) => {
    switch (draft.kind) {
      case 'definition':
      case 'reference':
        return draft.name.trim() !== '';
      case 'inheritance':
        return draft.name.trim() !== '' && draft.parentName.trim() !== '';
      case 'import':
        return draft.moduleSpecifier.trim() !== '';
    }
  });
}

/** The name that identifies a fact for de-duplication and ordering. */
function identifyingName(draft: Draft): string {
  switch (draft.kind) {
    case 'definition':
    case 'reference':
      return draft.name;
    case 'import':
      return draft.moduleSpecifier;
    case 'inheritance':
      return `${draft.name}\u0000${draft.relation}\u0000${draft.parentName}`;
  }
}

const KIND_ORDER: Record<FactKind, number> = {
  import: 0,
  definition: 1,
  inheritance: 2,
  reference: 3,
};

/**
 * Maps a parse's matches to stamped, de-duplicated, text-ordered facts.
 *
 * - each role capture is one fact; a definition, reference or inheritance
 *   takes its name from the first `@name` in its own match, and yields no fact
 *   without one;
 * - an import is one fact per match, anchored at its module specifier;
 * - every fact strictly inside a definition's node takes the innermost such
 *   definition's name as its enclosing name;
 * - facts equal in kind, range and identifying name are kept once (the first);
 * - order is start offset, then kind, then identifying name.
 */
export function buildFacts(entry: LanguageEntry, matches: readonly ProjectedMatch[]): Fact[] {
  const located = matches.flatMap(draftsOf);

  const seen = new Set<string>();
  const unique = located.filter(({ draft, node }) => {
    const key = `${draft.kind}\u0000${String(node.startIndex)}\u0000${String(node.endIndex)}\u0000${identifyingName(draft)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const definitions = unique.filter(({ draft }) => draft.kind === 'definition');

  const enclosingOf = (self: Located): string | null => {
    let best: Located | undefined;
    for (const candidate of definitions) {
      if (candidate === self) continue;
      const { node } = candidate;
      const contains =
        node.startIndex <= self.node.startIndex &&
        self.node.endIndex <= node.endIndex &&
        (node.startIndex < self.node.startIndex || self.node.endIndex < node.endIndex);
      if (!contains) continue;
      if (
        best === undefined ||
        node.endIndex - node.startIndex < best.node.endIndex - best.node.startIndex
      ) {
        best = candidate;
      }
    }
    return best !== undefined && best.draft.kind === 'definition' ? best.draft.name : null;
  };

  const ordered = [...unique].sort(
    (a, b) =>
      a.node.startIndex - b.node.startIndex ||
      KIND_ORDER[a.draft.kind] - KIND_ORDER[b.draft.kind] ||
      compareStrings(identifyingName(a.draft), identifyingName(b.draft)),
  );

  return ordered.map((item) => ({
    ...item.draft,
    language: entry.language,
    producer: TREE_SITTER_PRODUCER,
    extractorVersion: entry.extractorVersion,
    range: toSourceRange(item.node),
    enclosingName: enclosingOf(item),
  }));
}

/** A locale-independent string order, so two machines order facts alike. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
