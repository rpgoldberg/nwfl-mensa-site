// ============================================================================
// Which addresses the checker may connect to (SSRF, SPEC D4): the home LAN is the target, so only
// global unicast is dialled. IPv4 is refused by range; IPv6 is allowed only inside 2000::/3 and then
// refused by range again. An IPv4-mapped or -compatible IPv6 address is refused whatever it embeds,
// and so is any scoped (zone) address. Anything that is not a plain address literal is refused too:
// the caller resolves names first and passes only what the resolver returned.
// ============================================================================
import { isIPv4, isIPv6 } from 'node:net';

export type Refusal =
  | 'not-an-address'
  | 'unspecified'
  | 'private'
  | 'cgnat'
  | 'loopback'
  | 'link-local'
  | 'special'
  | 'documentation'
  | 'reserved'
  | 'benchmarking'
  | 'multicast'
  | 'ipv4-mapped'
  | 'ipv4-compatible'
  | 'ula'
  | 'scoped'
  | '6to4'
  | 'teredo'
  | 'orchid'
  | 'nat64'
  | 'discard'
  | 'not-global';

/** [first address, prefix length, reason], IPv4. */
const V4: readonly (readonly [string, number, Refusal])[] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'special'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

/** [first address, prefix length, reason], IPv6, checked in order (the more specific first). */
const V6: readonly (readonly [string, number, Refusal])[] = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['::ffff:0:0', 96, 'ipv4-mapped'],
  ['::', 96, 'ipv4-compatible'],
  ['64:ff9b::', 96, 'nat64'],
  ['64:ff9b:1::', 48, 'nat64'],
  ['100::', 64, 'discard'],
  ['fc00::', 7, 'ula'],
  ['fe80::', 10, 'link-local'],
  ['ff00::', 8, 'multicast'],
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
  ['2002::', 16, '6to4'],
  ['2001:2::', 48, 'benchmarking'],
  ['2001:10::', 28, 'orchid'],
  ['2001:20::', 28, 'orchid'],
  ['2001::', 32, 'teredo'],
];

function v4Bits(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** An IPv6 literal (node:net already accepted it) as a 128-bit number. */
function v6Bits(ip: string): bigint {
  // A dotted IPv4 tail (::ffff:10.0.0.1) becomes its two hex groups first.
  const text = ip.replace(/(\d+\.\d+\.\d+\.\d+)$/, (v4) => {
    const bits = v4Bits(v4);
    return `${(bits >> 16n).toString(16)}:${(bits & 0xffffn).toString(16)}`;
  });
  const [head = '', rest] = text.split('::') as [string, string | undefined];
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = 8 - left.length - right.length;
  const groups = [...left, ...(rest === undefined ? [] : Array<string>(fill).fill('0')), ...right];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function within(bits: bigint, base: bigint, prefix: number, width: number): boolean {
  const shift = BigInt(width - prefix);
  return bits >> shift === base >> shift;
}

/** Why an address may not be dialled, or null when it is global unicast. */
export function addressRefusal(ip: string): Refusal | null {
  if (isIPv4(ip)) {
    // node:net accepts only dotted decimal with four parts, so octal or decimal forms never get here.
    const bits = v4Bits(ip);
    for (const [base, prefix, reason] of V4) if (within(bits, v4Bits(base), prefix, 32)) return reason;
    return null;
  }
  if (ip.includes('%')) return isIPv6(ip.slice(0, ip.indexOf('%'))) ? 'scoped' : 'not-an-address';
  if (!isIPv6(ip)) return 'not-an-address';
  const bits = v6Bits(ip);
  for (const [base, prefix, reason] of V6) if (within(bits, v6Bits(base), prefix, 128)) return reason;
  // Global unicast is 2000::/3; everything outside it is refused.
  return within(bits, 0x2n << 124n, 3, 128) ? null : 'not-global';
}

export const isPublicAddress = (ip: string): boolean => addressRefusal(ip) === null;
