import { describe, expect, it, vi } from 'vitest';
import { TokenStore, sharedTokenStore } from '../token-store.mjs';

const NOW = 1_800_000_000;

describe('TokenStore (server-side, bounded)', () => {
  it('forgets tokens when their session ends, and keeps at most the cap', () => {
    const store = new TokenStore(2);
    store.put('a', { access_token: '1' }, NOW + 10);
    expect(store.get('a', NOW + 9)).toEqual({ access_token: '1' });
    expect(store.has('a', NOW + 9)).toBe(true);
    expect(store.get('a', NOW + 10)).toBeUndefined();
    expect(store.has('a', NOW + 10)).toBe(false);
    store.put('b', { access_token: '2' }, NOW + 10);
    store.put('c', { access_token: '3' }, NOW + 10);
    store.put('d', { access_token: '4' }, NOW + 10);
    expect(['b', 'c', 'd'].filter((sid) => store.has(sid, NOW))).toEqual(['c', 'd']);
    expect(store.take('c', NOW)).toEqual({ access_token: '3' });
    expect(store.has('c', NOW)).toBe(false);
  });

  it('keeps a record as long as its renewed session', () => {
    const store = new TokenStore();
    store.put('a', { access_token: '1' }, NOW + 10);
    store.extend('a', NOW + 100);
    expect(store.has('a', NOW + 50)).toBe(true);
    store.extend('gone', NOW + 100);
    expect(store.has('gone', NOW)).toBe(false);
  });

  it('is one store for the whole process: the site and the server wrapper see the same records', async () => {
    vi.resetModules();
    const again = await import('../token-store.mjs');
    expect(again.TokenStore).not.toBe(TokenStore); // a second copy of the file, as the bundle has
    expect(again.sharedTokenStore()).toBe(sharedTokenStore());
  });
});
