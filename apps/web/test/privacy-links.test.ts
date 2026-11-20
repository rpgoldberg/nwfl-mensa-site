// LAUNCH-FIX-1: where a reader is asked for their name and number, and where they see what is kept,
// the privacy page is one link away. e2e/signup.spec.ts follows the links in a browser.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const account = readFileSync('src/pages/account.astro', 'utf8');
const LINK = '<a href="/privacy">';
const FORM_VIEW = "{view === 'form' && (";
const STANDING_VIEW = "{view !== undefined && view !== 'form' && (";

/**
 * How deep the privacy link sits inside its view's block, in braces and parentheses: 0 and 0 when it is
 * shown whenever the view is (no condition of its own around it, however many lines that takes).
 */
function depthIn(block: string): [number, number] {
  const before = block.slice(0, block.indexOf(LINK));
  const count = (c: string) => before.split(c).length - 1;
  return [count('{') - count('}'), count('(') - count(')')];
}
/** The privacy link's own line: a plain paragraph, nothing hidden. */
const LINK_LINE = /^ *<p><a href="\/privacy">What we keep about you, and who can see it<\/a><\/p>$/m;

describe('/account', () => {
  it('links to the privacy page beside the sign-up form, before its fields', () => {
    const form = account.slice(account.indexOf("{view === 'form' && ("), account.indexOf("{view !== undefined && view !== 'form' && ("));
    expect(form).toContain(LINK);
    expect(form.indexOf(LINK)).toBeLessThan(form.indexOf('<form'));
    expect(depthIn(form.slice(FORM_VIEW.length))).toEqual([0, 0]);
    expect(form).toMatch(LINK_LINE);
  });

  it('links to the privacy page for every other standing, once', () => {
    const standing = account.slice(account.indexOf("{view !== undefined && view !== 'form' && ("));
    expect(standing.split(LINK)).toHaveLength(2);
    expect(depthIn(standing.slice(STANDING_VIEW.length))).toEqual([0, 0]);
    expect(standing).toMatch(LINK_LINE);
  });
});

describe('the layout', () => {
  it('has the privacy link in the footer of every page', () => {
    const base = readFileSync('src/layouts/Base.astro', 'utf8');
    const footer = /<footer[\s\S]*<\/footer>/.exec(base)?.[0] ?? '';
    expect(footer).toContain('<a href="/privacy">Privacy</a>');
    // A plain link in the footer's first line, shown on every page: no condition, nothing hidden.
    const links = /<p class="foot-links">([\s\S]*?)<\/p>/.exec(footer)?.[1] ?? '';
    expect(links).toMatch(/^(?:\s*<a href="\/[a-z-]*">[^<{}]+<\/a>)+$/);
    expect(links).toContain('<a href="/privacy">Privacy</a>');
    expect(footer).not.toMatch(/\bhidden\b|display:\s*none|visually-hidden/);
  });
});
