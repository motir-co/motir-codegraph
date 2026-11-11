// `pnpm db:migrate`: apply db/migrations/*.sql as codegraph_owner.
import { requireEnv } from '../config.js';
import { migrate } from '../db/migrate.js';

await migrate({
  connectionString: requireEnv('DATABASE_URL'),
  log: (line) => {
    console.log(line);
  },
});
