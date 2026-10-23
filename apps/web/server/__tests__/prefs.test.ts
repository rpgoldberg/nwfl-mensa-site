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
    expect(readPrefs(`${SIZE_COOKIE}=150; ${THEME_COOKIE}=dark`)).toEqual({ size: 150, theme: 'dark' });
    expect(readPrefs(`a=1;${THEME_COOKIE}=contrast-yellow ; ${SIZE_COOKIE}=75`)).toEqual({ size: 75, theme: 'contrast-yellow' });
    expect(readPrefs(`${THEME_COOKIE}=contrast-white`)).toEqual({ size: 100, theme: 'contrast-white' });
    expect(readPrefs(`${THEME_COOKIE}=light`)).toEqual({ size: 100, theme: 'light' });
    for (const size of SIZES) expect(readPrefs(`${SIZE_COOKIE}=${size}`).size).toBe(size);
  });

  it('maps the old five-step sizes to the new steps: 2 and 3 keep 125 and 150 %, 4 and 5 become 175 %', () => {
    expect([1, 2, 3, 4, 5].map((old) => readPrefs(`${SIZE_COOKIE}=${old}`).size)).toEqual([100, 125, 150, 175, 175]);
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
    expect(readPrefs(`x${SIZE_COOKIE}=150; x${THEME_COOKIE}=dark`)).toEqual(DEFAULT_PREFS);
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
    expect(readPrefs(` \t${SIZE_COOKIE} = 150 ;${THEME_COOKIE}=dark`)).toEqual({ size: 150, theme: 'dark' });
  });
});

describe('SIZES and THEMES', () => {
  it('are the seven sizes, 100 % the fourth, and the four themes in menu order', () => {
    expect(SIZES).toEqual([75, 80, 90, 100, 125, 150, 175]);
    expect(SIZES.indexOf(DEFAULT_PREFS.size)).toBe(3);
    expect(THEMES).toEqual(['light', 'dark', 'contrast-yellow', 'contrast-white']);
  });
});

describe('applyChange', () => {
  const at = (size: Size) => ({ size, theme: undefined });

  it('steps the size up and down through the seven sizes, and stops at each end', () => {
    expect(applyChange(at(100), { size: 'larger' }).size).toBe(125);
    expect(applyChange(at(150), { size: 'larger' }).size).toBe(175);
    expect(applyChange(at(175), { size: 'larger' }).size).toBe(175);
    expect(applyChange(at(100), { size: 'smaller' }).size).toBe(90);
    expect(applyChange(at(80), { size: 'smaller' }).size).toBe(75);
    expect(applyChange(at(75), { size: 'smaller' }).size).toBe(75);
  });

  it("sets the slider's notch with Use this size: notch 0 is 75 %, notch 6 is 175 %", () => {
    expect(SIZES.map((_, i) => applyChange(at(100), { size: 'set', step: String(i) }).size)).toEqual([...SIZES]);
  });

  it('changes nothing for a notch it does not know, or a notch without Use this size', () => {
    for (const step of [undefined, '', '7', '-1', '1.5', '03', ' 3', 'x', '1e0']) {
      expect(applyChange(at(150), { size: 'set', step }).size, String(step)).toBe(150);
    }
    // A theme button submits the same form, slider and all: the size stays.
    expect(applyChange(at(150), { step: '0', theme: 'dark' })).toEqual({ size: 150, theme: 'dark' });
  });

  it('sets a theme, or goes back to the device setting', () => {
    expect(applyChange(DEFAULT_PREFS, { theme: 'dark' })).toEqual({ size: 100, theme: 'dark' });
    expect(applyChange({ size: 125, theme: 'dark' }, { theme: 'contrast-yellow' })).toEqual({ size: 125, theme: 'contrast-yellow' });
    expect(applyChange({ size: 125, theme: 'dark' }, { theme: 'contrast-white' })).toEqual({ size: 125, theme: 'contrast-white' });
    expect(applyChange({ size: 125, theme: 'dark' }, { theme: 'light' })).toEqual({ size: 125, theme: 'light' });
    expect(applyChange({ size: 125, theme: 'dark' }, { theme: 'system' })).toEqual({ size: 125, theme: undefined });
  });

  it('cycles the theme for the reading bar in menu order: device, light, dark, soft yellow, warm white, device', () => {
    const seen: (string | undefined)[] = [];
    let prefs = applyChange(DEFAULT_PREFS, {});
    for (let i = 0; i < 5; i++) {
      prefs = applyChange(prefs, { theme: 'next' });
      seen.push(prefs.theme);
    }
    expect(seen).toEqual(['light', 'dark', 'contrast-yellow', 'contrast-white', undefined]);
  });

  it('changes nothing for a value it does not know', () => {
    const prefs = { size: 150 as const, theme: 'dark' as const };
    expect(applyChange(prefs, { size: 'huge', theme: 'neon' })).toEqual(prefs);
    expect(applyChange(prefs, { theme: 'contrast' })).toEqual(prefs);
    expect(applyChange(prefs, {})).toEqual(prefs);
  });
});

describe('prefsCookies', () => {
  it('stores a choice for a year, for the whole site, unreadable to scripts', () => {
    expect(prefsCookies({ size: 150, theme: 'dark' })).toEqual([
      `${SIZE_COOKIE}=150; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`,
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
    expect(prefsCookies(prefs).map((c) => c.split(';')[0])).toEqual([`${SIZE_COOKIE}=150`, `${THEME_COOKIE}=contrast-white`]);
  });

  it('makes every cookie host-only: __Host-, Secure, Path=/, no Domain, SameSite=Lax', () => {
    for (const prefs of [DEFAULT_PREFS, { size: 175 as const, theme: 'contrast-white' as const }, { size: 75 as const, theme: undefined }]) {
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
      '<input id="text-size" class="sl-input" type="range" name="step" min="0" max="6" step="1" value="3" aria-valuetext="100 percent" data-sizes="75 80 90 100 125 150 175">',
    );
    expect(sizeSlider(75)).toContain(' value="0" aria-valuetext="75 percent"');
    expect(sizeSlider(175)).toContain(' value="6" aria-valuetext="175 percent"');
  });
});

describe('htmlAttributes and stampHtml', () => {
  it('names the size always, and the theme only when the reader chose one', () => {
    expect(htmlAttributes(DEFAULT_PREFS)).toEqual({ lang: 'en', 'data-size': '100' });
    expect(htmlAttributes({ size: 175, theme: 'contrast-white' })).toEqual({ lang: 'en', 'data-size': '175', 'data-theme': 'contrast-white' });
  });

  it("rewrites only a prerendered page's html start tag and its size slider", () => {
    const page = `<!DOCTYPE html><html lang="en" data-size="100"><head></head><body><p>&lt;html data-size="100"&gt;</p><label for="text-size">Text size</label>${sizeSlider(100)}</body></html>`;
    expect(stampHtml(page, { size: 175, theme: 'dark' })).toBe(
      `<!DOCTYPE html><html lang="en" data-size="175" data-theme="dark"><head></head><body><p>&lt;html data-size="100"&gt;</p><label for="text-size">Text size</label>${sizeSlider(175)}</body></html>`,
    );
    expect(stampHtml(page, DEFAULT_PREFS)).toBe(page);
  });

  it('leaves a document with no html tag or slider alone', () => {
    expect(stampHtml('<p>hi</p>', { size: 125, theme: undefined })).toBe('<p>hi</p>');
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
