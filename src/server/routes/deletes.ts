import type { FastifyRequest } from 'fastify';

import {
  isUuid,
  requestDb,
  requireAuth,
  tenantExists,
  type TenantRouteConfig,
} from '../binding.js';
import { ApiError } from '../errors.js';
import type { V1Routes } from '../v1.js';

/**
 * Both delete routes admit an operator to any tenant, and answer a client's
 * ungranted tenant 404 when it is gone, so a retried delete reads as done.
 */
export const DELETE_ROUTE_CONFIG: TenantRouteConfig = {
  operatorAnyTenant: true,
  absentTenant: 'tenant_not_found',
};

const NO_TENANT = 'No such tenant.';
const NO_REPOSITORY = 'No such repository.';

interface TenantParams {
  tenantId: string;
}
interface RepositoryParams extends TenantParams {
  repositoryId: string;
}

async function scalar<T>(request: FastifyRequest, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await requestDb(request).query<{ value: T }>(`SELECT ${sql} AS value`, params);
  return (rows[0] as { value: T }).value;
}

/**
 * Deletes the path tenant; the schema's cascades remove its repositories,
 * their access-log rows and its grants. A client deletes as codegraph_app
 * under the binding, so only the tenant it is bound and granted can match.
 * An operator goes through the operator-gated definer function. Nothing
 * deleted is 404 `tenant_not_found`.
 */
export async function deleteTenant(request: FastifyRequest<{ Params: TenantParams }>) {
  const auth = requireAuth(request);
  const tenantId = request.params.tenantId.toLowerCase();
  const deleted =
    auth.kind === 'operator'
      ? await scalar<boolean>(request, 'codegraph.codegraph_delete_tenant_as_operator($1)', [
          tenantId,
        ])
      : (
          await requestDb(request).query(
            'DELETE FROM codegraph.tenants WHERE id = $1 RETURNING id',
            [tenantId],
          )
        ).rowCount === 1;
  if (!deleted) {
    throw new ApiError('tenant_not_found', NO_TENANT);
  }
}

/**
 * Deletes the path repository where it sits under the path tenant; the
 * cascade removes its access-log rows. A malformed repository id is refused
 * without a query. For an operator, a miss is told apart: an absent tenant is
 * 404 `tenant_not_found`, otherwise `repository_not_found`. A client's tenant
 * is already known to exist, since it holds a grant on it.
 */
export async function deleteRepository(request: FastifyRequest<{ Params: RepositoryParams }>) {
  const auth = requireAuth(request);
  const tenantId = request.params.tenantId.toLowerCase();
  const { repositoryId } = request.params;
  if (!isUuid(repositoryId)) {
    throw new ApiError('repository_not_found', NO_REPOSITORY);
  }
  if (auth.kind === 'operator') {
    const deleted = await scalar<boolean>(
      request,
      'codegraph.codegraph_delete_repository_as_operator($1, $2)',
      [tenantId, repositoryId],
    );
    if (deleted) {
      return;
    }
    if (!(await tenantExists(requestDb(request), tenantId))) {
      throw new ApiError('tenant_not_found', NO_TENANT);
    }
    throw new ApiError('repository_not_found', NO_REPOSITORY);
  }
  const { rowCount } = await requestDb(request).query(
    'DELETE FROM codegraph.repositories WHERE tenant_id = $1 AND id = $2 RETURNING id',
    [tenantId, repositoryId],
  );
  if (rowCount !== 1) {
    throw new ApiError('repository_not_found', NO_REPOSITORY);
  }
}

/**
 * `DELETE /v1/tenants/:tenantId` and
 * `DELETE /v1/tenants/:tenantId/repositories/:repositoryId`: 204 on success,
 * committed before the answer; any refusal rolls the transaction back.
 */
export const deleteRoutes: V1Routes = (v1) => {
  v1.delete<{ Params: TenantParams }>(
    '/tenants/:tenantId',
    { config: DELETE_ROUTE_CONFIG },
    async (request, reply) => {
      await deleteTenant(request);
      return reply.code(204).send();
    },
  );

  v1.delete<{ Params: RepositoryParams }>(
    '/tenants/:tenantId/repositories/:repositoryId',
    { config: DELETE_ROUTE_CONFIG },
    async (request, reply) => {
      await deleteRepository(request);
      return reply.code(204).send();
    },
  );
};
