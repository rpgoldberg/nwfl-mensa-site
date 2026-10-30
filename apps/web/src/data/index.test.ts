import { describe, expect, it } from 'vitest';
import { ApiUnavailable } from '../lib/api/client';
import { fixtureData } from './fixtures';
import { liveData, liveFromEnv, siteData } from './index';

describe('the data the pages read', () => {
  it('keeps the bundled fixtures for the newsletter and the minutes', () => {
    expect(siteData).toBe(fixtureData);
  });

  it('has no live data without API_URL, so the pages keep their bundled content (the canary runs so)', () => {
    const lines: string[] = [];
    expect(liveFromEnv({}, { publicOnly: false, log: (l) => lines.push(l) })).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('reads the API when API_URL is set', () => {
    const live = liveFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: false, log: () => {} });
    expect(live).toBeDefined();
    expect(Object.keys(live!).sort()).toEqual(['announcements', 'event', 'events', 'file', 'issues', 'offices', 'presidentReport', 'treasurerSummaries']);
  });

  it('answers every read as unavailable when API_URL is set wrongly, and says why once, at start', async () => {
    const lines: string[] = [];
    const live = liveFromEnv({ API_URL: 'ftp://api' }, { publicOnly: false, log: (l) => lines.push(l) });
    await expect(live!.offices()).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(live!.events('2026-11-01', '2026-11-30')).rejects.toBeInstanceOf(ApiUnavailable);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ level: 'error', msg: 'API_URL must be http: or https:' }]);
  });

  it('makes the live data once per process, from its environment', () => {
    expect(process.env['API_URL']).toBeUndefined();
    expect(liveData()).toBeUndefined();
    expect(liveData()).toBe(liveData());
  });

  it('never reads the API in a public-only build, which shows no submitted content (MT-50)', () => {
    expect(liveFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: true, log: () => {} })).toBeUndefined();
  });
});
