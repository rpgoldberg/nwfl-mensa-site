import { describe, expect, it } from 'vitest';
import { ABOUT_NAV, MENSA_LINKS, MORE_GROUPS, MORE_PAGES, PRIMARY_NAV, SECTIONS, currentNav, page, sectionFor, trailFor } from './site';

describe('SECTIONS (R1)', () => {
  it('has the nine public sections, each with a heading and a one-line description', () => {
    expect(SECTIONS.map((s) => s.path)).toEqual([
      '/',
      '/about',
      '/join',
      '/officers',
      '/governance',
      '/news',
      '/minutes',
      '/events',
      '/finances',
    ]);
    for (const s of SECTIONS) {
      expect(s.title.length, s.path).toBeGreaterThan(2);
      expect(s.description, s.path).toMatch(/^[A-Z].+\.$/);
      expect(s.description, s.path).not.toMatch(/\n/);
    }
  });

  it('prerenders About, Join and Governance only', () => {
    expect(SECTIONS.filter((s) => s.prerender).map((s) => s.path)).toEqual(['/about', '/join', '/governance']);
  });

  it('gives the long-read pages, About and Governance, the reading bar (R30)', () => {
    expect(SECTIONS.filter((s) => s.reading).map((s) => s.path)).toEqual(['/about', '/governance']);
  });

  it('heads the calendar and the newsletter with their nav words, Events and News', () => {
    expect(page('/events').title).toBe('Events');
    expect(page('/news').title).toBe('News');
  });
});

describe('PRIMARY_NAV (R30)', () => {
  it('is four, always one row: Home, Events, News, More, each with a word and an icon', () => {
    expect(PRIMARY_NAV.map((n) => [n.label, n.href, n.icon])).toEqual([
      ['Home', '/', 'home'],
      ['Events', '/events', 'calendar'],
      ['News', '/news', 'newsletter'],
      ['More', '/more', 'more'],
    ]);
  });
});

describe('MORE_PAGES', () => {
  it('lists every section but Home, then Search and Help (no longer in the header or the bar), and not the sign-in page', () => {
    expect(MORE_PAGES.map((p) => p.path)).toEqual([
      '/about',
      '/join',
      '/officers',
      '/governance',
      '/news',
      '/minutes',
      '/events',
      '/finances',
      '/search',
      '/help',
      '/home-screen',
    ]);
  });
});

describe('ABOUT_NAV', () => {
  it("is the design draft's About subnav: who we are, officers, governance, minutes and finances", () => {
    expect(ABOUT_NAV.map((n) => [n.label, n.href])).toEqual([
      ['Who we are', '/about'],
      ['Officers', '/officers'],
      ['Governance', '/governance'],
      ['Minutes', '/minutes'],
      ['Finances', '/finances'],
    ]);
    for (const n of ABOUT_NAV) expect(sectionFor(n.href), n.href).toBeDefined();
  });
});

describe('MENSA_LINKS', () => {
  it("are the old Home page's outbound links, each to Mensa's own sites or our Facebook group, over https", () => {
    expect(MENSA_LINKS.map((l) => l.label)).toEqual(['American Mensa', 'Region 10 of American Mensa', 'Mensa International', 'Our group on Facebook']);
    for (const l of MENSA_LINKS) expect(new URL(l.href).protocol, l.href).toBe('https:');
  });
});

describe('sectionFor', () => {
  it('finds a page by path, ignoring a trailing slash', () => {
    expect(sectionFor('/about')?.title).toBe('About us');
    expect(sectionFor('/about/')?.title).toBe('About us');
    expect(sectionFor('/help')?.title).toBe('Help');
    expect(sectionFor('/sign-in')?.title).toBe('Sign in');
    expect(sectionFor('/home-screen')?.title).toBe('Put the club on your home screen');
    expect(sectionFor('/nowhere')).toBeUndefined();
  });
});

describe('page', () => {
  it('returns a known page and refuses an unknown one, so a typo fails the build', () => {
    expect(page('/join').title).toBe('Join Mensa');
    expect(() => page('/jion')).toThrow('/jion');
  });
});

describe('currentNav', () => {
  it('marks the nav item a page belongs to', () => {
    expect(currentNav('/')).toBe('/');
    expect(currentNav('/events')).toBe('/events');
    expect(currentNav('/events/1b4e28ba-2fa1-11d2-883f-0016d3cca427')).toBe('/events');
    expect(currentNav('/news')).toBe('/news');
    expect(currentNav('/news/2014-03')).toBe('/news');
    expect(currentNav('/more')).toBe('/more');
  });

  it('puts the pages listed on More under More', () => {
    for (const path of ['/about', '/join', '/officers', '/governance', '/minutes', '/finances', '/search', '/help', '/home-screen']) {
      expect(currentNav(path), path).toBe('/more');
    }
  });

  it('marks nothing for the sign-in page or an unknown page', () => {
    expect(currentNav('/sign-in')).toBeUndefined();
    expect(currentNav('/nowhere')).toBeUndefined();
  });
});

describe('trailFor (breadcrumbs and Back)', () => {
  it('is empty on Home', () => {
    expect(trailFor('/', 'Home')).toEqual([]);
  });

  it('is Home then the page for a top-level page', () => {
    expect(trailFor('/about', 'About us')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'About us', href: '/about' },
    ]);
  });

  it('names each known ancestor of a deeper page', () => {
    expect(trailFor('/news/2014-03', 'March 2014')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'News', href: '/news' },
      { label: 'March 2014', href: '/news/2014-03' },
    ]);
    expect(trailFor('/events/1b4e28ba-2fa1-11d2-883f-0016d3cca427', 'Happy Hour').map((c) => c.label)).toEqual(['Home', 'Events', 'Happy Hour']);
  });

  it('skips an ancestor it has no name for', () => {
    expect(trailFor('/x/y', 'Y')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Y', href: '/x/y' },
    ]);
  });

  it('drops a trailing slash', () => {
    expect(trailFor('/join/', 'Join')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Join', href: '/join' },
    ]);
  });
});

describe('MORE_GROUPS', () => {
  it('has three groups, in order, each with the rows the More page shows', () => {
    expect(MORE_GROUPS.map((g) => [g.id, g.title, g.rows.map((r) => [r.title, r.href])])).toEqual([
      ['club', 'The club', [['About us', '/about'], ['Officers', '/officers'], ['Governance', '/governance'], ['Meeting minutes', '/minutes'], ['Finances', '/finances']]],
      ['on', "What\u2019s on", [['Events', '/events'], ['News', '/news'], ['Search', '/search']]],
      ['join', 'Join and get help', [['Join Mensa', '/join'], ['Help', '/help'], ['Contact an officer', '/officers'], ['Put the club on your home screen', '/home-screen']]],
    ]);
  });

  it('gives every row a one-line description, and lists every page MORE_PAGES lists', () => {
    const rows = MORE_GROUPS.flatMap((g) => g.rows);
    expect(rows).toHaveLength(12);
    for (const r of rows) expect(r.description, r.title).toMatch(/^[A-Z][^\n]+[^.]$/);
    for (const p of MORE_PAGES) expect(rows.map((r) => r.href), p.path).toContain(p.path);
  });

  it('keeps the More page description off the retired line', () => {
    expect(page('/more').description).not.toMatch(/^Every part/);
  });
});
