import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check.js';
import { ANSWERS_FORMAT, answersTemplate, buildLinkList, needsAnswer, parseAnswers } from '../src/build.js';
import { EXTRACT_FORMAT, type Extraction } from '../src/extract.js';
import { LIST_FORMAT, linksSha256, parseLinkList } from '../src/list.js';
import { CHECK_FORMAT, type CheckReport } from '../src/report.js';

const res = (url: string, over: Partial<CheckResult>): CheckResult => ({ url, kind: 'web', verdict: 'ok', reasons: [], notes: [], keepable: true, kept: url, chain: [], ...over });
const results: CheckResult[] = [
  res('https://site.example/', {}),
  res('http://site.example/up', { verdict: 'upgrade', reasons: ['upgraded'], kept: 'https://site.example/up' }),
  res('https://www.facebook.com/groups/x', { verdict: 'confirm', reasons: ['login-walled'] }),
  res('https://vndb.org/v1', { verdict: 'review', reasons: ['no-fetch'] }),
  res('https://site.example/gone', { verdict: 'drop', reasons: ['dead'] }),
  res('https://site.example/odd', { verdict: 'flag', reasons: ['unrelated-redirect'] }),
  res('http://10.0.0.1/', { verdict: 'drop', reasons: ['private-address'], keepable: false, kept: undefined }),
  res('mailto:editor@example.org', { kind: 'mail' }),
];
const report: CheckReport = { format: CHECK_FORMAT, issueDate: '2026-09-01', checkedAt: '2026-11-05T04:00:00.000Z', results };

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
const extractions = { public: extraction('public', results.map((r) => r.url)), members: extraction('members', ['https://site.example/', 'https://www.facebook.com/groups/x']) };

let counter = 0;
const random = (n: number): Uint8Array => {
  counter += 1;
  const bytes = new Uint8Array(n);
  bytes[15] = counter;
  return bytes;
};

describe('needsAnswer and the answers template', () => {
  it('asks about every keepable link that is not ok or upgrade, once per URL', () => {
    expect(results.filter(needsAnswer).map((r) => r.url)).toEqual(['https://www.facebook.com/groups/x', 'https://vndb.org/v1', 'https://site.example/gone', 'https://site.example/odd']);
    expect(answersTemplate(report)).toEqual({
      format: ANSWERS_FORMAT,
      answers: [
        { row: 1, url: 'https://www.facebook.com/groups/x', keep: false },
        { row: 2, url: 'https://vndb.org/v1', keep: false },
        { row: 3, url: 'https://site.example/gone', keep: false },
        { row: 4, url: 'https://site.example/odd', keep: false },
      ],
    });
  });
});

describe('parseAnswers', () => {
  it('reads yes and no by URL', () => {
    const answers = parseAnswers({ format: ANSWERS_FORMAT, answers: [{ row: 1, url: 'https://www.facebook.com/groups/x', keep: true }, { url: 'https://site.example/', keep: false }] }, report);
    expect([...answers]).toEqual([
      ['https://www.facebook.com/groups/x', true],
      ['https://site.example/', false],
    ]);
  });

  it.each([
    ['a non-object', null, /must be a JSON object/],
    ['a wrong format', { format: 'x', answers: [] }, /format must be/],
    ['an unknown field', { format: ANSWERS_FORMAT, answers: [], more: 1 }, /unknown field more/],
    ['answers that are not a list', { format: ANSWERS_FORMAT, answers: {} }, /answers must be a list/],
    ['an answer with an extra field', { format: ANSWERS_FORMAT, answers: [{ url: 'https://site.example/', keep: true, why: 'x' }] }, /unknown field why/],
    ['a URL the check never saw', { format: ANSWERS_FORMAT, answers: [{ url: 'https://typo.example/', keep: true }] }, /not in the check/],
    ['a keep that is not true or false', { format: ANSWERS_FORMAT, answers: [{ url: 'https://site.example/', keep: 'yes' }] }, /keep must be/],
    ['a bad row', { format: ANSWERS_FORMAT, answers: [{ row: 0, url: 'https://site.example/', keep: true }] }, /row must be/],
    ['the same URL twice', { format: ANSWERS_FORMAT, answers: [{ url: 'https://site.example/', keep: true }, { url: 'https://site.example/', keep: false }] }, /twice/],
    ['a yes for a link that cannot be kept', { format: ANSWERS_FORMAT, answers: [{ url: 'http://10.0.0.1/', keep: true }] }, /cannot be kept/],
  ])('refuses %s', (_name, json, message) => {
    expect(() => parseAnswers(json, report)).toThrow(message);
  });
});

describe('buildLinkList', () => {
  it('keeps ok and upgrade by default, the rest only on a yes, with fresh ids and the hash', () => {
    counter = 0;
    const answers = parseAnswers({ format: ANSWERS_FORMAT, answers: [{ url: 'https://www.facebook.com/groups/x', keep: true }, { url: 'https://vndb.org/v1', keep: true }, { url: 'mailto:editor@example.org', keep: false }] }, report);
    const list = buildLinkList(extractions, report, answers, random);
    expect(list.format).toBe(LIST_FORMAT);
    expect(list.sha256).toEqual({ public: 'a'.repeat(64), members: 'b'.repeat(64) });
    expect(list.links.public.map((l) => [l.url, l.kind, l.confirm, l.page])).toEqual([
      ['https://site.example/', 'web', false, 1],
      ['https://site.example/up', 'web', false, 2],
      ['https://www.facebook.com/groups/x', 'web', true, 3],
      ['https://vndb.org/v1', 'web', true, 1],
    ]);
    expect(list.links.members.map((l) => [l.url, l.confirm])).toEqual([
      ['https://site.example/', false],
      ['https://www.facebook.com/groups/x', true],
    ]);
    const ids = [...list.links.public, ...list.links.members].map((l) => l.id);
    expect(new Set(ids).size).toBe(6);
    expect(list.linksSha256).toBe(linksSha256(list.links, list.sha256));
    expect(parseLinkList(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  it('keeps nothing doubtful with no answers', () => {
    const list = buildLinkList(extractions, report, new Map());
    expect(list.links.public.map((l) => l.url)).toEqual(['https://site.example/', 'https://site.example/up', 'mailto:editor@example.org']);
  });

  it('refuses a link the check has no result for, and extractions given the wrong way round', () => {
    const extra = { ...extractions, members: extraction('members', ['https://unchecked.example/']) };
    expect(() => buildLinkList(extra, report, new Map())).toThrow(/no result for a link on members page 1/);
    expect(() => buildLinkList({ public: extractions.members, members: extractions.public }, report, new Map())).toThrow(/is the members extraction/);
  });
});
