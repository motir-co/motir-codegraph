import { describe, expect, it } from 'vitest';

import { DEFAULT_PER_FILE_CAP_BYTES, perFileCapBytes, requireEnv } from '../src/config.js';

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

describe('perFileCapBytes', () => {
  it('returns the value of PER_FILE_CAP_BYTES when it is set', () => {
    expect(perFileCapBytes({ PER_FILE_CAP_BYTES: '2097152' })).toBe(2_097_152);
  });

  it('defaults to 1,048,576 when it is unset or blank', () => {
    expect(DEFAULT_PER_FILE_CAP_BYTES).toBe(1_048_576);
    expect(perFileCapBytes({})).toBe(1_048_576);
    expect(perFileCapBytes({ PER_FILE_CAP_BYTES: '   ' })).toBe(1_048_576);
  });

  it.each(['abc', '0', '-5', '1.5', '1e6', '0x10', '99999999999999999999'])(
    'throws naming the variable for %s',
    (value) => {
      expect(() => perFileCapBytes({ PER_FILE_CAP_BYTES: value })).toThrow(/PER_FILE_CAP_BYTES/);
    },
  );

  it('reads the process environment by default', () => {
    const before = process.env.PER_FILE_CAP_BYTES;
    process.env.PER_FILE_CAP_BYTES = '4096';
    try {
      expect(perFileCapBytes()).toBe(4_096);
    } finally {
      if (before === undefined) delete process.env.PER_FILE_CAP_BYTES;
      else process.env.PER_FILE_CAP_BYTES = before;
    }
  });
});
