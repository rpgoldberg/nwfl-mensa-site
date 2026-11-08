import { describe, expect, it } from 'vitest';
import { accountHtml, escapeHtml, officerAreaFor, roleFor, stampAccount } from '../account.mjs';

const member = { sid: 's', sub: 'u', name: 'Jordan Example', groups: ['nwfl-members'], member: true, enrolee: true, officer: false, iat: 1, exp: 2, sliding: true };
const officer = { ...member, name: 'Alex Sample', officer: true, groups: ['nwfl-members', 'nwfl-officers'] };

describe('accountHtml (the header’s account area)', () => {
  /** The phone's Account menu, and the wide screen's row, each cut out of the area. */
  const menu = (html: string) => /<details class="account__menu"[\s\S]*<\/details>/.exec(html)?.[0] ?? '';
  const row = (html: string) => /<div class="account__inline">[\s\S]*?<\/form><\/div>/.exec(html)?.[0] ?? '';

  it('offers Sign in to a reader who is not signed in, coming back to the same page: a person icon over the word', () => {
    const html = accountHtml(undefined, { back: '/search?q=lunch', signIn: true });
    expect(html).toMatch(/^<div class="account" data-account="anon"><a class="hbtn hbtn--primary hbtn--stack" href="\/sign-in\?return=%2Fsearch%3Fq%3Dlunch"><svg [^>]*aria-hidden="true"[^>]*>.*<\/svg><span class="hbtn__word">Sign in<\/span><\/a><\/div>$/);
  });

  it('offers nothing in a build with sign-in off', () => {
    expect(accountHtml(undefined, { back: '/', signIn: false })).toBe('<div class="account" data-account="anon"></div>');
  });

  it('W-LOOK2: one Account button (a person icon and the word) opens a menu, a native disclosure that needs no script', () => {
    const html = menu(accountHtml(member, { back: '/', signIn: true }));
    expect(html).toMatch(/^<details class="account__menu" data-account-menu><summary class="hbtn hbtn--stack"><svg [^>]*aria-hidden="true"[^>]*>.*<\/svg><span class="hbtn__word">Account<\/span><\/summary>/);
    expect(html).not.toContain(' open');
  });

  it('W-LOOK2: the menu names the reader and their role, then Your account, the Officer area and Sign out, the same POST form', () => {
    const html = menu(accountHtml(officer, { back: '/', signIn: true }));
    expect(html).toContain('<p class="account__who"><span class="visually-hidden">Signed in as </span><b>Alex Sample</b> <span class="account__role">Officer</span></p>');
    const links = [...html.matchAll(/<a class="hbtn" href="([^"]+)">([^<]+)<\/a>|<button class="hbtn" type="submit">([^<]+)<\/button>/g)].map((m) => m[2] ?? m[3]);
    expect(links).toEqual(['Your account', 'Officer area', 'Sign out']);
    expect(html).toContain('<form class="sign-out" method="post" action="/sign-out"><button class="hbtn" type="submit">Sign out</button></form>');
  });

  it('keeps the wide screen\u2019s row: the name, Your account, the Officer area and Sign out, in that order', () => {
    expect(row(accountHtml(officer, { back: '/', signIn: true }))).toBe(
      '<div class="account__inline"><span class="who"><span class="visually-hidden">Signed in as </span>Alex Sample</span><a class="hbtn" href="/account">Your account</a><a class="hbtn" href="/officer-area">Officer area</a><form class="sign-out" method="post" action="/sign-out"><button class="hbtn" type="submit">Sign out</button></form></div>',
    );
  });

  it('shows a member\u2019s name and Sign out, with no Officer area, in the row and the menu alike', () => {
    const html = accountHtml(member, { back: '/', signIn: true });
    for (const part of [row(html), menu(html)]) {
      expect(part).toContain('Jordan Example');
      expect(part).toContain('<button class="hbtn" type="submit">Sign out</button>');
      expect(part).not.toContain('Officer area');
    }
    expect(menu(html)).toContain('<span class="account__role">Member</span>');
  });

  it('fix 1: adds Your account for one of the group\u2019s enrolees, and for no one else', () => {
    expect(row(accountHtml(member, { back: '/', signIn: true }))).toContain('Jordan Example</span><a class="hbtn" href="/account">Your account</a>');
    expect(menu(accountHtml(officer, { back: '/', signIn: true }))).toContain('<a class="hbtn" href="/account">Your account</a>');
    const loneAdmin = { ...member, groups: ['nwfl-admin'], member: false, enrolee: false };
    expect(accountHtml(loneAdmin, { back: '/', signIn: true })).not.toContain('Your account');
  });

  it('fix 1: adds the Officer area for everyone it admits: officers, the Admin, the Webmaster and the membership approvers', () => {
    const outsider = { ...member, groups: [], member: false, enrolee: false };
    for (const groups of [['nwfl-admin'], ['nwfl-webmaster'], ['nwfl-users', 'nwfl-membership-approvers']]) {
      const s = { ...outsider, groups };
      expect(officerAreaFor(s), groups.join()).toBe(true);
      const html = accountHtml(s, { back: '/', signIn: true });
      expect(row(html), groups.join()).toContain('<a class="hbtn" href="/officer-area">Officer area</a>');
      expect(menu(html), groups.join()).toContain('<a class="hbtn" href="/officer-area">Officer area</a>');
    }
    expect(officerAreaFor(officer)).toBe(true);
    for (const groups of [['nwfl-members'], ['nwfl-users', 'nwfl-invited'], ['mensa-nwfl-admin'], ['nwfl-affiliates']]) {
      expect(officerAreaFor({ ...outsider, groups }), groups.join()).toBe(false);
    }
    expect(officerAreaFor(undefined)).toBe(false);
  });

  it('W-LOOK2: names the role by the highest group held, and none for an enrolee whose standing only the API knows', () => {
    const outsider = { ...member, groups: [] as string[], member: false, enrolee: false };
    expect(roleFor({ ...outsider, groups: ['nwfl-members', 'nwfl-officers', 'nwfl-admin'] })).toBe('Administrator');
    expect(roleFor({ ...outsider, groups: ['nwfl-officers', 'nwfl-webmaster'] })).toBe('Webmaster');
    expect(roleFor({ ...outsider, groups: ['nwfl-members', 'nwfl-officers', 'nwfl-membership-approvers'] })).toBe('Officer');
    expect(roleFor({ ...outsider, groups: ['nwfl-users', 'nwfl-membership-approvers'] })).toBe('Membership approver');
    expect(roleFor({ ...outsider, groups: ['nwfl-members'] })).toBe('Member');
    expect(roleFor({ ...outsider, groups: ['nwfl-users'] })).toBeUndefined();
    const enrolee = accountHtml({ ...outsider, groups: ['nwfl-users'], enrolee: true }, { back: '/', signIn: true });
    expect(menu(enrolee)).toContain('<b>Jordan Example</b></p>');
    expect(menu(enrolee)).not.toContain('account__role');
  });

  it('escapes the name, whatever the provider sent, in the row and the menu', () => {
    const html = accountHtml({ ...member, name: '<img src=x onerror=alert(1)>&"\'' }, { back: '/', signIn: true });
    expect(html).not.toContain('<img');
    expect(html.split('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;')).toHaveLength(3);
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
