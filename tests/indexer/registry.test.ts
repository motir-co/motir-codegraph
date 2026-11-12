import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { composeExtractorVersion } from '../../src/extract/version.js';
import {
  buildPathLookup,
  LANGUAGE_DEFINITIONS,
  languageForPath,
  registerLanguage,
  listLanguages,
  unavailableLanguageForPath,
  unavailableLanguages,
} from '../../src/indexer/registry.js';
import { escapeRegExp } from '../helpers/regexp.js';

const require = createRequire(import.meta.url);

/** D5's twenty-one languages, written out by hand: never derived from the registry. */
const D5_LANGUAGES = [
  'TypeScript',
  'JavaScript',
  'Python',
  'Java',
  'Kotlin',
  'Scala',
  'Go',
  'C',
  'C++',
  'CUDA',
  'Ruby',
  'C#',
  'Visual Basic',
  'Rust',
  'Dart',
  'PHP',
  'Swift',
  'Elixir',
  'Haskell',
  'Lua',
  'Solidity',
];

/** Declared grammar variants: a second entry for a D5 language, not a further language. */
const GRAMMAR_VARIANTS = ['tsx'];

/** Every id the registry may answer, written out by hand. */
const LANGUAGE_IDS = [
  'c',
  'cpp',
  'csharp',
  'cuda',
  'dart',
  'elixir',
  'go',
  'haskell',
  'java',
  'javascript',
  'kotlin',
  'lua',
  'php',
  'python',
  'ruby',
  'rust',
  'scala',
  'solidity',
  'swift',
  'tsx',
  'typescript',
  'visualbasic',
];

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

describe('coverage', () => {
  it('puts every D5 language in exactly one group', () => {
    const registered = listLanguages()
      .filter((entry) => !GRAMMAR_VARIANTS.includes(entry.language))
      .map((entry) => entry.d5Name);
    const unavailable = unavailableLanguages().map((record) => record.d5Name);
    const seen = [...registered, ...unavailable];
    for (const name of D5_LANGUAGES) {
      expect(
        seen.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    }
    expect(seen.sort()).toEqual([...D5_LANGUAGES].sort());
  });

  it('records CUDA, Swift and Visual Basic as the languages with no grammar, each with a reason', () => {
    expect(unavailableLanguages().map((r) => r.id)).toEqual(['cuda', 'swift', 'visualbasic']);
    for (const record of unavailableLanguages()) {
      expect(record.reason.trim(), record.id).not.toBe('');
      expect(record.extensions.length + record.filenames.length, record.id).toBeGreaterThan(0);
    }
  });

  it('keeps a variant on its D5 language', () => {
    expect(listLanguages().find((e) => e.language === 'tsx')?.d5Name).toBe('TypeScript');
  });
});

describe('ids', () => {
  it('are exactly the constant list, lowercase and unique', () => {
    const ids = [
      ...listLanguages().map((e) => e.language),
      ...unavailableLanguages().map((r) => r.id),
    ];
    expect([...ids].sort()).toEqual(LANGUAGE_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });

  it('come back from listLanguages in ascending order, the same on every call', () => {
    const ids = listLanguages().map((e) => e.language);
    expect(ids).toEqual([...ids].sort());
    expect(listLanguages().map((e) => e.language)).toEqual(ids);
    expect(LANGUAGE_DEFINITIONS.map((d) => d.id)).toEqual(ids);
  });
});

describe('each registered entry', () => {
  it.each(listLanguages().map((e) => [e.language, e] as const))(
    '%s carries every field the extractor needs',
    (id, entry) => {
      const definition = LANGUAGE_DEFINITIONS.find((d) => d.id === id);
      expect(definition).toBeDefined();
      if (definition === undefined) return;
      expect(entry.grammar).toBeDefined();
      expect(entry.query).toBe(definition.query);
      expect(entry.query).toMatch(/@definition\.\w+/);
      expect(entry.query).toMatch(/@import\.module/);
      expect(entry.extensions.length + entry.filenames.length).toBeGreaterThan(0);
      for (const extension of entry.extensions) expect(extension).toMatch(/^\.[a-z0-9+]+$/);
      expect(entry.queryVersion).toBe(String(definition.queryRevision));
      expect(Number.isInteger(definition.queryRevision)).toBe(true);
      expect(definition.queryRevision).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(LANGUAGE_DEFINITIONS.map((d) => [d.id, d] as const))(
    '%s pins its grammar exactly, as a runtime dependency, at the version its literal names',
    (_id, definition) => {
      expect(packageJson.dependencies[definition.grammarPackage]).toBe(definition.grammarVersion);
      expect(packageJson.devDependencies[definition.grammarPackage]).toBeUndefined();
      const installed = JSON.parse(
        readFileSync(require.resolve(`${definition.grammarPackage}/package.json`), 'utf8'),
      ) as { version: string };
      expect(installed.version).toBe(definition.grammarVersion);
    },
  );
});

describe('extractor versions', () => {
  it('are the derivation over each entry’s own two literals', () => {
    for (const entry of listLanguages()) {
      expect(entry.extractorVersion, entry.language).toBe(
        composeExtractorVersion(entry.grammarVersion, entry.queryVersion),
      );
    }
  });

  it('move when either literal moves', () => {
    for (const entry of listLanguages()) {
      const bumpedQuery = composeExtractorVersion(
        entry.grammarVersion,
        String(Number(entry.queryVersion) + 1),
      );
      const bumpedGrammar = composeExtractorVersion(
        `${entry.grammarVersion}-next`,
        entry.queryVersion,
      );
      expect(bumpedQuery, entry.language).not.toBe(entry.extractorVersion);
      expect(bumpedGrammar, entry.language).not.toBe(entry.extractorVersion);
    }
  });
});

describe('path declarations', () => {
  it('declare no extension and no filename twice across both lists', () => {
    const declarations = [...LANGUAGE_DEFINITIONS, ...unavailableLanguages()];
    const extensions = declarations.flatMap((d) => d.extensions.map((e) => e.toLowerCase()));
    const filenames = declarations.flatMap((d) => d.filenames.map((f) => f.toLowerCase()));
    expect(extensions.filter((e, i) => extensions.indexOf(e) !== i)).toEqual([]);
    expect(filenames.filter((f, i) => filenames.indexOf(f) !== i)).toEqual([]);
  });
});

describe('languageForPath', () => {
  it.each([
    ['src/app.ts', 'typescript'],
    ['src/types.d.ts', 'typescript'],
    ['lib/x.mts', 'typescript'],
    ['ui/Button.tsx', 'tsx'],
    ['UI/BUTTON.TSX', 'tsx'],
    ['index.js', 'javascript'],
    ['a/b/c.cjs', 'javascript'],
    ['tool.py', 'python'],
    ['stubs.pyi', 'python'],
    ['Main.java', 'java'],
    ['build.gradle.kts', 'kotlin'],
    ['App.scala', 'scala'],
    ['main.go', 'go'],
    ['main.c', 'c'],
    ['include/stdio.h', 'cpp'],
    ['vector.hpp', 'cpp'],
    ['x.cc', 'cpp'],
    ['app.rb', 'ruby'],
    ['Gemfile', 'ruby'],
    ['sub/dir/Rakefile', 'ruby'],
    ['gemfile', 'ruby'],
    ['backup.tar.rb', 'ruby'],
    ['Program.cs', 'csharp'],
    ['lib.rs', 'rust'],
    ['main.dart', 'dart'],
    ['index.php', 'php'],
    ['mix.exs', 'elixir'],
    ['Main.hs', 'haskell'],
    ['init.lua', 'lua'],
    ['Token.sol', 'solidity'],
  ])('%s → %s', (path, id) => {
    expect(languageForPath(path)?.language).toBe(id);
    expect(unavailableLanguageForPath(path)).toBeNull();
  });

  it.each([
    '',
    'src/',
    'README',
    'Makefile',
    'notes.txt',
    '.ts',
    'dir/.py',
    'a.vb',
    'k.cu',
    'App.swift',
  ])('%j → null', (path) => {
    expect(languageForPath(path)).toBeNull();
  });
});

describe('unavailableLanguageForPath', () => {
  it.each([
    ['Module1.vb', 'visualbasic'],
    ['kernel.cu', 'cuda'],
    ['kernel.CUH', 'cuda'],
    ['Sources/App/main.swift', 'swift'],
  ])('%s → %s', (path, id) => {
    expect(unavailableLanguageForPath(path)).toBe(id);
    expect(languageForPath(path)).toBeNull();
  });

  it.each(['src/app.ts', 'Gemfile', 'notes.txt', '', 'dir/'])('%j → null', (path) => {
    expect(unavailableLanguageForPath(path)).toBeNull();
  });

  it('answers exactly for the paths an unavailable language declares', () => {
    for (const record of unavailableLanguages()) {
      for (const extension of record.extensions) {
        expect(unavailableLanguageForPath(`x${extension}`)).toBe(record.id);
      }
      expect(listLanguages().some((e) => e.language === record.id)).toBe(false);
    }
  });
});

describe('the dependency set', () => {
  it('adds no package for a language with no grammar', () => {
    const names = Object.keys(packageJson.dependencies).join(' ');
    expect(names).not.toMatch(/cuda|swift|vb|visual/i);
  });

  it('keeps every grammar’s install script off, with nothing else enabled but esbuild', () => {
    const workspace = readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');
    const enabled = [...workspace.matchAll(/^\s+'?([@\w/.-]+)'?: true$/gm)].map((m) => m[1]);
    expect(enabled).toEqual(['esbuild']);
    for (const definition of LANGUAGE_DEFINITIONS) {
      expect(workspace, definition.grammarPackage).toMatch(
        new RegExp(`^\\s+'?${escapeRegExp(definition.grammarPackage)}'?: false$`, 'm'),
      );
    }
  });
});

describe('buildPathLookup', () => {
  const claim = (id: string) => ({
    entry: null,
    unavailable: { id, d5Name: id, extensions: [], filenames: [], reason: 'test' },
  });

  it('matches the longest declared suffix whatever the declaration order', () => {
    const lookup = buildPathLookup([
      [{ extensions: ['.ts'], filenames: [] }, claim('short')],
      [{ extensions: ['.d.ts'], filenames: [] }, claim('long')],
    ]);
    expect(lookup('a/types.d.ts')?.unavailable?.id).toBe('long');
    expect(lookup('a/app.ts')?.unavailable?.id).toBe('short');
    expect(lookup('a/APP.TS')?.unavailable?.id).toBe('short');
    expect(lookup('.ts')).toBeNull();
  });

  it('consults filenames before extensions', () => {
    const lookup = buildPathLookup([
      [{ extensions: ['.lock'], filenames: [] }, claim('ext')],
      [{ extensions: [], filenames: ['Gemfile.lock'] }, claim('name')],
    ]);
    expect(lookup('x/gemfile.LOCK')?.unavailable?.id).toBe('name');
    expect(lookup('x/yarn.lock')?.unavailable?.id).toBe('ext');
  });

  it('refuses an extension or a filename declared twice, naming it', () => {
    expect(() =>
      buildPathLookup([
        [{ extensions: ['.x'], filenames: [] }, claim('a')],
        [{ extensions: ['.X'], filenames: [] }, claim('b')],
      ]),
    ).toThrow(/Extension \.X is declared twice/);
    expect(() =>
      buildPathLookup([
        [{ extensions: [], filenames: ['Build'] }, claim('a')],
        [{ extensions: [], filenames: ['build'] }, claim('b')],
      ]),
    ).toThrow(/Filename build is declared twice/);
  });
});

describe('registerLanguage', () => {
  it('names the language when its grammar does not load', async () => {
    const [first] = LANGUAGE_DEFINITIONS;
    if (first === undefined) throw new Error('no definitions');
    await expect(
      registerLanguage({ ...first, id: 'nolang', grammarFile: 'no-such-file.wasm' }),
    ).rejects.toThrow(/The nolang grammar did not load/);
  });
});
