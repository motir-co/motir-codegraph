import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitBlobHash, gitBlobHashOfFile } from '../../src/fetch/gitBlob.js';
import { hashTree } from '../../src/fetch/hashTree.js';

// The tree walk and the shared git blob id, checked against git itself.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hash-tree-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** `git hash-object` over the bytes: the id git itself would store them under. */
function gitHashObject(bytes: Buffer): string {
  return execFileSync('git', ['hash-object', '--stdin'], { input: bytes }).toString().trim();
}

describe('gitBlobHash', () => {
  it('answers the id git answers, as 40 lowercase hex characters', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('hello\n'), Buffer.alloc(70_000, 0xfe)]) {
      expect(gitBlobHash(bytes)).toBe(gitHashObject(bytes));
      expect(gitBlobHash(bytes)).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('streams a file of known size to the same id, and refuses a size that does not match', async () => {
    const bytes = Buffer.alloc(200_000, 0x41);
    await writeFile(join(root, 'f'), bytes);
    expect(await gitBlobHashOfFile(join(root, 'f'), bytes.length)).toBe(gitBlobHash(bytes));
    await expect(gitBlobHashOfFile(join(root, 'f'), bytes.length + 1)).rejects.toThrow(
      'changed size',
    );
  });
});

describe('hashTree', () => {
  it('maps every regular file to its id and size, with the totals, skipping symlinks and empty directories', async () => {
    const tree: Record<string, string> = {
      'README.md': '# hi\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/deep/b.ts': '',
    };
    for (const [path, contents] of Object.entries(tree)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    await mkdir(join(root, 'empty'));
    await symlink('src/a.ts', join(root, 'link'));

    const hashed = await hashTree(root);
    expect([...hashed.paths.keys()]).toEqual(['README.md', 'src/a.ts', 'src/deep/b.ts']);
    for (const [path, contents] of Object.entries(tree)) {
      expect(hashed.paths.get(path)).toBe(gitHashObject(Buffer.from(contents)));
      expect(hashed.sizes.get(path)).toBe(Buffer.byteLength(contents));
    }
    expect(hashed.fileCount).toBe(3);
    expect(hashed.totalBytes).toBe(Object.values(tree).reduce((n, c) => n + c.length, 0));
  });

  it('answers an empty tree for an empty root', async () => {
    expect(await hashTree(root)).toEqual({
      paths: new Map(),
      sizes: new Map(),
      fileCount: 0,
      totalBytes: 0,
    });
  });

  it('stops when its signal has aborted', async () => {
    await writeFile(join(root, 'a'), 'a');
    await expect(hashTree(root, AbortSignal.abort())).rejects.toThrow();
  });
});
