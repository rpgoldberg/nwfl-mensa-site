// LINKS-REPLACE and LINKS-REMEMBER (a): a different link in place of one, checked like any link, over the
// same printed text; and answers carried forward per URL. Synthetic URLs only.
import { describe, expect, it } from 'vitest';
import { ANSWERS_FORMAT, answersTemplate, buildLinkList, parseAnswers, replacementsOf } from '../src/build.js';
import type { CheckResult } from '../src/check.js';
import { EXTRACT_FORMAT, type Extraction } from '../src/extract.js';
import { parseLinkList } from '../src/list.js';
import { REMEMBER_FORMAT, parseRemember, rememberAnswers } from '../src/remember.js';
import { CHECK_FORMAT, type CheckReport } from '../src/report.js';
import { renderSheet } from '../src/sheet.js';

const res = (url: string, over: Partial<CheckResult>): CheckResult => ({ url, kind: 'web', verdict: 'ok', reasons: [], notes: [], keepable: true, kept: url, chain: [], ...over });
const results: CheckResult[] = [
  res('https://site.example/', {}),
  res('https://site.example/gone', { verdict: 'drop', reasons: ['dead'], fix: 'gone' }),
  res('https://site.example/odd', { verdict: 'flag', reasons: ['unrelated-redirect'], fix: 'odd' }),
  res('https://www.facebook.com/groups/x', { verdict: 'confirm', reasons: ['login-walled'], fix: 'fb' }),
  res('https://vndb.org/v1', { verdict: 'review', reasons: ['no-fetch'], fix: 'review' }),
  res('http://old.example/x', { verdict: 'drop', reasons: ['no-https', 'tls'], keepable: false, kept: undefined, fix: 'no https' }),
  res('https://site.example/busy', { verdict: 'flag', reasons: ['rate-limited'], fix: 'busy' }),
  res('http://10.0.0.1/', { verdict: 'drop', reasons: ['ip-literal'], keepable: false, kept: undefined, fix: 'ip' }),
];
const report: CheckReport = { format: CHECK_FORMAT, issueDate: '2026-09-01', checkedAt: '2026-11-05T04:00:00.000Z', results };
const checked = (rs: CheckResult[], issueDate = '2026-09-01'): CheckReport => ({ format: CHECK_FORMAT, issueDate, checkedAt: '2026-11-06T04:00:00.000Z', results: rs });

const extraction = (audience: 'public' | 'members', urls: string[]): Extraction => ({
  format: EXTRACT_FORMAT,
  audience,
  sha256: (audience === 'public' ? 'a' : 'b').repeat(64),
  pages: 3,
  links: urls.map((url, i) => ({ page: (i % 3) + 1, rect: [10, 10 + i, 50, 20 + i], url, text: `t${i}` })),
  refused: [],
  internal: 0,
  unlinked: [],
  unlinkedMore: 0,
});
const extractions = { public: extraction('public', results.map((r) => r.url)), members: extraction('members', ['https://site.example/gone']) };
const answers = (list: unknown[]): unknown => ({ format: ANSWERS_FORMAT, answers: list });

describe('a replace answer', () => {
  it('is read beside keep answers, normalized to its kept form, and listed for the check', () => {
    const got = parseAnswers(answers([{ row: 1, url: 'https://site.example/gone', replace: 'https://NEW.example/Page' }, { url: 'https://site.example/odd', keep: true }, { url: 'http://old.example/x', replace: 'https://new.example/old' }]), report);
    expect(got.get('https://site.example/gone')).toEqual({ replace: 'https://new.example/Page', where: 'answers[0] (row 1)' });
    expect(got.get('https://site.example/odd')).toBe(true);
    expect(replacementsOf(got)).toEqual(['https://new.example/Page', 'https://new.example/old']);
  });

  it.each([
    ['keep and replace both', { url: 'https://site.example/gone', keep: true, replace: 'https://new.example/' }, /answers\[0\]: give keep or replace, not both/],
    ['neither', { url: 'https://site.example/gone' }, /answers\[0\]\.keep must be true or false/],
    ['a replace that is not text', { url: 'https://site.example/gone', replace: 7 }, /answers\[0\]\.replace must be a web address/],
    ['an http replace', { url: 'https://site.example/gone', replace: 'http://new.example/' }, /answers\[0\]\.replace must start with https:\/\//],
    ['a mailto replace', { url: 'https://site.example/gone', replace: 'mailto:a@example.com' }, /must start with https:\/\//],
    ['a replace with credentials', { url: 'https://site.example/gone', replace: 'https://user:pw@example.com/' }, /answers\[0\]\.replace cannot be used \(credentials\)/],
    ['a replace on an IP literal', { url: 'https://site.example/gone', replace: 'https://93.184.216.1/' }, /cannot be used \(ip-literal\)/],
    ['a replace with a port', { url: 'https://site.example/gone', replace: 'https://new.example:8443/' }, /cannot be used \(port\)/],
    ['a replace to a local name', { url: 'https://site.example/gone', replace: 'https://intranet/' }, /cannot be used \(local-name\)/],
    ['a replace of another scheme', { url: 'https://site.example/gone', replace: 'javascript:alert(1)' }, /cannot be used \(scheme\)/],
  ])('refuses %s', (_name, entry, message) => {
    expect(() => parseAnswers(answers([entry]), report)).toThrow(message);
  });
});

describe('buildLinkList with replacements', () => {
  const replaced = checked([
    res('https://new.example/page', { notes: ['safe-browsing-off'] }),
    res('https://www.facebook.com/groups/new', { verdict: 'confirm', reasons: ['login-walled'] }),
    res('https://dead.example/', { verdict: 'drop', reasons: ['nxdomain'] }),
    res('https://parked.example/', { verdict: 'drop', reasons: ['parked'] }),
    res('https://bad.example/', { verdict: 'drop', reasons: ['private-address'], keepable: false, kept: undefined }),
  ]);

  it('places an ok replacement over the same printed text, in both copies, and never the original', () => {
    const got = parseAnswers(answers([{ url: 'https://site.example/gone', replace: 'https://new.example/page' }, { url: 'http://old.example/x', replace: 'https://www.facebook.com/groups/new' }]), report);
    const list = buildLinkList(extractions, report, got, undefined, replaced);
    const urls = [...list.links.public, ...list.links.members].map((l) => l.url);
    expect(urls).not.toContain('https://site.example/gone');
    const gonePublic = extractions.public.links[1];
    const newPublic = list.links.public.find((l) => l.url === 'https://new.example/page');
    expect(newPublic).toMatchObject({ page: gonePublic?.page, rect: gonePublic?.rect, kind: 'web', confirm: false });
    expect(list.links.public.find((l) => l.url === 'https://www.facebook.com/groups/new')).toMatchObject({ page: extractions.public.links[5]?.page, rect: extractions.public.links[5]?.rect, confirm: true });
    expect(list.links.members).toEqual([expect.objectContaining({ url: 'https://new.example/page', page: 1, rect: [10, 10, 50, 20] })]);
    // The approved list's format is unchanged: the strict reader (no new field) reads it back.
    expect(Object.keys(newPublic ?? {}).sort()).toEqual(['confirm', 'id', 'kind', 'page', 'rect', 'url']);
    expect(parseLinkList(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  it.each([
    ['dead', 'https://dead.example/', /answers\[0\] \(row 3\): the different link did not pass the check \(drop: nxdomain\)/],
    ['parked', 'https://parked.example/', /did not pass the check \(drop: parked\)/],
    ['private', 'https://bad.example/', /did not pass the check \(drop: private-address\)/],
    ['never checked', 'https://unchecked.example/', /answers\[0\] \(row 3\): the different link was not checked/],
  ])('fails step 8 for a %s replacement, naming the row', (_name, url, message) => {
    const got = parseAnswers(answers([{ row: 3, url: 'https://site.example/gone', replace: url }]), report);
    expect(() => buildLinkList(extractions, report, got, undefined, replaced)).toThrow(message);
  });

  it('refuses replacements with no check at all, or checked for another issue', () => {
    const got = parseAnswers(answers([{ url: 'https://site.example/gone', replace: 'https://new.example/page' }]), report);
    expect(() => buildLinkList(extractions, report, got)).toThrow(/answers\[0\]: the different link was not checked/);
    expect(() => buildLinkList(extractions, report, got, undefined, checked([], '2026-10-01'))).toThrow(/checked for another issue/);
  });
});

describe('the sheet offers a different link', () => {
  it('on drop, flag and review rows and on rows that cannot be kept, not on confirm', () => {
    const sheet = renderSheet(report, extractions);
    const line = (url: string): string => sheet.split('\n').find((l) => l.includes(`\`${url}\``)) ?? '';
    for (const url of ['https://site.example/gone', 'https://site.example/odd', 'https://vndb.org/v1', 'http://old.example/x']) expect(line(url)).toContain('Or give a different link.');
    expect(line('https://www.facebook.com/groups/x')).not.toContain('different link');
  });
});

describe('remembered answers (LINKS-REMEMBER a)', () => {
  const memory = parseRemember({
    format: REMEMBER_FORMAT,
    answers: [
      { url: 'https://site.example/gone', replace: 'https://new.example/page', answered: '2026-08-12' },
      { url: 'https://site.example/odd', keep: true, answered: '2026-08-12' },
      { url: 'https://www.facebook.com/groups/x', keep: false, answered: '2026-07-01' },
      { url: 'https://old.example/x', replace: 'https://new.example/old', answered: '2026-08-12' },
      { url: 'https://site.example/busy', keep: true, answered: '2026-08-12' },
      { url: 'https://site.example/', keep: false, answered: '2026-08-12' },
    ],
  });
  const fresh: CheckReport = { ...report, results: report.results.map((r) => (r.url === 'https://site.example/odd' ? { ...r, reasons: ['unrelated-redirect'] } : r.url === 'https://site.example/busy' ? { ...r, verdict: 'flag', reasons: ['tls'], fix: 'tls' } : r)) };

  it('pre-answers the same URL in the template, but never over a fresh unsafe verdict, and never an ok row', () => {
    expect(answersTemplate(fresh, memory).answers).toEqual([
      { row: 1, url: 'https://site.example/gone', replace: 'https://new.example/page' },
      { row: 2, url: 'https://site.example/odd', keep: false },
      { row: 3, url: 'https://www.facebook.com/groups/x', keep: false },
      { row: 4, url: 'https://vndb.org/v1', keep: false },
      { row: 5, url: 'https://site.example/busy', keep: false },
      { url: 'http://old.example/x', replace: 'https://new.example/old' },
    ]);
    // What the template pre-fills parses as answers.
    expect(parseAnswers(answersTemplate(fresh, memory), fresh).size).toBe(6);
  });

  it('says so on the sheet, with the date, and asks again on an unsafe verdict', () => {
    const sheet = renderSheet(fresh, extractions, memory);
    const line = (url: string): string => sheet.split('\n').find((l) => l.includes(`\`${url}\``)) ?? '';
    expect(line('https://site.example/gone')).toContain('Answered before on 2026-08-12: a different link, `https://new.example/page` (filled in).');
    expect(line('https://www.facebook.com/groups/x')).toContain('Answered before on 2026-07-01: no (filled in).');
    expect(line('https://site.example/odd')).toContain('Answered before on 2026-08-12, but asked again: unrelated-redirect.');
    expect(line('https://site.example/busy')).toContain('Answered before on 2026-08-12, but asked again: tls.');
    expect(line('http://old.example/x')).toContain('Answered before on 2026-08-12: a different link');
    expect(line('https://vndb.org/v1')).not.toContain('Answered before');
  });

  it('is written after step 8: this issue over the earlier ones, by kept URL, with the date', () => {
    const got = parseAnswers(answers([{ url: 'https://site.example/odd', keep: false }, { url: 'http://old.example/x', replace: 'https://new.example/other' }, { url: 'http://10.0.0.1/', keep: false }, { url: 'https://site.example/busy', keep: true }]), report);
    const written = rememberAnswers(memory, report, got, '2026-11-14');
    expect(written.format).toBe(REMEMBER_FORMAT);
    expect(written.answers).toEqual([
      { url: 'https://old.example/x', replace: 'https://new.example/other', answered: '2026-11-14' },
      { url: 'https://site.example/', keep: false, answered: '2026-08-12' },
      { url: 'https://site.example/busy', keep: true, answered: '2026-11-14' },
      { url: 'https://site.example/gone', replace: 'https://new.example/page', answered: '2026-08-12' },
      { url: 'https://site.example/odd', keep: false, answered: '2026-11-14' },
      { url: 'https://www.facebook.com/groups/x', keep: false, answered: '2026-07-01' },
    ]);
    expect(parseRemember(JSON.parse(JSON.stringify(written))).size).toBe(6);
    expect(rememberAnswers(new Map(), report, new Map(), '2026-11-14').answers).toEqual([]);
  });

  it.each([
    ['a non-object', [], /the remembered answers must be a JSON object/],
    ['a wrong format', { format: 'x', answers: [] }, /the remembered answers' format must be nwfl-link-remember\/1/],
    ['an unknown field', { format: REMEMBER_FORMAT, answers: [], more: 1 }, /unknown field more/],
    ['answers that are not a list', { format: REMEMBER_FORMAT, answers: {} }, /remembered answers must be a list/],
    ['an entry with an extra field', { format: REMEMBER_FORMAT, answers: [{ url: 'https://a.example/', keep: true, answered: '2026-08-12', why: 1 }] }, /remembered\[0\]: unknown field why/],
    ['a URL not in its kept form', { format: REMEMBER_FORMAT, answers: [{ url: 'http://a.example/', keep: true, answered: '2026-08-12' }] }, /remembered\[0\]\.url must be a kept https or mailto address/],
    ['a URL that is not text', { format: REMEMBER_FORMAT, answers: [{ url: 1, keep: true, answered: '2026-08-12' }] }, /remembered\[0\]\.url must be/],
    ['a bad date', { format: REMEMBER_FORMAT, answers: [{ url: 'https://a.example/', keep: true, answered: 'August' }] }, /remembered\[0\]\.answered must be YYYY-MM-DD/],
    ['keep and replace', { format: REMEMBER_FORMAT, answers: [{ url: 'https://a.example/', keep: true, replace: 'https://b.example/', answered: '2026-08-12' }] }, /remembered\[0\]: give keep or replace, not both/],
    ['neither', { format: REMEMBER_FORMAT, answers: [{ url: 'https://a.example/', answered: '2026-08-12' }] }, /remembered\[0\]\.keep must be true or false/],
    ['a bad replace', { format: REMEMBER_FORMAT, answers: [{ url: 'https://a.example/', replace: 'http://b.example/', answered: '2026-08-12' }] }, /remembered\[0\]\.replace must start with https/],
    ['the same URL twice', { format: REMEMBER_FORMAT, answers: [{ url: 'https://a.example/', keep: true, answered: '2026-08-12' }, { url: 'https://a.example/', keep: false, answered: '2026-08-12' }] }, /remembered\[1\]: the same URL is remembered twice/],
  ])('refuses a remember file with %s', (_name, json, message) => {
    expect(() => parseRemember(json)).toThrow(message);
  });
});
