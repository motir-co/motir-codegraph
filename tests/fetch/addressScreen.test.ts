import { describe, expect, it, vi } from 'vitest';

import {
  ALWAYS_REFUSED,
  bareHost,
  embeddedIpv4,
  ipv6Bytes,
  isRefusedAddress,
  REFUSED_UNLESS_ALLOWED,
  resolveAndScreen,
  systemResolver,
  type Resolver,
} from '../../src/fetch/addressScreen.js';
import { FetchRefusedError } from '../../src/fetch/errors.js';

// The screen, driven from its table: every refused range, the embedded IPv4
// forms, the allowed-host exception and the resolve-once step.

/** One address inside each range the card names, and the named metadata ones. */
const REFUSED = [
  '0.1.2.3',
  '10.1.2.3',
  '100.64.0.1',
  '100.127.255.254',
  '127.0.0.1',
  '169.254.169.254',
  '169.254.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.8',
  '192.0.2.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
  '::1',
  '::',
  '100::1',
  '2001:db8::1',
  '2002:a9fe:a9fe::1',
  'fc00::1',
  'fd00:ec2::254',
  'fe80::1',
  'febf::1',
  'fec0::1',
  'ff02::1',
  '2001:0:4136:e378::1',
];

const PUBLIC = ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111'];

function refusal(code: string): unknown {
  return expect.objectContaining({ name: 'FetchRefusedError', reasonCode: code });
}

describe('the refused-range table', () => {
  it('refuses an address in every range, and the metadata addresses', () => {
    expect(REFUSED.filter((a) => !isRefusedAddress(a))).toEqual([]);
  });

  it('lets a globally routable address through', () => {
    expect(PUBLIC.filter((a) => isRefusedAddress(a))).toEqual([]);
  });

  it('names every range the card lists, in its family', () => {
    const ranges = [...ALWAYS_REFUSED, ...REFUSED_UNLESS_ALLOWED].map(
      (r) => `${r.address}/${String(r.prefix)}`,
    );
    for (const expected of [
      '0.0.0.0/8',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.0.0.0/24',
      '192.0.2.0/24',
      '192.168.0.0/16',
      '198.18.0.0/15',
      '198.51.100.0/24',
      '203.0.113.0/24',
      '224.0.0.0/4',
      '240.0.0.0/4',
      '::1/128',
      '::/128',
      '100::/64',
      '2001:db8::/32',
      '2002::/16',
      'fc00::/7',
      'fe80::/10',
      'fec0::/10',
      'ff00::/8',
    ]) {
      expect(ranges).toContain(expected);
    }
  });

  it('refuses a string that is not an address', () => {
    expect(isRefusedAddress('localhost')).toBe(true);
    expect(isRefusedAddress('')).toBe(true);
  });

  it('screens an address carrying a zone by the address', () => {
    expect(isRefusedAddress('fe80::1%eth0')).toBe(true);
  });
});

describe('the embedded IPv4 forms', () => {
  it('unwraps ::ffff:0:0/96 and 64:ff9b::/96 and refuses them as IPv4', () => {
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isRefusedAddress(address)).toBe(true);
    }
    expect(embeddedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('64:ff9b::a9fe:a9fe')).toBe('169.254.169.254');
  });

  it('passes an embedded public IPv4 address, and finds none in a plain IPv6 one', () => {
    expect(isRefusedAddress('::ffff:1.1.1.1')).toBe(false);
    expect(isRefusedAddress('64:ff9b::808:808')).toBe(false);
    expect(embeddedIpv4('2606:4700:4700::1111')).toBeNull();
    expect(embeddedIpv4('64:ff9b:1::1')).toBeNull();
    expect(embeddedIpv4('1.1.1.1')).toBeNull();
  });

  it('expands IPv6 spellings to their bytes', () => {
    expect(ipv6Bytes('::')).toEqual(Array<number>(16).fill(0));
    expect(ipv6Bytes('1:2:3:4:5:6:7:8')).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
    expect(ipv6Bytes('ff02::1')?.slice(0, 2)).toEqual([0xff, 0x02]);
    expect(ipv6Bytes('not-an-address')).toBeNull();
  });
});

describe('FETCH_ALLOWED_HOSTS', () => {
  it('lifts the private and loopback ranges for a listed host, never link-local or metadata', () => {
    expect(isRefusedAddress('127.0.0.1', true)).toBe(false);
    expect(isRefusedAddress('10.0.0.5', true)).toBe(false);
    expect(isRefusedAddress('::1', true)).toBe(false);
    expect(isRefusedAddress('169.254.169.254', true)).toBe(true);
    expect(isRefusedAddress('fe80::1', true)).toBe(true);
    expect(isRefusedAddress('fd00:ec2::254', true)).toBe(true);
    expect(isRefusedAddress('::ffff:169.254.169.254', true)).toBe(true);
  });

  it('matches the URL host case-insensitively without its brackets', () => {
    expect(bareHost('Git.Internal')).toBe('git.internal');
    expect(bareHost('[::1]')).toBe('::1');
  });
});

describe('resolveAndScreen', () => {
  const spy = (answers: { address: string; family: number }[]) =>
    vi.fn<Resolver>(() => Promise.resolve(answers));

  it('resolves once and answers the first screened address', async () => {
    const resolver = spy([
      { address: '1.1.1.1', family: 4 },
      { address: '1.0.0.1', family: 4 },
    ]);
    await expect(
      resolveAndScreen('Source.Example', { allowedHosts: [], resolver }),
    ).resolves.toEqual({ address: '1.1.1.1', family: 4 });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith('source.example');
  });

  it('refuses the whole host when any one answer is refused', async () => {
    const resolver = spy([
      { address: '1.1.1.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(resolveAndScreen('h.example', { allowedHosts: [], resolver })).rejects.toEqual(
      refusal('address_refused'),
    );
  });

  it('applies the allowed-host exception only to the listed host', async () => {
    const resolver = spy([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      resolveAndScreen('localhost', { allowedHosts: ['localhost'], resolver }),
    ).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(
      resolveAndScreen('other', { allowedHosts: ['localhost'], resolver }),
    ).rejects.toEqual(refusal('address_refused'));
    const metadata = spy([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      resolveAndScreen('localhost', { allowedHosts: ['localhost'], resolver: metadata }),
    ).rejects.toEqual(refusal('address_refused'));
  });

  it('screens an IP literal without consulting the resolver', async () => {
    const resolver = spy([]);
    await expect(resolveAndScreen('1.1.1.1', { allowedHosts: [], resolver })).resolves.toEqual({
      address: '1.1.1.1',
      family: 4,
    });
    await expect(resolveAndScreen('[::1]', { allowedHosts: [], resolver })).rejects.toEqual(
      refusal('address_refused'),
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('refuses fetch_failed for a name that does not resolve or resolves to nothing', async () => {
    const failing = vi.fn<Resolver>(() =>
      Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND h'), { code: 'ENOTFOUND' })),
    );
    const error = await resolveAndScreen('h.invalid', {
      allowedHosts: [],
      resolver: failing,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchRefusedError);
    expect(error).toMatchObject({ reasonCode: 'fetch_failed' });
    expect((error as Error).message).not.toContain('h.invalid');
    await expect(
      resolveAndScreen('h.invalid', {
        allowedHosts: [],
        resolver: () => Promise.reject(new Error('no code')),
      }),
    ).rejects.toEqual(refusal('fetch_failed'));
    await expect(
      resolveAndScreen('h.example', { allowedHosts: [], resolver: spy([]) }),
    ).rejects.toEqual(refusal('fetch_failed'));
  });

  it('uses the system resolver by default', async () => {
    const answers = await systemResolver('localhost');
    expect(answers.length).toBeGreaterThan(0);
  });
});
