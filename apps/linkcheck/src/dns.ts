// ============================================================================
// Names, resolved by the checker itself (SPEC D4, SSRF): every address a name gives must be global
// unicast, or the name is refused whole, so a name that answers one public and one private address
// cannot slip through. The caller dials only an address returned here (net.ts pins it), so a DNS
// that answers differently the second time (rebinding) is never asked a second time for that hop.
// ============================================================================
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type Refusal, addressRefusal } from './addr.js';

export type DnsCode = 'nxdomain' | 'nodata' | 'timeout' | 'servfail';

export class DnsFailure extends Error {
  override name = 'DnsFailure';
  constructor(readonly code: DnsCode) {
    super(`DNS: ${code}`);
  }
}

export interface Dns {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveMx(host: string): Promise<{ exchange: string; priority: number }[]>;
  resolveNs(host: string): Promise<string[]>;
}

function failure(error: unknown): DnsFailure {
  const code = (error as { code?: string }).code;
  return new DnsFailure(code === 'ENOTFOUND' ? 'nxdomain' : code === 'ENODATA' ? 'nodata' : code === 'ETIMEOUT' ? 'timeout' : 'servfail');
}

export interface DnsOptions {
  /** Servers to ask; the system's (the container's --dns) by default. */
  servers?: string[];
  timeoutMs?: number;
  tries?: number;
}

/** DNS over c-ares (node:dns Resolver), never the hosts file; its errors as DnsFailure codes. */
export function systemDns(options: DnsOptions = {}): Dns {
  const resolver = new Resolver({ timeout: options.timeoutMs ?? 5000, tries: options.tries ?? 2 });
  if (options.servers) resolver.setServers(options.servers);
  const wrap =
    <T>(run: (host: string) => Promise<T>) =>
    (host: string): Promise<T> =>
      run(host).catch((error: unknown) => {
        throw failure(error);
      });
  return {
    resolve4: wrap((host) => resolver.resolve4(host)),
    resolve6: wrap((host) => resolver.resolve6(host)),
    resolveMx: wrap(async (host) => (await resolver.resolveMx(host)).map(({ exchange, priority }) => ({ exchange, priority }))),
    resolveNs: wrap((host) => resolver.resolveNs(host)),
  };
}

export interface Address {
  address: string;
  family: 4 | 6;
}

export type Resolved =
  | { ok: true; addresses: Address[] }
  | { ok: false; reason: 'private-address'; detail: Refusal }
  | { ok: false; reason: 'nxdomain' | 'nodata' | 'dns-failure' };

/** The addresses to dial for a host (an IP literal as it is), IPv4 first; refused whole if any is not public. */
export async function resolveAddresses(host: string, dns: Dns): Promise<Resolved> {
  const family = isIP(host);
  let addresses: Address[];
  if (family !== 0) {
    addresses = [{ address: host, family: family as 4 | 6 }];
  } else {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
    addresses = [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
    ];
    if (addresses.length === 0) {
      const codes = [v4, v6].map((r) => (r.status === 'rejected' && r.reason instanceof DnsFailure ? r.reason.code : r.status === 'fulfilled' ? 'nodata' : 'servfail'));
      if (codes.every((c) => c === 'nxdomain')) return { ok: false, reason: 'nxdomain' };
      if (codes.every((c) => c === 'nodata' || c === 'nxdomain')) return { ok: false, reason: 'nodata' };
      return { ok: false, reason: 'dns-failure' };
    }
  }
  for (const { address } of addresses) {
    const refusal = addressRefusal(address);
    if (refusal !== null) return { ok: false, reason: 'private-address', detail: refusal };
  }
  return { ok: true, addresses };
}
