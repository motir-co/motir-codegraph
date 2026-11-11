import { existsSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

// A developer's `.env` (copied from `.env.example`) supplies the database URLs.
// CI sets them on the job instead, and a variable already set always wins.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every database test shares one Postgres. Running files in parallel would
    // let one file's schema reset race another's fixture, so files run one at a
    // time; tests inside a file already run in order.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
});
