import { gzipSync } from 'node:zlib';

// Builds gzip tarballs byte by byte, so a test controls every header the
// fetcher's extraction judges — including the hostile shapes a well-behaved
// packer refuses to write (an absolute name, a `..` segment) and the extension
// headers real `git archive` output carries (a pax global header, a GNU
// long-name header). Written by hand rather than with the parser under test.

/** One archive entry. A `file` carries contents; a `symlink` or `link` a target. */
export interface TarEntry {
  readonly name: string;
  readonly type?: 'file' | 'directory' | 'symlink' | 'link' | 'char' | 'block' | 'fifo';
  readonly contents?: string | Buffer;
  readonly linkname?: string;
}

const TYPEFLAG = {
  file: '0',
  link: '1',
  symlink: '2',
  char: '3',
  block: '4',
  directory: '5',
  fifo: '6',
} as const;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** One 512-byte ustar header. */
function header(name: string, size: number, typeflag: string, linkname = ''): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write(octal(0o644, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(1_700_000_000, 12), 136);
  block.write('        ', 148);
  block.write(typeflag, 156);
  block.write(linkname.slice(0, 100), 157, 'utf8');
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function padded(bytes: Buffer): Buffer {
  const rest = bytes.length % 512;
  return rest === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(512 - rest)]);
}

/** The raw (uncompressed) tar bytes of `entries`, with GNU long names where needed. */
export function tarBytes(entries: readonly TarEntry[], extra: Buffer[] = []): Buffer {
  const parts: Buffer[] = [...extra];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const body =
      type === 'file'
        ? Buffer.isBuffer(entry.contents)
          ? entry.contents
          : Buffer.from(entry.contents ?? '', 'utf8')
        : Buffer.alloc(0);
    if (Buffer.byteLength(entry.name) > 100) {
      parts.push(...gnuLongName(entry.name));
    }
    parts.push(header(entry.name, body.length, TYPEFLAG[type], entry.linkname));
    if (body.length > 0) parts.push(padded(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A GNU long-name ('L') header and its body, naming the entry that follows. */
export function gnuLongName(name: string): Buffer[] {
  const body = Buffer.from(`${name}\0`, 'utf8');
  return [header('././@LongLink', body.length, 'L'), padded(body)];
}

/** A pax global ('g') header carrying a comment, as `git archive` writes one first. */
export function paxGlobalHeader(comment = 'a'.repeat(40)): Buffer[] {
  // A pax record is "<length> <key>=<value>\n", the length counting its own digits.
  const record = (key: string, value: string) => {
    const base = Buffer.byteLength(`${key}=${value}\n`) + 1;
    let digits = 1;
    while (String(base + digits).length !== digits) digits += 1;
    return `${String(base + digits)} ${key}=${value}\n`;
  };
  const body = Buffer.from(record('comment', comment), 'utf8');
  return [header('pax_global_header', body.length, 'g'), padded(body)];
}

/** A gzip tarball of `entries`. */
export function tarball(entries: readonly TarEntry[], extra: Buffer[] = []): Buffer {
  return gzipSync(tarBytes(entries, extra));
}

/** A gzip tarball of a path → contents map, every path under `prefix/` when given. */
export function treeTarball(files: Record<string, string | Buffer>, prefix?: string): Buffer {
  return tarball(
    Object.entries(files).map(([path, contents]) => ({
      name: prefix === undefined ? path : `${prefix}/${path}`,
      contents,
    })),
  );
}

/** The hostile and unusual shapes the extraction must handle. */
export const hostile = {
  absolute: () => tarball([{ name: '/etc/codegraph-escape', contents: 'x' }]),
  dotDot: () => tarball([{ name: 'repo/../../codegraph-escape', contents: 'x' }]),
  symlink: () =>
    tarball([
      { name: 'repo/a.ts', contents: 'a' },
      { name: 'repo/link', type: 'symlink', linkname: '/etc/passwd' },
    ]),
  duplicate: () =>
    tarball([
      { name: 'repo/a.ts', contents: 'first' },
      { name: 'repo/a.ts', contents: 'second' },
    ]),
  paxGlobal: () => tarball([{ name: 'repo/a.ts', contents: 'a' }], paxGlobalHeader()),
  longName: (name = `repo/${'deep/'.repeat(25)}file.ts`) => tarball([{ name, contents: 'long' }]),
  empty: () => tarball([]),
} as const;
