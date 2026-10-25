/* eslint-disable -- the challenger's R2a tests, kept as written (only M2 removed). */
// CHALLENGER (R2a): pure-lens adversarial cases. Each `it` asserts the SECURE outcome; red = finding.
import { describe, expect, it } from 'vitest';
import { cellKey } from '../../src/redaction/policy.js';
import { lensFor, subjectKey } from '../../src/redaction/render.js';
import type { Tree } from '../../src/content/tree.js';

const S = subjectKey('content_item', '00000000-0000-0000-0000-000000000001');
const policy = new Map([[cellKey('public', 'member_name'), 'redact']]);
const lens = (quote: string) => lensFor('public', policy as never, [{ subject: S, quote, category: 'member_name' }]);
const t = (value: string, quote: string) => lens(quote).text(value, [S]);
const visible = (s: string) => s.normalize('NFKC').replace(/[­​-‍⁠﻿]/g, '');

describe('R2a challenge: the lens', () => {
  it('C1 substring: a marked name inside another word does not leave a "[withheld]ual" that spells the name', () => {
    expect(t('Annual picnic: Ann will drive', 'Ann')).not.toMatch(/\[withheld\][a-z]/);
  });
  it('C1b case-insensitive common word: mark "Mark" (a name) must not turn "remarkable" into "re[withheld]able"', () => {
    expect(t('A remarkable talk by Mark Doe', 'Mark Doe')).toBe('A remarkable talk by [withheld]');
    expect(t('Mark Doe: a remarkable talk', 'Mark')).not.toContain('re[withheld]able');
  });
  it('C2 NFD body vs NFC quote: the name is withheld', () => {
    const out = t('Ride with José Núñez', 'José Núñez');
    expect(visible(out)).not.toContain('José Núñez');
  });
  it('C3 soft hyphen / zero-width space inside the name: withheld', () => {
    expect(visible(t('Call John Sm­ith', 'John Smith'))).not.toContain('John Smith');
    expect(visible(t('Call Jo​hn Smith', 'John Smith'))).not.toContain('John Smith');
  });
  it('C4 full-width and ß/SS case variants: withheld', () => {
    expect(visible(t('Call ＪＯＨＮ ＳＭＩＴＨ', 'John Smith'))).not.toContain('JOHN SMITH');
    expect(t('Host: ANNA STRAUSS', 'Anna Strauß')).toBe('Host: [withheld]');
  });
  it('C5 a link target that carries the name with + for space is unwrapped', () => {
    const tree: Tree = { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'John Smith ', bold: false, italic: false }, { type: 'link', href: 'https://example.org/find?q=John+Smith', children: [{ type: 'text', text: 'profile', bold: false, italic: false }] }] }] };
    expect(JSON.stringify(lens('John Smith').tree(tree, [S]))).not.toMatch(/John\+Smith/i);
  });
  it('C5b double-encoded target', () => {
    const tree: Tree = { blocks: [{ type: 'paragraph', children: [{ type: 'link', href: 'https://example.org/John%2520Smith', children: [{ type: 'text', text: 'profile', bold: false, italic: false }] }] }] };
    expect(decodeURIComponent(decodeURIComponent(JSON.stringify(lens('John Smith').tree(tree, [S]))))).not.toContain('John Smith');
  });
  it('C6 control: plain, case and spacing variants ARE withheld', () => {
    expect(t('call JOHN\n\tsmith now', 'John Smith')).toBe('call [withheld] now');
    expect(t('John Smith and John Smith', 'John Smith')).toBe('[withheld] and [withheld]');
  });
});
