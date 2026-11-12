import { describe, expect, it } from 'vitest';

import { VerifiedCredentials } from '../../src/server/authLimit.js';

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('VerifiedCredentials', () => {
  it('remembers a credential for its time to live, and each success extends it', () => {
    const time = clock();
    const verified = new VerifiedCredentials(100, 10, time.now);
    expect(verified.has('a')).toBe(false);
    verified.remember('a');
    time.advance(99);
    expect(verified.has('a')).toBe(true);
    verified.remember('a');
    time.advance(99);
    expect(verified.has('a')).toBe(true);
    time.advance(1);
    expect(verified.has('a')).toBe(false);
    // An expired entry is dropped when it is read.
    expect(verified.size).toBe(0);
  });

  it('forgets a credential on request', () => {
    const verified = new VerifiedCredentials(100, 10);
    verified.remember('a');
    verified.forget('a');
    expect(verified.has('a')).toBe(false);
    verified.forget('never-seen');
    expect(verified.size).toBe(0);
  });

  it('drops the least recently seen credential past its capacity', () => {
    const verified = new VerifiedCredentials(1_000, 2);
    verified.remember('a');
    verified.remember('b');
    // Seeing `a` again makes `b` the stalest.
    verified.remember('a');
    verified.remember('c');
    expect(verified.size).toBe(2);
    expect(verified.has('a')).toBe(true);
    expect(verified.has('b')).toBe(false);
    expect(verified.has('c')).toBe(true);
  });

  it('reads the real clock by default', () => {
    const verified = new VerifiedCredentials(60_000, 1);
    verified.remember('a');
    expect(verified.has('a')).toBe(true);
  });
});
