import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

/**
 * The gate's fixture: a database built from empty by the shipped bootstrap and
 * migrations (never by test DDL), seeded only through
 * codegraph_bootstrap_operator() and the operator functions. Tenant A holds
 * two repositories and tenant B one, under different names, and a client of
 * kind `client` is granted A only, with one credential.
 */
export interface Foundation {
  db: FreshDatabase;
  fx: TenancyFixture;
}

export async function foundation(): Promise<Foundation> {
  const db = await freshDatabase();
  const fx = await buildTenancyFixture(db, {
    a: ['acme-web', 'acme-api'],
    b: ['globex-core'],
  });
  return { db, fx };
}
