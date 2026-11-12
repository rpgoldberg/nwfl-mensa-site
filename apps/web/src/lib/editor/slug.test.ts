// EDITOR E2: an item's slug, made from its title by the site (officers never see it), as the API's
// content_item.slug check allows (^[a-z0-9][a-z0-9-]{0,99}$), with -2, -3 and on when it is taken.
import { describe, expect, it } from 'vitest';
import { SlugTaken } from '../api/editor';
import { SLUG_MAX, createWithSlug, slugCandidate, slugFromTitle } from './slug';

const ALLOWED = /^[a-z0-9][a-z0-9-]{0,99}$/;

describe('slugFromTitle', () => {
  it.each([
    ['Lunch moves to Thursdays', 'lunch-moves-to-thursdays'],
    ['  The   President’s Report: November 2026!  ', 'the-president-s-report-november-2026'],
    ['Café Crème & Brûlée', 'cafe-creme-brulee'],
    ['--Already--dashed--', 'already-dashed'],
    ['ÆON straße', 'aeon-strasse'],
    ['2026 picnic', '2026-picnic'],
  ])('%s → %s', (title, slug) => {
    expect(slugFromTitle(title)).toBe(slug);
  });

  it('falls back to "item" for a title with no letter or digit it can keep', () => {
    expect(slugFromTitle('会議のお知らせ')).toBe('item');
    expect(slugFromTitle('!!!')).toBe('item');
    expect(slugFromTitle('')).toBe('item');
  });

  it('is cut to fit with room for a suffix, never ending on a dash', () => {
    const slug = slugFromTitle(`${'word '.repeat(60)}end`);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX - 4);
    expect(slug).toMatch(ALLOWED);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('slugCandidate', () => {
  it('is the slug first, then -2, -3 and on', () => {
    expect([1, 2, 3, 10].map((n) => slugCandidate('picnic', n))).toEqual(['picnic', 'picnic-2', 'picnic-3', 'picnic-10']);
  });

  it('cuts a long slug to make room for the suffix, never leaving a dash before it', () => {
    const base = `${'a'.repeat(97)}-bc`;
    const second = slugCandidate(base, 2);
    expect(second.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(second).toMatch(ALLOWED);
    expect(second).toBe(`${'a'.repeat(97)}-2`);
    expect(slugCandidate(base, 1)).toBe(base);
  });
});

describe('createWithSlug', () => {
  it('tries the next slug each time the slug is taken, and returns what the create gave', async () => {
    const taken = new Set(['picnic', 'picnic-2']);
    const tried: string[] = [];
    const made = await createWithSlug('Picnic', async (slug) => {
      tried.push(slug);
      if (taken.has(slug)) throw new SlugTaken('CreateItem');
      return { slug };
    });
    expect(made).toEqual({ slug: 'picnic-3' });
    expect(tried).toEqual(['picnic', 'picnic-2', 'picnic-3']);
  });

  it('gives up with SlugTaken after the last try', async () => {
    let tries = 0;
    await expect(
      createWithSlug(
        'Picnic',
        async () => {
          tries++;
          throw new SlugTaken('CreateItem');
        },
        5,
      ),
    ).rejects.toBeInstanceOf(SlugTaken);
    expect(tries).toBe(5);
  });

  it('passes any other failure straight on, without another try', async () => {
    let tries = 0;
    const boom = new Error('down');
    await expect(
      createWithSlug('Picnic', async () => {
        tries++;
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(tries).toBe(1);
  });
});
