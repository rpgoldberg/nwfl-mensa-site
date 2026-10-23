// The seven text sizes live in one constant, SIZES (server/prefs.mjs). CSS
// cannot import it, so this reads the stylesheets the site ships and checks
// every rule keyed on a size against it: the root size, the panel's readout,
// the bold notch, the slider's fill, and where A+ gives way below the cap.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, SIZES } from '../server/prefs.mjs';

const css = (file: string) => readFileSync(`src/styles/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = css('tokens.css');
const site = css('site.css');
const named = (text: string) => new Set([...text.matchAll(/data-size="(\d+)"/g)].map((m) => Number(m[1])));
const largest = SIZES.at(-1)!;

describe('the CSS for the seven sizes (SIZES)', () => {
  it('sets the root size of each, in percent, and names no other', () => {
    const rules = new Map([...tokens.matchAll(/html\[data-size="(\d+)"\]\s*\{\s*font-size:\s*(?:min\()?(\d+)%/g)].map((m) => [Number(m[1]), Number(m[2])]));
    expect([...rules.keys()]).toEqual([...SIZES]);
    for (const [size, percent] of rules) expect(percent, String(size)).toBe(size);
    expect([...named(tokens)]).toEqual([...SIZES]);
    expect([...named(site)].sort((a, b) => a - b)).toEqual([...SIZES]);
  });

  it('shows each size in the readout and in bold among the notch numbers', () => {
    for (const size of SIZES) {
      expect(site, String(size)).toContain(`html[data-size="${size}"] .sz-now [data-for-size="${size}"]`);
      expect(site, String(size)).toContain(`html[data-size="${size}"] .tick[data-for-size="${size}"]`);
    }
  });

  it("fills the slider's track to each notch: notch k of 6 is k/6 of the way", () => {
    expect(site).toMatch(/\.sl-input \{[^}]*--fill: 50%;/);
    expect(SIZES.indexOf(DEFAULT_PREFS.size)).toBe(3);
    SIZES.forEach((size, k) => {
      if (size === DEFAULT_PREFS.size) return;
      const fill = new RegExp(`html\\[data-size="${size}"\\] \\.sl-input \\{ --fill: ([\\d.]+)%; \\}`).exec(site);
      expect(Number(fill?.[1]), String(size)).toBeCloseTo((100 * k) / 6, 2);
    });
  });

  it('caps only the largest size by the screen, and gives A+ way at the next one where the cap brings the largest below it', () => {
    const cap = Number(new RegExp(`html\\[data-size="${largest}"\\] \\{ font-size: min\\(${largest}%, ([\\d.]+)vw\\); \\}`).exec(tokens)?.[1]);
    expect(cap).toBeGreaterThan(0);
    const next = SIZES.at(-2)!;
    // Below this width (in the browser's em, as the cap is) cap vw is under next %.
    const em = Number(new RegExp(`@media \\(max-width: ([\\d.]+)em\\) \\{\\s*html\\[data-size="${next}"\\] \\.size-up`).exec(site)?.[1]);
    expect(em).toBeCloseTo(next / cap, 3);
  });
});
