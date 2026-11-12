import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

export interface HealthBody {
  status: 'ok' | 'unavailable';
  process: { up: true; uptimeSeconds: number };
  database: { up: boolean };
}

/** Resolves true when `SELECT 1` answers within `timeoutMs`, false otherwise. */
export async function databaseUp(pool: pg.Pool, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  const probe = pool.query('SELECT 1').then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([probe, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /health`, the one route outside `/v1`. It needs no credential, because
 * the load balancer calls it, and reports the process and its database: 200
 * when `SELECT 1` answers, 503 when it fails or does not answer in time.
 */
export function registerHealth(
  app: FastifyInstance,
  pool: pg.Pool,
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): void {
  app.get('/health', async (_request, reply) => {
    const up = await databaseUp(pool, timeoutMs);
    const body: HealthBody = {
      status: up ? 'ok' : 'unavailable',
      process: { up: true, uptimeSeconds: Math.round(process.uptime()) },
      database: { up },
    };
    return reply
      .code(up ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(body);
  });
}
