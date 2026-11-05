import { describe, expect, it } from 'vitest';
import type { CheckDeps } from '../src/check.js';
import { USAGE, main, type Io } from '../src/cli.js';
import { EXTRACT_FORMAT, type Extraction, readPdf } from '../src/extract.js';
import { ANSWERS_FORMAT } from '../src/build.js';
import { parseLinkList } from '../src/list.js';
import { parseCheckReport } from '../src/report.js';
import { buildPdf, uriLink } from './helpers/pdf.js';
import { fakeDns } from './helpers/servers.js';

function memoryIo(files: Record<string, Uint8Array | string> = {}, over: Partial<Io> = {}): Io & { files: Map<string, string | Uint8Array>; out: string[]; err: string[]; depsSeen: string[] } {
  const store = new Map<string, string | Uint8Array>(Object.entries(files));
  const out: string[] = [];
  const err: string[] = [];
  const depsSeen: string[] = [];
  return {
    files: store,
    out,
    err,
    depsSeen,
    readFile: (path) => {
      const got = store.get(path);
      if (got === undefined) return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
      return Promise.resolve(typeof got === 'string' ? new TextEncoder().encode(got) : got);
    },
    writeFile: (path, data) => {
      store.set(path, data);
      return Promise.resolve();
    },
    print: (line) => out.push(line),
    warn: (line) => err.push(line),
    env: {},
    now: () => new Date('2026-11-05T04:00:00.000Z'),
    checkDeps: (issueDate): CheckDeps => {
      depsSeen.push(issueDate);
      // Offline: nothing resolves; the links below are on the no-fetch and login-walled lists, or mailto.
      return { dns: fakeDns({ 'www.facebook.com': ['157.240.1.35'] }, { mx: { 'example.org': [{ exchange: 'mx.example.org', priority: 10 }] } }), connect: () => Promise.reject(new Error('no network in this test')), issueDate };
    },
    extract: (pdf, audience) => readPdf(pdf, audience),
    ...over,
  };
}

const text = (io: { files: Map<string, string | Uint8Array> }, path: string): string => io.files.get(path) as string;

describe('the CLI', () => {
  const pdf = buildPdf([
    {
      text: [{ x: 72, y: 700, str: 'Our group page and the directory' }],
      annots: [uriLink([72, 696, 150, 712], 'https://www.facebook.com/groups/example'), uriLink([160, 696, 250, 712], 'https://members.us.mensa.org/directory'), uriLink([72, 600, 150, 612], 'mailto:editor@example.org')],
    },
  ]);

  it('prints the usage for help and for nothing, and refuses an unknown command or flag', async () => {
    const io = memoryIo();
    expect(await main(['help'], io)).toBe(0);
    expect(await main([], io)).toBe(0);
    expect(io.out.join('\n')).toContain(USAGE);
    expect(await main(['launch'], io)).toBe(2);
    expect(await main(['extract', '--colour', 'red'], io)).toBe(2);
    expect(await main(['extract', '--in'], io)).toBe(2);
    expect(io.err.join('\n')).toMatch(/unknown command launch[\s\S]*unknown flag --colour[\s\S]*--in needs a value/);
  });

  it('runs extract, check and list end to end, offline, on a synthetic issue', async () => {
    const io = memoryIo({ '/in/public.pdf': pdf, '/in/members.pdf': pdf });
    // extract runs in-process here (readPdf); production runs it in its worker.
    expect(await main(['extract', '--audience', 'public', '--in', '/in/public.pdf', '--out', '/out'], io)).toBe(0);
    expect(await main(['extract', '--audience', 'members', '--in', '/in/members.pdf', '--out', '/out'], io)).toBe(0);
    const extraction = JSON.parse(text(io, '/out/extract-public.json')) as Extraction;
    expect(extraction.format).toBe(EXTRACT_FORMAT);
    expect(extraction.links).toHaveLength(3);
    expect(io.out).toContain('extract public: 3 links, 0 refused, 0 printed with no link');

    expect(await main(['check', '--issue-date', '2026-09-01', '--out', '/out', '/out/extract-public.json', '/out/extract-members.json'], io)).toBe(0);
    expect(io.depsSeen).toEqual(['2026-09-01']);
    const report = parseCheckReport(JSON.parse(text(io, '/out/check.json')));
    expect(report.checkedAt).toBe('2026-11-05T04:00:00.000Z');
    expect(report.results.map((r) => [r.url, r.verdict])).toEqual([
      ['https://www.facebook.com/groups/example', 'confirm'],
      ['https://members.us.mensa.org/directory', 'review'],
      ['mailto:editor@example.org', 'ok'],
    ]);
    expect(text(io, '/out/sheet.md')).toContain('# Link check sheet');
    expect(JSON.parse(text(io, '/out/answers-template.json'))).toEqual({
      format: ANSWERS_FORMAT,
      answers: [
        { row: 1, url: 'https://www.facebook.com/groups/example', keep: false },
        { row: 2, url: 'https://members.us.mensa.org/directory', keep: false },
      ],
    });
    expect(io.out).toContain('check: 1 ok, 0 upgrade, 1 confirm, 1 review, 0 flag, 0 drop; 2 need an answer');

    io.files.set('/out/answers.json', JSON.stringify({ format: ANSWERS_FORMAT, answers: [{ row: 1, url: 'https://www.facebook.com/groups/example', keep: true }] }));
    expect(await main(['list', '--check', '/out/check.json', '--public', '/out/extract-public.json', '--members', '/out/extract-members.json', '--answers', '/out/answers.json', '--out', '/out'], io)).toBe(0);
    const list = parseLinkList(JSON.parse(text(io, '/out/links.json')));
    expect(list.links.public.map((l) => [l.url, l.confirm])).toEqual([
      ['https://www.facebook.com/groups/example', true],
      ['mailto:editor@example.org', false],
    ]);
    expect(io.out).toContain(`linksSha256 ${list.linksSha256}`);
    expect(io.out).toContain('list: 2 public links, 2 members links kept');

    // Without answers, only what is kept by default.
    expect(await main(['list', '--check', '/out/check.json', '--public', '/out/extract-public.json', '--members', '/out/extract-members.json', '--out', '/out'], io)).toBe(0);
    expect(parseLinkList(JSON.parse(text(io, '/out/links.json'))).links.public.map((l) => l.url)).toEqual(['mailto:editor@example.org']);
  });

  it('refuses two extractions for the same audience', async () => {
    const io = memoryIo({ '/in/p.pdf': pdf });
    await main(['extract', '--audience', 'public', '--in', '/in/p.pdf', '--out', '/o'], io);
    expect(await main(['check', '--issue-date', '2026-09-01', '--out', '/o', '/o/extract-public.json', '/o/extract-public.json'], io)).toBe(1);
    expect(io.err).toEqual(['linkcheck: two extraction files are both for public']);
  });

  it('checks one extraction alone', async () => {
    const io = memoryIo({ '/in/p.pdf': pdf });
    await main(['extract', '--audience', 'public', '--in', '/in/p.pdf', '--out', '/o'], io);
    expect(await main(['check', '--issue-date', '2026-09-01', '--out', '/o', '/o/extract-public.json'], io)).toBe(0);
  });

  it.each([
    [['extract', '--audience', 'officers', '--in', '/x', '--out', '/o'], /--audience must be public or members/],
    [['extract', '--audience', 'public', '--out', '/o'], /--in is needed/],
    [['extract', '--audience', 'public', '--in', '/missing.pdf', '--out', '/o'], /cannot read \/missing.pdf/],
    [['check', '--issue-date', 'soon', '--out', '/o', '/x'], /--issue-date must be YYYY-MM-DD/],
    [['check', '--issue-date', '2026-09-01', '--out', '/o'], /one or two extraction files/],
    [['check', '--issue-date', '2026-09-01', '--out', '/o', '/bad.json'], /\/bad.json is not JSON/],
    [['check', '--issue-date', '2026-09-01', '--out', '/o', '/wrong.json'], /format must be/],
    [['list', '--check', '/bad.json', '--public', '/x', '--members', '/y', '--out', '/o'], /is not JSON/],
  ])('refuses %j', async (argv, message) => {
    const io = memoryIo({ '/x': 'x', '/bad.json': '{', '/wrong.json': '{"format":"x"}' });
    expect(await main(argv, io)).toBe(1);
    expect(io.err.join('\n')).toMatch(message);
  });

  it('refuses a file that is not a PDF with the extractor\u2019s reason, and names no stack', async () => {
    const io = memoryIo({ '/in/x.pdf': 'hello' });
    expect(await main(['extract', '--audience', 'public', '--in', '/in/x.pdf', '--out', '/o'], io)).toBe(1);
    expect(io.err).toEqual(['linkcheck: the file is not a PDF']);
  });

  it('warns that Safe Browsing is not used when a key is set', async () => {
    const io = memoryIo({ '/in/p.pdf': pdf }, { env: { NWFL_SAFE_BROWSING_KEY: 'set' } });
    await main(['extract', '--audience', 'public', '--in', '/in/p.pdf', '--out', '/o'], io);
    expect(await main(['check', '--issue-date', '2026-09-01', '--out', '/o', '/o/extract-public.json'], io)).toBe(0);
    expect(io.err).toEqual(['linkcheck: a Safe Browsing key is set, but this version does not consult Safe Browsing yet']);
    expect(io.err.join('')).not.toContain('set,but');
  });

  it('reports an unexpected error without its details', async () => {
    const io = memoryIo({}, { readFile: () => Promise.reject(new TypeError('secret detail')) });
    expect(await main(['check', '--issue-date', '2026-09-01', '--out', '/o', '/x'], io)).toBe(1);
    expect(io.err).toEqual(['linkcheck: cannot read /x']);
    const io2 = memoryIo({ '/in/p.pdf': pdf }, { writeFile: () => Promise.reject(new TypeError('secret detail')) });
    expect(await main(['extract', '--audience', 'public', '--in', '/in/p.pdf', '--out', '/o'], io2)).toBe(1);
    expect(io2.err).toEqual(['linkcheck: an unexpected error (TypeError)']);
  });
});
