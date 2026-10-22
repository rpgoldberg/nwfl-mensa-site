import { describe, expect, it } from 'vitest';
import { MORE_PAGES, PRIMARY_NAV, SECTIONS, currentNav, page, sectionFor, trailFor } from './site';

describe('SECTIONS (R1)', () => {
  it('has the nine public sections, each with a heading and a one-line description', () => {
    expect(SECTIONS.map((s) => s.path)).toEqual([
      '/',
      '/about',
      '/join',
      '/officers',
      '/governance',
      '/newsletter',
      '/minutes',
      '/calendar',
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
});

describe('PRIMARY_NAV (R30)', () => {
  it('is Home, Calendar, Newsletter, Search, More, each with a word', () => {
    expect(PRIMARY_NAV.map((n) => [n.label, n.href])).toEqual([
      ['Home', '/'],
      ['Calendar', '/calendar'],
      ['Newsletter', '/newsletter'],
      ['Search', '/search'],
      ['More', '/more'],
    ]);
  });
});

describe('MORE_PAGES', () => {
  it('lists every section but Home, then Help, and not the sign-in page', () => {
    expect(MORE_PAGES.map((p) => p.path)).toEqual([
      '/about',
      '/join',
      '/officers',
      '/governance',
      '/newsletter',
      '/minutes',
      '/calendar',
      '/finances',
      '/help',
      '/home-screen',
    ]);
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
    expect(currentNav('/calendar')).toBe('/calendar');
    expect(currentNav('/calendar/2026-11-13-happy-hour')).toBe('/calendar');
    expect(currentNav('/newsletter')).toBe('/newsletter');
    expect(currentNav('/newsletter/2014-03')).toBe('/newsletter');
    expect(currentNav('/search')).toBe('/search');
    expect(currentNav('/more')).toBe('/more');
  });

  it('puts the pages listed on More under More', () => {
    for (const path of ['/about', '/join', '/officers', '/governance', '/minutes', '/finances', '/help', '/home-screen']) {
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
    expect(trailFor('/newsletter/2014-03', 'March 2014')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Newsletter', href: '/newsletter' },
      { label: 'March 2014', href: '/newsletter/2014-03' },
    ]);
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
