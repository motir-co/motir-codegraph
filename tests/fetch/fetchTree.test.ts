import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FetchSettings } from '../../src/config.js';
import type { Resolver } from '../../src/fetch/addressScreen.js';
import { download } from '../../src/fetch/download.js';
import { refusalFrom, TIMEOUT_MESSAGE } from '../../src/fetch/errors.js';
import { gitBlobHash } from '../../src/fetch/gitBlob.js';
import {
  FETCH_REFUSAL_CODES,
  FetchRefusedError,
  fetchTree,
  type FetchTreeOptions,
} from '../../src/fetch/fetchTree.js';
import { hostile, tarball, treeTarball } from '../helpers/tarball.js';
import {
  assertCertificateCurrent,
  startTarballServer,
  type TarballServer,
} from '../helpers/tarballServer.js';

// The whole call against the https fixture server: the happy path and its
// map, every refusal code with its situation, the redirect walk, both caps,
// the empty workspace after a refusal, and a marker in every URL's query
// string that must appear in no message and on neither stream.

const MARKER = 'url-marker-7f3a9c';
const SETTINGS: FetchSettings = {
  byteCapBytes: 1_048_576,
  tarByteCapBytes: 1_048_576,
  timeoutMs: 5_000,
  allowedHosts: ['localhost'],
};

let server: TarballServer;
let parent: string;
let dir: string;
let output: string[];

beforeAll(async () => {
  server = await startTarballServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'fetch-tree-'));
  dir = join(parent, 'workspace');
  await mkdir(dir);
  await writeFile(join(parent, 'sibling.txt'), 'untouched');
  output = [];
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
  }
  server.requests.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(parent, { recursive: true, force: true });
});

/** A resolver answering `address` for every name, counting its calls. */
function resolverTo(...addresses: string[]) {
  return vi.fn<Resolver>(() =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    ),
  );
}

function options(overrides: Partial<FetchTreeOptions> = {}, settings: Partial<FetchSettings> = {}) {
  return {
    settings: { ...SETTINGS, ...settings },
    tls: { ca: server.ca },
    resolver: resolverTo('127.0.0.1'),
    ...overrides,
  } satisfies FetchTreeOptions;
}

const withMarker = (url: string) => `${url}${url.includes('?') ? '&' : '?'}token=${MARKER}`;

/** Runs a fetch expected to refuse, and answers the refusal after the URL-marker sweep. */
async function refused(
  url: string,
  opts: FetchTreeOptions = options(),
): Promise<FetchRefusedError> {
  const error = await fetchTree({ url: withMarker(url), dir }, opts).then(
    () => {
      throw new Error('the fetch did not refuse');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchRefusedError);
  const refusal = error as FetchRefusedError;
  expect(refusal.message).not.toContain(MARKER);
  expect(refusal.message).not.toContain('token=');
  expect(String(refusal.stack)).not.toContain(MARKER);
  expect(output).toEqual([]);
  // The workspace is empty and nothing outside it moved.
  expect(await readdir(dir)).toEqual([]);
  expect((await readdir(parent)).sort()).toEqual(['sibling.txt', 'workspace']);
  return refusal;
}

const SAMPLE = {
  'README.md': '# sample\n',
  'src/index.ts': 'export const x = 1;\n',
  'src/deep/util.ts': 'export function f() {\n  return 2;\n}\n',
  'empty.txt': '',
};

describe('a fetch that succeeds', () => {
  it('answers every regular file with its git blob id and size, the files at join(root, path)', async () => {
    const commit = 'a'.repeat(40);
    const url = server.commit('acme/web', commit, treeTarball(SAMPLE, `web-${commit}`));
    const resolver = resolverTo('127.0.0.1');
    const tree = await fetchTree({ url: withMarker(url), dir }, options({ resolver }));

    expect([...tree.paths.keys()].sort()).toEqual(Object.keys(SAMPLE).sort());
    expect(tree.fileCount).toBe(4);
    expect(tree.totalBytes).toBe(Object.values(SAMPLE).reduce((n, c) => n + c.length, 0));
    for (const [path, contents] of Object.entries(SAMPLE)) {
      const onDisk = await readFile(join(tree.root, path));
      expect(onDisk.toString()).toBe(contents);
      expect(tree.paths.get(path)).toBe(gitBlobHash(onDisk));
      expect(tree.paths.get(path)).toBe(
        execFileSync('git', ['hash-object', '--stdin'], { input: onDisk, stdio: 'pipe' })
          .toString()
          .trim(),
      );
      expect(tree.sizes.get(path)).toBe(onDisk.length);
    }
    // Only the tree is left in the workspace; the archive is gone.
    expect(await readdir(dir)).toEqual(['tree']);
    expect(tree.root).toBe(join(dir, 'tree'));
    // Resolved once; the Host header named the URL's host, not the address.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual([
      {
        path: `/acme/web/archive/${commit}.tar.gz?token=${MARKER}`,
        host: `localhost:${String(server.port)}`,
      },
    ]);
    expect(output).toEqual([]);
  });

  it('strips nothing when the files sit under two top-level names', async () => {
    const url = server.serve('/two.tar.gz', treeTarball({ 'a/x.ts': 'x', 'b/y.ts': 'y' }));
    const tree = await fetchTree({ url, dir }, options());
    expect([...tree.paths.keys()]).toEqual(['a/x.ts', 'b/y.ts']);
    expect(await readFile(join(tree.root, 'b/y.ts'), 'utf8')).toBe('y');
  });

  it('strips nothing for a file at the root, and skips symlinks and the pax header', async () => {
    const url = server.serve(
      '/flat.tar.gz',
      tarball([
        { name: 'top.ts', contents: 't' },
        { name: 'repo/link', type: 'symlink', linkname: '../top.ts' },
        { name: 'repo/', type: 'directory' },
      ]),
    );
    const tree = await fetchTree({ url, dir }, options());
    expect([...tree.paths.keys()]).toEqual(['top.ts']);
  });

  it('answers an empty tree for an archive with no regular files', async () => {
    const url = server.serve('/empty.tar.gz', hostile.empty());
    const tree = await fetchTree({ url, dir }, options());
    expect(tree).toMatchObject({ fileCount: 0, totalBytes: 0 });
    expect(tree.paths.size).toBe(0);
    expect(tree.sizes.size).toBe(0);
    expect(await readdir(tree.root)).toEqual([]);
  });

  it('reads a body sent with no declared length', async () => {
    const url = server.serve('/chunked.tar.gz', treeTarball(SAMPLE, 'r'), { chunked: true });
    expect((await fetchTree({ url, dir }, options())).fileCount).toBe(4);
  });

  it('follows up to three https redirects, resolving and screening each hop', async () => {
    const final = server.serve('/final.tar.gz', treeTarball({ 'a.ts': 'a' }, 'r'));
    server.redirect('/r3', final);
    server.redirect('/r2', '/r3');
    const first = server.redirect('/r1', `${server.origin}/r2`);
    const resolver = resolverTo('127.0.0.1');
    const tree = await fetchTree({ url: first, dir }, options({ resolver }));
    expect([...tree.paths.keys()]).toEqual(['a.ts']);
    expect(resolver).toHaveBeenCalledTimes(4);
  });
});

describe('the five refusals', () => {
  it('has exactly five reason codes', () => {
    expect(FETCH_REFUSAL_CODES).toEqual([
      'not_https',
      'address_refused',
      'source_too_large',
      'fetch_timeout',
      'fetch_failed',
    ]);
  });

  it('not_https: a scheme that is not https, or no absolute URL, before any name is resolved', async () => {
    const resolver = resolverTo('127.0.0.1');
    for (const url of [
      'http://localhost/a.tar.gz',
      'file:///etc/passwd',
      's3://bucket/key.tar.gz',
      'not a url',
      '/relative/path',
    ]) {
      expect((await refused(url, options({ resolver }))).reasonCode).toBe('not_https');
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('address_refused: a private address for a host that is not allowed, or any refused answer', async () => {
    const url = server.serve('/a.tar.gz', treeTarball({ 'a.ts': 'a' }));
    expect((await refused(url, options({}, { allowedHosts: [] }))).reasonCode).toBe(
      'address_refused',
    );
    expect(
      (await refused(url, options({ resolver: resolverTo('127.0.0.1', '169.254.169.254') })))
        .reasonCode,
    ).toBe('address_refused');
    expect((await refused(url, options({ resolver: resolverTo('fe80::1') }))).reasonCode).toBe(
      'address_refused',
    );
    expect(server.requests).toEqual([]);
  });

  it('address_refused with the default settings and resolver: localhost is loopback', async () => {
    const url = server.serve('/d.tar.gz', treeTarball({ 'a.ts': 'a' }));
    expect((await refused(url, {})).reasonCode).toBe('address_refused');
  });

  it('checks the certificate against the URL host name, not the pinned address', async () => {
    // 127.0.0.1 is on the certificate; wrong.test is not. Pinned to 127.0.0.1,
    // a fetch of https://wrong.test must still fail its TLS check.
    const path = '/w.tar.gz';
    server.serve(path, treeTarball({ 'a.ts': 'a' }));
    const url = `https://wrong.test:${String(server.port)}${path}`;
    const refusal = await refused(url, options({}, { allowedHosts: ['wrong.test'] }));
    expect(refusal.reasonCode).toBe('fetch_failed');
  });

  it('redirect hops: to http refuses not_https, to a refused address address_refused, a fourth fetch_failed', async () => {
    const toHttp = server.redirect('/to-http', `http://localhost:${String(server.port)}/x`);
    expect((await refused(toHttp)).reasonCode).toBe('not_https');

    const toPrivate = server.redirect('/to-private', 'https://internal.example/x');
    const resolver = vi.fn<Resolver>((host) =>
      Promise.resolve([{ address: host === 'localhost' ? '127.0.0.1' : '10.1.2.3', family: 4 }]),
    );
    expect((await refused(toPrivate, options({ resolver }))).reasonCode).toBe('address_refused');
    expect(resolver).toHaveBeenCalledTimes(2);

    const end = server.serve('/end.tar.gz', treeTarball({ 'a.ts': 'a' }));
    server.redirect('/h4', end);
    server.redirect('/h3', '/h4');
    server.redirect('/h2', '/h3');
    const first = server.redirect('/h1', '/h2');
    expect((await refused(first)).reasonCode).toBe('fetch_failed');
  });

  it('source_too_large: a declared length over the cap, before the body is read', async () => {
    const url = server.serve('/big.tar.gz', Buffer.alloc(4096, 1));
    expect((await refused(url, options({}, { byteCapBytes: 1024 }))).reasonCode).toBe(
      'source_too_large',
    );
  });

  it('source_too_large: an undeclared length streaming past the cap', async () => {
    const url = server.serve('/big-chunked.tar.gz', Buffer.alloc(8192, 1), { chunked: true });
    expect((await refused(url, options({}, { byteCapBytes: 1024 }))).reasonCode).toBe(
      'source_too_large',
    );
  });

  it('source_too_large: extracted bytes over TAR_BYTE_CAP_BYTES', async () => {
    const url = server.serve(
      '/bomb.tar.gz',
      treeTarball({ 'zeros.bin': Buffer.alloc(100_000) }, 'r'),
    );
    expect((await refused(url, options({}, { tarByteCapBytes: 10_000 }))).reasonCode).toBe(
      'source_too_large',
    );
  });

  it('fetch_timeout: a source that stalls past the deadline', async () => {
    const url = server.route('/stall.tar.gz', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.write(Buffer.alloc(10));
    });
    expect((await refused(url, options({}, { timeoutMs: 300 }))).reasonCode).toBe('fetch_timeout');
  });

  it('fetch_failed: a non-2xx status, bytes that are not gzip, gzip that is not tar, an unsafe path', async () => {
    const missing = `${server.origin}/nothing-here.tar.gz`;
    expect((await refused(missing)).reasonCode).toBe('fetch_failed');
    const html = server.serve('/html', Buffer.from('<html>login</html>'));
    expect((await refused(html)).reasonCode).toBe('fetch_failed');
    const { gzipSync } = await import('node:zlib');
    const notTar = server.serve('/not-tar.tar.gz', gzipSync(Buffer.alloc(900, 3)));
    expect((await refused(notTar)).reasonCode).toBe('fetch_failed');
    for (const [path, bytes] of [
      ['/abs.tar.gz', hostile.absolute()],
      ['/dotdot.tar.gz', hostile.dotDot()],
    ] as const) {
      expect((await refused(server.serve(path, bytes))).reasonCode).toBe('fetch_failed');
    }
  });

  it('fetch_failed: a name that does not resolve, and a connection that is refused', async () => {
    const failing = vi.fn<Resolver>(() =>
      Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
    );
    expect(
      (await refused('https://source.invalid/a.tar.gz', options({ resolver: failing }))).reasonCode,
    ).toBe('fetch_failed');
    const closed = await startTarballServer();
    await closed.close();
    expect((await refused(`${closed.origin}/a.tar.gz`)).reasonCode).toBe('fetch_failed');
  });

  it('fetch_failed when the workspace cannot take the tree, leaving it empty', async () => {
    const url = server.serve('/ok.tar.gz', treeTarball({ 'a.ts': 'a' }));
    await writeFile(join(dir, 'extract'), 'in the way');
    const error = await fetchTree({ url: withMarker(url), dir }, options()).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reasonCode: 'fetch_failed' });
    expect((error as Error).message).not.toContain(MARKER);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('the connection', () => {
  it('connects to an IP-literal host by address, checking the certificate against it', async () => {
    const path = '/ip.tar.gz';
    server.serve(path, treeTarball({ 'a.ts': 'a' }));
    const resolver = resolverTo('10.0.0.1');
    const tree = await fetchTree(
      { url: `https://127.0.0.1:${String(server.port)}${path}`, dir },
      options({ resolver }, { allowedHosts: ['127.0.0.1'] }),
    );
    expect(tree.fileCount).toBe(1);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('trusts no certificate it was not given', async () => {
    const url = server.serve('/untrusted.tar.gz', treeTarball({ 'a.ts': 'a' }));
    const { settings, resolver } = options();
    expect((await refused(url, { settings, resolver })).reasonCode).toBe('fetch_failed');
  });

  it('fails a body cut off before its declared length', async () => {
    const url = server.route('/cut.tar.gz', (_req, res) => {
      res.writeHead(200, { 'content-length': '100000' });
      res.write(Buffer.alloc(10), () => res.destroy());
    });
    expect((await refused(url)).reasonCode).toBe('fetch_failed');
  });

  it('defaults to port 443, and reads a 3xx without a location as a failure', async () => {
    const signal = AbortSignal.timeout(5_000);
    const common = {
      dest: join(dir, 'x'),
      byteCap: 1024,
      allowedHosts: ['localhost'],
      resolver: resolverTo('127.0.0.1'),
      signal,
      ca: server.ca,
    };
    await expect(download(new URL('https://localhost/a.tar.gz'), common)).rejects.toMatchObject({
      reasonCode: 'fetch_failed',
    });
    const url = server.route('/304', (_req, res) => {
      res.writeHead(304).end();
    });
    await expect(download(new URL(url), common)).rejects.toMatchObject({
      reasonCode: 'fetch_failed',
      message: 'The source answered HTTP 304, not a success.',
    });
  });
});

describe('refusalFrom', () => {
  it('passes a refusal through, reads an aborted signal as the deadline, and names only a code', () => {
    const own = new FetchRefusedError('not_https', 'x');
    expect(refusalFrom(own, AbortSignal.abort(), () => 'y')).toBe(own);
    expect(
      refusalFrom(new Error('https://h/?token=secret'), AbortSignal.abort(), () => 'y'),
    ).toEqual(expect.objectContaining({ reasonCode: 'fetch_timeout', message: TIMEOUT_MESSAGE }));
    const failed = (code: string | null) => `failed:${String(code)}`;
    expect(
      refusalFrom(Object.assign(new Error('h'), { code: 'EPIPE' }), undefined, failed).message,
    ).toBe('failed:EPIPE');
    expect(refusalFrom(null, new AbortController().signal, failed).message).toBe('failed:null');
  });
});

describe('the fixture server', () => {
  it('refuses to start on an expired certificate', () => {
    expect(() => {
      assertCertificateCurrent(server.ca, new Date('2200-01-01T00:00:00Z'));
    }).toThrow('expired');
    expect(server.caFile.endsWith('tarball-server-cert.pem')).toBe(true);
  });
});
