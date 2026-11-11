// `pnpm db:bootstrap`: create or re-assert the two logins (local and CI only).
import { requireEnv } from '../config.js';
import { bootstrap } from '../db/bootstrap.js';

const result = await bootstrap({
  adminUrl: requireEnv('DATABASE_ADMIN_URL'),
  ownerUrl: requireEnv('DATABASE_URL'),
  appUrl: requireEnv('DATABASE_APP_URL'),
});
console.log(
  `bootstrapped codegraph_owner and codegraph_app; database ${result.database} ` +
    (result.createdDatabase ? 'created' : 'already existed'),
);
