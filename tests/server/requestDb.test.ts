import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { finishRequestDb } from '../../src/server/auth.js';
import { releaseRequestDb, requestDb, requireAuth } from '../../src/server/binding.js';
import { createAppPool } from '../../src/server/pool.js';

/** A request carrying a fake connection, as the /v1 hooks leave it. */
function fakeRequest(query: () => Promise<unknown>) {
  const release = vi.fn();
  const queries = vi.fn(query);
  const client = { query: queries, release } as unknown as pg.PoolClient;
  const request = {
    auth: null,
    dbState: { client, finished: false, released: false },
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;
  return { request, queries, release };
}

describe('finishRequestDb', () => {
  it('commits once and releases once, however often it is called', async () => {
    const { request, queries, release } = fakeRequest(() => Promise.resolve());
    await finishRequestDb(request, true);
    await finishRequestDb(request, false);
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('destroys the connection and reports the failure when COMMIT fails', async () => {
    const { request, release } = fakeRequest(() => Promise.reject(new Error('connection lost')));
    await expect(finishRequestDb(request, true)).rejects.toThrow(
      'ending the request transaction failed',
    );
    expect(release).toHaveBeenCalledWith(true);
  });

  it('does nothing for a request that never took a connection', async () => {
    await expect(
      finishRequestDb({ dbState: null } as unknown as FastifyRequest, true),
    ).resolves.toBeUndefined();
  });
});

describe('releaseRequestDb', () => {
  it('logs a failed rollback instead of throwing', async () => {
    const error = vi.fn();
    const { request, release } = fakeRequest(() => Promise.reject(new Error('gone')));
    (request as unknown as { log: { error: typeof error } }).log.error = error;
    await releaseRequestDb(request);
    expect(release).toHaveBeenCalledWith(true);
    expect(error).toHaveBeenCalled();
  });
});

describe('the handler guards', () => {
  it('refuse a request that did not come through the /v1 hooks', () => {
    const bare = { auth: null, dbState: null } as unknown as FastifyRequest;
    expect(() => requireAuth(bare)).toThrow('route handled without authentication');
    expect(() => requestDb(bare)).toThrow('route handled without a request transaction');
  });
});

describe('createAppPool', () => {
  it('survives an idle connection error instead of crashing the process', async () => {
    const pool = createAppPool('postgresql://u:p@127.0.0.1:1/none');
    expect(() => pool.emit('error', new Error('terminated'))).not.toThrow();
    await pool.end();
  });
});
