import { describe, expect, it } from 'vitest';
import { PUBLIC_HOSTS } from '../../server/public-hosts.mjs';
import { feedWebcal, publicOrigin } from './origin';

const SITE = new URL('https://nwflorida.us');
const asked = (host: string | undefined, url = 'http://localhost:8080/events'): Request => new Request(url, host === undefined ? {} : { headers: { host } });

describe('publicOrigin', () => {
  it.each(['canary.nwflorida.us', 'nwflorida.us', 'www.nwflorida.us', 'nwflmensa.us', 'www.nwflmensa.us'])('trusts the Host %s', (host) => {
    expect(publicOrigin(asked(host), SITE)).toBe(`https://${host}`);
  });

  it('ignores a port and the case of a trusted Host', () => {
    expect(publicOrigin(asked('Canary.NWFlorida.us:8080'), SITE)).toBe('https://canary.nwflorida.us');
  });

  it.each(['evil.example', 'nwflorida.us.evil.example', 'evil.example/nwflorida.us', 'x@nwflorida.us', 'sub.canary.nwflorida.us', '', ' '])('falls back to the configured site for the Host %j', (host) => {
    expect(publicOrigin(asked(host), SITE)).toBe('https://nwflorida.us');
  });

  it('falls back to the configured site with no Host at all', () => {
    expect(publicOrigin(asked(undefined), SITE)).toBe('https://nwflorida.us');
  });

  it('never reads a forwarded host', () => {
    const request = new Request('http://localhost:8080/events', { headers: { host: 'evil.example', 'x-forwarded-host': 'canary.nwflorida.us' } });
    expect(publicOrigin(request, SITE)).toBe('https://nwflorida.us');
  });

  it('keeps a local run on its own address, port and scheme', () => {
    expect(publicOrigin(asked('localhost:4321', 'http://localhost:4321/events'), SITE)).toBe('http://localhost:4321');
    expect(publicOrigin(asked('localhost:8443', 'https://localhost:8443/events'), SITE)).toBe('https://localhost:8443');
  });

  it('uses the built-in site when none is configured', () => {
    expect(publicOrigin(asked('evil.example'), undefined)).toBe('https://nwflorida.us');
  });

  it('lists exactly the hosts the server trusts, each over https', () => {
    expect(PUBLIC_HOSTS.filter((h) => h.hostname !== 'localhost').every((h) => h.protocol === 'https')).toBe(true);
    expect(PUBLIC_HOSTS.map((h) => h.hostname)).toEqual(
      expect.arrayContaining(['canary.nwflorida.us', 'nwflorida.us', 'www.nwflorida.us', 'nwflmensa.us', 'www.nwflmensa.us']),
    );
  });
});

describe('feedWebcal', () => {
  it('is the calendar feed on the trusted host', () => {
    expect(feedWebcal(asked('canary.nwflorida.us'), SITE)).toBe('webcal://canary.nwflorida.us/calendar.ics');
  });

  it('is the feed on the configured site for any other Host', () => {
    expect(feedWebcal(asked('evil.example'), SITE)).toBe('webcal://nwflorida.us/calendar.ics');
  });

  it('keeps the port of a local run', () => {
    expect(feedWebcal(asked('localhost:4321', 'http://localhost:4321/events'), SITE)).toBe('webcal://localhost:4321/calendar.ics');
  });
});
