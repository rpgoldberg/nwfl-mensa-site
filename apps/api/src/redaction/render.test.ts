// REDACT R2a: the per-audience lens, as pure functions. A mark is a passage
// (its exact text) or a whole item, in one category; the policy decides per
// audience whether that category is shown, redacted or hidden. Every person
// and number here is made up.
import { describe, expect, it } from 'vitest';
import type { Block, Inline, Tree } from '../content/tree.js';
import { LOOKALIKES } from './confusables.js';
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

describe('the lens: look-alike letters (UTS #39 skeleton, after folding)', () => {
  const name = (quote: string) => lensFor('public', POLICY, [span(quote, 'member_name')]);
  const CYRILLIC_J = '\u{0408}';
  const CYRILLIC_O = '\u{043E}';
  const GREEK_OMICRON = '\u{03BF}';

  it('withholds a marked name written with a Cyrillic or Greek look-alike in place of a letter', () => {
    const lens = name('John Smith');
    expect(lens.text(`Call ${CYRILLIC_J}ohn Smith`, [ITEM])).toBe(`Call ${WITHHELD}`);
    expect(lens.text(`Call J${CYRILLIC_O}hn Smith`, [ITEM])).toBe(`Call ${WITHHELD}`);
    expect(lens.text(`Call J${GREEK_OMICRON}hn Smith`, [ITEM])).toBe(`Call ${WITHHELD}`);
    expect(lens.text('Call \u{0410}nn', [ITEM])).toBe('Call \u{0410}nn');
    expect(name('Ann').text('Call \u{0410}nn', [ITEM])).toBe(`Call ${WITHHELD}`);
  });

  it('withholds a look-alike copy added beside the real name, and keeps the mark anchored', () => {
    const text = `Call John Smith. Later: ${CYRILLIC_J}ohn Smith drives.`;
    const anchored: MarkRow = { subject: ITEM, quote: 'John Smith', category: 'member_name', anchoredIn: new Set(['v1']) };
    const lens = lensFor('public', POLICY, [anchored]);
    expect(lens.hidden([ITEM], 'v1')).toBe(false);
    expect(lens.text(text, [ITEM])).toBe(`Call ${WITHHELD}. Later: ${WITHHELD} drives.`);
    expect(quoteMatches('John Smith', [`Call ${CYRILLIC_J}ohn Smith`])).toBe(true);
  });

  it('matches a mark typed with a look-alike against the plain Latin name', () => {
    expect(name(`${CYRILLIC_J}ohn Smith`).text('Call John Smith', [ITEM])).toBe(`Call ${WITHHELD}`);
  });

  it('withholds a digit look-alike, and keeps unrelated letters apart', () => {
    expect(name('John').text('Call J0hn or Jahn', [ITEM])).toBe(`Call ${WITHHELD} or Jahn`);
  });

  // One case per entry of the generated table: the source in place of its Latin letter, both
  // ways, alone and beside the real letter.
  const entries = Object.entries(LOOKALIKES).flatMap(([latin, sources]) => [...sources].map((source) => [latin, source] as const));
  it('covers every Latin-confusable Cyrillic and Greek letter, from the table', () => {
    const scripts = (script: string) => entries.filter(([, source]) => new RegExp(`\\p{Script=${script}}`, 'u').test(source)).map(([, source]) => source);
    // Lower and upper case of the Latin-looking Cyrillic and Greek letters UTS #39 lists.
    expect(scripts('Cyrillic')).toEqual(expect.arrayContaining(['\u{0430}', '\u{0410}', '\u{0435}', '\u{043E}', '\u{0440}', '\u{0441}', '\u{0445}', '\u{0458}', '\u{0408}', '\u{0455}', '\u{0456}']));
    expect(scripts('Greek')).toEqual(expect.arrayContaining(['\u{0391}', '\u{03B1}', '\u{039F}', '\u{03BF}', '\u{03BD}', '\u{03C1}', '\u{0397}', '\u{039A}', '\u{03A4}']));
    expect(entries.length).toBeGreaterThan(700);
  });
  it.each(entries)('treats %s and %s alike', (latin, source) => {
    const plain = `zq${latin}qz`;
    const lookalike = `zq${source}qz`;
    expect(name(plain).text(`a ${lookalike} b`, [ITEM])).toBe(`a ${WITHHELD} b`);
    expect(name(lookalike).text(`a ${plain} b`, [ITEM])).toBe(`a ${WITHHELD} b`);
    expect(name(plain).text(`a ${plain} ${lookalike.toUpperCase()} b`, [ITEM])).toBe(`a ${WITHHELD} ${WITHHELD} b`);
  });
});

describe('the lens: word edges', () => {
  const name = (quote: string) => lensFor('public', POLICY, [span(quote, 'member_name')]);

  it('reads a digit as a word edge', () => {
    expect(name('Ann').text('user Ann2 and Ann 2, 2Ann', [ITEM])).toBe(`user ${WITHHELD}2 and ${WITHHELD} 2, 2${WITHHELD}`);
    expect(name('Ann').text('Annual Anna', [ITEM])).toBe('Annual Anna');
  });

  it('finds a name inside CJK text, which has no spaces', () => {
    expect(name('\u5C0F\u660E').text('\u738B\u5C0F\u660E\u6765\u4E86', [ITEM])).toBe(`\u738B${WITHHELD}\u6765\u4E86`);
    expect(name('Ann').text('\u738BAnn\u6765', [ITEM])).toBe(`\u738B${WITHHELD}\u6765`);
    expect(name('\u30A2\u30F3 Lee').text('\u3067\u30A2\u30F3 Lee\u3067\u3059', [ITEM])).toBe(`\u3067${WITHHELD}\u3067\u3059`);
  });

  it('reads an emoji as a word edge', () => {
    expect(name('Ann').text('Ann\u{1F600} and \u{1F600}Ann', [ITEM])).toBe(`${WITHHELD}\u{1F600} and \u{1F600}${WITHHELD}`);
  });

  it('folds case fully, then strips accents: \u0130smail is ismail, and a combining accent does not hide a name', () => {
    expect(name('ismail').text('\u0130smail drives', [ITEM])).toBe(`${WITHHELD} drives`);
    expect(name('Ismail').text('\u0130SMA\u0130L and Isma\u0131l', [ITEM])).toBe(`${WITHHELD} and ${WITHHELD}`);
    expect(name('Ann').text('An\u0301n drives', [ITEM])).toBe(`${WITHHELD} drives`);
    expect(name('Jos\u00E9 N\u00FA\u00F1ez').text('Jose Nunez and JOSE\u0301 NU\u0301N\u0303EZ', [ITEM])).toBe(`${WITHHELD} and ${WITHHELD}`);
  });

  it('still matches numbers as numbers, whole', () => {
    const lens = lensFor('public', POLICY, [span('555-0142')]);
    expect(lens.text('Ring 555-0142 or 5550142, not 85550142', [ITEM])).toBe(`Ring ${WITHHELD} or ${WITHHELD}, not 85550142`);
  });
});
