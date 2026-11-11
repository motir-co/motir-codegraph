import { describe, expect, it } from 'vitest';

import { requireEnv } from '../src/config.js';

describe('requireEnv', () => {
  it('returns the value of a set variable', () => {
    expect(requireEnv('SOME_URL', { SOME_URL: 'postgresql://localhost/x' })).toBe(
      'postgresql://localhost/x',
    );
  });

  it('names the variable when it is unset', () => {
    expect(() => requireEnv('SOME_URL', {})).toThrow(/SOME_URL is not set/);
  });

  it('treats a blank value as unset', () => {
    expect(() => requireEnv('SOME_URL', { SOME_URL: '  ' })).toThrow(/SOME_URL is not set/);
  });
});
