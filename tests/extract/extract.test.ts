import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { beforeAll, describe, expect, it } from 'vitest';

import { extract } from '../../src/extract/extract.js';
import { compileQuery, loadGrammar } from '../../src/extract/runtime.js';
import { TREE_SITTER_PRODUCER } from '../../src/extract/types.js';
import type { Fact, LanguageEntry } from '../../src/extract/types.js';
import { composeExtractorVersion } from '../../src/extract/version.js';
import { TYPESCRIPT_TAGS_QUERY } from './fixtures/typescriptTags.js';

const require = createRequire(import.meta.url);

/** The grammar version, read from the package the suite loads it from. */
const GRAMMAR_VERSION = (
  JSON.parse(readFileSync(require.resolve('tree-sitter-typescript/package.json'), 'utf8')) as {
    version: string;
  }
).version;

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

let entry: LanguageEntry;

beforeAll(async () => {
  const grammar = await loadGrammar(
    require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
  );
  entry = {
    language: 'typescript',
    extensions: ['.ts'],
    filenames: [],
    grammar,
    grammarVersion: GRAMMAR_VERSION,
    queryVersion: 'test-1',
    query: TYPESCRIPT_TAGS_QUERY,
    extractorVersion: composeExtractorVersion(GRAMMAR_VERSION, 'test-1'),
  };
});

const named = (facts: readonly Fact[], kind: Fact['kind'], name: string): Fact | undefined =>
  facts.find((f) => f.kind === kind && (f.kind === 'import' ? f.moduleSpecifier : f.name) === name);

describe('extract over the clean fixture', () => {
  it('returns one fact of each kind, with the shapes the fact table stores', () => {
    const { facts, parsedWithErrors } = extract(entry, fixture('clean.ts.txt'));
    expect(parsedWithErrors).toBe(false);
    expect(new Set(facts.map((f) => f.kind))).toEqual(
      new Set(['definition', 'reference', 'import', 'inheritance']),
    );
    expect(named(facts, 'definition', 'Repo')).toMatchObject({ definitionKind: 'class' });
    expect(named(facts, 'reference', 'parse')).toMatchObject({ referenceKind: 'call' });
    const imported = named(facts, 'import', './base');
    expect(imported).toBeDefined();
    expect(imported).toMatchObject({ importedNames: expect.arrayContaining(['Base']) as unknown });
    expect(named(facts, 'inheritance', 'Repo')).toMatchObject({
      parentName: 'Base',
      relation: 'extends',
    });
  });

  it('pins the exact fact list: ranges, enclosing names and text order', () => {
    const { facts } = extract(entry, fixture('clean.ts.txt'));
    const stamp = {
      language: 'typescript',
      producer: TREE_SITTER_PRODUCER,
      extractorVersion: entry.extractorVersion,
    };
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
        range: { startLine: 3, startColumn: 8, endLine: 7, endColumn: 2 },
        enclosingName: null,
      },
      {
        ...stamp,
        kind: 'inheritance',
        name: 'Repo',
        parentName: 'Base',
        relation: 'extends',
        range: { startLine: 3, startColumn: 27, endLine: 3, endColumn: 31 },
        enclosingName: 'Repo',
      },
      {
        ...stamp,
        kind: 'definition',
        name: 'load',
        definitionKind: 'method',
        range: { startLine: 4, startColumn: 3, endLine: 6, endColumn: 4 },
        enclosingName: 'Repo',
      },
      {
        ...stamp,
        kind: 'reference',
        name: 'parse',
        referenceKind: 'call',
        range: { startLine: 5, startColumn: 12, endLine: 5, endColumn: 21 },
        enclosingName: 'load',
      },
    ]);
    for (const fact of facts) {
      expect(fact.range.startLine).toBeGreaterThanOrEqual(1);
      expect(fact.range.startColumn).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns deep-equal facts on a second call', () => {
    const source = fixture('clean.ts.txt');
    expect(extract(entry, source)).toEqual(extract(entry, source));
  });

  it('declares no blob, commit, repository or path on any fact', () => {
    const { facts } = extract(entry, fixture('clean.ts.txt'));
    for (const fact of facts) {
      expect(Object.keys(fact).filter((key) => /blob|commit|repo|path/i.test(key))).toEqual([]);
    }
  });
});

describe('extract over non-ASCII source', () => {
  it('counts columns in UTF-16 code units, as the source string is indexed', () => {
    // 'é' is one code unit (two UTF-8 bytes); '😀' is two code units (four bytes).
    const { facts } = extract(entry, '/* é😀 */ f();');
    expect(facts).toMatchObject([
      { kind: 'reference', name: 'f', range: { startLine: 1, startColumn: 11, endColumn: 14 } },
    ]);
  });
});

describe('extract over a source with a syntax error', () => {
  it('returns the facts the parser recovered and parsedWithErrors true, without throwing', () => {
    const { facts, parsedWithErrors } = extract(entry, fixture('broken.ts.txt'));
    expect(parsedWithErrors).toBe(true);
    expect(facts.length).toBeGreaterThan(0);
    expect(named(facts, 'definition', 'Repo')).toMatchObject({ definitionKind: 'class' });
  });
});

describe('extract with a broken entry', () => {
  it('throws naming the language when the query does not compile', () => {
    const broken = { ...entry, language: 'brokenlang', query: '(no_such_node) @name' };
    expect(() => extract(broken, 'const x = 1;')).toThrow(/brokenlang/);
  });
});

describe('compileQuery', () => {
  it('compiles once per language version', () => {
    const first = compileQuery(entry);
    expect(compileQuery({ ...entry })).toBe(first);
    const bumped = {
      ...entry,
      queryVersion: 'test-2',
      extractorVersion: `${entry.extractorVersion}-2`,
    };
    const second = compileQuery(bumped);
    expect(second).not.toBe(first);
    expect(compileQuery(bumped)).toBe(second);
    // Back to the first version: compiled afresh, and extraction still works.
    expect(extract(entry, 'f();').facts).toMatchObject([{ kind: 'reference', name: 'f' }]);
  });
});

describe('composeExtractorVersion', () => {
  it('is an identity over both inputs', () => {
    const base = composeExtractorVersion('0.23.2', '1');
    expect(composeExtractorVersion('0.23.2', '1')).toBe(base);
    expect(composeExtractorVersion('0.23.3', '1')).not.toBe(base);
    expect(composeExtractorVersion('0.23.2', '2')).not.toBe(base);
    expect(base).not.toBe('0.23.2');
    expect(base).not.toBe('1');
  });

  it('refuses an empty input and a grammar version that would make it ambiguous', () => {
    expect(() => composeExtractorVersion('', '1')).toThrow(/both required/);
    expect(() => composeExtractorVersion('1', ' ')).toThrow(/both required/);
    expect(() => composeExtractorVersion('a/q1', '2')).toThrow(/may not contain/);
  });
});
