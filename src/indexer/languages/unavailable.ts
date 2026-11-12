/**
 * The D5 languages with no grammar this service can load
 * (docs/tree-sitter-runtime.md). Each record keeps the extension and filename
 * map its language is recognised by, so a stored blob can record the language
 * its path resolved to and be found again when that language gains a grammar.
 * This module imports no grammar package.
 *
 * A language that gains a grammar moves from here to a module of its own,
 * taking its map with it.
 */
import type { UnavailableLanguage } from '../registry.js';

export const UNAVAILABLE_LANGUAGES: readonly UnavailableLanguage[] = [
  {
    id: 'cuda',
    d5Name: 'CUDA',
    extensions: ['.cu', '.cuh'],
    filenames: [],
    reason:
      'tree-sitter-cuda (0.21.2) is maintained but publishes no .wasm build, and neither grammar bundle carries CUDA.',
  },
  {
    id: 'swift',
    d5Name: 'Swift',
    extensions: ['.swift'],
    filenames: [],
    reason:
      'tree-sitter-swift (0.7.1) is maintained but publishes native prebuilds only, no .wasm; the one third-party repack (@binclusive/tree-sitter-swift-wasm 0.1.0) is not a maintained grammar and was not adopted.',
  },
  {
    id: 'visualbasic',
    d5Name: 'Visual Basic',
    extensions: ['.vb'],
    filenames: [],
    reason:
      'No maintained tree-sitter grammar for Visual Basic is published; tree-sitter-vb-dotnet (0.1.9) ships no .wasm build.',
  },
];
