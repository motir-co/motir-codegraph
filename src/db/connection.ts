/** The two logins every part of the service is written against. */
export const OWNER_LOGIN = 'codegraph_owner';
export const APP_LOGIN = 'codegraph_app';

export interface ConnectionTarget {
  user: string;
  password: string;
  database: string;
}

/**
 * Reads the login, password and database out of a `postgresql://` URL. The
 * bootstrap takes each login's password from the URL that login connects
 * with, so the two can never disagree.
 */
export function parseConnectionUrl(name: string, url: string): ConnectionTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} is not a valid postgresql:// URL.`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`${name} must be a postgresql:// URL.`);
  }
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (user === '' || password === '' || database === '') {
    throw new Error(`${name} must name a user, a password and a database.`);
  }
  return { user, password, database };
}

/** The same URL pointed at another database: how the tests get a fresh one. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}
