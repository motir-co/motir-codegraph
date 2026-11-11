import { describe, expect, it } from 'vitest';

import { parseConnectionUrl, withDatabase } from '../../src/db/connection.js';

describe('parseConnectionUrl', () => {
  it('reads the login, password and database, decoding escapes', () => {
    expect(parseConnectionUrl('X', 'postgresql://codegraph_app:p%40ss@localhost:5432/cg')).toEqual({
      user: 'codegraph_app',
      password: 'p@ss',
      database: 'cg',
    });
  });

  it('accepts the postgres:// spelling', () => {
    expect(parseConnectionUrl('X', 'postgres://a:b@h/c').database).toBe('c');
  });

  it('refuses a value that is not a URL, naming the variable', () => {
    expect(() => parseConnectionUrl('DATABASE_URL', 'not a url')).toThrow(
      /DATABASE_URL is not a valid/,
    );
  });

  it('refuses another scheme', () => {
    expect(() => parseConnectionUrl('DATABASE_URL', 'mysql://a:b@h/c')).toThrow(
      /DATABASE_URL must be a postgresql/,
    );
  });

  it.each([
    ['no password', 'postgresql://a@h/c'],
    ['no user', 'postgresql://h/c'],
    ['no database', 'postgresql://a:b@h/'],
  ])('refuses a URL with %s', (_label, url) => {
    expect(() => parseConnectionUrl('DATABASE_URL', url)).toThrow(
      /must name a user, a password and a database/,
    );
  });
});

describe('withDatabase', () => {
  it('points the same URL at another database', () => {
    expect(withDatabase('postgresql://a:b@localhost:5432/one?sslmode=disable', 'two')).toBe(
      'postgresql://a:b@localhost:5432/two?sslmode=disable',
    );
  });
});
