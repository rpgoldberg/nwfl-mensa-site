import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check.js';
import { EXTRACT_FORMAT, type Extraction } from '../src/extract.js';
import { CHECK_FORMAT, type CheckReport } from '../src/report.js';
import { renderSheet } from '../src/sheet.js';

const res = (url: string, over: Partial<CheckResult>): CheckResult => ({ url, kind: 'web', verdict: 'ok', reasons: [], notes: [], keepable: true, kept: url, chain: [], ...over });
const report: CheckReport = {
  format: CHECK_FORMAT,
  issueDate: '2026-09-01',
  checkedAt: '2026-11-05T04:00:00.000Z',
  results: [
    res('https://site.example/', { finalUrl: 'https://site.example/' }),
    res('https://site.example/odd', { verdict: 'flag', reasons: ['unrelated-redirect'], finalUrl: 'https://other.example/x|y', fix: 'It now leads to another site; check that it is the right one.' }),
    res('https://vndb.org/v1', { verdict: 'review', reasons: ['no-fetch'], fix: 'Not checked: officer review.' }),
    res('http://10.0.0.1/`x`', { verdict: 'drop', reasons: ['private-address'], keepable: false, kept: undefined, fix: 'It points into a private network; it cannot be kept.' }),
    res('https://b\u00fccher.example/', {}),
  ],
};
const extraction = (audience: 'public' | 'members', links: Extraction['links'], extra: Partial<Extraction> = {}): Extraction => ({
  format: EXTRACT_FORMAT,
  audience,
  sha256: 'a'.repeat(64),
  pages: 4,
  links,
  refused: [],
  internal: 0,
  unlinked: [],
  unlinkedMore: 0,
  ...extra,
});

describe('renderSheet', () => {
  const sheet = renderSheet(report, {
    public: extraction(
      'public',
      [
        { page: 1, rect: [1, 1, 2, 2], url: 'https://site.example/', text: 'Our site' },
        { page: 2, rect: [1, 1, 2, 2], url: 'https://site.example/odd', text: 'Odd *bold* | pipe <b>tag</b> [link](javascript:x)' },
        { page: 3, rect: [1, 1, 2, 2], url: 'https://site.example/odd', text: '' },
        { page: 4, rect: [1, 1, 2, 2], url: 'http://10.0.0.1/`x`', text: 'Inside' },
        { page: 4, rect: [1, 1, 2, 2], url: 'https://b\u00fccher.example/', text: 'Books' },
      ],
      { refused: [{ page: 2, reason: 'scheme', scheme: 'javascript' }, { page: 3, reason: 'rect' }], internal: 2, unlinked: [{ page: 1, url: 'https://printed.example/a|b' }], unlinkedMore: 4 },
    ),
    members: extraction('members', [{ page: 1, rect: [1, 1, 2, 2], url: 'https://vndb.org/v1', text: 'Visual novels' }]),
  });

  it('opens with the issue date, the counts and how to answer', () => {
    expect(sheet).toContain('# Link check sheet');
    expect(sheet).toContain('Issue date 2026-09-01');
    expect(sheet).toContain('2 ok, 0 upgrade, 0 confirm, 1 review, 1 flag, 1 drop');
    expect(sheet).toMatch(/LINKS: 1 yes, 2 no/);
  });

  it('numbers each URL that needs an answer once, with its files and pages', () => {
    expect(sheet).toContain('| 1 | public | 2, 3 | Odd \\*bold\\* \\| pipe \\<b\\>tag\\</b\\> \\[link\\]\\(javascript:x\\) | `https://site.example/odd` | `https://other.example/x%7Cy` | flag | unrelated-redirect | It now leads to another site; check that it is the right one. |');
    expect(sheet).toContain('| 2 | members | 1 | Visual novels | `https://vndb.org/v1` |  | review | no-fetch | Not checked: officer review. |');
    const both = renderSheet({ ...report, results: [report.results[2] as CheckResult] }, {
      public: extraction('public', [{ page: 2, rect: [1, 1, 2, 2], url: 'https://vndb.org/v1', text: '' }]),
      members: extraction('members', [{ page: 1, rect: [1, 1, 2, 2], url: 'https://vndb.org/v1', text: 'Visual novels' }, { page: 3, rect: [1, 1, 2, 2], url: 'https://vndb.org/v1', text: '' }]),
    });
    expect(both).toContain('| 1 | public, members | public 2; members 1, 3 | Visual novels |');
  });

  it('lists what is kept, what cannot be kept, what was refused and what is printed with no link', () => {
    expect(sheet).toContain('| public | 1 | Our site | `https://site.example/` | ok |');
    expect(sheet).toContain('| public | 4 | Books | `https://xn--bcher-kva.example/` | ok |');
    expect(sheet).toContain('| public | 4 | Inside | `http://10.0.0.1/%60x%60` | private-address | It points into a private network; it cannot be kept. |');
    expect(sheet).toContain('| public | 2 | a link with a scheme that is never kept (javascript) |');
    expect(sheet).toContain('| public | 3 | a link whose area is off the page |');
    expect(sheet).toContain('2 links to places inside the file (not kept in this version)');
    expect(sheet).toContain('| public | 1 | `https://printed.example/a%7Cb` |');
    expect(sheet).toContain('and 4 more');
  });

  it('carries no control or bidi character, and no raw backtick or pipe inside a cell', () => {
    const hostile = renderSheet({ ...report, results: [res('https://evil.example/\u202egnp.exe', { verdict: 'flag', reasons: ['blocked'], fix: 'The site refused the checker (401 or 403); open it yourself.' })] }, {
      public: extraction('public', [{ page: 1, rect: [1, 1, 2, 2], url: 'https://evil.example/\u202egnp.exe', text: 'a\u202eb\u0000c' }]),
      members: extraction('members', []),
    });
    // eslint-disable-next-line no-control-regex -- the test looks for control characters
    expect(hostile).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u202a-\u202e\u2066-\u2069]/);
    expect(hostile).toContain('a\ufffdb\ufffdc');
  });

  it('cuts long text and long URLs, and shows a result no extraction holds with no file or page', () => {
    const long = `https://site.example/${'p'.repeat(400)}`;
    const sheet = renderSheet({ ...report, results: [res(long, { verdict: 'flag', reasons: ['blocked'], fix: 'The site refused the checker (401 or 403); open it yourself.' }), res('https://orphan.example/', { verdict: 'flag', reasons: ['blocked'], fix: 'The site refused the checker (401 or 403); open it yourself.' })] }, {
      public: extraction('public', [{ page: 1, rect: [1, 1, 2, 2], url: long, text: 'w '.repeat(150) }]),
      members: extraction('members', []),
    });
    expect(sheet).toMatch(/`https:\/\/site\.example\/p+\u2026`/);
    expect(sheet).toMatch(/\| (w ){99}w\u2026 \|/);
    expect(sheet).toContain('| 2 |  |  |  | `https://orphan.example/` |');
  });

  it('says so when nothing needs an answer', () => {
    const quiet = renderSheet({ ...report, results: [res('https://site.example/', {})] }, { public: extraction('public', [{ page: 1, rect: [1, 1, 2, 2], url: 'https://site.example/', text: '' }]), members: extraction('members', []) });
    expect(quiet).toContain('Nothing needs your answer.');
  });
});
