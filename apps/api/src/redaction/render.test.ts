// REDACT R2a: the per-audience lens, as pure functions. A mark is a passage
// (its exact text) or a whole item, in one category; the policy decides per
// audience whether that category is shown, redacted or hidden. Every person
// and number here is made up.
import { describe, expect, it } from 'vitest';
import type { Block, Inline, Tree } from '../content/tree.js';
import { cellKey } from './policy.js';
import { type MarkRow, WITHHELD, lensFor, quoteMatches, subjectKey, venueCategory } from './render.js';

const ITEM = subjectKey('content_item', '00000000-0000-4000-8000-000000000001');
const OTHER = subjectKey('content_item', '00000000-0000-4000-8000-000000000002');

// The launch defaults that matter here (0012).
const POLICY = new Map([
  [cellKey('public', 'member_phone'), 'redact'],
  [cellKey('public', 'member_name'), 'redact'],
  [cellKey('public', 'member_email'), 'hide'],
  [cellKey('public', 'member_address'), 'redact'],
  [cellKey('members', 'member_phone'), 'show'],
  [cellKey('members', 'member_name'), 'show'],
  [cellKey('members', 'member_email'), 'show'],
  [cellKey('members', 'member_address'), 'redact'],
  [cellKey('officers', 'member_phone'), 'show'],
]);

const span = (quote: string, category = 'member_phone', subject = ITEM): MarkRow => ({ subject, quote, category });
const whole = (category = 'member_name', subject = ITEM): MarkRow => ({ subject, quote: null, category });

describe('the lens: text', () => {
  it('withholds the marked text for an audience whose policy redacts it, with one fixed placeholder', () => {
    const lens = lensFor('public', POLICY, [span('850-555-0142')]);
    expect(lens.text('Call 850-555-0142 to ride along', [ITEM])).toBe(`Call ${WITHHELD} to ride along`);
    expect(lens.text('Call 850-555-0142', [ITEM])).not.toMatch(/[*█x]{3}/);
  });

  it('shows it to an audience whose policy shows it', () => {
    expect(lensFor('members', POLICY, [span('850-555-0142')]).text('Call 850-555-0142', [ITEM])).toBe('Call 850-555-0142');
  });

  it('matches every occurrence, without regard to case or spacing', () => {
    const lens = lensFor('public', POLICY, [span('Pat  Example', 'member_name')]);
    expect(lens.text('pat example said: PAT\nEXAMPLE.', [ITEM])).toBe(`${WITHHELD} said: ${WITHHELD}.`);
  });

  it('treats the quote as words, not as a pattern', () => {
    const lens = lensFor('public', POLICY, [span('a.b(c)*', 'member_name')]);
    expect(lens.text('x a.b(c)* y aXb(c)y xa.b(c)', [ITEM])).toBe(`x ${WITHHELD})* y aXb(c)y xa.b(c)`);
  });

  it('withholds overlapping marks as one passage, so no fragment is left between them', () => {
    const lens = lensFor('public', POLICY, [span('Pat Example', 'member_name'), span('Example Lane', 'member_address')]);
    expect(lens.text('at Pat Example Lane today', [ITEM])).toBe(`at ${WITHHELD} today`);
  });

  it('applies only the marks of the subjects asked about', () => {
    const lens = lensFor('public', POLICY, [span('Pat Example', 'member_name', OTHER)]);
    expect(lens.text('Pat Example', [ITEM])).toBe('Pat Example');
    expect(lens.text('Pat Example', [ITEM, OTHER])).toBe(WITHHELD);
  });

  it('reads an unknown audience or category as HIDE: the item is dropped', () => {
    expect(lensFor('public', POLICY, [span('Pat', 'shoe_size')]).hidden([ITEM])).toBe(true);
    expect(lensFor('nobody', POLICY, [span('Pat', 'member_phone')]).hidden([ITEM])).toBe(true);
  });
});

describe('the lens: hiding and whole-item marks', () => {
  it('drops an item with a whole-item mark from an audience that does not see its category', () => {
    expect(lensFor('public', POLICY, [whole()]).hidden([ITEM])).toBe(true);
    expect(lensFor('members', POLICY, [whole()]).hidden([ITEM])).toBe(false);
  });

  it('drops an item whose passage is in a category the policy hides', () => {
    const marks = [span('pat@example.org', 'member_email')];
    expect(lensFor('public', POLICY, marks).hidden([ITEM])).toBe(true);
    expect(lensFor('members', POLICY, marks).hidden([ITEM])).toBe(false);
  });

  it('drops nothing for marks on other subjects', () => {
    expect(lensFor('public', POLICY, [whole('member_name', OTHER)]).hidden([ITEM])).toBe(false);
  });

  it('says whether any mark changes what this audience sees', () => {
    expect(lensFor('public', POLICY, [span('Pat')]).affected([ITEM])).toBe(true);
    expect(lensFor('members', POLICY, [span('Pat')]).affected([ITEM])).toBe(false);
    expect(lensFor('public', POLICY, []).affected([ITEM])).toBe(false);
  });

  it('gives the policy action for a structured field, fail-closed', () => {
    const lens = lensFor('public', POLICY, []);
    expect(lens.action('member_phone')).toBe('redact');
    expect(lens.action('officer_contact')).toBe('hide');
    expect(lens.audience).toBe('public');
  });
});

describe('the lens: the body tree', () => {
  const t = (text: string, bold = false) => ({ type: 'text' as const, text, bold, italic: false });
  const para = (...children: Inline[]): Block => ({ type: 'paragraph', children });
  const lens = lensFor('public', POLICY, [span('Pat Example', 'member_name'), span('850-555-0142')]);
  const all = (tree: Tree) => JSON.stringify(tree);

  it('withholds a passage split across emphasis runs', () => {
    const out = lens.tree({ blocks: [para(t('Ask Pat '), t('Example', true), t(' at noon'))] }, [ITEM]);
    expect(all(out)).not.toMatch(/Pat|Example/);
    expect(all(out)).toContain(WITHHELD);
    expect(all(out)).toContain('at noon');
  });

  it('withholds inside links, members passages, headings, lists, quotes and image alt text', () => {
    const tree: Tree = {
      blocks: [
        { type: 'heading', level: 2, children: [t('Pat Example')] },
        { type: 'list', ordered: false, items: [[para(t('call 850-555-0142'))]] },
        { type: 'quote', children: [para({ type: 'members', children: [t('Pat Example')] })] },
        { type: 'members', children: [{ type: 'image', fileId: '00000000-0000-4000-8000-00000000000a', alt: 'Pat Example waving' }] },
        para({ type: 'link', href: 'https://example.org/a', children: [t('Pat Example')] }),
        { type: 'redacted' },
      ],
    };
    const out = all(lens.tree(tree, [ITEM]));
    expect(out).not.toMatch(/Pat|Example\b|0142/);
    expect(out).toContain('https://example.org/a');
    expect(out).toContain('waving');
  });

  it('drops a link target that carries the marked text, keeping its words', () => {
    const out = lens.tree({ blocks: [para({ type: 'link', href: 'tel:850-555-0142', children: [t('ring')] }), para({ type: 'link', href: 'mailto:pat%20example@example.org', children: [t('mail')] })] }, [ITEM]);
    expect(all(out)).not.toMatch(/0142|pat/i);
    expect(all(out)).toContain('ring');
    expect(all(out)).toContain('mail');
  });

  it('withholds the whole body when a passage crosses blocks and cannot be cut out in place', () => {
    const out = lens.tree({ blocks: [para(t('Ask Pat')), para(t('Example tomorrow'))] }, [ITEM]);
    expect(out).toEqual({ blocks: [{ type: 'redacted' }] });
  });

  it('returns the tree as it was when nothing applies', () => {
    const tree: Tree = { blocks: [para(t('Lunch at noon'))] };
    expect(lens.tree(tree, [ITEM])).toEqual(tree);
    expect(lensFor('members', POLICY, [span('Lunch')]).tree(tree, [ITEM])).toEqual(tree);
  });
});

describe('venueCategory', () => {
  it('reads only a business as a business venue; anything else is private (fail-closed)', () => {
    expect(venueCategory('business')).toBe('business_venue');
    for (const kind of ['member_home', 'virtual', '', 'BUSINESS', 'unknown']) expect(venueCategory(kind), kind).toBe('private_venue');
  });
});

describe('the lens: anchoring (fail closed)', () => {
  const SERIES = subjectKey('event_series', '00000000-0000-4000-8000-000000000003');
  const anchored = (scopes: string[], subject = ITEM): MarkRow => ({ subject, quote: 'Pat Example', category: 'member_name', anchoredIn: new Set(scopes) });

  it('drops an item from an audience that redacts the mark when its passage matches nowhere in the version shown', () => {
    const lens = lensFor('public', POLICY, [anchored(['version-1'])]);
    expect(lens.hidden([ITEM], 'version-1')).toBe(false);
    expect(lens.hidden([ITEM], 'version-2')).toBe(true);
    expect(lens.hidden([ITEM])).toBe(true);
    expect(lensFor('members', POLICY, [anchored([])]).hidden([ITEM], 'version-2')).toBe(false);
  });

  it('anchors an event mark in its own subject', () => {
    expect(lensFor('public', POLICY, [anchored([SERIES], SERIES)]).hidden([SERIES])).toBe(false);
    expect(lensFor('public', POLICY, [anchored([], SERIES)]).hidden([SERIES])).toBe(true);
  });

  it('matches a quote in any of the texts, normalized', () => {
    expect(quoteMatches('Pat Example', ['nothing', 'mail pat.example@example.org'])).toBe(true);
    expect(quoteMatches('Pat Example', ['Patricia Examples'])).toBe(false);
    expect(quoteMatches('...', ['a ... b'])).toBe(true);
  });
});

describe('the lens: whole words, normalized', () => {
  const lens = lensFor('public', POLICY, [span('850-555-0142'), span('Pat Example', 'member_name')]);

  it('withholds a number written with other separators, or none', () => {
    expect(lens.text('Ring 850.555.0142, (850) 555 0142 or 8505550142', [ITEM])).toBe(`Ring ${WITHHELD}, (${WITHHELD} or ${WITHHELD}`);
  });

  it('withholds a name inside an address or a link, but not inside a longer word', () => {
    expect(lens.text('Mail pat.example@example.org', [ITEM])).toBe(`Mail ${WITHHELD}@example.org`);
    expect(lens.text('Patricia Examples', [ITEM])).toBe('Patricia Examples');
  });
});
