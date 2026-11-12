import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { REPOSITORY_STATUS_KEYS } from '../../src/server/status.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { call, startCopies, type Copies } from '../helpers/server.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;
let copies: Copies;
let log: QueryLog;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  copies = await startCopies(db.appUrl, 2);
  log = recordQueries((copies.copies[0] as Copies['copies'][number]).pool);
});

afterAll(async () => {
  await copies.stop();
  await db.drop();
});

beforeEach(() => {
  log.clear();
});

const statusPath = (tenantId: string, repositoryId: string) =>
  `/v1/tenants/${tenantId}/repositories/${repositoryId}/status`;

function status(path: string, url = copies.baseUrls[0] as string) {
  return call(url, path, { token: fx.readerToken });
}

describe('the status of a registered repository', () => {
  it.each([0, 1])('reads not_indexed, in the one shape, for A repository %i', async (index) => {
    const repository = fx.tenantA.repositories[index] as { id: string };
    const response = await status(statusPath(fx.tenantA.id, repository.id));
    expect(response.status).toBe(200);
    expect(Object.keys(response.body as object)).toEqual(REPOSITORY_STATUS_KEYS);
    expect(response.body).toEqual({
      tenantId: fx.tenantA.id,
      repositoryId: repository.id,
      state: 'not_indexed',
      indexedCommit: null,
      inProgressJob: null,
      lastFailure: null,
      languages: [],
    });
  });

  it('takes its ids from the row, so an upper-case path answers the stored ids', async () => {
    const repository = fx.tenantA.repositories[0] as { id: string };
    const response = await status(
      statusPath(fx.tenantA.id.toUpperCase(), repository.id.toUpperCase()),
    );
    expect(response.body).toMatchObject({ tenantId: fx.tenantA.id, repositoryId: repository.id });
  });

  it('runs no query of its own beyond the resolver’s read of codegraph.repositories', async () => {
    const repository = fx.tenantA.repositories[0] as { id: string };
    await status(statusPath(fx.tenantA.id, repository.id));
    const own = log
      .texts()
      .filter(
        (text) =>
          !['BEGIN', 'COMMIT', BIND_TENANT_SQL].includes(text) &&
          !text.includes('codegraph_authenticate'),
      );
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/FROM codegraph\.repositories WHERE id = \$1$/);
  });
});

describe('refusals', () => {
  const PERMISSION_DENIED = {
    error: { code: 'permission_denied', message: 'The credential may not use this tenant.' },
  };
  const REPOSITORY_NOT_FOUND = {
    error: { code: 'repository_not_found', message: 'No such repository.' },
  };

  it('answers a repository of an ungranted tenant 403', async () => {
    const repository = fx.tenantB.repositories[0] as { id: string };
    expect(await status(statusPath(fx.tenantB.id, repository.id))).toMatchObject({
      status: 403,
      body: PERMISSION_DENIED,
    });
  });

  it.each([
    ['a missing repository', randomUUID()],
    ['a malformed repository id', 'not-a-uuid'],
    ['a repository of another tenant', 'B'],
  ])('answers %s 404', async (_name, id) => {
    const repositoryId = id === 'B' ? (fx.tenantB.repositories[0] as { id: string }).id : id;
    expect(await status(statusPath(fx.tenantA.id, repositoryId))).toMatchObject({
      status: 404,
      body: REPOSITORY_NOT_FOUND,
    });
  });

  it('answers no credential 401', async () => {
    const repository = fx.tenantA.repositories[0] as { id: string };
    const response = await call(
      copies.baseUrls[0] as string,
      statusPath(fx.tenantA.id, repository.id),
    );
    expect(response.status).toBe(401);
  });
});

describe('two copies', () => {
  it('answer the same status and body, alternately', async () => {
    const repository = fx.tenantA.repositories[0] as { id: string };
    const answers = [];
    for (const url of [...copies.baseUrls, ...copies.baseUrls]) {
      answers.push(await status(statusPath(fx.tenantA.id, repository.id), url));
    }
    const [firstAnswer] = answers;
    for (const answer of answers) {
      expect({ status: answer.status, body: answer.body }).toEqual({
        status: firstAnswer?.status,
        body: firstAnswer?.body,
      });
    }
    expect(firstAnswer?.status).toBe(200);
  });
});
