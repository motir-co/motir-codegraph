import { createHash } from 'node:crypto';

/**
 * The capacity gate's frozen batch: fifty changed source files, one for each
 * grammar-backed language the registry ships and TypeScript filling the rest.
 *
 * Every file is built here, deterministically, from a per-language unit of
 * real source repeated until the file reaches its target size, so the batch is
 * the same bytes on every run and a later run's printed numbers stay
 * comparable with this one's. Each file opens with a one-line header naming its
 * own fixture path, which makes all fifty byte strings — and so all fifty git
 * blob hashes — distinct: no store in the batch is a re-store of another.
 */

/** The declared size band, inclusive, in bytes. */
export const MIN_FILE_BYTES = 1024;
export const MAX_FILE_BYTES = 4096;

/** The batch the timed case stores. */
export const BATCH_SIZE = 50;

/** One file of the batch, as a worker would hold it after fetching. */
export interface CapacityFile {
  /** The language the fixture declares; the registry must resolve the path to it. */
  readonly language: string;
  readonly path: string;
  readonly bytes: Buffer;
  /** `git hash-object` of `bytes`. */
  readonly gitBlobHash: string;
}

interface LanguageSample {
  readonly language: string;
  readonly extension: string;
  /** The header line, given the file's path. */
  readonly header: (path: string) => string;
  /** Lines every file of the language needs before its units (a package, a module). */
  readonly preamble: string;
  /** One self-contained unit of source; `n` keeps every definition's name distinct. */
  readonly unit: (n: string) => string;
}

const slashes = (path: string): string => `// ${path} — capacity fixture`;
const hashes = (path: string): string => `# ${path} — capacity fixture`;
const dashes = (path: string): string => `-- ${path} — capacity fixture`;

/** One sample per grammar-backed language, in the registry's id order. */
const SAMPLES: readonly LanguageSample[] = [
  {
    language: 'c',
    extension: '.c',
    header: slashes,
    preamble: '#include <stdio.h>\n#include "widget.h"\n',
    unit: (n) =>
      `static int scale_${n}(int value, int factor) {\n  int total = value * factor;\n  return clamp(total, ${n});\n}\n`,
  },
  {
    language: 'cpp',
    extension: '.cpp',
    header: slashes,
    preamble: '#include <vector>\n#include "widget.hpp"\n',
    unit: (n) =>
      `namespace app {\nclass Widget${n} : public Base {\n public:\n  int run(int value) { return compute(value, ${n}); }\n};\n}  // namespace app\n`,
  },
  {
    language: 'csharp',
    extension: '.cs',
    header: slashes,
    preamble: 'using System;\nusing App.Core;\n',
    unit: (n) =>
      `namespace App.Widgets {\n  public class Widget${n} : WidgetBase, IWidget {\n    public int Run(int value) { return Compute(value, ${n}); }\n  }\n}\n`,
  },
  {
    language: 'dart',
    extension: '.dart',
    header: slashes,
    preamble: "import 'package:app/base.dart';\n",
    unit: (n) =>
      `class Widget${n} extends Base implements Runner {\n  int run(int value) {\n    return compute(value, ${n});\n  }\n}\n`,
  },
  {
    language: 'elixir',
    extension: '.ex',
    header: hashes,
    preamble: '',
    unit: (n) =>
      `defmodule App.Widget${n} do\n  alias App.Base\n\n  def run(value) do\n    Base.compute(value, ${n})\n  end\nend\n`,
  },
  {
    language: 'go',
    extension: '.go',
    header: slashes,
    preamble: 'package widgets\n\nimport "example.com/app/base"\n',
    unit: (n) =>
      `type Widget${n} struct{ base.Base }\n\nfunc (w Widget${n}) Run(value int) int {\n\treturn base.Compute(value, ${n})\n}\n`,
  },
  {
    language: 'haskell',
    extension: '.hs',
    header: dashes,
    preamble: 'module Widgets where\n\nimport App.Base (compute)\n',
    unit: (n) => `run${n} :: Int -> Int\nrun${n} value = compute value ${n}\n`,
  },
  {
    language: 'java',
    extension: '.java',
    header: slashes,
    preamble: 'package app.widgets;\n\nimport app.base.Base;\n',
    unit: (n) =>
      `class Widget${n} extends Base implements Runner {\n  int run(int value) {\n    return compute(value, ${n});\n  }\n}\n`,
  },
  {
    language: 'javascript',
    extension: '.js',
    header: slashes,
    preamble: "import { compute } from './base.js';\n",
    unit: (n) =>
      `export function run${n}(value) {\n  const total = compute(value, ${n});\n  return total;\n}\n`,
  },
  {
    language: 'kotlin',
    extension: '.kt',
    header: slashes,
    preamble: 'package app.widgets\n\nimport app.base.Base\n',
    unit: (n) =>
      `class Widget${n} : Base() {\n    fun run(value: Int): Int {\n        return compute(value, ${n})\n    }\n}\n`,
  },
  {
    language: 'lua',
    extension: '.lua',
    header: dashes,
    preamble: 'local base = require("app.base")\n',
    unit: (n) =>
      `local function run_${n}(value)\n  local total = base.compute(value, ${n})\n  return total\nend\n`,
  },
  {
    language: 'php',
    extension: '.php',
    // PHP source starts at its open tag, so the header shares its line.
    header: (path) => `<?php // ${path} — capacity fixture`,
    preamble: 'namespace App\\Widgets;\n\nuse App\\Base\\Base;\n',
    unit: (n) =>
      `class Widget${n} extends Base {\n    public function run($value) {\n        return compute($value, ${n});\n    }\n}\n`,
  },
  {
    language: 'python',
    extension: '.py',
    header: hashes,
    preamble: 'from app.base import Base, compute\n',
    unit: (n) =>
      `class Widget${n}(Base):\n    def run(self, value):\n        return compute(value, ${n})\n\n`,
  },
  {
    language: 'ruby',
    extension: '.rb',
    header: hashes,
    preamble: "require 'app/base'\n",
    unit: (n) =>
      `class Widget${n} < Base\n  def run(value)\n    compute(value, ${n})\n  end\nend\n`,
  },
  {
    language: 'rust',
    extension: '.rs',
    header: slashes,
    preamble: 'use crate::base::compute;\n',
    unit: (n) =>
      `pub struct Widget${n};\n\nimpl Widget${n} {\n    pub fn run(&self, value: i64) -> i64 {\n        compute(value, ${n})\n    }\n}\n`,
  },
  {
    language: 'scala',
    extension: '.scala',
    header: slashes,
    preamble: 'package app.widgets\n\nimport app.base.Base\n',
    unit: (n) =>
      `class Widget${n} extends Base {\n  def run(value: Int): Int = compute(value, ${n})\n}\n`,
  },
  {
    language: 'solidity',
    extension: '.sol',
    header: slashes,
    preamble: 'pragma solidity ^0.8.0;\n\nimport "./Base.sol";\n',
    unit: (n) =>
      `contract Widget${n} is Base {\n    function run(uint256 value) public pure returns (uint256) {\n        return compute(value, ${n});\n    }\n}\n`,
  },
  {
    language: 'tsx',
    extension: '.tsx',
    header: slashes,
    preamble: "import { compute } from './base';\n",
    unit: (n) =>
      `export function Widget${n}(props: { value: number }) {\n  return <span className="widget">{compute(props.value, ${n})}</span>;\n}\n`,
  },
  {
    language: 'typescript',
    extension: '.ts',
    header: slashes,
    preamble: "import { Base, compute } from './base';\n",
    unit: (n) =>
      `export class Widget${n} extends Base {\n  run(value: number): number {\n    return compute(value, ${n});\n  }\n}\n`,
  },
];

/** `git hash-object`: SHA-1 over `blob <length>\0` and the bytes. */
export function gitBlobHash(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

/**
 * Builds one file: its header, its language's preamble, then units until the
 * file reaches `target` bytes. A unit is under 200 bytes, so a target at or
 * under 3,800 keeps the file inside the band.
 */
function build(sample: LanguageSample, path: string, target: number): CapacityFile {
  let source = `${sample.header(path)}\n${sample.preamble}\n`;
  for (let n = 1; Buffer.byteLength(source) < target; n += 1) {
    source += `\n${sample.unit(String(n))}`;
  }
  const bytes = Buffer.from(source, 'utf8');
  return { language: sample.language, path, bytes, gitBlobHash: gitBlobHash(bytes) };
}

/** A size target in [1,200, 3,780], spread evenly and fixed per position. */
function targetFor(index: number): number {
  return 1200 + ((index * 389) % 2581);
}

/**
 * The batch, in its fixed order: one file per sample language first, then
 * TypeScript until there are `count` files. `root` prefixes every path, so a
 * second batch of the same shape (the incrementality run) has bytes of its own.
 */
export function capacityBatch(count = BATCH_SIZE, root = 'capacity'): CapacityFile[] {
  const typescript = SAMPLES.find((s) => s.language === 'typescript');
  if (typescript === undefined) throw new Error('The fixture has no TypeScript sample.');
  const files: CapacityFile[] = [];
  for (let index = 0; index < count; index += 1) {
    const sample = SAMPLES[index] ?? typescript;
    const path = `${root}/${sample.language}/module_${String(index + 1).padStart(2, '0')}${sample.extension}`;
    files.push(build(sample, path, targetFor(index)));
  }
  return files;
}

/** The languages the fixture carries a sample for, in the registry's id order. */
export const FIXTURE_LANGUAGES: readonly string[] = SAMPLES.map((s) => s.language);
