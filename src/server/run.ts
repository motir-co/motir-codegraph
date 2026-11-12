import { isIP } from 'node:net';

import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { requireEnv } from '../config.js';
import { buildApp } from './app.js';
import { createAppPool } from './pool.js';
import { DEFAULT_FAILED_AUTH_LIMIT, DEFAULT_RATE_LIMIT, type RateLimitSettings } from './v1.js';

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

/** A per-minute limit from `name`, or `fallback` when it is unset. */
function readPerMinute(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: RateLimitSettings,
): RateLimitSettings {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`${name} must be a whole number of 1 or more, not ${raw}.`);
  }
  return { max, timeWindowMs: 60_000 };
}

/**
 * `RATE_LIMIT_PER_MINUTE`, the requests one caller may make to `/v1` per
 * minute on one copy; 1200 when it is unset.
 */
export function readRateLimit(env: NodeJS.ProcessEnv): RateLimitSettings {
  return readPerMinute(env, 'RATE_LIMIT_PER_MINUTE', DEFAULT_RATE_LIMIT);
}

/**
 * `FAILED_AUTH_LIMIT_PER_MINUTE`, the failed authentications one client
 * address may make to `/v1` per minute on one copy; 60 when it is unset.
 */
export function readFailedAuthLimit(env: NodeJS.ProcessEnv): RateLimitSettings {
  return readPerMinute(env, 'FAILED_AUTH_LIMIT_PER_MINUTE', DEFAULT_FAILED_AUTH_LIMIT);
}

/** The names `proxy-addr` accepts for its preset ranges. */
const PROXY_RANGE_NAMES: readonly string[] = ['loopback', 'linklocal', 'uniquelocal'];

function isProxyAddress(entry: string): boolean {
  if (PROXY_RANGE_NAMES.includes(entry)) {
    return true;
  }
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
}

/**
 * `TRUST_PROXY`, the comma-separated addresses and CIDR ranges of the proxies
 * in front of the server (the load balancer's subnets) whose
 * `X-Forwarded-For` is believed, so `request.ip`, which the
 * failed-authentication limit counts by, is the real client. Unset trusts
 * none, and every caller behind a proxy then shares its address.
 */
export function readTrustProxy(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const entries = raw.split(',').map((entry) => entry.trim());
  if (!entries.every(isProxyAddress)) {
    throw new Error(
      `TRUST_PROXY must be a comma-separated list of proxy addresses and CIDR ranges, not ${raw}.`,
    );
  }
  return entries;
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
 * (`DATABASE_APP_URL`), listens on `HOST`:`PORT`, limits each caller to
 * `RATE_LIMIT_PER_MINUTE` and each address to `FAILED_AUTH_LIMIT_PER_MINUTE`
 * failed authentications, reading addresses through `TRUST_PROXY`. `main.ts` calls this and
 * wires `shutdown` to SIGTERM and SIGINT.
 */
export async function runServer(
  env: NodeJS.ProcessEnv = process.env,
  logger: FastifyServerOptions['logger'] = true,
): Promise<RunningServer> {
  const appUrl = requireEnv('DATABASE_APP_URL', env);
  const port = readPort(env);
  const rateLimit = readRateLimit(env);
  const failedAuthLimit = readFailedAuthLimit(env);
  const trustProxy = readTrustProxy(env);
  const host = env.HOST === undefined || env.HOST.trim() === '' ? DEFAULT_HOST : env.HOST;
  const pool = createAppPool(appUrl);
  let app: FastifyInstance;
  try {
    app = await buildApp({ pool, logger, rateLimit, failedAuthLimit, trustProxy });
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
