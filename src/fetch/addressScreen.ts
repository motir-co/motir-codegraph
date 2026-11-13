/**
 * The address screen: which addresses a fetch may connect to.
 *
 * The screen runs on ADDRESSES, never on names. A name is resolved once,
 * every address it answers is screened, and one refused address refuses the
 * whole hop — a public host that also answers with a link-local address is not
 * a source host. The caller then connects to the address this module answers,
 * never to the name, so the resolver is never asked a second time and cannot
 * answer differently after the screen ran (DNS rebinding).
 *
 * The refused ranges are a table checked through Node's `net.BlockList`. Two
 * IPv6 forms embed an IPv4 address — the IPv4-mapped prefix ::ffff:0:0/96 and
 * the NAT64 prefix 64:ff9b::/96 — and are unwrapped and re-checked as IPv4, so
 * ::ffff:169.254.169.254 is refused as the metadata address it is. 6to4
 * (2002::/16) and Teredo (2001::/32) embed an IPv4 address in a form no single
 * rule unwraps, so both are refused outright.
 *
 * `FETCH_ALLOWED_HOSTS` is the one exception: a listed host may resolve to a
 * loopback or private address (a source host inside the deployment's own
 * network). It never exempts the link-local and instance-metadata ranges, and
 * an allowed host is still resolved once and pinned like any other.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { FetchRefusedError, refusalFrom, withCode } from './errors.js';

/** One refused range: an address and its prefix length, in one family. */
export interface RefusedRange {
  readonly address: string;
  readonly prefix: number;
  readonly family: 'ipv4' | 'ipv6';
  /** Why the range is refused, for a person reading the table. */
  readonly reason: string;
}

/** Ranges refused for EVERY host, an allowed one included. */
export const ALWAYS_REFUSED: readonly RefusedRange[] = [
  { address: '169.254.0.0', prefix: 16, family: 'ipv4', reason: 'link-local, instance metadata' },
  { address: 'fe80::', prefix: 10, family: 'ipv6', reason: 'link-local' },
  { address: 'fd00:ec2::254', prefix: 128, family: 'ipv6', reason: 'instance metadata (IPv6)' },
];

/** Ranges refused unless the host is in `FETCH_ALLOWED_HOSTS`. */
export const REFUSED_UNLESS_ALLOWED: readonly RefusedRange[] = [
  { address: '0.0.0.0', prefix: 8, family: 'ipv4', reason: '"this" network' },
  { address: '10.0.0.0', prefix: 8, family: 'ipv4', reason: 'private' },
  { address: '100.64.0.0', prefix: 10, family: 'ipv4', reason: 'carrier-grade NAT' },
  { address: '127.0.0.0', prefix: 8, family: 'ipv4', reason: 'loopback' },
  { address: '172.16.0.0', prefix: 12, family: 'ipv4', reason: 'private' },
  { address: '192.0.0.0', prefix: 24, family: 'ipv4', reason: 'IETF protocol assignments' },
  { address: '192.0.2.0', prefix: 24, family: 'ipv4', reason: 'documentation' },
  { address: '192.168.0.0', prefix: 16, family: 'ipv4', reason: 'private' },
  { address: '198.18.0.0', prefix: 15, family: 'ipv4', reason: 'benchmarking' },
  { address: '198.51.100.0', prefix: 24, family: 'ipv4', reason: 'documentation' },
  { address: '203.0.113.0', prefix: 24, family: 'ipv4', reason: 'documentation' },
  { address: '224.0.0.0', prefix: 4, family: 'ipv4', reason: 'multicast' },
  { address: '240.0.0.0', prefix: 4, family: 'ipv4', reason: 'reserved, broadcast' },
  { address: '::1', prefix: 128, family: 'ipv6', reason: 'loopback' },
  { address: '::', prefix: 128, family: 'ipv6', reason: 'unspecified' },
  { address: '100::', prefix: 64, family: 'ipv6', reason: 'discard-only' },
  { address: '2001::', prefix: 32, family: 'ipv6', reason: 'Teredo (embeds IPv4)' },
  { address: '2001:db8::', prefix: 32, family: 'ipv6', reason: 'documentation' },
  { address: '2002::', prefix: 16, family: 'ipv6', reason: '6to4 (embeds IPv4)' },
  { address: 'fc00::', prefix: 7, family: 'ipv6', reason: 'unique local' },
  { address: 'fec0::', prefix: 10, family: 'ipv6', reason: 'site-local (deprecated)' },
  { address: 'ff00::', prefix: 8, family: 'ipv6', reason: 'multicast' },
];

function blockList(ranges: readonly RefusedRange[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    list.addSubnet(range.address, range.prefix, range.family);
  }
  return list;
}

const ALWAYS = blockList(ALWAYS_REFUSED);
const UNLESS_ALLOWED = blockList(REFUSED_UNLESS_ALLOWED);

/**
 * The 16 bytes of an IPv6 address in text form (an RFC 4291 spelling,
 * optionally with a dotted-quad tail and a zone), or null when it is not one.
 */
export function ipv6Bytes(text: string): number[] | null {
  const address = text.split('%')[0] ?? '';
  if (isIP(address) !== 6) return null;
  let head = address;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted !== null) {
    head = `${dotted[1] ?? ''}0:0`;
    tail.push(...(dotted[2] ?? '').split('.').map(Number));
  }
  const [left = '', right] = head.split('::');
  const words = (part: string) => (part === '' ? [] : part.split(':').map((w) => parseInt(w, 16)));
  const l = words(left);
  const r = right === undefined ? [] : words(right);
  const all =
    right === undefined ? l : [...l, ...Array<number>(8 - l.length - r.length).fill(0), ...r];
  const bytes = all.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * The IPv4 address an IPv6 one embeds through the IPv4-mapped (::ffff:0:0/96)
 * or NAT64 (64:ff9b::/96) prefix, or null when it embeds none.
 */
export function embeddedIpv4(address: string): string | null {
  const bytes = ipv6Bytes(address);
  if (bytes === null) return null;
  const mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  return mapped || nat64 ? bytes.slice(12).join('.') : null;
}

/**
 * Whether the screen refuses `address` (an IP literal). `allowed` is whether
 * the host it was resolved for is in `FETCH_ALLOWED_HOSTS`: it lifts the
 * private and loopback ranges, never the link-local and metadata ones. A
 * string that is not an IP address is refused.
 */
export function isRefusedAddress(address: string, allowed = false): boolean {
  const bare = address.split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4 !== null) return isRefusedAddress(v4, allowed);
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (ALWAYS.check(bare, type)) return true;
  return !allowed && UNLESS_ALLOWED.check(bare, type);
}

/** One resolved address, as the resolver answers it. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** The resolver: every address a name answers. Swappable in tests. */
export type Resolver = (host: string) => Promise<readonly ResolvedAddress[]>;

/** The system resolver, every address at once (`getaddrinfo`, as a connect would use). */
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, order: 'verbatim' });

/** A URL's host without IPv6 brackets, lower-cased. */
export function bareHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

/**
 * Resolves `host` ONCE, screens every address it answers, and answers the one
 * address to connect to. An IP literal is screened without a resolver call.
 * Refuses `address_refused` when any answer is refused, and `fetch_failed`
 * when the name does not resolve.
 */
export async function resolveAndScreen(
  host: string,
  options: { readonly allowedHosts: readonly string[]; readonly resolver: Resolver },
): Promise<ResolvedAddress> {
  const name = bareHost(host);
  const allowed = options.allowedHosts.includes(name);
  let answers: readonly ResolvedAddress[];
  const literal = isIP(name);
  if (literal !== 0) {
    answers = [{ address: name, family: literal }];
  } else {
    try {
      answers = await options.resolver(name);
    } catch (error) {
      throw refusalFrom(
        error,
        undefined,
        (code) => `The source host did not resolve${withCode(code)}.`,
      );
    }
  }
  const first = answers[0];
  if (first === undefined) {
    throw new FetchRefusedError('fetch_failed', 'The source host resolved to no address.');
  }
  if (answers.some((a) => isRefusedAddress(a.address, allowed))) {
    throw new FetchRefusedError(
      'address_refused',
      'The source host resolves to an address the fetcher may not connect to.',
    );
  }
  return first;
}
