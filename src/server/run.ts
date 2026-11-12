import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { requireEnv } from '../config.js';
import { buildApp } from './app.js';
import { createAppPool } from './pool.js';

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = '0.0.0.0';

/** `PORT`, or 8080 when it is unset: it names a socket, not a database. */
export function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be a port number from 0 to 65535, not ${raw}.`);
  }
  return port;
}

export interface RunningServer {
  app: FastifyInstance;
  pool: pg.Pool;
  /** The address the listener is bound to, e.g. `http://127.0.0.1:8080`. */
  address: string;
  /** Closes the listener (finishing in-flight requests), then the pool. */
  shutdown(): Promise<void>;
}

/**
 * Starts the server from the environment: connects as codegraph_app
 * (`DATABASE_APP_URL`), listens on `HOST`:`PORT`. `main.ts` calls this and
 * wires `shutdown` to SIGTERM and SIGINT.
 */
export async function runServer(
  env: NodeJS.ProcessEnv = process.env,
  logger: FastifyServerOptions['logger'] = true,
): Promise<RunningServer> {
  const appUrl = requireEnv('DATABASE_APP_URL', env);
  const port = readPort(env);
  const host = env.HOST === undefined || env.HOST.trim() === '' ? DEFAULT_HOST : env.HOST;
  const pool = createAppPool(appUrl);
  let app: FastifyInstance;
  try {
    app = await buildApp({ pool, logger });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const address = await app.listen({ port, host });

  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= (async () => {
      await app.close();
      await pool.end();
    })();
    return closing;
  };
  return { app, pool, address, shutdown };
}
