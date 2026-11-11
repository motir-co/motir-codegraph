import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrap } from '../../src/db/bootstrap.js';
import { withDatabase } from '../../src/db/connection.js';
import {
  freshDatabase,
  INSUFFICIENT_PRIVILEGE,
  queryRows,
  sqlState,
  withClient,
  type FreshDatabase,
} from '../helpers/db.js';

const ROLE_SNAPSHOT = `
  SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
         r.rolreplication, r.rolcanlogin, r.rolinherit, r.rolconfig,
         ARRAY(SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
               WHERE m.member = r.oid ORDER BY 1)::text[] AS member_of
  FROM pg_roles r
  WHERE r.rolname IN ('codegraph_owner', 'codegraph_app')
  ORDER BY r.rolname`;

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase({ migrate: false });
});

afterAll(async () => {
  await db.drop();
});

describe('db:bootstrap', () => {
  it('creates both logins with the attributes the service relies on', async () => {
    const roles = await withClient(db.adminUrl, async (c) => await queryRows(c, ROLE_SNAPSHOT));
    expect(roles).toEqual([
      {
        rolname: 'codegraph_app',
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolreplication: false,
        rolcanlogin: true,
        rolinherit: true,
        rolconfig: ['search_path=codegraph'],
        member_of: [],
      },
      {
        rolname: 'codegraph_owner',
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolreplication: false,
        rolcanlogin: true,
        rolinherit: true,
        rolconfig: ['search_path=codegraph'],
        member_of: [],
      },
    ]);
  });

  it('created the database and made codegraph_owner its owner', async () => {
    const owner = await withClient(db.adminUrl, async (c) => {
      const result = await c.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [db.name],
      );
      return result.rows[0]?.owner;
    });
    expect(owner).toBe('codegraph_owner');
  });

  it('is idempotent: a second run changes no attribute or membership', async () => {
    const before = await withClient(db.adminUrl, async (c) => await queryRows(c, ROLE_SNAPSHOT));
    const second = await bootstrap({
      adminUrl: db.adminUrl,
      ownerUrl: db.ownerUrl,
      appUrl: db.appUrl,
    });
    expect(second).toEqual({ database: db.name, createdDatabase: false });
    const after = await withClient(db.adminUrl, async (c) => await queryRows(c, ROLE_SNAPSHOT));
    expect(after).toEqual(before);
  });

  it('re-asserts a drifted login and removes a membership that would let the app become the owner', async () => {
    await withClient(db.adminUrl, async (c) => {
      await c.query('ALTER ROLE codegraph_app CREATEDB BYPASSRLS');
      await c.query('GRANT codegraph_owner TO codegraph_app');
    });
    await bootstrap({ adminUrl: db.adminUrl, ownerUrl: db.ownerUrl, appUrl: db.appUrl });
    const roles = await withClient(db.adminUrl, async (c) => await queryRows(c, ROLE_SNAPSHOT));
    for (const role of roles) {
      expect(role).toMatchObject({ rolcreatedb: false, rolbypassrls: false, member_of: [] });
    }
  });

  it('sets each password from its own URL, so both logins can connect', async () => {
    for (const url of [db.ownerUrl, db.appUrl]) {
      const user = await withClient(
        url,
        async (c) => (await queryRows(c, 'SELECT current_user'))[0],
      );
      expect(user).toBeDefined();
    }
  });

  it('leaves codegraph_app no CREATE on the database and unable to SET ROLE codegraph_owner', async () => {
    await withClient(db.appUrl, async (c) => {
      const privilege = await c.query<{ create: boolean }>(
        "SELECT has_database_privilege(current_database(), 'CREATE') AS create",
      );
      expect(privilege.rows[0]?.create).toBe(false);
      await c.query('BEGIN');
      expect(await sqlState(c, 'SET ROLE codegraph_owner')).toBe(INSUFFICIENT_PRIVILEGE);
      await c.query('ROLLBACK');
    });
  });

  it.each([
    [
      'DATABASE_URL',
      { ownerUrl: 'postgresql://someone:x@localhost/db' },
      /DATABASE_URL must connect as codegraph_owner/,
    ],
    [
      'DATABASE_APP_URL',
      { appUrl: 'postgresql://someone:x@localhost/db' },
      /DATABASE_APP_URL must connect as codegraph_app/,
    ],
  ])('refuses a %s that names another login', async (_name, override, message) => {
    await expect(
      bootstrap({ adminUrl: db.adminUrl, ownerUrl: db.ownerUrl, appUrl: db.appUrl, ...override }),
    ).rejects.toThrow(message);
  });

  it('refuses owner and app URLs that name different databases', async () => {
    await expect(
      bootstrap({
        adminUrl: db.adminUrl,
        ownerUrl: db.ownerUrl,
        appUrl: withDatabase(db.appUrl, 'other'),
      }),
    ).rejects.toThrow(/must name the same database/);
  });
});
