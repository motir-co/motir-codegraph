import { describe, expect, it } from 'vitest';

import { buildFacts, stripQuotes, toSourceRange } from '../../src/extract/buildFacts.js';
import type { ProjectedCapture, ProjectedMatch } from '../../src/extract/runtime.js';
import { TREE_SITTER_PRODUCER } from '../../src/extract/types.js';
import type { Fact, LanguageEntry } from '../../src/extract/types.js';
import { composeExtractorVersion } from '../../src/extract/version.js';

// The mapper never touches the grammar, so the entry carries a stand-in.
const entry = {
  language: 'toylang',
  extensions: ['.toy'],
  filenames: [],
  grammar: {} as LanguageEntry['grammar'],
  grammarVersion: '1.0.0',
  queryVersion: '1',
  query: '',
  extractorVersion: composeExtractorVersion('1.0.0', '1'),
} satisfies LanguageEntry;

/**
 * A capture on one line of a toy source, from 0-based column `from` to `to`
 * (exclusive) on 0-based row `row`. Offsets are row * 100 + column, which keeps
 * them ordered like the text.
 */
function cap(name: string, text: string, row: number, from: number, to: number): ProjectedCapture {
  return {
    name,
    text,
    startIndex: row * 100 + from,
    endIndex: row * 100 + to,
    startPoint: { row, column: from },
    endPoint: { row, column: to },
  };
}

/** A capture spanning rows, 0-based. */
function span(
  name: string,
  text: string,
  [startRow, startCol]: [number, number],
  [endRow, endCol]: [number, number],
): ProjectedCapture {
  return {
    name,
    text,
    startIndex: startRow * 100 + startCol,
    endIndex: endRow * 100 + endCol,
    startPoint: { row: startRow, column: startCol },
    endPoint: { row: endRow, column: endCol },
  };
}

const m = (...captures: ProjectedCapture[]): ProjectedMatch => ({ captures });

const stamp = {
  language: 'toylang',
  producer: TREE_SITTER_PRODUCER,
  extractorVersion: entry.extractorVersion,
};

describe('buildFacts', () => {
  it('maps the four capture families to the four fact kinds, stamped', () => {
    const facts = buildFacts(entry, [
      m(cap('import.module', '"./base"', 0, 21, 29), cap('import.name', 'Base', 0, 9, 13)),
      m(span('definition.class', 'class Repo…', [2, 0], [6, 1]), cap('name', 'Repo', 2, 6, 10)),
      m(cap('name', 'Repo', 2, 6, 10), cap('inheritance.extends', 'Base', 2, 19, 23)),
      m(span('reference.call', 'parse(id)', [4, 11], [4, 20]), cap('name', 'parse', 4, 11, 16)),
    ]);
    expect(facts).toEqual<Fact[]>([
      {
        ...stamp,
        kind: 'import',
        moduleSpecifier: './base',
        importedNames: ['Base'],
        range: { startLine: 1, startColumn: 22, endLine: 1, endColumn: 30 },
        enclosingName: null,
      },
      {
        ...stamp,
        kind: 'definition',
        name: 'Repo',
        definitionKind: 'class',
        range: { startLine: 3, startColumn: 1, endLine: 7, endColumn: 2 },
        enclosingName: null,
      },
      {
        ...stamp,
        kind: 'inheritance',
        name: 'Repo',
        parentName: 'Base',
        relation: 'extends',
        range: { startLine: 3, startColumn: 20, endLine: 3, endColumn: 24 },
        enclosingName: 'Repo',
      },
      {
        ...stamp,
        kind: 'reference',
        name: 'parse',
        referenceKind: 'call',
        range: { startLine: 5, startColumn: 12, endLine: 5, endColumn: 21 },
        enclosingName: 'Repo',
      },
    ]);
  });

  it('names the innermost enclosing definition, and none at the top level', () => {
    const facts = buildFacts(entry, [
      m(span('definition.class', 'class', [0, 0], [9, 1]), cap('name', 'Outer', 0, 6, 11)),
      m(span('definition.method', 'load', [1, 2], [5, 3]), cap('name', 'load', 1, 2, 6)),
      m(cap('reference.call', 'parse()', 3, 4, 11), cap('name', 'parse', 3, 4, 9)),
      m(span('definition.function', 'fn', [10, 0], [12, 1]), cap('name', 'top', 10, 9, 12)),
    ]);
    const enclosing = Object.fromEntries(
      facts.map((f) => [f.kind === 'import' ? f.moduleSpecifier : f.name, f.enclosingName]),
    );
    expect(enclosing).toEqual({ Outer: null, load: 'Outer', parse: 'load', top: null });
  });

  it('does not treat a definition as enclosing itself or another node of the same span', () => {
    const facts = buildFacts(entry, [
      m(span('definition.class', 'x', [0, 0], [2, 1]), cap('name', 'A', 0, 6, 7)),
      m(span('definition.namespace', 'x', [0, 0], [2, 1]), cap('name', 'B', 0, 6, 7)),
    ]);
    expect(facts.map((f) => f.enclosingName)).toEqual([null, null]);
  });

  it('yields no fact for a role capture whose match has no @name, and keeps the rest', () => {
    const facts = buildFacts(entry, [
      m(span('definition.class', 'class', [0, 0], [3, 1])),
      m(cap('reference.call', 'go()', 1, 2, 6)),
      m(cap('inheritance.implements', 'Iface', 0, 20, 25)),
      m(cap('reference.call', 'run()', 2, 2, 7), cap('name', 'run', 2, 2, 5)),
    ]);
    expect(facts.map((f) => [f.kind, f.kind === 'import' ? '' : f.name])).toEqual([
      ['reference', 'run'],
    ]);
  });

  it('carries an unknown definition kind through verbatim and ignores unknown captures', () => {
    const facts = buildFacts(entry, [
      m(
        span('definition.trait', 'trait Show…', [0, 0], [2, 1]),
        cap('name', 'Show', 0, 6, 10),
        cap('doc', '/** docs */', 0, 0, 0),
        cap('local.scope', '…', 0, 0, 1),
      ),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: 'definition', name: 'Show', definitionKind: 'trait' });
  });

  it('de-duplicates on kind, range and identifying name, keeping the first', () => {
    const viaOne = m(span('definition.class', 'c', [0, 0], [1, 1]), cap('name', 'A', 0, 6, 7));
    const viaTwo = m(span('definition.class', 'c', [0, 0], [1, 1]), cap('name', 'A', 0, 6, 7));
    const otherKind = m(span('definition.struct', 'c', [0, 0], [1, 1]), cap('name', 'A', 0, 6, 7));
    const facts = buildFacts(entry, [viaOne, viaTwo, otherKind]);
    // Same kind, range and name: once. definitionKind is not part of the identity.
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ definitionKind: 'class' });
  });

  it('keeps two inheritances of one symbol from one node apart by relation', () => {
    const facts = buildFacts(entry, [
      m(cap('name', 'A', 0, 6, 7), cap('inheritance.extends', 'B', 0, 16, 17)),
      m(cap('name', 'A', 0, 6, 7), cap('inheritance.implements', 'B', 0, 16, 17)),
    ]);
    expect(facts.map((f) => (f.kind === 'inheritance' ? f.relation : ''))).toEqual([
      'extends',
      'implements',
    ]);
  });

  it('orders by start offset, then kind, then name, whatever order the matches came in', () => {
    const a = m(cap('reference.call', 'b()', 1, 0, 3), cap('name', 'b', 1, 0, 1));
    const b = m(cap('reference.call', 'a()', 1, 0, 3), cap('name', 'a', 1, 0, 1));
    const c = m(cap('definition.function', 'f', 1, 0, 9), cap('name', 'f', 1, 0, 1));
    const d = m(cap('import.module', "'x'", 0, 5, 8));
    const forward = buildFacts(entry, [a, b, c, d]);
    const backward = buildFacts(entry, [d, c, b, a]);
    const names = forward.map((f) => (f.kind === 'import' ? f.moduleSpecifier : f.name));
    expect(names).toEqual(['x', 'f', 'a', 'b']);
    expect(backward).toEqual(forward);
  });

  it('makes one import per match, names in source order, and allows none', () => {
    const facts = buildFacts(entry, [
      m(
        cap('import.name', 'A', 0, 9, 10),
        cap('import.name', 'B', 0, 12, 13),
        cap('import.module', "'mod'", 0, 21, 26),
      ),
      m(cap('import.module', '"side-effect"', 1, 7, 20)),
    ]);
    expect(facts).toMatchObject([
      { kind: 'import', moduleSpecifier: 'mod', importedNames: ['A', 'B'] },
      { kind: 'import', moduleSpecifier: 'side-effect', importedNames: [] },
    ]);
  });

  it('drops a fact whose name is only whitespace', () => {
    const facts = buildFacts(entry, [
      m(cap('definition.class', 'c', 0, 0, 5), cap('name', ' ', 0, 1, 2)),
      m(cap('name', 'A', 1, 0, 1), cap('inheritance.extends', ' ', 1, 5, 6)),
      m(cap('import.module', '""', 2, 0, 2)),
    ]);
    expect(facts).toEqual([]);
  });

  it('returns nothing for no matches', () => {
    expect(buildFacts(entry, [])).toEqual([]);
  });
});

describe('toSourceRange', () => {
  it('converts 0-based runtime points to 1-based positions with an exclusive end', () => {
    expect(toSourceRange(cap('x', 'x', 0, 0, 1))).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
    });
    expect(toSourceRange(span('x', 'x', [4, 7], [9, 0]))).toEqual({
      startLine: 5,
      startColumn: 8,
      endLine: 10,
      endColumn: 1,
    });
  });
});

describe('stripQuotes', () => {
  it.each([
    ["'./base'", './base'],
    ['"fmt"', 'fmt'],
    ['`tpl`', 'tpl'],
    ["''", ''],
    ['bare.module', 'bare.module'],
    ['"mismatched\'', '"mismatched\''],
    ['"', '"'],
    ['"a"b"', 'a"b'],
  ])('%s → %s', (input, output) => {
    expect(stripQuotes(input)).toBe(output);
  });
});
