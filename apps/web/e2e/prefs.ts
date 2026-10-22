import type { BrowserContext } from '@playwright/test';
import { SIZE_COOKIE, THEME_COOKIE } from '../server/prefs.mjs';

export const THEMES = ['light', 'dark', 'contrast'] as const;

/** Arrive as a reader who already chose a size and theme (the cookies /prefs sets). */
export async function setPrefs(
  context: BrowserContext,
  baseURL: string,
  prefs: { size?: number; theme?: (typeof THEMES)[number] },
): Promise<void> {
  const cookies = [];
  if (prefs.size) cookies.push({ name: SIZE_COOKIE, value: String(prefs.size), url: baseURL });
  if (prefs.theme) cookies.push({ name: THEME_COOKIE, value: prefs.theme, url: baseURL });
  await context.addCookies(cookies);
}
