import { describe, expect, it } from 'vitest';
import { accountHtml, escapeHtml, stampAccount } from '../account.mjs';

const member = { sid: 's', sub: 'u', name: 'Jordan Example', groups: ['nwfl-members'], member: true, officer: false, iat: 1, exp: 2, sliding: true };
const officer = { ...member, name: 'Alex Sample', officer: true, groups: ['nwfl-members', 'nwfl-officers'] };

describe('accountHtml (the header’s account area)', () => {
  it('offers Sign in to a reader who is not signed in, coming back to the same page', () => {
    expect(accountHtml(undefined, { back: '/search?q=lunch', signIn: true })).toBe(
      '<div class="account" data-account="anon"><a class="hbtn hbtn--primary" href="/sign-in?return=%2Fsearch%3Fq%3Dlunch">Sign in</a></div>',
    );
  });

  it('offers nothing in a build with sign-in off', () => {
    expect(accountHtml(undefined, { back: '/', signIn: false })).toBe('<div class="account" data-account="anon"></div>');
  });

  it('shows a member’s name and Sign out, a plain form that posts', () => {
    const html = accountHtml(member, { back: '/', signIn: true });
    expect(html).toContain('<span class="visually-hidden">Signed in as </span>Jordan Example');
    expect(html).toContain('<form class="sign-out" method="post" action="/sign-out"><button class="hbtn" type="submit">Sign out</button></form>');
    expect(html).not.toContain('Officer area');
  });

  it('adds the Officer area for an officer', () => {
    expect(accountHtml(officer, { back: '/', signIn: true })).toContain('<a class="hbtn" href="/officer-area">Officer area</a>');
  });

  it('escapes the name, whatever the provider sent', () => {
    expect(accountHtml({ ...member, name: '<img src=x onerror=alert(1)>&"\'' }, { back: '/', signIn: true })).toContain(
      '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;',
    );
    expect(escapeHtml('a<b>&"\'c')).toBe('a&lt;b&gt;&amp;&quot;&#39;c');
  });
});

describe('stampAccount (prerendered pages, signed in)', () => {
  const page = `<header>${accountHtml(undefined, { back: '/about', signIn: true })}</header><main><div>About</div></main>`;

  it('puts the signed-in area in place of Sign in, and nothing else', () => {
    expect(stampAccount(page, officer)).toBe(`<header>${accountHtml(officer, { back: '/about', signIn: true })}</header><main><div>About</div></main>`);
  });

  it('leaves the page alone for a reader who is not signed in', () => {
    expect(stampAccount(page, undefined)).toBe(page);
  });

  it('never stamps a build with sign-in off', () => {
    const off = `<header>${accountHtml(undefined, { back: '/about', signIn: false })}</header>`;
    expect(stampAccount(off, officer)).toBe(off);
  });
});
