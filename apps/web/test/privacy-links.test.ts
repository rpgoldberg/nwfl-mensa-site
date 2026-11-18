// LAUNCH-FIX-1: where a reader is asked for their name and number, and where they see what is kept,
// the privacy page is one link away. e2e/signup.spec.ts follows the links in a browser.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const account = readFileSync('src/pages/account.astro', 'utf8');
const LINK = '<a href="/privacy">';

describe('/account', () => {
  it('links to the privacy page beside the sign-up form, before its fields', () => {
    const form = account.slice(account.indexOf("{view === 'form' && ("), account.indexOf("{view !== undefined && view !== 'form' && ("));
    expect(form).toContain(LINK);
    expect(form.indexOf(LINK)).toBeLessThan(form.indexOf('<form'));
  });

  it('links to the privacy page for every other standing, once', () => {
    const standing = account.slice(account.indexOf("{view !== undefined && view !== 'form' && ("));
    expect(standing.split(LINK)).toHaveLength(2);
  });
});

describe('the layout', () => {
  it('has the privacy link in the footer of every page', () => {
    const base = readFileSync('src/layouts/Base.astro', 'utf8');
    expect(/<footer[\s\S]*<\/footer>/.exec(base)?.[0]).toContain('<a href="/privacy">Privacy</a>');
  });
});
