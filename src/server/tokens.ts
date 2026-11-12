import { randomBytes } from 'node:crypto';

import { hashToken } from './auth.js';

/** Every token the service issues starts with this, so a leaked one is recognisable. */
export const TOKEN_PREFIX = 'cgk_';
/** The display prefix's length: the `credentials.display_prefix` column's limit. */
export const DISPLAY_PREFIX_LENGTH = 12;

export interface MintedToken {
  /** Shown once, in the answer that issues it; never stored. */
  token: string;
  /** Its SHA-256: the only form the database stores. */
  hash: Buffer;
  /** Its first 12 characters, stored to recognise it by. */
  displayPrefix: string;
}

/** A new credential token: `cgk_` and 32 random bytes in base64url (47 characters). */
export function mintToken(): MintedToken {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), displayPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH) };
}
