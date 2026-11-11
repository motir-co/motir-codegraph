import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { requireEnv } from '../src/config.js';

describe('the Postgres the service runs on', () => {
  it('is reachable through DATABASE_URL and is version 16 or later', async () => {
    // No skip when the variable is missing: a database test that skips reads as
    // green in CI while measuring nothing.
    const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
    await client.connect();
    try {
      const result = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      expect(Number(result.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160000);
    } finally {
      await client.end();
    }
  });
});
