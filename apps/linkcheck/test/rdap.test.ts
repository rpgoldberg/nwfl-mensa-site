import { afterEach, describe, expect, it } from 'vitest';
import { RDAP_BOOTSTRAP, makeRdap, rdapDomain } from '../src/rdap.js';
import { type Route, type Stand, fakeDns, routedConnect, startHttps, testPki } from './helpers/servers.js';

const IANA = '93.184.215.20';
const REGISTRY = '93.184.215.21';
const pki = testPki(['data.iana.org', 'rdap.registry.example', 'rdap.other.example']);
const stands: Stand[] = [];
afterEach(async () => {
  await Promise.all(stands.splice(0).map((s) => s.close()));
});

const bootstrap = { version: '1.0', services: [[['example', 'test'], ['http://rdap.registry.example/', 'https://rdap.registry.example/v1/']], [['org'], ['https://rdap.other.example/']]] };

async function setup(registry: Route, iana: Route = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bootstrap))) {
  const ianaStand = await startHttps(iana, pki);
  const registryStand = await startHttps(registry, pki);
  stands.push(ianaStand, registryStand);
  const connect = routedConnect({ [IANA]: ianaStand.port, [REGISTRY]: registryStand.port }, pki.ca);
  const dns = fakeDns({ 'data.iana.org': [IANA], 'rdap.registry.example': [REGISTRY], 'rdap.other.example': [REGISTRY] });
  return { rdap: makeRdap({ dns, connect }), connect };
}

const route = (r: Route): Route => r;
const domainReply = (events: unknown): Route => (req, res) => {
  if (req.url === '/v1/domain/site.example') res.writeHead(200, { 'content-type': 'application/rdap+json' }).end(JSON.stringify({ objectClassName: 'domain', events }));
  else res.writeHead(404).end();
};

describe('rdapDomain', () => {
  it('is the ICANN registrable domain (a private suffix is not a registry)', () => {
    expect(rdapDomain('www.site.example')).toBe('site.example');
    expect(rdapDomain('one.github.io')).toBe('github.io');
    expect(rdapDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(rdapDomain('8.8.8.8')).toBeUndefined();
  });
});

describe('makeRdap: the registration date, from the server the IANA bootstrap names', () => {
  it('uses the official bootstrap URL by default', () => {
    expect(RDAP_BOOTSTRAP).toBe('https://data.iana.org/rdap/dns.json');
  });

  it('reads the latest registration or re-registration event, from the https server', async () => {
    const { rdap, connect } = await setup(
      domainReply([
        { eventAction: 'registration', eventDate: '2001-05-01T00:00:00Z' },
        { eventAction: 'reregistration', eventDate: '2025-03-04T10:00:00Z' },
        { eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' },
        { eventAction: 'last changed', eventDate: '2026-01-01T00:00:00Z' },
      ]),
    );
    expect(await rdap.registered('site.example')).toEqual({ status: 'dated', date: '2025-03-04' });
    // Cached: a second ask for the same domain and the bootstrap cost nothing more.
    const before = connect.targets.length;
    expect(await rdap.registered('site.example')).toEqual({ status: 'dated', date: '2025-03-04' });
    expect(connect.targets.length).toBe(before);
  });

  it.each([
    ['a TLD the bootstrap does not list', 'site.unlisted', 'no-rdap'],
    ['a domain the registry does not know', 'missing.example', 'not-found'],
  ])('reports %s', async (_name, domain, why) => {
    const { rdap } = await setup(domainReply([]));
    expect(await rdap.registered(domain)).toEqual({ status: 'unknown', why });
  });

  it.each([
    ['no events', domainReply(undefined)],
    ['no registration event', domainReply([{ eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }])],
    ['a bad date', domainReply([{ eventAction: 'registration', eventDate: 'yesterday' }])],
    ['a server error', route((_req, res) => res.writeHead(500).end())],
    ['a body that is not JSON', route((_req, res) => res.writeHead(200, { 'content-type': 'application/rdap+json' }).end('<html>'))],
  ])('reports unknown on %s', async (_name, route) => {
    const { rdap } = await setup(route);
    expect(await rdap.registered('site.example')).toEqual({ status: 'unknown', why: 'error' });
  });

  it.each([
    ['a bootstrap that is not JSON', route((_req, res) => res.end('nope'))],
    ['a bootstrap of the wrong shape', route((_req, res) => res.end(JSON.stringify({ services: 'x' })))],
    ['a bootstrap entry of the wrong shape', route((_req, res) => res.end(JSON.stringify({ services: [['example', 'x'], [[1], [2]]] })))],
    ['a bootstrap server error', route((_req, res) => res.writeHead(503).end())],
  ])('reports no-rdap on %s', async (_name, iana) => {
    const { rdap } = await setup(domainReply([]), iana);
    expect(await rdap.registered('site.example')).toEqual({ status: 'unknown', why: 'no-rdap' });
  });

  it('never uses a plain-http RDAP server', async () => {
    const only = { services: [[['example'], ['http://rdap.registry.example/']]] };
    const { rdap, connect } = await setup(domainReply([]), (_req, res) => res.end(JSON.stringify(only)));
    expect(await rdap.registered('site.example')).toEqual({ status: 'unknown', why: 'no-rdap' });
    expect(connect.targets.map((t) => t.address)).toEqual([IANA]);
  });
});
