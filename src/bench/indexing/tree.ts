/**
 * The indexing benchmark's two generated trees, from a seed label and never
 * committed as bytes.
 *
 * - The push arm's base: PUSH_BASE_PATHS small files, the resolved-map scale
 *   the commit-layer capacity gate calibrates its 50-path delta on
 *   (`MAP_PATHS` in tests/integration/layerCapacity.fixture.ts), and its
 *   successors, each the base with exactly PUSH_CHANGED_PATHS paths changed.
 * - The first-index arm's motir-core-sized tree: TypeScript-shaped text files
 *   until the total reaches MOTIR_CORE_TEXT_BYTES, no file past the per-file
 *   cap.
 *
 * Every tree is a generator of files, so a caller can count it, hash it or
 * write it without ever holding the whole tree in memory: each file is derived
 * from the seed and its own index alone.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGzip } from 'node:zlib';

import { gitBlobHash } from '../../fetch/gitBlob.js';

/** The push arm's base: the resolved-map size the library's delta target is measured at. */
export const PUSH_BASE_PATHS = 20_000;
/** The paths one push changes: the story's "a push touching 50 files". */
export const PUSH_CHANGED_PATHS = 50;

/**
 * motir-core's recorded size: about 207 MB of text, about 51 MB deflated. The
 * generator reaches 207 MiB, which is at least 207 MB in either unit.
 */
export const MOTIR_CORE_TEXT_BYTES = 207 * 1024 * 1024;
export const MOTIR_CORE_DEFLATED_BYTES = 51 * 1024 * 1024;

/** The largest file the large profile writes, well under any per-file cap in use. */
export const LARGE_FILE_MAX_BYTES = 40 * 1024;
const LARGE_FILE_MIN_BYTES = 4 * 1024;

export interface TreeFile {
  readonly path: string;
  readonly bytes: Buffer;
}

export interface TreeTotals {
  /** Distinct paths. */
  readonly paths: number;
  /** Files written (or counted). */
  readonly files: number;
  readonly textBytes: number;
  readonly largestFileBytes: number;
}

/** A small deterministic generator (mulberry32) seeded from `label`. */
export function rng(label: string): () => number {
  let state = createHash('sha1').update(label).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The base's path for index `i`, spread over 40 packages of 25 modules. */
export function pushPath(i: number): string {
  const dir = `pkg${String(i % 40).padStart(2, '0')}/mod${String(Math.floor(i / 40) % 25).padStart(2, '0')}`;
  return `${dir}/file${String(i).padStart(5, '0')}.ts`;
}

/** The PUSH_CHANGED_PATHS paths every successor changes, spread across the base. */
export function pushChangedPaths(): string[] {
  const stride = Math.floor(PUSH_BASE_PATHS / PUSH_CHANGED_PATHS);
  return Array.from({ length: PUSH_CHANGED_PATHS }, (_, k) => pushPath(k * stride));
}

/** The push arm's base tree. */
export function* pushBase(seed: string): Generator<TreeFile> {
  const salt = Math.floor(rng(`${seed} base`)() * 1_000_000);
  for (let i = 0; i < PUSH_BASE_PATHS; i += 1) {
    yield {
      path: pushPath(i),
      bytes: Buffer.from(`export const v${String(i)} = ${String(salt + i)};\n`),
    };
  }
}

/** The base with exactly the PUSH_CHANGED_PATHS paths changed, to contents labelled `label`. */
export function* pushSuccessor(seed: string, label: string): Generator<TreeFile> {
  const changed = new Set(pushChangedPaths());
  for (const file of pushBase(seed)) {
    yield changed.has(file.path)
      ? { path: file.path, bytes: Buffer.from(`// ${seed} ${label} ${file.path}\n`) }
      : file;
  }
}

const WORDS = [
  'account',
  'adapter',
  'address',
  'agent',
  'answer',
  'archive',
  'batch',
  'binding',
  'blob',
  'board',
  'branch',
  'buffer',
  'cache',
  'card',
  'chain',
  'channel',
  'check',
  'claim',
  'client',
  'commit',
  'config',
  'content',
  'context',
  'credential',
  'cursor',
  'delta',
  'design',
  'digest',
  'draft',
  'entry',
  'event',
  'fetch',
  'field',
  'filter',
  'folder',
  'gate',
  'grant',
  'graph',
  'handler',
  'header',
  'index',
  'issue',
  'item',
  'job',
  'key',
  'label',
  'layer',
  'lease',
  'limit',
  'loader',
  'locale',
  'map',
  'member',
  'message',
  'model',
  'module',
  'node',
  'notice',
  'option',
  'owner',
  'page',
  'panel',
  'parent',
  'path',
  'plan',
  'policy',
  'pool',
  'project',
  'prompt',
  'queue',
  'range',
  'reader',
  'record',
  'ref',
  'release',
  'repo',
  'report',
  'request',
  'result',
  'review',
  'route',
  'row',
  'rule',
  'run',
  'scope',
  'section',
  'session',
  'setting',
  'shape',
  'signal',
  'slice',
  'source',
  'sprint',
  'state',
  'status',
  'step',
  'store',
  'stream',
  'target',
  'task',
  'tenant',
  'theme',
  'thread',
  'token',
  'tree',
  'value',
  'view',
  'worker',
  'writer',
];
const TYPES = ['string', 'number', 'boolean', 'string[]', 'number[]', 'Record<string, number>'];
const OPS = ['+', '-', '*', '%'];

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

function ident(next: () => number): string {
  const a = pick(next, WORDS);
  const b = pick(next, WORDS);
  return `${a}${b.charAt(0).toUpperCase()}${b.slice(1)}`;
}

/** One TypeScript-shaped file of about `target` bytes, never past LARGE_FILE_MAX_BYTES. */
function largeFileText(next: () => number, target: number): string {
  const header = `import { ${ident(next)}, ${ident(next)} } from './${pick(next, WORDS)}.js';\n\n`;
  const parts: string[] = [header];
  let length = header.length;
  for (;;) {
    const a = ident(next);
    const b = ident(next);
    const local = ident(next);
    const n = String(Math.floor(next() * 10_000));
    const block =
      `/** ${pick(next, WORDS)} ${pick(next, WORDS)} for the ${pick(next, WORDS)}. */\n` +
      `export function ${ident(next)}(${a}: number, ${b}: ${pick(next, TYPES)}): number {\n` +
      `  const ${local} = ${a} ${pick(next, OPS)} ${n};\n` +
      `  return ${local};\n}\n\n`;
    if (length + block.length > LARGE_FILE_MAX_BYTES) break;
    parts.push(block);
    length += block.length;
    if (length >= target) break;
  }
  return parts.join('');
}

/** The large profile's path for file `i`. */
function largePath(i: number): string {
  return `packages/area${String(i % 40).padStart(2, '0')}/module${String(Math.floor(i / 40) % 30).padStart(2, '0')}/file${String(i).padStart(5, '0')}.ts`;
}

/**
 * The first-index arm's motir-core-sized tree: files of 4–40 KiB of
 * TypeScript-shaped text until the total reaches `totalBytes`. Each file comes
 * from the seed and its own index, so the generator holds one file at a time.
 */
export function* largeTree(
  seed: string,
  totalBytes: number = MOTIR_CORE_TEXT_BYTES,
): Generator<TreeFile> {
  let total = 0;
  for (let i = 0; total < totalBytes; i += 1) {
    const next = rng(`${seed} large ${String(i)}`);
    const target =
      LARGE_FILE_MIN_BYTES + Math.floor(next() * (LARGE_FILE_MAX_BYTES - LARGE_FILE_MIN_BYTES));
    const bytes = Buffer.from(largeFileText(next, target));
    total += bytes.length;
    yield { path: largePath(i), bytes };
  }
}

/** Counts a tree, and maps each path to its git blob id, one file at a time. */
export function summarise(files: Iterable<TreeFile>): {
  totals: TreeTotals;
  map: Map<string, string>;
} {
  const counted = summariseStream();
  for (const file of files) counted.add(file);
  return counted.result();
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** One 512-byte ustar header for a regular file. */
export function ustarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  const block = Buffer.alloc(512);
  block.write(name, 0, 'utf8');
  block.write(octal(0o644, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(1_700_000_000, 12), 136);
  block.write('        ', 148);
  block.write('0', 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

/**
 * Writes `files` under `dir` as real files AND into one gzip tarball at
 * `tarball`, every entry under `prefix/` (the single top-level directory a
 * host's archive carries). One file is held at a time, and the gzip stream's
 * backpressure is honoured, so memory stays flat however large the tree.
 */
export async function materialise(
  files: Iterable<TreeFile>,
  target: { dir: string; tarball: string; prefix: string },
): Promise<{ totals: TreeTotals; map: Map<string, string>; tarballBytes: number }> {
  await mkdir(dirname(target.tarball), { recursive: true });
  const gzip = createGzip();
  const out = createWriteStream(target.tarball);
  gzip.pipe(out);
  const write = async (chunk: Buffer) => {
    if (!gzip.write(chunk)) await once(gzip, 'drain');
  };
  const counted = summariseStream();
  for (const file of files) {
    const path = join(target.dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
    await write(ustarHeader(`${target.prefix}/${file.path}`, file.bytes.length));
    await write(file.bytes);
    const rest = file.bytes.length % 512;
    if (rest !== 0) await write(Buffer.alloc(512 - rest));
    counted.add(file);
  }
  await write(Buffer.alloc(1024));
  gzip.end();
  await once(out, 'close');
  return { ...counted.result(), tarballBytes: out.bytesWritten };
}

/** `summarise`, one file at a time. */
function summariseStream() {
  const map = new Map<string, string>();
  let files = 0;
  let textBytes = 0;
  let largestFileBytes = 0;
  return {
    add(file: TreeFile) {
      map.set(file.path, gitBlobHash(file.bytes));
      files += 1;
      textBytes += file.bytes.length;
      largestFileBytes = Math.max(largestFileBytes, file.bytes.length);
    },
    result: () => ({ totals: { paths: map.size, files, textBytes, largestFileBytes }, map }),
  };
}
