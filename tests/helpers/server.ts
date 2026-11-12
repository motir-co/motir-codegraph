import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { buildApp, type BuildAppOptions } from '../../src/server/app.js';
import { createAppPool } from '../../src/server/pool.js';

export interface ServerCopy {
  app: FastifyInstance;
  pool: pg.Pool;
  /** e.g. `http://127.0.0.1:41234` */
  baseUrl: string;
  stop(): Promise<void>;
}

export interface Copies {
  copies: ServerCopy[];
  baseUrls: string[];
  stop(): Promise<void>;
}

export type CopyOptions = Omit<BuildAppOptions, 'pool'>;

/**
 * One copy of the server, as `main.ts` builds it: its own codegraph_app pool
 * and a real listener on an ephemeral port, so tests drive the same sockets a
 * load balancer would.
 */
export async function startServer(appUrl: string, options: CopyOptions = {}): Promise<ServerCopy> {
  const pool = createAppPool(appUrl);
  const app = await buildApp({ ...options, pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  let stopped: Promise<void> | undefined;
  return {
    app,
    pool,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    stop() {
      stopped ??= (async () => {
        await app.close();
        await pool.end();
      })();
      return stopped;
    },
  };
}

/** `n` copies against one database, each with its own pool and port. */
export async function startCopies(
  appUrl: string,
  n: number,
  options: CopyOptions = {},
): Promise<Copies> {
  const copies: ServerCopy[] = [];
  try {
    for (let i = 0; i < n; i += 1) {
      copies.push(await startServer(appUrl, options));
    }
  } catch (error) {
    await Promise.all(copies.map((copy) => copy.stop()));
    throw error;
  }
  return {
    copies,
    baseUrls: copies.map((copy) => copy.baseUrl),
    async stop() {
      await Promise.all(copies.map((copy) => copy.stop()));
    },
  };
}

/** A JSON call against a running copy. */
export async function call(
  baseUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== undefined) {
    headers.authorization = `Bearer ${init.token}`;
  }
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? null : (JSON.parse(text) as unknown),
  };
}
