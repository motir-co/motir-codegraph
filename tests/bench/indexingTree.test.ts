import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PER_FILE_CAP_BYTES } from '../../src/config.js';
import {
  largeTree,
  LARGE_FILE_MAX_BYTES,
  materialise,
  MOTIR_CORE_TEXT_BYTES,
  PUSH_BASE_PATHS,
  PUSH_CHANGED_PATHS,
  pushBase,
  pushChangedPaths,
  pushSuccessor,
  summarise,
  ustarHeader,
  type TreeFile,
} from '../../src/bench/indexing/tree.js';

// The indexing benchmark's generator (src/bench/indexing/tree.ts): one seed
// yields the same bytes, two seeds differ, the push successor changes exactly
// its 50 paths, and the large profile reaches motir-core's recorded text size
// one file at a time.

/** A git blob id, computed here rather than by the code under test. */
const blobId = (bytes: Buffer) =>
  createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');

/** One digest over every path, content and blob id of a tree, in order. */
function digestOf(files: Iterable<TreeFile>): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path).update('\0').update(file.bytes).update(blobId(file.bytes));
  }
  return hash.digest('hex');
}

function* first(files: Iterable<TreeFile>, n: number): Generator<TreeFile> {
  let i = 0;
  for (const file of files) {
    if (i >= n) return;
    yield file;
    i += 1;
  }
}

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'indexing-tree-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('the push profile', () => {
  it('yields byte-identical paths, contents and blob ids for one seed, and different ones for two', () => {
    expect(digestOf(pushBase('a'))).toBe(digestOf(pushBase('a')));
    expect(digestOf(pushBase('a'))).not.toBe(digestOf(pushBase('b')));
    expect(digestOf(pushSuccessor('a', 'p1'))).toBe(digestOf(pushSuccessor('a', 'p1')));
  });

  it('has PUSH_BASE_PATHS distinct paths, and a successor differs from it in exactly 50', () => {
    const base = summarise(pushBase('a'));
    expect(base.totals.paths).toBe(PUSH_BASE_PATHS);
    expect(base.totals.files).toBe(PUSH_BASE_PATHS);
    const successor = summarise(pushSuccessor('a', 'p1'));
    expect(successor.totals.paths).toBe(PUSH_BASE_PATHS);
    const changed = [...successor.map].filter(([path, hash]) => base.map.get(path) !== hash);
    expect(changed).toHaveLength(PUSH_CHANGED_PATHS);
    expect(changed.map(([path]) => path).sort()).toEqual([...pushChangedPaths()].sort());
    for (const [path, hash] of changed) expect(base.map.get(path)).not.toBe(hash);
    // Two successors of one base change the same paths to different contents.
    const other = summarise(pushSuccessor('a', 'p2'));
    for (const path of pushChangedPaths()) {
      expect(other.map.get(path)).not.toBe(successor.map.get(path));
    }
  });
});

describe('the large profile', () => {
  it('yields byte-identical files for one seed and different ones for two', () => {
    expect(digestOf(first(largeTree('a'), 50))).toBe(digestOf(first(largeTree('a'), 50)));
    expect(digestOf(first(largeTree('a'), 50))).not.toBe(digestOf(first(largeTree('b'), 50)));
  });

  it('reaches motir-core’s text size under the per-file cap, holding one file at a time', () => {
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let files = 0;
    let textBytes = 0;
    let largest = 0;
    const paths = new Set<string>();
    for (const file of largeTree('a')) {
      files += 1;
      textBytes += file.bytes.length;
      largest = Math.max(largest, file.bytes.length);
      paths.add(file.path);
      if (files % 500 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    expect(textBytes).toBeGreaterThanOrEqual(MOTIR_CORE_TEXT_BYTES);
    expect(textBytes).toBeGreaterThanOrEqual(207_000_000);
    expect(largest).toBeLessThanOrEqual(LARGE_FILE_MAX_BYTES);
    expect(largest).toBeLessThanOrEqual(DEFAULT_PER_FILE_CAP_BYTES);
    expect(paths.size).toBe(files);
    // A tree held whole would grow the heap by its 207 MiB; one file at a time does not.
    expect(peak - before).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);

  it('stops at the total it is given', () => {
    const { totals } = summarise(largeTree('a', 1_000_000));
    expect(totals.textBytes).toBeGreaterThanOrEqual(1_000_000);
    expect(totals.textBytes).toBeLessThan(1_000_000 + LARGE_FILE_MAX_BYTES);
  });
});

describe('materialise', () => {
  it('writes real files and one tarball under a single top-level directory, and counts them', async () => {
    const dir = join(scratch, 'tree');
    const tarball = join(scratch, 'tree.tar.gz');
    const files = [...first(pushBase('a'), 30)];
    const written = await materialise(files, { dir, tarball, prefix: 'top' });
    expect(written.totals).toEqual(summarise(files).totals);
    expect(written.map).toEqual(summarise(files).map);
    for (const file of files) expect(await readFile(join(dir, file.path))).toEqual(file.bytes);
    expect((await readdir(dir)).length).toBeGreaterThan(0);

    const tar = gunzipSync(await readFile(tarball));
    expect(written.tarballBytes).toBe((await readFile(tarball)).length);
    // Walk the ustar entries: every name under top/, every body the file's own bytes.
    const seen = new Map<string, Buffer>();
    for (let at = 0; at + 512 <= tar.length;) {
      const header = tar.subarray(at, at + 512);
      if (header.every((byte) => byte === 0)) break;
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(header.subarray(124, 136).toString('utf8'), 8);
      seen.set(name, tar.subarray(at + 512, at + 512 + size));
      at += 512 + Math.ceil(size / 512) * 512;
    }
    expect(seen.size).toBe(files.length);
    for (const file of files) expect(seen.get(`top/${file.path}`)).toEqual(file.bytes);
  });

  it('writes a tree larger than the gzip stream buffers, whole', async () => {
    const files = [...first(largeTree('a'), 400)];
    const written = await materialise(files, {
      dir: join(scratch, 'large'),
      tarball: join(scratch, 'large.tar.gz'),
      prefix: 'top',
    });
    expect(written.totals).toEqual(summarise(files).totals);
    expect(gunzipSync(await readFile(join(scratch, 'large.tar.gz'))).length).toBeGreaterThan(
      written.totals.textBytes,
    );
  });

  it('refuses a tar name past 100 bytes', () => {
    expect(() => ustarHeader('x'.repeat(101), 1)).toThrow(/too long/);
    expect(ustarHeader('a.ts', 3)).toHaveLength(512);
  });
});
