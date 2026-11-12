import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { call, startCopies } from '../helpers/server.js';

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

/** The health answer with the one field that legitimately differs removed. */
function comparable(body: unknown): unknown {
  const { process: proc, ...rest } = body as { process: { uptimeSeconds: number } };
  return { ...rest, process: { ...proc, uptimeSeconds: 0 } };
}

describe('two copies against one database', () => {
  it('answer alternating calls alike, and one keeps answering when the other stops', async () => {
    const copies = await startCopies(db.appUrl, 2);
    try {
      expect(copies.copies).toHaveLength(2);
      expect(new Set(copies.baseUrls).size).toBe(2);
      expect(copies.copies[0]?.pool).not.toBe(copies.copies[1]?.pool);

      const answers = [];
      for (let i = 0; i < 6; i += 1) {
        const baseUrl = copies.baseUrls[i % 2] as string;
        answers.push(await call(baseUrl, '/health'));
      }
      for (const answer of answers) {
        expect(answer.status).toBe(200);
        expect(comparable(answer.body)).toEqual(comparable(answers[0]?.body));
      }

      await copies.copies[0]?.stop();
      const survivor = await call(copies.baseUrls[1] as string, '/health');
      expect(survivor.status).toBe(200);
    } finally {
      await copies.stop();
    }
  });
});
