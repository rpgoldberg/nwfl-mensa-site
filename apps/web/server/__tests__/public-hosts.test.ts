import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE, SITE, profileSite, siteFor } from '../public-hosts.mjs';

describe('SITE, the fallback origin (S2)', () => {
  it('is the SITE_ORIGIN profile when one is set and valid', () => {
    expect(siteFor({ SITE_ORIGIN: 'https://canary.nwflmensa.us' })).toBe('https://canary.nwflmensa.us');
    expect(siteFor({ SITE_ORIGIN: 'https://nwflmensa.us' })).toBe('https://nwflmensa.us');
    expect(profileSite({ SITE_ORIGIN: 'https://canary.nwflmensa.us' })).toBe('https://canary.nwflmensa.us');
  });

  it('stays https://nwflorida.us otherwise', () => {
    expect(DEFAULT_SITE).toBe('https://nwflorida.us');
    for (const SITE_ORIGIN of [undefined, '', 'https://nwflorida.us/', 'https://evil.example', '__proto__', 'https://canary.nwflmensa.us/']) {
      expect(siteFor({ SITE_ORIGIN }), String(SITE_ORIGIN)).toBe('https://nwflorida.us');
      expect(profileSite({ SITE_ORIGIN }), String(SITE_ORIGIN)).toBeUndefined();
    }
  });

  it('is read from the environment once, at load', () => {
    expect(SITE).toBe(siteFor(process.env));
  });
});
