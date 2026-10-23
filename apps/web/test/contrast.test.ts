// Every theme's colours, read from the stylesheet the site ships (W-LOOK): each
// text pair at or above 7:1 (WCAG AAA) and each border and focus ring at or
// above 3:1, as WCAG 2.2 computes them (sRGB relative luminance).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync('src/styles/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties set in the first rule whose selector matches `selector`. */
function block(selector: RegExp): Record<string, string> {
  const m = new RegExp(`${selector.source}\\s*\\{([^{}]*)\\}`).exec(tokens);
  if (!m) throw new Error(`no rule for ${selector.source}`);
  return Object.fromEntries([...m[1]!.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, name, value]) => [name!, value!.toLowerCase()]));
}

const COLOURS = ['bg', 'surface', 'ink', 'muted', 'accent', 'on-accent', 'accent-soft', 'line', 'line-soft', 'focus', 'ok', 'ok-bg', 'warn', 'warn-bg', 'stop', 'stop-bg', 'members', 'members-bg'];

const light = block(/:root/);
const THEMES: Record<string, Record<string, string>> = {
  light,
  dark: { ...light, ...block(/html\[data-theme="dark"\]/) },
  'contrast-yellow': { ...light, ...block(/html\[data-theme="contrast-yellow"\]/) },
  'contrast-white': { ...light, ...block(/html\[data-theme="contrast-white"\]/) },
};

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text over its background, as the pages use them. */
const TEXT = [
  ['ink', 'bg'], ['ink', 'surface'], ['muted', 'bg'], ['muted', 'surface'],
  ['accent', 'bg'], ['accent', 'surface'], ['on-accent', 'accent'],
  // The current tab, the chosen theme and the About subnav: ink on the soft tint.
  ['ink', 'accent-soft'],
  ['ok', 'ok-bg'], ['warn', 'warn-bg'], ['stop', 'stop-bg'], ['members', 'members-bg'],
  ['ink', 'warn-bg'], ['ink', 'members-bg'],
  ['ok', 'surface'], ['warn', 'surface'], ['stop', 'surface'], ['members', 'surface'],
] as const;

/** Borders, bars and focus rings (WCAG 1.4.11). */
const NON_TEXT = [['line', 'bg'], ['line', 'surface'], ['focus', 'bg'], ['focus', 'surface'], ['accent', 'accent-soft']] as const;

describe('contrast, computed from tokens.css', () => {
  it('knows the WCAG numbers: black on white is 21:1, a colour on itself 1:1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#00566b', '#00566b')).toBe(1);
    expect(contrast('#11242e', '#f5f8f9')).toBeCloseTo(14.96, 2);
  });

  it('has the four themes the menu offers besides the device, each with every colour', () => {
    for (const [name, theme] of Object.entries(THEMES)) expect(Object.keys(theme).sort(), name).toEqual([...COLOURS].sort());
  });

  for (const [name, theme] of Object.entries(THEMES)) {
    it(`${name}: every text pair is at least 7:1, every border and focus ring at least 3:1`, () => {
      const low = [
        ...TEXT.filter(([fg, bg]) => contrast(theme[fg]!, theme[bg]!) < 7).map(([fg, bg]) => `${fg}/${bg} ${contrast(theme[fg]!, theme[bg]!).toFixed(2)}`),
        ...NON_TEXT.filter(([fg, bg]) => contrast(theme[fg]!, theme[bg]!) < 3).map(([fg, bg]) => `${fg}/${bg} ${contrast(theme[fg]!, theme[bg]!).toFixed(2)}`),
      ];
      expect(low).toEqual([]);
    });
  }

  it('gives a device that asks for dark the dark theme, and one that asks for more contrast the warm white one', () => {
    expect(block(/@media \(prefers-color-scheme: dark\)\s*\{\s*html:not\(\[data-theme\]\)/)).toEqual(block(/html\[data-theme="dark"\]/));
    expect(block(/@media \(prefers-contrast: more\)\s*\{\s*html:not\(\[data-theme\]\)/)).toEqual(block(/html\[data-theme="contrast-white"\]/));
  });

  it('has no yellow-on-black theme any more', () => {
    expect(tokens).not.toMatch(/data-theme="contrast"\]/);
    expect(tokens).not.toMatch(/#ffe14d/i);
  });
});
