import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

// An https server on a loopback port that serves source tarballs the way a
// git host's archive endpoint does, for the fetcher's tests and for anything
// that runs a job end to end. Its certificate is committed under certs/ (long
// dated, for localhost, 127.0.0.1 and ::1); an in-process fetch trusts it
// through `ca` (the PEM), a child process through NODE_EXTRA_CA_CERTS (`caFile`).
//
// It listens on 127.0.0.1 only. An in-process fetch pins `localhost` there with
// its own resolver; a fetch through the system resolver (a worker process, or
// the real fetcher's default) does not, and the fetcher connects to the FIRST
// address a name resolves to — on a host whose `localhost` answers ::1 first
// (GitHub's runners) that is a port nobody listens on. Such a fetch takes
// `originHost: '127.0.0.1'`: an IP literal, never resolved, on the certificate.

const CERTS = join(fileURLToPath(new URL('.', import.meta.url)), 'certs');
/** The committed certificate's file, for a child process's NODE_EXTRA_CA_CERTS. */
export const TARBALL_SERVER_CA_FILE = join(CERTS, 'tarball-server-cert.pem');
const KEY_FILE = join(CERTS, 'tarball-server-key.pem');

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface TarballServer {
  /** `https://<originHost>:<port>` — no trailing slash. */
  readonly origin: string;
  readonly port: number;
  /** The certificate as PEM, for an in-process fetch's `tls.ca`. */
  readonly ca: string;
  /** The certificate's file path, for a child process's NODE_EXTRA_CA_CERTS. */
  readonly caFile: string;
  /** Every request seen: its path (with query) and Host header. */
  readonly requests: { path: string; host: string | undefined }[];
  /** Serves a named commit's tarball at `/<repo>/archive/<commit>.tar.gz`; answers its URL. */
  commit(repo: string, commit: string, bytes: Buffer): string;
  /** Serves `bytes` at `path` (with a Content-Length unless `chunked`); answers its URL. */
  serve(path: string, bytes: Buffer, options?: { chunked?: boolean; status?: number }): string;
  /** Routes `path` to an arbitrary handler; answers its URL. */
  route(path: string, handler: Handler): string;
  /** Redirects `path` to `location` with a 302; answers its URL. */
  redirect(path: string, location: string): string;
  close(): Promise<void>;
}

/** Refuses to start on a certificate that has expired, naming the file. */
export function assertCertificateCurrent(pem: string, now = new Date()): void {
  const validTo = new Date(new X509Certificate(pem).validTo);
  if (validTo.getTime() <= now.getTime()) {
    throw new Error(
      `The test certificate ${TARBALL_SERVER_CA_FILE} expired on ${validTo.toISOString()}; regenerate it.`,
    );
  }
}

export interface TarballServerOptions {
  /**
   * The host every URL it answers names: `localhost` (the default) for a fetch
   * that pins the name with its own resolver, `127.0.0.1` for one that resolves
   * through the system and must not depend on its address order.
   */
  readonly originHost?: 'localhost' | '127.0.0.1';
}

export async function startTarballServer(
  options: TarballServerOptions = {},
): Promise<TarballServer> {
  const ca = readFileSync(TARBALL_SERVER_CA_FILE, 'utf8');
  assertCertificateCurrent(ca);
  const routes = new Map<string, Handler>();
  const requests: { path: string; host: string | undefined }[] = [];
  const server: Server = createServer(
    { key: readFileSync(KEY_FILE, 'utf8'), cert: ca },
    (req, res) => {
      const path = req.url ?? '/';
      requests.push({ path, host: req.headers.host });
      const handler = routes.get(path.split('?')[0] ?? path);
      // The path is the client's: only a registered handler is ever called.
      if (typeof handler !== 'function') {
        res.writeHead(404).end('not found');
        return;
      }
      handler(req, res);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `https://${options.originHost ?? 'localhost'}:${String(port)}`;
  const route = (path: string, handler: Handler) => {
    routes.set(path, handler);
    return `${origin}${path}`;
  };
  const serve = (
    path: string,
    bytes: Buffer,
    options: { chunked?: boolean; status?: number } = {},
  ) =>
    route(path, (_req, res) => {
      const headers: Record<string, string> = { 'content-type': 'application/gzip' };
      if (options.chunked !== true) headers['content-length'] = String(bytes.length);
      res.writeHead(options.status ?? 200, headers);
      if (options.chunked === true) {
        // Several writes with no declared length: the body arrives chunked.
        const step = Math.max(1, Math.ceil(bytes.length / 8));
        for (let i = 0; i < bytes.length; i += step) res.write(bytes.subarray(i, i + step));
        res.end();
      } else {
        res.end(bytes);
      }
    });
  return {
    origin,
    port,
    ca,
    caFile: TARBALL_SERVER_CA_FILE,
    requests,
    commit: (repo, commit, bytes) => serve(`/${repo}/archive/${commit}.tar.gz`, bytes),
    serve,
    route,
    redirect: (path, location) =>
      route(path, (_req, res) => {
        res.writeHead(302, { location }).end();
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
