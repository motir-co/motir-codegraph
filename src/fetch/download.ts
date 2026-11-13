/**
 * One https GET of a source archive into a file, with the address screen,
 * the redirect walk, the byte cap and the caller's deadline.
 *
 * Each hop: the scheme is settled first (https only), the host is resolved
 * ONCE and every answer screened (`resolveAndScreen`), and the connection is
 * opened to the screened ADDRESS while the URL's host name travels as the TLS
 * server name and the Host header — so the certificate is checked against the
 * name the caller asked for and nothing the resolver could change afterwards.
 * A redirect is a new name, so it goes through the same steps, at most
 * `MAX_REDIRECTS` times.
 *
 * The cap is held twice: a declared Content-Length over it refuses before the
 * body is read, and the streamed byte count refuses the moment it passes, so a
 * server that lies about (or omits) its length gets no further than the cap.
 *
 * Nothing here logs, and no message carries the URL or anything the server
 * sent.
 */
import { createWriteStream } from 'node:fs';
import { request, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { bareHost, resolveAndScreen, type Resolver } from './addressScreen.js';
import { FetchRefusedError, refusalFrom, withCode } from './errors.js';

/** Redirects followed before a fetch is refused. */
export const MAX_REDIRECTS = 3;

export interface DownloadOptions {
  /** Where the body is written. */
  readonly dest: string;
  /** The compressed-bytes cap. */
  readonly byteCap: number;
  readonly allowedHosts: readonly string[];
  readonly resolver: Resolver;
  /** Aborts the whole download, redirects included. */
  readonly signal: AbortSignal;
  /** Extra certificate authorities to trust (the test fixture's). */
  readonly ca?: string | Buffer | undefined;
}

function tooLarge(): FetchRefusedError {
  return new FetchRefusedError(
    'source_too_large',
    'The source archive is larger than FETCH_BYTE_CAP_BYTES.',
  );
}

/** The https URL a hop goes to, or `not_https`. */
export function httpsUrl(raw: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new FetchRefusedError('not_https', 'The fetch URL is not an absolute https URL.');
  }
  if (url.protocol !== 'https:') {
    throw new FetchRefusedError('not_https', 'The fetch URL is not an absolute https URL.');
  }
  return url;
}

/** Counts bytes through, refusing past the cap. */
class ByteCap extends Transform {
  private seen = 0;

  constructor(private readonly cap: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.cap) {
      done(tooLarge());
      return;
    }
    done(null, chunk);
  }
}

/** Sends one GET to the pinned address and answers the response head. */
function get(url: URL, address: string, options: DownloadOptions): Promise<IncomingMessage> {
  const host = bareHost(url.hostname);
  const requestOptions: RequestOptions = {
    host: address,
    port: url.port === '' ? 443 : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { host: url.host, 'accept-encoding': 'identity' },
    // A server name is a DNS name; an IP literal host is checked by address.
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    agent: false,
    signal: options.signal,
  };
  return new Promise((resolve, reject) => {
    const req = request(requestOptions, resolve);
    req.on('error', reject);
    req.end();
  });
}

/**
 * Downloads `url` into `options.dest`, following at most `MAX_REDIRECTS`
 * https redirects, and answers the bytes written. Every failure is a
 * `FetchRefusedError`.
 */
export async function download(url: URL, options: DownloadOptions): Promise<number> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const pinned = await resolveAndScreen(current.hostname, options);
    let response: IncomingMessage;
    try {
      response = await get(current, pinned.address, options);
    } catch (error) {
      throw refusalFrom(
        error,
        options.signal,
        (code) => `The source could not be downloaded${withCode(code)}.`,
      );
    }
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location !== undefined) {
      response.resume();
      if (hop >= MAX_REDIRECTS) {
        throw new FetchRefusedError(
          'fetch_failed',
          `The source redirected more than ${String(MAX_REDIRECTS)} times.`,
        );
      }
      current = httpsUrl(response.headers.location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new FetchRefusedError(
        'fetch_failed',
        `The source answered HTTP ${String(status)}, not a success.`,
      );
    }
    const declared = response.headers['content-length'];
    if (declared !== undefined && Number(declared) > options.byteCap) {
      response.destroy();
      throw tooLarge();
    }
    const cap = new ByteCap(options.byteCap);
    let written = 0;
    cap.on('data', (chunk: Buffer) => {
      written += chunk.length;
    });
    try {
      await pipeline(response, cap, createWriteStream(options.dest), { signal: options.signal });
    } catch (error) {
      response.destroy();
      throw refusalFrom(
        error,
        options.signal,
        (code) => `The source could not be downloaded${withCode(code)}.`,
      );
    }
    return written;
  }
}
