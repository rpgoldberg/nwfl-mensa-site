// MARKUP-DOS round 3: trimTrailing (src/links/urls.ts, linkcheck's copy byte for byte) trims in one pass.
// The frozen copy below is the version it replaced, which recounted the brackets for each character it
// took off (quadratic on a hostile run of them). The two must agree on every input.
import { describe, expect, it } from 'vitest';
import { trimTrailing } from '../../src/links/urls.js';

/** FROZEN: trimTrailing as it was on main at f9bcc90. */
function before(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    if (/[.,;:!?'"]/.test(last)) out = out.slice(0, -1);
    else if (last === ')' && (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length) out = out.slice(0, -1);
    else if (last === ']' && (out.match(/\[/g) ?? []).length < (out.match(/\]/g) ?? []).length) out = out.slice(0, -1);
    else return out;
  }
}

describe('trimTrailing in one pass', () => {
  it('agrees with the version it replaced on every string of up to six of these characters', () => {
    const alphabet = ['a', '.', ',', ';', ':', '!', '?', "'", '"', '(', ')', '[', ']', '/'];
    let level = [''];
    let checked = 0;
    for (let length = 1; length <= 5; length += 1) {
      level = level.flatMap((prefix) => alphabet.map((c) => prefix + c));
      for (const tail of level) {
        const url = `https://a.example/${tail}`;
        if (trimTrailing(url) !== before(url)) expect(trimTrailing(url), url).toBe(before(url));
        checked += 1;
      }
    }
    expect(checked).toBe(14 + 14 ** 2 + 14 ** 3 + 14 ** 4 + 14 ** 5);
  });

  it('agrees on 20,000 seeded longer tails', () => {
    let seed = 0x7a11;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 4294967296;
    };
    const alphabet = 'a.,;:!?\'"()[]/xé';
    for (let n = 0; n < 20_000; n += 1) {
      let tail = '';
      const length = Math.floor(next() * 40);
      for (let k = 0; k < length; k += 1) tail += alphabet[Math.floor(next() * alphabet.length)] as string;
      const url = `https://a.example/${tail}`;
      if (trimTrailing(url) !== before(url)) expect(trimTrailing(url), url).toBe(before(url));
    }
  });

  it('takes linear time on a hostile run of closing brackets', () => {
    const url = `https://a.example/${')'.repeat(20_000)}${']'.repeat(20_000)}`;
    const start = performance.now();
    expect(trimTrailing(url)).toBe('https://a.example/');
    expect(performance.now() - start).toBeLessThan(50);
  });
});
