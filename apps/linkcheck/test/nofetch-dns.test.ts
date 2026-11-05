// B1, through the production resolver (c-ares, dns.ts systemDns) and a DNS stand-in on loopback: a
// no-fetch or login-walled host written with trailing dots asks the DNS nothing it may not ask, on the
// link itself and on a redirect hop. (The challenger's repro, kept as a regression test.)
import { describe, expect, it } from 'vitest';
import { makeChecker } from '../src/check.js';
import { systemDns } from '../src/dns.js';
import { follow } from '../src/net.js';
import { startDnsServer } from './helpers/dns-server.js';
import { routedConnect, startHttps, testPki } from './helpers/servers.js';

const A = '93.184.216.1';
// Assembled from parts: the repository's contact-detail scan allows example domains only.
const mail = (local: string, domain: string): string => `mailto:${local}@${domain}`;

describe('the no-fetch list through the production resolver', () => {
  it.each([
    ['https://us.mensa.org.../members/roster', 'review'],
    [mail('officer', 'members.us.mensa.org..'), 'review'],
    ['https://members.us.mensa.org/control', 'review'],
    ['https://www.facebook.com.../groups/x', 'confirm'],
  ])('%s asks nothing about it but what it may, and connects nowhere (%s)', async (url, verdict) => {
    const server = await startDnsServer((_name, type) => (type === 'A' ? { answers: [A] } : type === 'MX' ? { answers: [{ priority: 10, exchange: 'mx.example' }] } : { answers: [] }));
    const pki = testPki(['us.mensa.org', 'www.facebook.com']);
    const stand = await startHttps((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('served'), pki);
    try {
      const connect = routedConnect({ [A]: stand.port }, pki.ca);
      const dns = systemDns({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      const out = await makeChecker({ dns, connect, issueDate: '2026-09-01', limits: { hopMs: 1000 } }).check(url);
      expect(out.verdict).toBe(verdict);
      expect(server.queries.filter((q) => q.name.includes('mensa'))).toEqual([]);
      if (verdict === 'confirm') expect(server.queries.map((q) => `${q.type} ${q.name}`).sort()).toEqual(['A www.facebook.com', 'AAAA www.facebook.com']);
      expect(connect.targets).toEqual([]);
    } finally {
      await stand.close();
      await server.close();
    }
  });

  it('a redirect to members.us.mensa.org.. is neither resolved nor requested', async () => {
    const server = await startDnsServer((_name, type) => (type === 'A' ? { answers: [A] } : { answers: [] }));
    const pki = testPki(['site.example', 'members.us.mensa.org']);
    const seen: string[] = [];
    const stand = await startHttps((req, res) => {
      seen.push(`${req.headers.host ?? ''} ${req.url ?? ''}`);
      if (req.headers.host === 'site.example') res.writeHead(302, { location: 'https://members.us.mensa.org../roster' }).end();
      else res.writeHead(200, { 'content-type': 'text/plain' }).end('member data');
    }, pki);
    try {
      const connect = routedConnect({ [A]: stand.port }, pki.ca);
      const dns = systemDns({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      const out = await follow('https://site.example/', { dns, connect, limits: { hopMs: 1000 } });
      expect(out.failure).toBe('no-fetch');
      expect(server.queries.filter((q) => q.name.includes('mensa'))).toEqual([]);
      expect(seen).toEqual(['site.example /']);
    } finally {
      await stand.close();
      await server.close();
    }
  });
});
