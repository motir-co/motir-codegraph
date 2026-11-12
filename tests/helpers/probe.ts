import {
  requestDb,
  requireAuth,
  requireOperator,
  resolveRepository,
} from '../../src/server/binding.js';
import { ApiError } from '../../src/server/errors.js';
import type { V1Routes } from '../../src/server/v1.js';

/**
 * Test-only `/v1` routes that exercise the authentication and binding path
 * without any real route of substance. Mounted through `buildApp`'s
 * `v1Routes`; `main.ts` never mounts them.
 */
export const probeRoutes: V1Routes = (v1) => {
  v1.get('/whoami', (request) => requireAuth(request));

  v1.get<{ Params: { tenantId: string } }>('/tenants/:tenantId/repositories', async (request) => {
    const { rows } = await requestDb(request).query<{ id: string }>(
      'SELECT id FROM codegraph.repositories ORDER BY id',
    );
    return { repositoryIds: rows.map(({ id }) => id) };
  });

  v1.get<{ Params: { tenantId: string; repositoryId: string } }>(
    '/tenants/:tenantId/repositories/:repositoryId',
    async (request) => {
      const repository = await resolveRepository(request);
      return { id: repository.id, tenantId: repository.tenant_id, name: repository.display_name };
    },
  );

  v1.post('/operator-probe', (request) => {
    const auth = requireOperator(request);
    return { operator: auth.clientId };
  });

  // Calls an operator function WITHOUT the TypeScript guard, so the
  // database's own codegraph_require_operator() is what refuses a client.
  v1.post('/operator-db-probe', async (request) => {
    const { rows } = await requestDb(request).query<{ id: string }>(
      "SELECT codegraph.codegraph_create_tenant('probe tenant') AS id",
    );
    return { tenantId: rows[0]?.id };
  });

  // Renames a repository of the bound tenant, then answers or throws: the
  // write is kept only by a success answer.
  v1.post<{
    Params: { tenantId: string; repositoryId: string };
    Querystring: { fail?: string };
  }>('/tenants/:tenantId/repositories/:repositoryId/rename-probe', async (request) => {
    const repository = await resolveRepository(request);
    const name = `renamed-${String(Date.now())}`;
    await requestDb(request).query(
      'UPDATE codegraph.repositories SET display_name = $1 WHERE id = $2',
      [name, repository.id],
    );
    if (request.query.fail !== undefined) {
      throw new ApiError('permission_denied', 'probe failure after a write');
    }
    return { name };
  });
};
