import { Ajv } from 'ajv';
import type { FastifyReply, FastifyRequest, FastifySchema } from 'fastify';

import { enqueueJob, JobKind, supersedeQueuedPushes } from '../../db/indexJobs.js';
import { requestDb, requireAuth, resolveRepository } from '../binding.js';
import { ApiError } from '../errors.js';
import type { V1Routes } from '../v1.js';

/**
 * The longest `fetchUrl` accepted. A pre-signed tarball URL carries a long
 * query string; the bound keeps the row and any accidental rendering bounded.
 * It is not a security control: screening the address is the fetcher's job.
 */
export const MAX_FETCH_URL_LENGTH = 8192;
/** The longest ref name accepted, stored byte-for-byte as sent. */
export const MAX_REF_LENGTH = 1024;
/** The most `changedPaths` entries a push may carry, and the longest one. */
export const MAX_CHANGED_PATHS = 10_000;
export const MAX_CHANGED_PATH_LENGTH = 4096;

/** The one sentence a fetch URL that fails its shape check is refused with. */
export const FETCH_URL_REFUSED = 'fetchUrl must be an absolute http or https URL.';

/**
 * A SHA-1 commit id: 40 lowercase hex. A SHA-256 id (64) is refused, because
 * the fetcher hashes blobs with SHA-1 and would index ids no repository holds.
 */
const commitId = { type: 'string', pattern: '^[0-9a-f]{40}$' } as const;
/** Non-blank: at least one character that is not white space. */
const ref = { type: 'string', minLength: 1, maxLength: MAX_REF_LENGTH, pattern: '\\S' } as const;
const flag = { type: 'boolean' } as const;
/**
 * Only bounded here; its shape is checked in the handler, after the
 * repository resolves, with a fixed sentence that can never echo the value.
 */
const fetchUrl = { type: 'string', maxLength: MAX_FETCH_URL_LENGTH } as const;
const changedPaths = {
  type: 'array',
  maxItems: MAX_CHANGED_PATHS,
  items: { type: 'string', minLength: 1, maxLength: MAX_CHANGED_PATH_LENGTH },
} as const;

/**
 * These routes' own validator: the app's Ajv coerces types (Fastify's
 * default), which would accept `"true"` for `isDefaultBranch` and a bare
 * string for `changedPaths`. A JSON body has its types already, so here a
 * value of the wrong type is refused rather than converted, and an unnamed
 * field is refused rather than dropped.
 */
const strictAjv = new Ajv({ coerceTypes: false, removeAdditional: false, allErrors: false });

function routeSchema(
  params: object,
  body: object,
): {
  schema: FastifySchema;
  validatorCompiler: (route: { schema: object }) => ReturnType<Ajv['compile']>;
} {
  return {
    schema: { params, body },
    validatorCompiler: ({ schema }) => strictAjv.compile(schema),
  };
}

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const;
}

/**
 * Strings only, not `format: uuid`: a malformed repository id is the
 * resolver's 404 and a malformed tenant id the binding's 403, as on every
 * other `/v1` route, so the schema must not turn either into a 400.
 */
const repositoryParams = objectSchema({
  tenantId: { type: 'string' },
  repositoryId: { type: 'string' },
});

const requestBody = objectSchema({ commit: commitId, ref, isDefaultBranch: flag, fetchUrl });
const pushBody = objectSchema({
  commit: commitId,
  ref,
  isDefaultBranch: flag,
  previousHead: commitId,
  changedPaths,
  fetchUrl,
});

interface RequestBody {
  commit: string;
  ref: string;
  isDefaultBranch: boolean;
  fetchUrl: string;
}

interface PushBody extends RequestBody {
  previousHead: string;
  changedPaths: string[];
}

/** Written out with its scheme and `//`, not a spelling the URL parser would repair. */
const ABSOLUTE_HTTP = /^https?:\/\//i;

/** An absolute `http` or `https` URL; the address itself is not screened here. */
export function isFetchUrlShape(value: string): boolean {
  return ABSOLUTE_HTTP.test(value) && URL.canParse(value);
}

/**
 * The one enqueue the three calls share, on the request's transaction:
 * resolve the repository (404 before any other judgement), check the fetch
 * URL's shape, then, for a push, supersede the still-queued pushes of the
 * same ref BEFORE inserting, so the new row is never among those it
 * supersedes. The `/v1` `onSend` hook commits before the 202 leaves.
 */
async function enqueue(
  request: FastifyRequest,
  reply: FastifyReply,
  kind: JobKind,
  body: RequestBody,
  push?: { previousHead: string; changedPaths: string[] },
) {
  const repository = await resolveRepository(request);
  if (!isFetchUrlShape(body.fetchUrl)) {
    throw new ApiError('invalid_request', FETCH_URL_REFUSED);
  }
  const db = requestDb(request);
  const scope = { tenantId: repository.tenant_id, repositoryId: repository.id };
  if (push !== undefined) {
    await supersedeQueuedPushes(db, scope, body.ref);
  }
  const job = await enqueueJob(db, {
    ...scope,
    clientId: requireAuth(request).clientId,
    kind,
    commitSha: body.commit,
    refName: body.ref,
    isDefaultBranch: body.isDefaultBranch,
    candidateAncestors: push === undefined ? [] : [push.previousHead],
    changedPaths: push?.changedPaths ?? [],
    fetchUrl: body.fetchUrl,
  });
  return reply.code(202).send({ jobId: job.id });
}

/**
 * `POST /v1/tenants/:tenantId/repositories/:repositoryId/{first-index,push,refresh}`.
 * Each writes ONE queued job and answers `202 { jobId }`; nothing is fetched,
 * hashed or indexed in the request. Refusals are the one path's (401, 403),
 * the resolver's 404, and 400 `invalid_request` for a body that fails its
 * schema or a fetch URL that fails its shape check.
 */
export const indexingRoutes: V1Routes = (v1) => {
  const base = '/tenants/:tenantId/repositories/:repositoryId';

  v1.post<{ Body: RequestBody }>(
    `${base}/first-index`,
    routeSchema(repositoryParams, requestBody),
    (request, reply) => enqueue(request, reply, JobKind.FirstIndex, request.body),
  );

  v1.post<{ Body: PushBody }>(
    `${base}/push`,
    routeSchema(repositoryParams, pushBody),
    (request, reply) =>
      enqueue(request, reply, JobKind.Push, request.body, {
        previousHead: request.body.previousHead,
        changedPaths: request.body.changedPaths,
      }),
  );

  v1.post<{ Body: RequestBody }>(
    `${base}/refresh`,
    routeSchema(repositoryParams, requestBody),
    (request, reply) => enqueue(request, reply, JobKind.Refresh, request.body),
  );
};
