import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readFailedAuthLimit,
  readPort,
  readRateLimit,
  readTrustProxy,
  runServer,
} from '../../src/server/run.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { call } from '../helpers/server.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

describe('readPort', () => {
  it('defaults to 8080 and reads a valid port', () => {
    expect(readPort({})).toBe(8080);
    expect(readPort({ PORT: ' ' })).toBe(8080);
    expect(readPort({ PORT: '9001' })).toBe(9001);
  });

  it.each(['http', '-1', '65536', '80.5'])('refuses PORT=%s', (raw) => {
    expect(() => readPort({ PORT: raw })).toThrow(/PORT must be a port number/);
  });
});

describe('readRateLimit', () => {
  it('defaults to 1200 a minute and reads a valid limit', () => {
    expect(readRateLimit({})).toEqual({ max: 1200, timeWindowMs: 60_000 });
    expect(readRateLimit({ RATE_LIMIT_PER_MINUTE: ' ' })).toEqual({
      max: 1200,
      timeWindowMs: 60_000,
    });
    expect(readRateLimit({ RATE_LIMIT_PER_MINUTE: '30' })).toEqual({
      max: 30,
      timeWindowMs: 60_000,
    });
  });

  it.each(['many', '0', '-5', '2.5'])('refuses RATE_LIMIT_PER_MINUTE=%s', (raw) => {
    expect(() => readRateLimit({ RATE_LIMIT_PER_MINUTE: raw })).toThrow(
      /RATE_LIMIT_PER_MINUTE must be a whole number/,
    );
  });
});

describe('readFailedAuthLimit', () => {
  it('defaults to 60 a minute and reads a valid limit', () => {
    expect(readFailedAuthLimit({})).toEqual({ max: 60, timeWindowMs: 60_000 });
    expect(readFailedAuthLimit({ FAILED_AUTH_LIMIT_PER_MINUTE: '10' })).toEqual({
      max: 10,
      timeWindowMs: 60_000,
    });
  });

  it.each(['few', '0', '1.5'])('refuses FAILED_AUTH_LIMIT_PER_MINUTE=%s', (raw) => {
    expect(() => readFailedAuthLimit({ FAILED_AUTH_LIMIT_PER_MINUTE: raw })).toThrow(
      /FAILED_AUTH_LIMIT_PER_MINUTE must be a whole number/,
    );
  });
});

describe('readTrustProxy', () => {
  it('trusts no proxy when unset', () => {
    expect(readTrustProxy({})).toEqual([]);
    expect(readTrustProxy({ TRUST_PROXY: '  ' })).toEqual([]);
  });

  it('reads addresses, CIDR ranges and the preset range names', () => {
    expect(
      readTrustProxy({ TRUST_PROXY: '10.0.0.0/16, 10.1.2.3,fd00::/8, ::1, uniquelocal' }),
    ).toEqual(['10.0.0.0/16', '10.1.2.3', 'fd00::/8', '::1', 'uniquelocal']);
  });

  it.each([
    '1',
    'true',
    '10.0.0.0/33',
    '::/129',
    '10.0.0.0/x',
    '10.0.0.0/8/8',
    'lb.internal',
    '10.0.0.1,',
  ])('refuses TRUST_PROXY=%s', (raw) => {
    expect(() => readTrustProxy({ TRUST_PROXY: raw })).toThrow(
      /TRUST_PROXY must be a comma-separated list of proxy addresses and CIDR ranges/,
    );
  });
});

describe('runServer', () => {
  it('needs DATABASE_APP_URL', async () => {
    await expect(runServer({}, false)).rejects.toThrow(/DATABASE_APP_URL is not set/);
  });

  it('listens, answers, and on shutdown closes the listener and then the pool', async () => {
    const server = await runServer(
      { DATABASE_APP_URL: db.appUrl, PORT: '0', HOST: '127.0.0.1' },
      false,
    );
    expect(server.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await call(server.address, '/health')).status).toBe(200);

    await Promise.all([server.shutdown(), server.shutdown()]);
    expect(server.app.server.listening).toBe(false);
    expect(server.pool.ended).toBe(true);
    await expect(call(server.address, '/health')).rejects.toThrow();
  });

  it('binds 0.0.0.0 when HOST is unset', async () => {
    const server = await runServer({ DATABASE_APP_URL: db.appUrl, PORT: '0' }, false);
    try {
      expect(server.address).toMatch(/:\d+$/);
      expect(server.app.server.address()).toMatchObject({ address: '0.0.0.0' });
    } finally {
      await server.shutdown();
    }
  });
});

describe('the entry point as a process', () => {
  it('starts, answers /health, and exits 0 on SIGTERM after closing the listener then the pool', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_APP_URL: db.appUrl, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`server did not start:\n${output}`));
      }, 20_000);
      child.stdout.on('data', () => {
        const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    expect((await call(address, '/health')).status).toBe(200);

    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(output).toContain('closing the listener, then the pool');
  }, 30_000);
});
