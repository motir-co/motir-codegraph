import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export const V1_PREFIX = '/v1';

/** A module of `/v1` routes: registers its routes on the plugin it is given. */
export type V1Routes = (v1: FastifyInstance) => void | Promise<void>;

export interface V1Options {
  pool: pg.Pool;
  /** Extra route modules mounted on `/v1`, for tests only; `main.ts` passes none. */
  routes?: readonly V1Routes[];
}

/**
 * The `/v1` plugin, registered with `prefix: '/v1'`. Every versioned route is
 * registered here and nowhere else, so whatever this plugin installs applies
 * to all of them.
 */
export async function v1Plugin(app: FastifyInstance, options: V1Options): Promise<void> {
  for (const routes of options.routes ?? []) {
    await app.register(async (scope) => {
      await routes(scope);
    });
  }
}
