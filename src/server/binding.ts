import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';

import { type AuthContext, finishRequestDb } from './auth.js';
import { ApiError } from './errors.js';

/** The path parameter a route names its tenant by. */
export const TENANT_PARAM = 'tenantId';
/** The path parameter a route names its repository by. */
export const REPOSITORY_PARAM = 'repositoryId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The binding statement: both settings in one round trip. */
export const BIND_TENANT_SQL =
  "SELECT set_config('app.client_id', $1, true), set_config('app.tenant_id', $2, true)";
export const BIND_CLIENT_SQL = "SELECT set_config('app.client_id', $1, true)";

/** The authenticated client, which every `/v1` handler has. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    // Unreachable through the /v1 hooks; a route outside them is a bug.
    throw new Error('route handled without authentication');
  }
  return request.auth;
}

/** The request's connection, inside its bound transaction. */
export function requestDb(request: FastifyRequest) {
  const state = request.dbState;
  if (state === null || state.finished) {
    throw new Error('route handled without a request transaction');
  }
  return state.client;
}

/**
 * What a route may declare (`config`) about its `:tenantId`. Only the two
 * delete routes declare anything; every other route takes the defaults.
 */
export interface TenantRouteConfig {
  /**
   * An operator is admitted to any tenant, granted or not, and bound with
   * `app.client_id` only: the route reaches the tenant through an
   * operator-gated definer function, never through the tenant binding.
   */
  operatorAnyTenant?: boolean;
  /**
   * A client naming a tenant it holds no grant on is answered this 404 when
   * the tenant does not exist (403 when it does), so a retried delete of a
   * tenant that is gone reads as done.
   */
  absentTenant?: 'tenant_not_found';
}

declare module 'fastify' {
  interface FastifyContextConfig {
    operatorAnyTenant?: boolean;
    absentTenant?: 'tenant_not_found';
  }
}

const NO_TENANT = 'No such tenant.';
const TENANT_DENIED = 'The credential may not use this tenant.';

/** What the binding hook binds: the client and a tenant, or the client only. */
export type TenantAccess = { tenantId: string } | { tenantId: null };

/**
 * Decides whether the client may use the path tenant, before any statement
 * of the route runs. By default a tenant the client holds no live grant on
 * is refused 403 whether or not it exists, so a client cannot probe which
 * tenant ids exist. A route's `config` may relax that (see
 * `TenantRouteConfig`). Returns the tenant to bind, lower-cased, or null to
 * bind the client only.
 */
export async function checkTenantAccess(
  db: pg.ClientBase,
  auth: AuthContext,
  tenantId: string,
  config: TenantRouteConfig,
): Promise<TenantAccess> {
  if (config.operatorAnyTenant === true && auth.kind === 'operator') {
    if (!isUuid(tenantId)) {
      throw new ApiError('tenant_not_found', NO_TENANT);
    }
    return { tenantId: null };
  }
  const normalized = tenantId.toLowerCase();
  if (auth.tenantIds.includes(normalized)) {
    return { tenantId: normalized };
  }
  if (config.absentTenant !== undefined) {
    if (!isUuid(tenantId) || !(await tenantExists(db, normalized))) {
      throw new ApiError(config.absentTenant, NO_TENANT);
    }
  }
  throw new ApiError('permission_denied', TENANT_DENIED);
}

/** Whether a tenant with this id exists, read through the definer function. */
export async function tenantExists(db: pg.ClientBase, tenantId: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    'SELECT codegraph.codegraph_tenant_exists($1) AS exists',
    [tenantId],
  );
  return (rows[0] as { exists: boolean }).exists;
}

function pathParam(request: FastifyRequest, name: string): string | undefined {
  const params = request.params as Record<string, string | undefined> | undefined;
  return params?.[name];
}

/**
 * The `/v1` binding hook (`preHandler`, once route params are known). A route
 * naming `:tenantId` has the tenant checked against the client's grants, then
 * ONE statement binds `app.client_id` and `app.tenant_id` for the
 * transaction; a route naming no tenant, or an operator on a route that admits
 * it to any tenant, binds the client only.
 */
export async function bind(request: FastifyRequest): Promise<void> {
  const auth = requireAuth(request);
  const db = requestDb(request);
  const tenantId = pathParam(request, TENANT_PARAM);
  if (tenantId === undefined) {
    await db.query(BIND_CLIENT_SQL, [auth.clientId]);
    return;
  }
  const access = await checkTenantAccess(db, auth, tenantId, request.routeOptions.config);
  if (access.tenantId === null) {
    await db.query(BIND_CLIENT_SQL, [auth.clientId]);
    return;
  }
  await db.query(BIND_TENANT_SQL, [auth.clientId, access.tenantId]);
}

/** 403 `permission_denied` unless the request carries an operator credential. */
export function requireOperator(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.kind !== 'operator') {
    throw new ApiError('permission_denied', 'This call needs an operator credential.');
  }
  return auth;
}

export interface RepositoryRow {
  id: string;
  tenant_id: string;
  display_name: string;
  created_at: Date;
}

/**
 * The repository a route names under its bound, granted tenant. A malformed
 * id is refused without a query; a missing one, or one in another tenant
 * (invisible under the binding), answers 404. Never an empty answer.
 */
export async function resolveRepository(request: FastifyRequest): Promise<RepositoryRow> {
  const repositoryId = pathParam(request, REPOSITORY_PARAM);
  if (repositoryId === undefined || !isUuid(repositoryId)) {
    throw new ApiError('repository_not_found', 'No such repository.');
  }
  const { rows } = await requestDb(request).query<RepositoryRow>(
    'SELECT id, tenant_id, display_name, created_at FROM codegraph.repositories WHERE id = $1',
    [repositoryId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new ApiError('repository_not_found', 'No such repository.');
  }
  return row;
}

/**
 * Ends the transaction before the answer leaves (`onSend`): a success answer
 * commits, so a response the caller sees is always one the database kept; an
 * error answer rolls back.
 */
export async function commitOrRollback(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  await finishRequestDb(request, reply.statusCode < 400);
  return payload;
}

/** The last exit (`onResponse`): whatever happened, the connection goes back. */
export async function releaseRequestDb(request: FastifyRequest): Promise<void> {
  try {
    await finishRequestDb(request, false);
  } catch (error) {
    request.log.error({ err: error }, 'rollback failed');
  }
}
