/**
 * The fetcher's one entry point: `fetchTree({ url, dir })` turns a job's fetch
 * URL into the commit's tree on disk and its identity.
 *
 * In order: the scheme is settled before any name is resolved; the archive is
 * downloaded to ONE file in the workspace (`download.ts`: screened, pinned,
 * capped); it is extracted beside it (`extract.ts`: typed, path-checked,
 * capped) and then deleted, BEFORE hashing, so when the map is computed the
 * tree is the only thing on disk; one shared top-level directory is stripped
 * by relocating the files, never by rewriting paths, so `join(root, path)` is
 * always the file whose id the map carries; and the tree is hashed
 * (`hashTree.ts`). One deadline bounds all of it.
 *
 * THE CALLER OWNS THE WORKSPACE. It creates `dir`, passes it in and removes it
 * on every exit path. The fetcher writes only `source.tar.gz`, `extract/` and
 * `tree/` inside it, deletes what it wrote on any refusal (leaving `dir`
 * empty of its files), and never removes `dir` itself.
 *
 * A refusal is a thrown `FetchRefusedError` carrying one of five reason codes.
 * Its message is a fixed sentence: never the URL, never its query string,
 * never what a server sent. The module writes nothing to stdout or stderr.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { readFetchSettings, type FetchSettings } from '../config.js';
import { systemResolver, type Resolver } from './addressScreen.js';
import { download, httpsUrl } from './download.js';
import { refusalFrom, withCode } from './errors.js';
import { extractArchive } from './extract.js';
import { hashTree } from './hashTree.js';

export { FETCH_REFUSAL_CODES, FetchRefusedError, type FetchRefusalCode } from './errors.js';

/** A fetched commit tree: the files at `join(root, path)` and their identity. */
export interface FetchedTree {
  /** Tree path → 40-hex git blob id. */
  readonly paths: ReadonlyMap<string, string>;
  /** Tree path → bytes. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** The tree's root: `join(root, path)` is that file. */
  readonly root: string;
}

export interface FetchTreeOptions {
  /** The four settings; `readFetchSettings()` when omitted. */
  readonly settings?: FetchSettings;
  /** Extra certificate authorities to trust — the test fixture's PEM. */
  readonly tls?: { readonly ca?: string | Buffer };
  /** The resolver; the system's when omitted. A test seam. */
  readonly resolver?: Resolver;
}

/** The names the fetcher writes inside the caller's workspace. */
export const WORKSPACE_ENTRIES = {
  archive: 'source.tar.gz',
  extract: 'extract',
  tree: 'tree',
} as const;

/** The one directory every regular file sits under, or null. */
function sharedTopLevel(paths: readonly string[]): string | null {
  let top: string | null = null;
  for (const path of paths) {
    const slash = path.indexOf('/');
    if (slash < 0) return null;
    const first = path.slice(0, slash);
    if (top !== null && first !== top) return null;
    top = first;
  }
  return top;
}

async function cleanup(dir: string): Promise<void> {
  await Promise.all(
    Object.values(WORKSPACE_ENTRIES).map((name) =>
      rm(join(dir, name), { recursive: true, force: true }),
    ),
  );
}

/**
 * Fetches the archive at `url` into the workspace `dir` and answers its tree.
 * Throws `FetchRefusedError` — `not_https`, `address_refused`,
 * `source_too_large`, `fetch_timeout` or `fetch_failed` — leaving `dir` empty
 * of everything it wrote.
 */
export async function fetchTree(
  target: { readonly url: string; readonly dir: string },
  options: FetchTreeOptions = {},
): Promise<FetchedTree> {
  const url = httpsUrl(target.url);
  const settings = options.settings ?? readFetchSettings();
  const signal = AbortSignal.timeout(settings.timeoutMs);
  const archive = join(target.dir, WORKSPACE_ENTRIES.archive);
  const extracted = join(target.dir, WORKSPACE_ENTRIES.extract);
  const root = join(target.dir, WORKSPACE_ENTRIES.tree);
  try {
    await download(url, {
      dest: archive,
      byteCap: settings.byteCapBytes,
      allowedHosts: settings.allowedHosts,
      resolver: options.resolver ?? systemResolver,
      signal,
      ca: options.tls?.ca,
    });
    await mkdir(extracted);
    const { paths } = await extractArchive(archive, extracted, {
      tarByteCap: settings.tarByteCapBytes,
      signal,
    });
    await rm(archive);
    const top = sharedTopLevel(paths);
    if (top === null) {
      await rename(extracted, root);
    } else {
      await rename(join(extracted, top), root);
      await rm(extracted, { recursive: true });
    }
    const hashed = await hashTree(root, signal);
    return { ...hashed, root };
  } catch (error) {
    await cleanup(target.dir);
    throw refusalFrom(
      error,
      signal,
      (code) => `The source tree could not be written to the workspace${withCode(code)}.`,
    );
  }
}
