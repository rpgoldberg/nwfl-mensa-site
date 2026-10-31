// REDACT R1: the pure policy resolution. A missing cell, an unknown audience or
// category, or an action the category does not allow resolves to HIDE.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIENCES, CATEGORIES, actionsFor, cellKey, loosens, needsSecondOfficer, resolveAction, type Policy } from './policy.js';

const policy = (cells: Array<[string, string, string]>): Policy => new Map(cells.map(([audience, category, action]) => [cellKey(audience, category), action]));

describe('resolveAction', () => {
  it('returns the cell’s action when it is one the category allows', () => {
    const p = policy([
      ['public', 'member_phone', 'redact'],
      ['members', 'member_phone', 'show'],
      ['public', 'image', 'blur'],
      ['officers', 'image', 'show'],
    ]);
    expect(resolveAction(p, 'public', 'member_phone')).toBe('redact');
    expect(resolveAction(p, 'members', 'member_phone')).toBe('show');
    expect(resolveAction(p, 'public', 'image')).toBe('blur');
    expect(resolveAction(p, 'officers', 'image')).toBe('show');
  });

  it('fails closed on a missing cell', () => {
    expect(resolveAction(policy([]), 'members', 'member_email')).toBe('hide');
  });

  it.each([
    ['an unknown action', 'public', 'member_email', 'reveal'],
    ['an empty action', 'public', 'member_email', ''],
    ['blur on a text category', 'public', 'member_email', 'blur'],
    ['redact on an image (no partial redaction)', 'public', 'image', 'redact'],
  ])('fails closed on %s', (_case, audience, category, action) => {
    expect(resolveAction(policy([[audience, category, action]]), audience, category)).toBe('hide');
  });

  it.each([
    ['an unknown audience', 'staff', 'member_email'],
    ['an unknown category', 'public', 'member_birthday'],
    ['an inherited property name', 'public', 'constructor'],
  ])('fails closed on %s, even when the map holds that key', (_case, audience, category) => {
    expect(resolveAction(policy([[audience, category, 'show']]), audience, category)).toBe('hide');
  });

  it('covers three audiences and eight categories', () => {
    expect(AUDIENCES).toEqual(['public', 'members', 'officers']);
    expect(CATEGORIES).toEqual(['member_name', 'member_address', 'member_phone', 'member_email', 'private_venue', 'business_venue', 'officer_contact', 'image']);
  });

  it('lets text be shown, redacted or hidden, and an image be shown, blurred or hidden, least strict first', () => {
    expect(actionsFor('member_name')).toEqual(['show', 'redact', 'hide']);
    expect(actionsFor('image')).toEqual(['show', 'blur', 'hide']);
  });
});

describe('loosens', () => {
  it.each([
    ['member_phone', 'hide', 'redact', true],
    ['member_phone', 'hide', 'show', true],
    ['member_phone', 'redact', 'show', true],
    ['member_phone', 'show', 'redact', false],
    ['member_phone', 'redact', 'hide', false],
    ['member_phone', 'show', 'hide', false],
    ['image', 'hide', 'blur', true],
    ['image', 'blur', 'show', true],
    ['image', 'show', 'blur', false],
    // An unknown current value reads as the strictest, so moving off it loosens.
    ['member_phone', 'garbage', 'redact', true],
  ] as const)('%s %s -> %s: %s', (category, from, to, expected) => {
    expect(loosens(category, from, to)).toBe(expected);
  });
});

describe('needsSecondOfficer', () => {
  it('holds a loosening of the public audience for a second officer', () => {
    expect(needsSecondOfficer('public', 'member_phone', 'redact', 'show')).toBe(true);
    expect(needsSecondOfficer('public', 'image', 'blur', 'show')).toBe(true);
  });

  it('applies a tightening, or a change for members or officers, at once', () => {
    expect(needsSecondOfficer('public', 'member_phone', 'show', 'hide')).toBe(false);
    expect(needsSecondOfficer('members', 'member_phone', 'hide', 'show')).toBe(false);
    expect(needsSecondOfficer('officers', 'image', 'hide', 'show')).toBe(false);
  });
});

describe('TENANT (CF-ISO-0)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is nwflorida when TENANT is unset, and the configured chapter when it is set', async () => {
    vi.stubEnv('TENANT', undefined);
    vi.resetModules();
    expect((await import('./policy.js')).TENANT).toBe('nwflorida');
    vi.stubEnv('TENANT', 'mensa-other');
    vi.resetModules();
    expect((await import('./policy.js')).TENANT).toBe('mensa-other');
  });

  it('refuses to load with a malformed TENANT: it is written into SQL text (ledger.ts), so only 0012\'s pattern passes', async () => {
    vi.stubEnv('TENANT', "nwflorida' OR '1'='1");
    vi.resetModules();
    await expect(import('./policy.js')).rejects.toThrow(/^TENANT must/);
  });
});
