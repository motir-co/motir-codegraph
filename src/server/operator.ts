import type { FastifyRequest } from 'fastify';

import { requestDb, requireOperator } from './binding.js';
import { ApiError } from './errors.js';
import { mintToken } from './tokens.js';
import type { V1Routes } from './v1.js';

const uuid = { type: 'string', format: 'uuid' } as const;
/** A display name: non-blank, bounded. */
const displayName = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;
const kind = { type: 'string', enum: ['client', 'operator'] } as const;

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const;
}

const clientParams = objectSchema({ clientId: uuid });
const credentialParams = objectSchema({ credentialId: uuid });
const grantBody = objectSchema({ clientId: uuid, tenantId: uuid });

/** One value from an operator function, called on the request's transaction. */
async function callFunction<T>(
  request: FastifyRequest,
  sql: string,
  params: unknown[],
): Promise<T> {
  const { rows } = await requestDb(request).query<{ value: T }>(`SELECT ${sql} AS value`, params);
  return (rows[0] as { value: T }).value;
}

interface ClientRow {
  client_id: string;
  name: string;
  kind: 'client' | 'operator';
  created_at: Date;
  credential_id: string | null;
  display_prefix: string | null;
  credential_created_at: Date | null;
  revoked_at: Date | null;
}

/** A row the LEFT JOIN filled: every credential column but revoked_at is set. */
type CredentialRow = ClientRow & {
  credential_id: string;
  display_prefix: string;
  credential_created_at: Date;
};

function hasCredential(row: ClientRow): row is CredentialRow {
  return row.credential_id !== null;
}

/**
 * The operator calls, under `/v1/operator/`. They carry tenant and client ids
 * in the body or under `:clientId` / `:credentialId`, never `:tenantId`: the
 * operator functions take ids as arguments, and an operator holds no grant on
 * a tenant it has just created. A client credential is refused 403 before the
 * body is validated or any query of the route runs; each function's own
 * codegraph_require_operator() is the second wall.
 */
export const operatorRoutes: V1Routes = (v1) => {
  v1.addHook('preValidation', (request, _reply, done) => {
    try {
      requireOperator(request);
      done();
    } catch (error) {
      done(error as Error);
    }
  });

  v1.post<{ Body: { displayName: string } }>(
    '/operator/tenants',
    { schema: { body: objectSchema({ displayName }) } },
    async (request, reply) => {
      const tenantId = await callFunction<string>(
        request,
        'codegraph.codegraph_create_tenant($1)',
        [request.body.displayName],
      );
      return reply.code(201).send({ tenantId });
    },
  );

  v1.post<{ Body: { tenantId: string; displayName: string } }>(
    '/operator/repositories',
    { schema: { body: objectSchema({ tenantId: uuid, displayName }) } },
    async (request, reply) => {
      const { tenantId } = request.body;
      const repositoryId = await callFunction<string>(
        request,
        'codegraph.codegraph_register_repository($1, $2)',
        [tenantId, request.body.displayName],
      );
      return reply.code(201).send({ tenantId: tenantId.toLowerCase(), repositoryId });
    },
  );

  v1.post<{ Body: { name: string; kind: 'client' | 'operator' } }>(
    '/operator/clients',
    { schema: { body: objectSchema({ name: displayName, kind }) } },
    async (request, reply) => {
      const { name, kind: clientKind } = request.body;
      const clientId = await callFunction<string>(
        request,
        'codegraph.codegraph_create_client($1, $2)',
        [name, clientKind],
      );
      return reply.code(201).send({ clientId, name, kind: clientKind });
    },
  );

  v1.get<{ Params: { clientId: string } }>(
    '/operator/clients/:clientId',
    { schema: { params: clientParams } },
    async (request) => {
      const { rows } = await requestDb(request).query<ClientRow>(
        'SELECT * FROM codegraph.codegraph_get_client($1)',
        [request.params.clientId],
      );
      const [first] = rows;
      if (first === undefined) {
        throw new ApiError('client_not_found', 'No such client.');
      }
      return {
        clientId: first.client_id,
        name: first.name,
        kind: first.kind,
        createdAt: first.created_at.toISOString(),
        credentials: rows.filter(hasCredential).map((row) => ({
          credentialId: row.credential_id,
          displayPrefix: row.display_prefix,
          createdAt: row.credential_created_at.toISOString(),
          revokedAt: row.revoked_at?.toISOString() ?? null,
        })),
      };
    },
  );

  // The one answer a token ever appears in. It is sent only after the request
  // transaction commits (onSend), so a returned token is always a stored one.
  v1.post<{ Params: { clientId: string } }>(
    '/operator/clients/:clientId/credentials',
    { schema: { params: clientParams } },
    async (request, reply) => {
      const { clientId } = request.params;
      const minted = mintToken();
      const credentialId = await callFunction<string>(
        request,
        'codegraph.codegraph_issue_credential($1, $2, $3)',
        [clientId, minted.hash, minted.displayPrefix],
      );
      return reply.code(201).header('cache-control', 'no-store').send({
        credentialId,
        clientId: clientId.toLowerCase(),
        token: minted.token,
        displayPrefix: minted.displayPrefix,
      });
    },
  );

  v1.post<{ Params: { credentialId: string } }>(
    '/operator/credentials/:credentialId/revoke',
    { schema: { params: credentialParams } },
    async (request) => {
      const { credentialId } = request.params;
      const revoked = await callFunction<boolean>(
        request,
        'codegraph.codegraph_revoke_credential($1)',
        [credentialId],
      );
      return { credentialId: credentialId.toLowerCase(), revoked };
    },
  );

  v1.post<{ Body: { clientId: string; tenantId: string } }>(
    '/operator/grants',
    { schema: { body: grantBody } },
    async (request) => {
      const { clientId, tenantId } = request.body;
      const grantId = await callFunction<string>(
        request,
        'codegraph.codegraph_grant_access($1, $2)',
        [clientId, tenantId],
      );
      return { grantId, clientId: clientId.toLowerCase(), tenantId: tenantId.toLowerCase() };
    },
  );

  v1.post<{ Body: { clientId: string; tenantId: string } }>(
    '/operator/grants/revoke',
    { schema: { body: grantBody } },
    async (request) => {
      const { clientId, tenantId } = request.body;
      const revoked = await callFunction<boolean>(
        request,
        'codegraph.codegraph_revoke_access($1, $2)',
        [clientId, tenantId],
      );
      return { clientId: clientId.toLowerCase(), tenantId: tenantId.toLowerCase(), revoked };
    },
  );
};
