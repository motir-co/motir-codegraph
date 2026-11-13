import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractArchive, treePath } from '../../src/fetch/extract.js';
import { hostile, paxGlobalHeader, tarball, tarBytes } from '../helpers/tarball.js';

// The extraction against archives built in memory: entry-type skips, path
// rules, the extension headers real `git archive` output carries, the
// last-wins rule and the extracted-bytes cap.

const CAP = 1_048_576;
let parent: string;
let dest: string;

beforeEach(async () => {
  // The destination sits inside a parent whose other entries are compared
  // before and after, so an escape would show up as a new sibling.
  parent = await mkdtemp(join(tmpdir(), 'extract-test-'));
  dest = join(parent, 'dest');
  await writeFile(join(parent, 'sibling.txt'), 'untouched');
  await mkdir(dest);
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

async function extractBytes(bytes: Buffer, tarByteCap = CAP) {
  const archive = join(parent, 'a.tar.gz');
  await writeFile(archive, bytes);
  try {
    return await extractArchive(archive, dest, { tarByteCap });
  } finally {
    await rm(archive);
  }
}

async function files(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...(await files(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

const refused = (code: string): unknown => expect.objectContaining({ reasonCode: code });

describe('treePath', () => {
  it('normalises a relative name and refuses an absolute or escaping one before any join', () => {
    expect(treePath('repo/a.ts')).toBe('repo/a.ts');
    expect(treePath('./repo//a.ts')).toBe('repo/a.ts');
    expect(treePath('repo/')).toBe('repo');
    expect(treePath('./')).toBeNull();
    for (const bad of ['/etc/passwd', '\\x', 'C:/x', 'a/../b', '..', 'a\\..\\b']) {
      expect(() => treePath(bad)).toThrow(expect.objectContaining({ reasonCode: 'fetch_failed' }));
    }
  });
});

describe('extractArchive', () => {
  it('writes every regular file at its path and counts the bytes', async () => {
    const out = await extractBytes(
      tarball([
        { name: 'repo/', type: 'directory' },
        { name: 'repo/a.ts', contents: 'alpha' },
        { name: 'repo/src/b.ts', contents: 'bravo!' },
      ]),
    );
    expect(out).toEqual({ paths: ['repo/a.ts', 'repo/src/b.ts'], bytes: 11 });
    expect(await readFile(join(dest, 'repo/src/b.ts'), 'utf8')).toBe('bravo!');
  });

  it('skips every entry that is not a regular file', async () => {
    const out = await extractBytes(
      tarball([
        { name: 'repo/a.ts', contents: 'a' },
        { name: 'repo/link', type: 'symlink', linkname: '/etc/passwd' },
        { name: 'repo/hard', type: 'link', linkname: 'repo/a.ts' },
        { name: 'repo/sub/', type: 'directory' },
        { name: 'repo/dev', type: 'char' },
        { name: 'repo/blk', type: 'block' },
        { name: 'repo/pipe', type: 'fifo' },
      ]),
    );
    expect(out.paths).toEqual(['repo/a.ts']);
    expect(await files(dest)).toEqual(['repo/a.ts']);
  });

  it('refuses an absolute or a `..` name, writing nothing outside the destination', async () => {
    for (const bytes of [hostile.absolute(), hostile.dotDot()]) {
      await expect(extractBytes(bytes)).rejects.toEqual(refused('fetch_failed'));
      expect((await readdir(parent)).sort()).toEqual(['dest', 'sibling.txt']);
    }
  });

  it('refuses an unsafe name even on an entry it would skip', async () => {
    await expect(
      extractBytes(tarball([{ name: '/abs-link', type: 'symlink', linkname: 'x' }])),
    ).rejects.toEqual(refused('fetch_failed'));
  });

  it('keeps the later bytes of two entries sharing a name', async () => {
    const out = await extractBytes(hostile.duplicate());
    expect(out.paths).toEqual(['repo/a.ts']);
    expect(await readFile(join(dest, 'repo/a.ts'), 'utf8')).toBe('second');
  });

  it('reads a pax global header as metadata, never as a file', async () => {
    const out = await extractBytes(hostile.paxGlobal());
    expect(out.paths).toEqual(['repo/a.ts']);
    expect(await files(dest)).toEqual(['repo/a.ts']);
  });

  it('skips a root regular file named pax_global_header', async () => {
    const out = await extractBytes(
      tarball([
        { name: 'pax_global_header', contents: 'x' },
        { name: 'repo/a.ts', contents: 'a' },
      ]),
    );
    expect(out.paths).toEqual(['repo/a.ts']);
  });

  it('extracts a path over 100 characters from a GNU long-name header', async () => {
    const long = `repo/${'deep/'.repeat(25)}file.ts`;
    expect(long.length).toBeGreaterThan(100);
    const out = await extractBytes(hostile.longName(long));
    expect(out.paths).toEqual([long]);
    expect(await readFile(join(dest, long), 'utf8')).toBe('long');
  });

  it('extracts both extension headers together, as git archive writes them', async () => {
    const long = `repo/${'x'.repeat(120)}.ts`;
    // tarBytes writes a GNU long-name pair before any name over 100 bytes.
    const bytes = tarBytes(
      [
        { name: 'repo/a.ts', contents: 'a' },
        { name: long, contents: 'b' },
      ],
      paxGlobalHeader(),
    );
    expect(bytes.includes(Buffer.from('././@LongLink'))).toBe(true);
    const { gzipSync } = await import('node:zlib');
    const out = await extractBytes(gzipSync(bytes));
    expect(out.paths).toEqual(['repo/a.ts', long]);
  });

  it('writes a file larger than one write buffer whole', async () => {
    const big = Buffer.alloc(3_000_000, 0x5a);
    const out = await extractBytes(tarball([{ name: 'repo/big.bin', contents: big }]), 4_000_000);
    expect(out.bytes).toBe(big.length);
    expect((await readFile(join(dest, 'repo/big.bin'))).equals(big)).toBe(true);
  });

  it('answers nothing for an empty archive', async () => {
    expect(await extractBytes(hostile.empty())).toEqual({ paths: [], bytes: 0 });
  });

  it('refuses source_too_large past the extracted-bytes cap', async () => {
    await expect(
      extractBytes(tarball([{ name: 'repo/big', contents: Buffer.alloc(5000, 1) }]), 4096),
    ).rejects.toEqual(refused('source_too_large'));
  });

  it('refuses fetch_failed for bytes that are not gzip, and for gzip that is not tar', async () => {
    await expect(extractBytes(Buffer.from('plain text, not gzip'))).rejects.toEqual(
      expect.objectContaining({
        reasonCode: 'fetch_failed',
        message: 'The source is not a gzip archive.',
      }),
    );
    const { gzipSync } = await import('node:zlib');
    await expect(extractBytes(gzipSync(Buffer.alloc(700, 7)))).rejects.toEqual(
      expect.objectContaining({
        reasonCode: 'fetch_failed',
        message: 'The source is not a readable tar archive.',
      }),
    );
  });

  it('refuses a truncated archive', async () => {
    const whole = tarball([{ name: 'repo/a.ts', contents: Buffer.alloc(4000, 2) }]);
    await expect(extractBytes(whole.subarray(0, whole.length - 20))).rejects.toEqual(
      refused('fetch_failed'),
    );
  });

  it('refuses fetch_timeout when its signal aborts', async () => {
    const archive = join(parent, 'a.tar.gz');
    await writeFile(archive, tarball([{ name: 'repo/a.ts', contents: 'a' }]));
    await expect(
      extractArchive(archive, dest, { tarByteCap: CAP, signal: AbortSignal.abort() }),
    ).rejects.toEqual(refused('fetch_timeout'));
  });
});
