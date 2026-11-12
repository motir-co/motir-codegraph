import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';

/**
 * Every error the server answers, by code. The code is what a caller branches
 * on; the status is derived from it, so the two can never disagree.
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  permission_denied: 403,
  repository_not_found: 404,
  tenant_not_found: 404,
  client_not_found: 404,
  route_not_found: 404,
  internal_error: 500,
  service_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** SQLSTATE 42501. */
export const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * SQLSTATEs an operator function raises for input the request schemas did
 * not catch: a check, a not-null or a value the type refuses.
 */
const INVALID_INPUT_STATES: readonly string[] = ['23514', '23502', '22P02', '22001'];
const FOREIGN_KEY_VIOLATION = '23503';

/** The constraint that names what a foreign-key violation did not find. */
const NO_TENANT = { code: 'tenant_not_found', message: 'No such tenant.' } as const;
const NO_CLIENT = { code: 'client_not_found', message: 'No such client.' } as const;
const MISSING_REFERENCE: Readonly<
  Record<string, { code: ErrorCode; message: string } | undefined>
> = {
  repositories_tenant_id_fkey: NO_TENANT,
  grants_tenant_id_fkey: NO_TENANT,
  credentials_client_id_fkey: NO_CLIENT,
  grants_client_id_fkey: NO_CLIENT,
};

/** A client error Fastify itself raised: schema validation, a malformed body. */
function isFastifyClientError(error: FastifyError | Error): error is FastifyError {
  const { statusCode } = error as Partial<FastifyError>;
  return (
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500 &&
    ('validation' in error || (error as Partial<FastifyError>).code?.startsWith('FST_') === true)
  );
}

/** The one error body every refusal and failure is answered with. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

/** Thrown by a handler or hook to answer with `code` and `message`. */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }

  get statusCode(): number {
    return ERROR_STATUS[this.code];
  }
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Answers `code` with its status and the one error body. */
export function sendError(reply: FastifyReply, code: ErrorCode, message: string): FastifyReply {
  return reply.code(ERROR_STATUS[code]).send(errorBody(code, message));
}

/**
 * The application's error handler. An `ApiError` answers its own code; any
 * other error is logged and answered `internal_error` with a fixed message, so
 * neither its message nor its stack reaches the caller.
 */
export function handleError(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ApiError) {
    return sendError(reply, error.code, error.message);
  }
  // The database refusing the bound client (codegraph_require_operator() in
  // every operator function raises insufficient_privilege) is the same
  // refusal as the server's own guards.
  if (error instanceof pg.DatabaseError && error.code === INSUFFICIENT_PRIVILEGE) {
    return sendError(reply, 'permission_denied', 'The credential may not make this call.');
  }
  if (isFastifyClientError(error)) {
    return sendError(reply, 'invalid_request', error.message);
  }
  if (error instanceof pg.DatabaseError && error.code !== undefined) {
    if (INVALID_INPUT_STATES.includes(error.code)) {
      return sendError(reply, 'invalid_request', 'The request is not valid.');
    }
    const missing =
      error.code === FOREIGN_KEY_VIOLATION ? MISSING_REFERENCE[error.constraint ?? ''] : undefined;
    if (missing !== undefined) {
      return sendError(reply, missing.code, missing.message);
    }
  }
  request.log.error({ err: error }, 'unhandled error');
  return sendError(reply, 'internal_error', 'The server could not complete the request.');
}

/** Any path no route answers. */
export function handleNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const path = request.url.split('?', 1)[0] ?? request.url;
  return sendError(reply, 'route_not_found', `No route answers ${request.method} ${path}.`);
}
