import type { BrowserContext } from '@playwright/test';
import { SIZE_COOKIE, THEMES as THEME_LIST, THEME_COOKIE } from '../server/prefs.mjs';

/** The four themes a reader can choose besides the device's, in menu order. */
export const THEMES = THEME_LIST;

/** Arrive as a reader who already chose a size (in percent, or an old 1 to 5) and theme (the cookies /prefs sets). */
export async function setPrefs(
  context: BrowserContext,
  baseURL: string,
  prefs: { size?: number; theme?: (typeof THEMES)[number] | 'contrast' },
): Promise<void> {
  const cookies = [];
  if (prefs.size) cookies.push({ name: SIZE_COOKIE, value: String(prefs.size), url: baseURL });
  if (prefs.theme) cookies.push({ name: THEME_COOKIE, value: prefs.theme, url: baseURL });
  await context.addCookies(cookies);
}
