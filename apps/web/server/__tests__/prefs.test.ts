import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  SIZES,
  SIZE_COOKIE,
  THEMES,
  THEME_COOKIE,
  type Size,
  applyChange,
  htmlAttributes,
  prefsCookies,
  readPrefs,
  safeBack,
  sizeSlider,
  stampHtml,
} from '../prefs.mjs';

describe('cookie names', () => {
  it('are host-only by prefix, so no other app on a parent domain can set them', () => {
    expect(SIZE_COOKIE).toBe('__Host-nwfl-size');
    expect(THEME_COOKIE).toBe('__Host-nwfl-theme');
  });
});

describe('readPrefs', () => {
  it('is 100 % and the device theme with no cookie', () => {
    expect(readPrefs(undefined)).toEqual({ size: 100, theme: undefined });
    expect(readPrefs('')).toEqual(DEFAULT_PREFS);
  });

  it('reads the size and theme cookies', () => {
    expect(readPrefs(`${SIZE_COOKIE}=${SIZES[5]}; ${THEME_COOKIE}=dark`)).toEqual({ size: SIZES[5], theme: 'dark' });
    expect(readPrefs(`a=1;${THEME_COOKIE}=contrast-yellow ; ${SIZE_COOKIE}=75`)).toEqual({ size: 75, theme: 'contrast-yellow' });
    expect(readPrefs(`${THEME_COOKIE}=contrast-white`)).toEqual({ size: 100, theme: 'contrast-white' });
    expect(readPrefs(`${THEME_COOKIE}=light`)).toEqual({ size: 100, theme: 'light' });
    for (const size of SIZES) expect(readPrefs(`${SIZE_COOKIE}=${size}`).size).toBe(size);
  });

  it("maps the old five-step sizes to the new steps: 1 is 100 %, 2 is 115 %, 3 is 140 %, 4 and 5 are 175 % (Ross's map)", () => {
    for (const [old, now] of [['1', SIZES[3]], ['2', SIZES[4]], ['3', SIZES[5]], ['4', SIZES[6]], ['5', SIZES[6]]] as const) {
      expect(readPrefs(`${SIZE_COOKIE}=${old}`).size, `old size ${old}`).toBe(now);
    }
  });

  it('maps the old high contrast theme (yellow on black, now dropped) to warm white', () => {
    expect(readPrefs(`${THEME_COOKIE}=contrast`).theme).toBe('contrast-white');
  });

  it('ignores a value it does not know, and a cookie whose name only ends the same', () => {
    for (const size of ['0', '6', '2.5', 'big', '', '03', '100.0', '200', '85', '0100']) {
      expect(readPrefs(`${SIZE_COOKIE}=${size}`).size, size).toBe(100);
    }
    for (const theme of ['neon', '', 'Dark', 'system', 'contrast-black']) {
      expect(readPrefs(`${THEME_COOKIE}=${theme}`).theme, theme).toBeUndefined();
    }
    expect(readPrefs(`x${SIZE_COOKIE}=${SIZES[5]}; x${THEME_COOKIE}=dark`)).toEqual(DEFAULT_PREFS);
  });

  it('ignores the same names without the prefix, which a sibling subdomain could set', () => {
    expect(readPrefs('nwfl-size=175; nwfl-theme=dark')).toEqual(DEFAULT_PREFS);
  });

  it('ignores a name that becomes ours only once a no-break space is trimmed off (the 0xA0 toss)', () => {
    // A sibling sets "\xa0__Host-nwfl-size" on the parent domain: not a __Host-
    // name to the browser, so it is stored with the Domain, and sent back with the 0xA0.
    expect(readPrefs(' __Host-nwfl-size=175;  __Host-nwfl-theme=dark')).toEqual(DEFAULT_PREFS);
    expect(readPrefs('x=1; __Host-nwfl-size=175')).toEqual(DEFAULT_PREFS);
  });

  it('matches names case-sensitively: a __HOST- variant is not ours', () => {
    expect(readPrefs('__HOST-nwfl-size=175; __host-nwfl-theme=dark')).toEqual(DEFAULT_PREFS);
  });

  it('trims only the space and tab a Cookie header may carry around a name', () => {
    expect(readPrefs(` \t${SIZE_COOKIE} = ${SIZES[5]} ;${THEME_COOKIE}=dark`)).toEqual({ size: SIZES[5], theme: 'dark' });
  });
});

describe('SIZES and THEMES', () => {
  it('are the seven sizes, 100 % the fourth, and the four themes in menu order', () => {
    // Ross's list (2026-10-23, 12:0xC); every other test reads SIZES.
    expect(SIZES).toEqual([75, 80, 90, 100, 115, 140, 175]);
    expect(SIZES.indexOf(DEFAULT_PREFS.size)).toBe(3);
    expect(THEMES).toEqual(['light', 'dark', 'contrast-yellow', 'contrast-white']);
  });
});

describe('applyChange', () => {
  const at = (size: Size) => ({ size, theme: undefined });

  it('steps the size up and down through the seven sizes, and stops at each end', () => {
    expect(applyChange(at(100), { size: 'larger' }).size).toBe(SIZES[4]);
    expect(applyChange(at(SIZES[5]), { size: 'larger' }).size).toBe(SIZES[6]);
    expect(applyChange(at(SIZES[6]), { size: 'larger' }).size).toBe(SIZES[6]);
    expect(applyChange(at(SIZES[3]), { size: 'smaller' }).size).toBe(SIZES[2]);
    expect(applyChange(at(SIZES[1]), { size: 'smaller' }).size).toBe(SIZES[0]);
    expect(applyChange(at(SIZES[0]), { size: 'smaller' }).size).toBe(SIZES[0]);
  });

  it("sets the slider's notch with Use this size: notch 0 is 75 %, notch 6 is 175 %", () => {
    expect(SIZES.map((_, i) => applyChange(at(100), { size: 'set', step: String(i) }).size)).toEqual([...SIZES]);
  });

  it('changes nothing for a notch it does not know, or a notch without Use this size', () => {
    for (const step of [undefined, '', '7', '-1', '1.5', '03', ' 3', 'x', '1e0']) {
      expect(applyChange(at(SIZES[5]), { size: 'set', step }).size, String(step)).toBe(SIZES[5]);
    }
    // A theme button submits the same form, slider and all: the size stays.
    expect(applyChange(at(SIZES[5]), { step: '0', theme: 'dark' })).toEqual({ size: SIZES[5], theme: 'dark' });
  });

  it('sets a theme, or goes back to the device setting', () => {
    expect(applyChange(DEFAULT_PREFS, { theme: 'dark' })).toEqual({ size: 100, theme: 'dark' });
    expect(applyChange({ size: SIZES[4], theme: 'dark' }, { theme: 'contrast-yellow' })).toEqual({ size: SIZES[4], theme: 'contrast-yellow' });
    expect(applyChange({ size: SIZES[4], theme: 'dark' }, { theme: 'contrast-white' })).toEqual({ size: SIZES[4], theme: 'contrast-white' });
    expect(applyChange({ size: SIZES[4], theme: 'dark' }, { theme: 'light' })).toEqual({ size: SIZES[4], theme: 'light' });
    expect(applyChange({ size: SIZES[4], theme: 'dark' }, { theme: 'system' })).toEqual({ size: SIZES[4], theme: undefined });
  });

  it('changes nothing for a value it does not know', () => {
    const prefs = { size: SIZES[5], theme: 'dark' as const };
    expect(applyChange(prefs, { size: 'huge', theme: 'neon' })).toEqual(prefs);
    // The reading bar's cycle is gone: "next" is a value it does not know.
    expect(applyChange(prefs, { theme: 'next' })).toEqual(prefs);
    expect(applyChange(prefs, { theme: 'contrast' })).toEqual(prefs);
    expect(applyChange(prefs, {})).toEqual(prefs);
  });
});

describe('prefsCookies', () => {
  it('stores a choice for a year, for the whole site, unreadable to scripts', () => {
    expect(prefsCookies({ size: SIZES[5], theme: 'dark' })).toEqual([
      `${SIZE_COOKIE}=${SIZES[5]}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`,
      `${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`,
    ]);
  });

  it('removes a cookie that holds the default, so an untouched reader sends none', () => {
    expect(prefsCookies(DEFAULT_PREFS)).toEqual([
      `${SIZE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`,
      `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`,
    ]);
  });

  it('rewrites an old cookie in the new form on the next press', () => {
    const prefs = applyChange(readPrefs(`${SIZE_COOKIE}=5; ${THEME_COOKIE}=contrast`), { size: 'smaller' });
    expect(prefsCookies(prefs).map((c) => c.split(';')[0])).toEqual([`${SIZE_COOKIE}=${SIZES[5]}`, `${THEME_COOKIE}=contrast-white`]);
  });

  it('makes every cookie host-only: __Host-, Secure, Path=/, no Domain, SameSite=Lax', () => {
    for (const prefs of [DEFAULT_PREFS, { size: SIZES[6], theme: 'contrast-white' as const }, { size: SIZES[0], theme: undefined }]) {
      for (const cookie of prefsCookies(prefs)) {
        const [pair, ...rest] = cookie.split(';').map((part) => part.trim());
        const attrs = rest.map((a) => a.toLowerCase());
        expect(pair).toMatch(/^__Host-[\w-]+=/);
        expect(attrs).toEqual(expect.arrayContaining(['secure', 'path=/', 'samesite=lax', 'httponly']));
        expect(attrs.filter((a) => a.startsWith('domain'))).toEqual([]);
      }
    }
  });
});

describe('sizeSlider', () => {
  it("is a native range of seven notches at the reader's size, named for a screen reader in percent", () => {
    expect(sizeSlider(100)).toBe(
      `<input id="text-size" class="sl-input" type="range" name="step" min="0" max="6" step="1" value="3" aria-valuetext="100 percent" data-sizes="${SIZES.join(' ')}">`,
    );
    SIZES.forEach((size, i) => expect(sizeSlider(size)).toContain(` value="${i}" aria-valuetext="${size} percent"`));
  });
});

describe('htmlAttributes and stampHtml', () => {
  it('names the size always, and the theme only when the reader chose one', () => {
    expect(htmlAttributes(DEFAULT_PREFS)).toEqual({ lang: 'en', 'data-size': '100' });
    expect(htmlAttributes({ size: SIZES[6], theme: 'contrast-white' })).toEqual({ lang: 'en', 'data-size': String(SIZES[6]), 'data-theme': 'contrast-white' });
  });

  it("rewrites only a prerendered page's html start tag and its size slider", () => {
    const page = `<!DOCTYPE html><html lang="en" data-size="100"><head></head><body><p>&lt;html data-size="100"&gt;</p><label for="text-size">Text size</label>${sizeSlider(100)}</body></html>`;
    expect(stampHtml(page, { size: SIZES[6], theme: 'dark' })).toBe(
      `<!DOCTYPE html><html lang="en" data-size="${SIZES[6]}" data-theme="dark"><head></head><body><p>&lt;html data-size="100"&gt;</p><label for="text-size">Text size</label>${sizeSlider(SIZES[6])}</body></html>`,
    );
    expect(stampHtml(page, DEFAULT_PREFS)).toBe(page);
  });

  it('leaves a document with no html tag or slider alone', () => {
    expect(stampHtml('<p>hi</p>', { size: SIZES[4], theme: undefined })).toBe('<p>hi</p>');
  });
});

describe('safeBack', () => {
  it('keeps a path on this site, with its query, in printable ASCII', () => {
    expect(safeBack('/search?q=caf%C3%A9&page=2')).toBe('/search?q=caf%C3%A9&page=2');
    expect(safeBack('/about')).toBe('/about');
    expect(safeBack('/search?q=picnic+lunch')).toBe('/search?q=picnic+lunch');
    expect(safeBack('/')).toBe('/');
  });

  it('drops a fragment, since the redirect adds its own', () => {
    expect(safeBack('/about#reader-menu')).toBe('/about');
  });

  it('sends anything that could leave the site, or split a header, to Home', () => {
    for (const back of [
      undefined,
      '',
      'about',
      '//evil.example/x',
      '/\\evil.example',
      '/\tevil',
      'https://evil.example/',
      'javascript:alert(1)',
      '/a\r\nSet-Cookie: x=1',
      `/${'a'.repeat(2048)}`,
      '/\u0000x',
      '/\u0001x',
      '/a\u001fb',
      '/\u007fx',
      '/\u20acx',
      '/caf\u00e9',
    ]) {
      expect(safeBack(back), String(back).slice(0, 40)).toBe('/');
    }
  });
});
