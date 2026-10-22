import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  SIZE_COOKIE,
  THEME_COOKIE,
  applyChange,
  htmlAttributes,
  prefsCookies,
  readPrefs,
  safeBack,
  stampHtml,
} from '../prefs.mjs';

describe('readPrefs', () => {
  it('is size 1 and the device theme with no cookie', () => {
    expect(readPrefs(undefined)).toEqual({ size: 1, theme: undefined });
    expect(readPrefs('')).toEqual(DEFAULT_PREFS);
  });

  it('reads the size and theme cookies', () => {
    expect(readPrefs(`${SIZE_COOKIE}=3; ${THEME_COOKIE}=dark`)).toEqual({ size: 3, theme: 'dark' });
    expect(readPrefs(`a=1;${THEME_COOKIE}=contrast ; ${SIZE_COOKIE}=5`)).toEqual({ size: 5, theme: 'contrast' });
    expect(readPrefs(`${THEME_COOKIE}=light`)).toEqual({ size: 1, theme: 'light' });
  });

  it('ignores a value it does not know, and a cookie whose name only ends the same', () => {
    for (const size of ['0', '6', '2.5', 'big', '', '03']) {
      expect(readPrefs(`${SIZE_COOKIE}=${size}`).size, size).toBe(1);
    }
    for (const theme of ['neon', '', 'Dark', 'system']) {
      expect(readPrefs(`${THEME_COOKIE}=${theme}`).theme, theme).toBeUndefined();
    }
    expect(readPrefs(`x${SIZE_COOKIE}=4; x${THEME_COOKIE}=dark`)).toEqual(DEFAULT_PREFS);
  });
});

describe('applyChange', () => {
  const at = (size: 1 | 2 | 3 | 4 | 5) => ({ size, theme: undefined });

  it('steps the size up and down, from 100 % to 200 %, and stops at each end', () => {
    expect(applyChange(at(1), { size: 'larger' }).size).toBe(2);
    expect(applyChange(at(4), { size: 'larger' }).size).toBe(5);
    expect(applyChange(at(5), { size: 'larger' }).size).toBe(5);
    expect(applyChange(at(3), { size: 'smaller' }).size).toBe(2);
    expect(applyChange(at(1), { size: 'smaller' }).size).toBe(1);
  });

  it('sets a theme, or goes back to the device setting', () => {
    expect(applyChange(DEFAULT_PREFS, { theme: 'dark' })).toEqual({ size: 1, theme: 'dark' });
    expect(applyChange({ size: 2, theme: 'dark' }, { theme: 'contrast' })).toEqual({ size: 2, theme: 'contrast' });
    expect(applyChange({ size: 2, theme: 'dark' }, { theme: 'light' })).toEqual({ size: 2, theme: 'light' });
    expect(applyChange({ size: 2, theme: 'dark' }, { theme: 'system' })).toEqual({ size: 2, theme: undefined });
  });

  it('cycles the theme for the reading bar: device, light, dark, high contrast, device', () => {
    const seen: (string | undefined)[] = [];
    let prefs = applyChange(DEFAULT_PREFS, {});
    for (let i = 0; i < 4; i++) {
      prefs = applyChange(prefs, { theme: 'next' });
      seen.push(prefs.theme);
    }
    expect(seen).toEqual(['light', 'dark', 'contrast', undefined]);
  });

  it('changes nothing for a value it does not know', () => {
    const prefs = { size: 3 as const, theme: 'dark' as const };
    expect(applyChange(prefs, { size: 'huge', theme: 'neon' })).toEqual(prefs);
    expect(applyChange(prefs, {})).toEqual(prefs);
  });
});

describe('prefsCookies', () => {
  it('stores a choice for a year, for the whole site, unreadable to scripts', () => {
    expect(prefsCookies({ size: 3, theme: 'dark' }, { secure: false })).toEqual([
      `${SIZE_COOKIE}=3; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
      `${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
    ]);
  });

  it('marks the cookies Secure over https', () => {
    for (const c of prefsCookies({ size: 2, theme: 'light' }, { secure: true })) expect(c).toMatch(/; Secure$/);
  });

  it('removes a cookie that holds the default, so an untouched reader sends none', () => {
    expect(prefsCookies(DEFAULT_PREFS, { secure: false })).toEqual([
      `${SIZE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
      `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
    ]);
  });
});

describe('htmlAttributes and stampHtml', () => {
  it('names the size always, and the theme only when the reader chose one', () => {
    expect(htmlAttributes(DEFAULT_PREFS)).toEqual({ lang: 'en', 'data-size': '1' });
    expect(htmlAttributes({ size: 4, theme: 'contrast' })).toEqual({ lang: 'en', 'data-size': '4', 'data-theme': 'contrast' });
  });

  it("rewrites only a prerendered page's html start tag", () => {
    const page = '<!DOCTYPE html><html lang="en" data-size="1"><head></head><body><p>&lt;html data-size="1"&gt;</p></body></html>';
    expect(stampHtml(page, { size: 5, theme: 'dark' })).toBe(
      '<!DOCTYPE html><html lang="en" data-size="5" data-theme="dark"><head></head><body><p>&lt;html data-size="1"&gt;</p></body></html>',
    );
    expect(stampHtml(page, DEFAULT_PREFS)).toBe(page);
  });

  it('leaves a document with no html tag alone', () => {
    expect(stampHtml('<p>hi</p>', { size: 2, theme: undefined })).toBe('<p>hi</p>');
  });
});

describe('safeBack', () => {
  it('keeps a path on this site, with its query', () => {
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
    ]) {
      expect(safeBack(back), String(back).slice(0, 40)).toBe('/');
    }
  });
});
