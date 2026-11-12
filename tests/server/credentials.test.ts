import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mintToken, TOKEN_PREFIX } from '../../src/server/tokens.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;
let server: ServerCopy;
let logged = '';

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  // The server's real logger, at its default level, written to a buffer.
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logged += chunk.toString();
      done();
    },
  });
  server = await startServer(db.appUrl, { logger: { level: 'info', stream } });
});

afterAll(async () => {
  await server.stop();
  await db.drop();
});

describe('mintToken', () => {
  it('mints a cgk_ token of 47 characters, its SHA-256 and its 12-character prefix', () => {
    const minted = mintToken();
    expect(minted.token).toMatch(/^cgk_[A-Za-z0-9_-]{43}$/);
    expect(minted.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(minted.hash).toEqual(createHash('sha256').update(minted.token).digest());
    expect(minted.displayPrefix).toBe(minted.token.slice(0, 12));
    expect(mintToken().token).not.toBe(minted.token);
  });
});

describe('issuing a credential', () => {
  it('shows the token exactly once, and stores only its hash and display prefix', async () => {
    logged = '';
    const issued = await call(server.baseUrl, `/v1/operator/clients/${fx.readerId}/credentials`, {
      method: 'POST',
      token: fx.operatorToken,
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const { token, credentialId, displayPrefix } = issued.body as {
      token: string;
      credentialId: string;
      displayPrefix: string;
    };
    expect(issued.body).toEqual({ credentialId, clientId: fx.readerId, token, displayPrefix });
    expect(displayPrefix).toBe(token.slice(0, 12));

    // The request was logged, and the token is not in the log.
    expect(logged).toContain('/credentials');
    expect(logged).not.toContain(token);

    // The client read lists the credential and carries no token or hash.
    const read = await call(server.baseUrl, `/v1/operator/clients/${fx.readerId}`, {
      token: fx.operatorToken,
    });
    const listed = (read.body as { credentials: { credentialId: string }[] }).credentials.find(
      (credential) => credential.credentialId === credentialId,
    );
    expect(listed).toEqual({
      credentialId,
      displayPrefix,
      createdAt: expect.any(String) as string,
      revokedAt: null,
    });
    expect(JSON.stringify(read.body)).not.toContain(token);
    expect(JSON.stringify(read.body)).not.toMatch(/hash/i);

    // As the owner: the hash is the token's SHA-256, and no column holds it.
    const [row] = await withClient(db.ownerUrl, (c) =>
      queryRows<{ token_hash: Buffer; display_prefix: string; as_text: string }>(
        c,
        'SELECT token_hash, display_prefix, cr::text AS as_text FROM codegraph.credentials cr WHERE id = $1',
        [credentialId],
      ),
    );
    expect(row?.token_hash).toEqual(createHash('sha256').update(token).digest());
    expect(row?.display_prefix).toBe(token.slice(0, 12));
    expect(row?.as_text).not.toContain(token);
    expect(row?.as_text).not.toContain(token.slice(12));
  });
});
