import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from './errors.js';

/** The requests one caller may make, or fail to authenticate, per window. */
export interface RateLimitSettings {
  max: number;
  timeWindowMs: number;
}

/** The body of every `/v1` 429, from either limit. */
export const RATE_LIMITED_MESSAGE = 'Too many requests; retry after the Retry-After seconds.';

/**
 * The most credentials a copy remembers as recently authenticated. Only a
 * credential that authenticated is ever remembered, so the set is bounded by
 * the live credentials that call this copy, not by what a caller sends; the
 * cap is a backstop, and past it the least recently seen is forgotten.
 */
export const VERIFIED_CREDENTIALS_CAPACITY = 10_000;

/**
 * A request's credential, as the SHA-256 of its whole `Authorization` header
 * (so no token is held in memory), or null when it sends none.
 */
export function credentialKey(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization === undefined || authorization === '') {
    return null;
  }
  return createHash('sha256').update(authorization).digest('base64url');
}

/**
 * The credentials that authenticated on this copy within the last `ttlMs`,
 * each kept alive by its own next success. Least recently seen first, so
 * eviction past `capacity` drops the stalest entry.
 */
export class VerifiedCredentials {
  readonly #expiresAt = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #now: () => number;

  constructor(ttlMs: number, capacity: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#capacity = capacity;
    this.#now = now;
  }

  get size(): number {
    return this.#expiresAt.size;
  }

  has(key: string): boolean {
    const expiresAt = this.#expiresAt.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= this.#now()) {
      this.#expiresAt.delete(key);
      return false;
    }
    return true;
  }

  remember(key: string): void {
    // Re-inserting moves the key to the end: the map's order is recency.
    this.#expiresAt.delete(key);
    this.#expiresAt.set(key, this.#now() + this.#ttlMs);
    if (this.#expiresAt.size > this.#capacity) {
      const stalest = this.#expiresAt.keys().next().value;
      if (stalest !== undefined) {
        this.#expiresAt.delete(stalest);
      }
    }
  }

  forget(key: string): void {
    this.#expiresAt.delete(key);
  }
}

type AuthenticateHook = (request: FastifyRequest) => Promise<void>;

/**
 * Wraps the authentication hook in the failed-authentication limit, counted
 * per client address (`request.ip`, so `trustProxy` must name the load
 * balancer for it to be the real client). A request whose credential has not
 * authenticated on this copy recently is counted BEFORE it authenticates, so
 * requests in flight at once cannot overshoot the limit: past `max` in the
 * window, it is refused 429 `rate_limited` before the authenticate call, takes
 * no connection and runs no statement. In practice the count is the address's
 * failures plus one for each credential's first success, since a credential
 * that authenticates is then remembered and passes uncounted. That is what
 * keeps a working caller served while another caller at the same address
 * floods made-up tokens; a remembered credential that fails is forgotten.
 */
export function limitFailedAuthentication(
  app: FastifyInstance,
  authenticate: AuthenticateHook,
  settings: RateLimitSettings,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  // The plugin's default key: the client address, an IPv6 address by its /64.
  const attempts = app.createRateLimit({ max: settings.max, timeWindow: settings.timeWindowMs });
  const verified = new VerifiedCredentials(settings.timeWindowMs, VERIFIED_CREDENTIALS_CAPACITY);

  return async (request, reply) => {
    const credential = credentialKey(request);
    if (credential === null || !verified.has(credential)) {
      const state = await attempts(request);
      if (!state.isAllowed && state.isExceeded) {
        void reply.header('retry-after', state.ttlInSeconds);
        throw new ApiError('rate_limited', RATE_LIMITED_MESSAGE);
      }
    }
    try {
      await authenticate(request);
    } catch (error) {
      if (credential !== null && error instanceof ApiError && error.code === 'unauthenticated') {
        verified.forget(credential);
      }
      throw error;
    }
    if (credential !== null) {
      verified.remember(credential);
    }
  };
}
