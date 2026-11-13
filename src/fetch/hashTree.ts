/**
 * Walks an extracted tree and hashes every regular file to its git blob id in
 * one pass, gathering each file's size, the file count and the total bytes
 * from the bytes actually read. Symlinks, directories and anything else that
 * is not a regular file are not tree paths.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { gitBlobHashOfFile } from './gitBlob.js';

/** A hashed tree: path → git blob id and path → bytes, with the totals. */
export interface HashedTree {
  readonly paths: ReadonlyMap<string, string>;
  readonly sizes: ReadonlyMap<string, number>;
  readonly fileCount: number;
  readonly totalBytes: number;
}

async function* regularFiles(root: string, prefix: string): AsyncGenerator<string> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  // Byte order of the names, independent of any locale.
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* regularFiles(root, path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

/** Hashes every regular file under `root`; paths use `/` and sort by name. */
export async function hashTree(root: string, signal?: AbortSignal): Promise<HashedTree> {
  const paths = new Map<string, string>();
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  for await (const path of regularFiles(root, '')) {
    signal?.throwIfAborted();
    const file = join(root, ...path.split('/'));
    const { size } = await lstat(file);
    paths.set(path, await gitBlobHashOfFile(file, size));
    sizes.set(path, size);
    totalBytes += size;
  }
  return { paths, sizes, fileCount: paths.size, totalBytes };
}
