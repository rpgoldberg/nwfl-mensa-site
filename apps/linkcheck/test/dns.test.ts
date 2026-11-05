import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DnsFailure, resolveAddresses, systemDns } from '../src/dns.js';
import { type DnsServer, startDnsServer } from './helpers/dns-server.js';
import { fakeDns } from './helpers/servers.js';

describe('systemDns against a DNS stand-in', () => {
  let server: DnsServer;
  beforeAll(async () => {
    server = await startDnsServer((name, type) => {
      if (name === 'gone.example') return { rcode: 3 };
      if (name === 'broken.example') return { rcode: 2 };
      if (name === 'quiet.example') return 'silent';
      if (name === 'site.example' && type === 'A') return { answers: ['93.184.215.14'] };
      if (name === 'site.example' && type === 'AAAA') return { answers: ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'] };
      if (name === 'site.example' && type === 'MX') return { answers: [{ priority: 10, exchange: 'mx.site.example' }] };
      if (name === 'site.example' && type === 'NS') return { answers: ['ns1.sedoparking.com'] };
      return { answers: [] };
    });
  });
  afterAll(() => server.close());
  const dns = () => systemDns({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 300, tries: 1 });

  it('reads A, AAAA, MX and NS records', async () => {
    expect(await dns().resolve4('site.example')).toEqual(['93.184.215.14']);
    expect(await dns().resolve6('site.example')).toEqual(['2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
    expect(await dns().resolveMx('site.example')).toEqual([{ priority: 10, exchange: 'mx.site.example' }]);
    expect(await dns().resolveNs('site.example')).toEqual(['ns1.sedoparking.com']);
  });

  it.each([
    ['gone.example', 'nxdomain'],
    ['empty.example', 'nodata'],
    ['broken.example', 'servfail'],
    ['quiet.example', 'timeout'],
  ])('maps %s to %s', async (name, code) => {
    await expect(dns().resolve4(name)).rejects.toEqual(new DnsFailure(code as DnsFailure['code']));
  });

  it('uses the system resolver when no servers are given', () => {
    expect(typeof systemDns().resolve4).toBe('function');
  });
});

describe('resolveAddresses: every address a name gives must be public', () => {
  it('takes a public IP literal as it is, without DNS', async () => {
    const dns = fakeDns({});
    expect(await resolveAddresses('8.8.8.8', dns)).toEqual({ ok: true, addresses: [{ address: '8.8.8.8', family: 4 }] });
    expect(await resolveAddresses('2606:4700:4700::1111', dns)).toEqual({ ok: true, addresses: [{ address: '2606:4700:4700::1111', family: 6 }] });
    expect(dns.calls).toEqual([]);
  });

  it.each(['127.0.0.1', '10.1.2.3', '::1', '::ffff:10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.0.10'])('refuses the literal %s without DNS', async (ip) => {
    const dns = fakeDns({});
    expect(await resolveAddresses(ip, dns)).toMatchObject({ ok: false, reason: 'private-address' });
    expect(dns.calls).toEqual([]);
  });

  it('gathers v4 then v6', async () => {
    expect(await resolveAddresses('site.example', fakeDns({ 'site.example': ['2606:4700::1', '93.184.215.14'] }))).toEqual({
      ok: true,
      addresses: [
        { address: '93.184.215.14', family: 4 },
        { address: '2606:4700::1', family: 6 },
      ],
    });
  });

  it.each([
    [['93.184.215.14', '10.0.0.1'], 'private'],
    [['127.0.0.1'], 'loopback'],
    [['169.254.169.254'], 'link-local'],
    [['::1'], 'loopback'],
    [['::ffff:10.0.0.1'], 'ipv4-mapped'],
    [['100.64.0.1'], 'cgnat'],
    [['192.168.1.1'], 'private'],
  ])('refuses a name that resolves to %j (%s), even beside a public one', async (addresses, detail) => {
    expect(await resolveAddresses('site.example', fakeDns({ 'site.example': addresses }))).toEqual({ ok: false, reason: 'private-address', detail });
  });

  it('reads NXDOMAIN, no data and failures', async () => {
    expect(await resolveAddresses('gone.example', fakeDns({}))).toEqual({ ok: false, reason: 'nxdomain' });
    expect(await resolveAddresses('empty.example', fakeDns({ 'empty.example': [] }))).toEqual({ ok: false, reason: 'nodata' });
    expect(await resolveAddresses('slow.example', fakeDns({ 'slow.example': 'timeout' }))).toEqual({ ok: false, reason: 'dns-failure' });
  });

  it('turns an error that is not a DNS failure into a failure', async () => {
    const dns = { ...fakeDns({}), resolve4: () => Promise.reject(new Error('boom')), resolve6: () => Promise.reject(new Error('boom')) };
    expect(await resolveAddresses('site.example', dns)).toEqual({ ok: false, reason: 'dns-failure' });
  });
});
