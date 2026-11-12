import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

import { ApiError } from './errors.js';

/** The longest token the server will hash; anything longer is malformed. */
export const MAX_TOKEN_LENGTH = 512;

export type ClientKind = 'client' | 'operator';

/** The authenticated client of one request. */
export interface AuthContext {
  clientId: string;
  kind: ClientKind;
  /** The tenants the client holds a live grant on, read at authentication. */
  tenantIds: readonly string[];
}

/** The request's one connection and transaction. */
export interface RequestDb {
  client: pg.PoolClient;
  /** Set once the transaction has been committed or rolled back. */
  finished: boolean;
  released: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated client; set on every `/v1` route handler. */
    auth: AuthContext | null;
    /** The request's transaction state; internal to auth and binding. */
    dbState: RequestDb | null;
  }
}

/**
 * The token in an `Authorization: Bearer <token>` header, or null when the
 * header is missing, names another scheme, or carries an empty token, one
 * holding whitespace, or one longer than {@link MAX_TOKEN_LENGTH}.
 */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer (.*)$/is.exec(header);
  const token = match?.[1];
  if (token === undefined || token === '' || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    return null;
  }
  return token;
}

/** A token's SHA-256: the only form the database ever stores or compares. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

const UNAUTHENTICATED = 'A valid bearer credential is required.';

interface AuthenticateRow {
  client_id: string;
  client_kind: ClientKind;
  tenant_ids: string[];
}

/**
 * Ends the request's transaction (commit or rollback) and releases its
 * connection. Idempotent, so every exit path may call it.
 */
export async function finishRequestDb(request: FastifyRequest, commit: boolean): Promise<void> {
  const state = request.dbState;
  if (state === null || state.released) {
    return;
  }
  let failure: unknown;
  if (!state.finished) {
    state.finished = true;
    try {
      await state.client.query(commit ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      failure = error;
    }
  }
  state.released = true;
  // A connection whose COMMIT or ROLLBACK failed is in an unknown state:
  // destroy it rather than hand it to the next request.
  state.client.release(failure === undefined ? undefined : true);
  if (failure !== undefined) {
    throw new Error('ending the request transaction failed', { cause: failure });
  }
}

/**
 * The `/v1` authentication hook (`onRequest`). A malformed or missing
 * credential is refused before any query. Otherwise the request takes one
 * connection, opens its transaction and calls `codegraph_authenticate()`
 * once; no row (an unknown or revoked credential) rolls back and refuses.
 */
export function authenticate(pool: pg.Pool) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = parseBearer(request.headers.authorization);
    if (token === null) {
      throw new ApiError('unauthenticated', UNAUTHENTICATED);
    }

    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      request.log.warn({ err: error }, 'database unavailable');
      throw new ApiError('service_unavailable', 'The database cannot be reached.');
    }
    request.dbState = { client, finished: false, released: false };

    await client.query('BEGIN');
    const { rows } = await client.query<AuthenticateRow>(
      'SELECT client_id, client_kind, tenant_ids FROM codegraph.codegraph_authenticate($1)',
      [hashToken(token)],
    );
    const row = rows[0];
    if (row === undefined) {
      await finishRequestDb(request, false);
      throw new ApiError('unauthenticated', UNAUTHENTICATED);
    }
    request.auth = { clientId: row.client_id, kind: row.client_kind, tenantIds: row.tenant_ids };
  };
}
