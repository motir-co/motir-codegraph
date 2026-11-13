/**
 * Extracts a gzip tar archive into a directory, judging every entry before it
 * is used. An archive is attacker-controlled input, so:
 *
 * - an entry's TYPE is read from its header before its body is touched, and
 *   anything but a regular file (symlink, hardlink, directory, device, fifo) is
 *   skipped — which is also what keeps a submodule out of the tree;
 * - an entry's NAME is judged before it is ever joined to a path: an absolute
 *   name, or one with a `..` segment, refuses the whole archive;
 * - the extracted bytes are COUNTED as they are written, never trusted from a
 *   header, and refused past the cap;
 * - a root entry named `pax_global_header` (git archive's commit comment) is
 *   never a file.
 *
 * Two entries sharing a name leave the later one's bytes. Parsing is
 * `tar-stream`'s, including the pax and GNU long-name extension headers real
 * `git archive` output carries; tests/fetch/extract.test.ts proves it.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { extract as tarExtract, type Header } from 'tar-stream';

import { FetchRefusedError, refusalFrom } from './errors.js';

/** What an extraction wrote: every regular file's tree path, in archive order, deduplicated. */
export interface Extracted {
  readonly paths: readonly string[];
  readonly bytes: number;
}

function unsafeName(): FetchRefusedError {
  return new FetchRefusedError(
    'fetch_failed',
    'The source archive holds an entry whose path is absolute or leaves the archive.',
  );
}

/**
 * The tree path an entry name stands for, or null for a name that names
 * nothing (`.`, `./`). Refuses an absolute name or any `..` segment BEFORE
 * the name is resolved against a directory. Empty and `.` segments are
 * dropped, so `./a//b` is `a/b`.
 */
export function treePath(name: string): string | null {
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
    throw unsafeName();
  }
  const segments = name.split(/[/\\]/);
  if (segments.includes('..')) throw unsafeName();
  const kept = segments.filter((s) => s !== '' && s !== '.');
  return kept.length === 0 ? null : kept.join('/');
}

function tooLarge(): FetchRefusedError {
  return new FetchRefusedError(
    'source_too_large',
    'The source archive extracts to more than TAR_BYTE_CAP_BYTES.',
  );
}

/**
 * Writes one entry's body to `target`, counting every byte into the shared
 * total and refusing past the cap. The body is read with `for await` rather
 * than piped: the entry is a streamx stream, whose error a Node `pipeline`
 * does not observe, so a truncated archive would otherwise hang the write.
 */
async function writeEntry(
  body: AsyncIterable<unknown>,
  target: string,
  total: { bytes: number },
  cap: number,
): Promise<void> {
  const out = createWriteStream(target);
  try {
    for await (const item of body) {
      const chunk = item as Buffer;
      total.bytes += chunk.length;
      if (total.bytes > cap) throw tooLarge();
      if (!out.write(chunk)) await once(out, 'drain');
    }
  } finally {
    out.end();
    await finished(out);
  }
}

/**
 * Extracts the gzip tar at `archive` into `dest` (which must exist) and
 * answers the regular files written. Refuses `fetch_failed` for bytes that are
 * not gzip or not tar and for an unsafe name, and `source_too_large` past
 * `tarByteCap` extracted bytes.
 */
export async function extractArchive(
  archive: string,
  dest: string,
  options: { readonly tarByteCap: number; readonly signal?: AbortSignal },
): Promise<Extracted> {
  const total = { bytes: 0 };
  const written = new Set<string>();
  const parser = tarExtract();
  const consume = (async () => {
    for await (const entry of parser) {
      const header: Header = entry.header;
      // The name is judged for EVERY entry, before any of it is used.
      const path = treePath(header.name);
      const regular = header.type === 'file' || header.type === 'contiguous-file';
      if (!regular || path === null || path === 'pax_global_header') {
        entry.resume();
        continue;
      }
      const target = join(dest, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeEntry(entry, target, total, options.tarByteCap);
      written.delete(path);
      written.add(path);
    }
  })();
  const source = createReadStream(archive);
  const feeding =
    options.signal === undefined
      ? pipeline(source, createGunzip(), parser)
      : pipeline(source, createGunzip(), parser, { signal: options.signal });
  try {
    await Promise.all([feeding, consume]);
  } catch (error) {
    parser.destroy();
    source.destroy();
    // Whichever side failed first, a refusal one side raised is the reason:
    // a cap refusal inside an entry also tears the parser down, and that
    // second failure may settle first.
    const settled = await Promise.allSettled([feeding, consume]);
    const reasons: unknown[] = settled.map((r): unknown =>
      r.status === 'rejected' ? r.reason : null,
    );
    const raised = [error, ...reasons].find((r) => r instanceof FetchRefusedError);
    throw refusalFrom(raised ?? error, options.signal, (code) =>
      code?.startsWith('Z_') === true
        ? 'The source is not a gzip archive.'
        : 'The source is not a readable tar archive.',
    );
  }
  return { paths: [...written], bytes: total.bytes };
}
