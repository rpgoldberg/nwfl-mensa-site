import { describe, expect, it } from 'vitest';
import { parkedSignals } from '../src/parked.js';

describe('parkedSignals: any one means parked or for sale (Ross confirms)', () => {
  it('names parking nameservers', () => {
    expect(parkedSignals({ ns: ['ns1.sedoparking.com', 'ns2.sedoparking.com'] })).toEqual(['parking-ns']);
    expect(parkedSignals({ ns: ['NS1.PARKINGCREW.NET.'] })).toEqual(['parking-ns']);
    expect(parkedSignals({ ns: ['ns1.provider.example'] })).toEqual([]);
  });

  it('names a final host on a domain marketplace', () => {
    expect(parkedSignals({ finalUrl: 'https://www.hugedomains.com/domain_profile.cfm?d=site' })).toEqual(['marketplace']);
    expect(parkedSignals({ finalUrl: 'https://sedo.com/search/details/?domain=site.example' })).toEqual(['marketplace']);
    expect(parkedSignals({ finalUrl: 'https://www.godaddy.com/forsale/site.example' })).toEqual(['marketplace']);
    expect(parkedSignals({ finalUrl: 'https://www.godaddy.com/hosting' })).toEqual([]);
  });

  it.each([
    'This domain is for sale!',
    'The domain site.example may be for sale. Inquire now.',
    'Buy this domain',
    'This web page is parked FREE, courtesy of a registrar',
    'Make an offer on this domain',
  ])('names for-sale text: %s', (text) => {
    expect(parkedSignals({ body: `<html><body><h1>${text}</h1></body></html>` })).toEqual(['for-sale-text']);
  });

  it('names a near-empty page that loads a parking ad feed, and only a near-empty one', () => {
    expect(parkedSignals({ body: '<html><head><script src="//www.google.com/adsense/domains/caf.js"></script></head><body><div id="ads"></div></body></html>' })).toEqual(['parking-feed']);
    const full = `<html><head><script src="//www.google.com/adsense/domains/caf.js"></script></head><body>${'<p>Real club news and our calendar of events.</p>'.repeat(20)}</body></html>`;
    expect(parkedSignals({ body: full })).toEqual([]);
  });

  it('reads the visible text only: a phrase in a script or a comment is not a signal', () => {
    expect(parkedSignals({ body: '<script>var s = "this domain is for sale";</script><!-- buy this domain --><p>Welcome to the club</p>' })).toEqual([]);
  });

  it('gives nothing for nothing, and every signal once', () => {
    expect(parkedSignals({})).toEqual([]);
    expect(parkedSignals({ ns: ['ns1.bodis.com'], finalUrl: 'https://dan.com/buy-domain/site.example', body: 'This domain is for sale' })).toEqual(['parking-ns', 'marketplace', 'for-sale-text']);
  });

  it.each([
    ['<', '<'],
    ['<!--', '<!--'],
    ['<script', '<script'],
    ['<style>', '<style>'],
    ['<a ', '<a '],
  ])('reads a 256 KiB body of %j repeated in linear time (N2)', (_name, unit) => {
    const body = unit.repeat(Math.ceil((256 * 1024) / unit.length));
    const start = performance.now();
    expect(parkedSignals({ body })).toEqual([]);
    expect(performance.now() - start).toBeLessThan(500);
  }, 60_000);

  it('strips tags, comments and raw-text elements as the pattern did, unterminated ones to the end', () => {
    expect(parkedSignals({ body: '<p>This domain</p> <b>is</b> for <i>sale</i>' })).toEqual(['for-sale-text']);
    expect(parkedSignals({ body: '<STYLE>x</style ><p>Buy this domain</p>' })).toEqual(['for-sale-text']);
    expect(parkedSignals({ body: '<p>Welcome</p><!-- buy this domain' })).toEqual([]);
    expect(parkedSignals({ body: '<p>Welcome</p><script>buy this domain' })).toEqual([]);
    expect(parkedSignals({ body: '<p>Welcome</p><a href="buy this domain"' })).toEqual([]);
    expect(parkedSignals({ body: '<scripts>Buy this domain</scripts>' })).toEqual(['for-sale-text']);
    expect(parkedSignals({ body: 'Buy&nbsp;this&nbsp;domain' })).toEqual(['for-sale-text']);
  });

  // S4 (round 2): U+0130 lower-cases to two code units in full Unicode, which would shift every index
  // after it; the scan lower-cases ASCII only, so its indices stay those of the body.
  it.each([
    ['ten U+0130 before a tag', `${'\u0130'.repeat(10)}<b>x</b> This domain is for sale`],
    ['sixty U+0130 before a tag', `${'\u0130'.repeat(60)}<b>x</b> This domain is for sale`],
    ['U+0130 before a comment', `\u0130\u0130<!-- note --> This domain is for sale`],
    ['U+0130 before an empty tag', `\u0130\u0130\u0130<br> Buy this domain`],
    ['U+0130 before a script', `\u0130<script>var x = 1;</script><p>Make an offer on this domain</p>`],
  ])('finds for-sale text after %s', (_name, body) => {
    expect(parkedSignals({ body })).toEqual(['for-sale-text']);
  });

  it('still hides a for-sale phrase in a script or comment after U+0130', () => {
    expect(parkedSignals({ body: `\u0130\u0130<SCRIPT>buy this domain</SCRIPT><p>Welcome</p>` })).toEqual([]);
    expect(parkedSignals({ body: `\u0130<!-- buy this domain --><p>Welcome</p>` })).toEqual([]);
  });
});
