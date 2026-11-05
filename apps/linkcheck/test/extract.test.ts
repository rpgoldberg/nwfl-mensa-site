import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTRACT_FORMAT, ExtractError, MAX_PDF_BYTES, readPdf as extract, parseExtraction, type Extraction } from '../src/extract.js';
import { buildPdf, pdfString, uriLink } from './helpers/pdf.js';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('readPdf: the links of a PDF, with page, rect and the text under each', () => {
  it('reads URI links with their page, rect and text, and the plain-text URLs that have no link', async () => {
    const pdf = buildPdf([
      {
        text: [
          { x: 72, y: 700, str: 'Visit example.org today' },
          { x: 72, y: 650, str: 'See https://unlinked.example.com/path. for more' },
        ],
        annots: [uriLink([98, 696, 164, 712], 'https://example.org/events'), `<< /Type /Annot /Subtype /Link /Rect [72 600 140 612] /Dest [3 0 R /Fit] >>`],
      },
      { text: [{ x: 72, y: 700, str: 'Write to the editor' }], annots: [uriLink([72.004, 696.333, 200, 712], 'mailto:editor@example.org')] },
    ]);
    const out = await extract(pdf, 'public');
    expect(out).toEqual<Extraction>({
      format: EXTRACT_FORMAT,
      audience: 'public',
      sha256: sha(pdf),
      pages: 2,
      links: [
        { page: 1, rect: [98, 696, 164, 712], url: 'https://example.org/events', text: 'Visit example.org today' },
        { page: 2, rect: [72, 696.33, 200, 712], url: 'mailto:editor@example.org', text: 'Write to the editor' },
      ],
      refused: [],
      internal: 1,
      unlinked: [{ page: 1, url: 'https://unlinked.example.com/path' }],
      unlinkedMore: 0,
    });
    // What it writes reads back through the strict reader unchanged.
    expect(parseExtraction(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });

  it('clamps a rect to the crop box and refuses one wholly outside it', async () => {
    const pdf = buildPdf([
      {
        crop: [0, 0, 300, 300],
        annots: [uriLink([250, 250, 400, 320], 'https://example.org/a'), uriLink([310, 310, 400, 400], 'https://example.org/b'), uriLink([5, 5, 5, 20], 'https://example.org/c')],
      },
    ]);
    const out = await extract(pdf, 'members');
    expect(out.links).toEqual([{ page: 1, rect: [250, 250, 300, 300], url: 'https://example.org/a', text: '' }]);
    expect(out.refused).toEqual([
      { page: 1, reason: 'rect' },
      { page: 1, reason: 'rect' },
    ]);
  });

  it('refuses other schemes, control characters, over-long URLs and non-URI actions, naming the scheme only', async () => {
    const pdf = buildPdf([
      {
        annots: [
          uriLink([10, 10, 50, 50], 'javascript:alert(1)'),
          uriLink([10, 60, 50, 90], 'data:text/html,<b>x</b>'),
          uriLink([10, 100, 50, 130], 'https://example.org/\u0001x'),
          uriLink([10, 140, 50, 170], `https://example.org/${'a'.repeat(2100)}`),
          uriLink([10, 180, 50, 210], '/relative'),
          `<< /Type /Annot /Subtype /Link /Rect [60 10 90 40] /A << /S /JavaScript /JS (app.launchURL\\("https://example.org/js", true\\);) >> >>`,
          `<< /Type /Annot /Subtype /Link /Rect [60 50 90 80] /A << /S /Launch /F (https://example.org/launch) /NewWindow true >> >>`,
          uriLink([10, 220, 50, 250], 'https://example.org/caf\xc3\xa9'),
          uriLink([10, 260, 50, 290], 'https://example.org/\xc2\x85'),
        ],
      },
    ]);
    const out = await extract(pdf, 'public');
    expect(out.links).toEqual([{ page: 1, rect: [10, 220, 50, 250], url: 'https://example.org/caf\u00e9', text: '' }]);
    expect(out.refused).toEqual([
      { page: 1, reason: 'scheme', scheme: 'javascript' },
      { page: 1, reason: 'scheme', scheme: 'data' },
      { page: 1, reason: 'control' },
      { page: 1, reason: 'too-long' },
      { page: 1, reason: 'scheme' },
      { page: 1, reason: 'action' },
      { page: 1, reason: 'action' },
      { page: 1, reason: 'control' },
    ]);
  });

  it('refuses a URL with the remote-destination fragment pdf.js writes for a GoToR action, and reads a Launch with no /NewWindow like a URI (N1)', async () => {
    const pdf = buildPdf([
      {
        annots: [
          '<< /Type /Annot /Subtype /Link /Rect [10 10 100 30] /A << /S /GoToR /F (https://remote.example/file.pdf) /D [0 /Fit] >> >>',
          '<< /Type /Annot /Subtype /Link /Rect [10 40 100 60] /A << /S /GoToR /F (https://remote.example/file.pdf#page=2) /D [1 /XYZ 0 0 0] >> >>',
          uriLink([10, 70, 100, 90], 'https://example.org/a#[0,{"name":"Fit"}]'),
          '<< /Type /Annot /Subtype /Link /Rect [10 100 100 120] /A << /S /Launch /F (https://launch.example/run) >> >>',
          uriLink([10, 130, 100, 150], 'https://example.org/a#section-2'),
        ],
      },
    ]);
    const out = await extract(pdf, 'public');
    expect(out.links.map((l) => l.url)).toEqual(['https://launch.example/run', 'https://example.org/a#section-2']);
    expect(out.refused).toEqual([
      { page: 1, reason: 'action' },
      { page: 1, reason: 'action' },
      { page: 1, reason: 'action' },
    ]);
  });

  it('refuses a file with more than 500 links, a file over 10 MiB and bytes that are not a PDF', async () => {
    const many = buildPdf([{ annots: Array.from({ length: 501 }, (_, i) => uriLink([10, 10, 20, 20], `https://example.org/${i}`)) }]);
    await expect(extract(many, 'public')).rejects.toThrow(new ExtractError('the file has more than 500 links'));
    await expect(extract(new Uint8Array(MAX_PDF_BYTES + 1), 'public')).rejects.toThrow(/larger than 10 MiB/);
    await expect(extract(new TextEncoder().encode('hello'), 'public')).rejects.toThrow(/not a PDF/);
    await expect(extract(new TextEncoder().encode('%PDF-1.7\ngarbage'), 'public')).rejects.toThrow(/could not be read/);
  });

  it('refuses a file whose annotations or refusals run past the caps, and one past its deadline', async () => {
    const refusals = buildPdf([{ annots: Array.from({ length: 1001 }, () => uriLink([10, 10, 20, 20], 'tel:5550100')) }]);
    await expect(extract(refusals, 'public')).rejects.toThrow(/more than 1000 refused links/);
    const two = buildPdf([{ annots: [uriLink([10, 10, 20, 20], 'https://example.org/')] }, {}]);
    let now = 0;
    await expect(extract(two, 'public', { deadlineMs: 5, now: () => (now += 10) })).rejects.toThrow(/took longer than/);
  });

  it('keeps the first 500 unlinked URLs and counts the rest', async () => {
    const pages = Array.from({ length: 9 }, (_, p) => ({
      text: Array.from({ length: 60 }, (_, j) => ({ x: 10, y: 780 - j * 12, size: 8, str: `https://u${p * 60 + j}.example.com/` })).filter((_, j) => p * 60 + j < 503),
    }));
    const out = await extract(buildPdf(pages), 'public');
    expect(out.unlinked).toHaveLength(500);
    expect(out.unlinkedMore).toBe(3);
  });

  it('caps the text under a link at 300 characters with no control characters', async () => {
    const long = 'word '.repeat(100);
    const pdf = buildPdf([{ text: [{ x: 0, y: 700, size: 2, str: long }, { x: 0, y: 690, str: 'a\u0007b' }], annots: [uriLink([0, 680, 600, 712], 'https://example.org/')] }]);
    const out = await extract(pdf, 'public');
    expect(out.links[0]?.text.length).toBeLessThanOrEqual(300);
    // eslint-disable-next-line no-control-regex -- the test looks for control characters
    expect(out.links[0]?.text).not.toMatch(/[\u0000-\u001f]/);
  });

  it('never copies an annotation\u2019s own strings (/Contents, /T, /Alt) into its output', async () => {
    const pdf = buildPdf([
      { annots: [`<< /Type /Annot /Subtype /Link /Rect [10 10 50 50] /Contents ${pdfString('Leaky Contents')} /T ${pdfString('Leaky T')} /Alt ${pdfString('Leaky Alt')} /A << /S /URI /URI (https://example.org/) >> >>`] },
    ]);
    expect(JSON.stringify(await extract(pdf, 'public'))).not.toMatch(/Leaky/);
  });
});

describe('parseExtraction: the strict reader the later stages use', () => {
  const good = (): Extraction => ({
    format: EXTRACT_FORMAT,
    audience: 'public',
    sha256: 'a'.repeat(64),
    pages: 2,
    links: [{ page: 2, rect: [1, 2, 3, 4], url: 'https://example.org/', text: 'x' }],
    refused: [{ page: 1, reason: 'scheme', scheme: 'javascript' }],
    internal: 0,
    unlinked: [{ page: 1, url: 'https://example.com/' }],
    unlinkedMore: 0,
  });
  const cases: [string, (e: Extraction) => unknown, RegExp][] = [
    ['a non-object', () => null, /must be a JSON object/],
    ['an unknown field', (e) => ({ ...e, more: 1 }), /unknown field more/],
    ['a wrong format', (e) => ({ ...e, format: 'x' }), /format must be/],
    ['a wrong audience', (e) => ({ ...e, audience: 'officers' }), /audience must be/],
    ['a bad sha256', (e) => ({ ...e, sha256: 'A'.repeat(64) }), /sha256 must be/],
    ['a bad page count', (e) => ({ ...e, pages: 0 }), /pages must be/],
    ['links that are not a list', (e) => ({ ...e, links: {} }), /links must be a list/],
    ['over 500 links', (e) => ({ ...e, links: Array.from({ length: 501 }, () => e.links[0]) }), /links holds at most 500/],
    ['a link past the last page', (e) => ({ ...e, links: [{ ...e.links[0], page: 3 }] }), /page must be/],
    ['a link with a bad rect', (e) => ({ ...e, links: [{ ...e.links[0], rect: [1, 2, 3] }] }), /rect must be/],
    ['a link with a javascript url', (e) => ({ ...e, links: [{ ...e.links[0], url: 'javascript:x' }] }), /url must be/],
    ['a link with a control character', (e) => ({ ...e, links: [{ ...e.links[0], url: 'https://example.org/\u0000' }] }), /url must be/],
    ['a link with long text', (e) => ({ ...e, links: [{ ...e.links[0], text: 'x'.repeat(301) }] }), /text must be/],
    ['a link with an extra field', (e) => ({ ...e, links: [{ ...e.links[0], contents: 'x' }] }), /unknown field contents/],
    ['a refusal with an unknown reason', (e) => ({ ...e, refused: [{ page: 1, reason: 'other' }] }), /reason must be/],
    ['a refusal with a bad scheme', (e) => ({ ...e, refused: [{ page: 1, reason: 'scheme', scheme: 'Java Script' }] }), /scheme must be/],
    ['refused that is not a list', (e) => ({ ...e, refused: 1 }), /refused must be a list/],
    ['over 1000 refusals', (e) => ({ ...e, refused: Array.from({ length: 1001 }, () => e.refused[0]) }), /refused holds at most 1000/],
    ['a bad internal count', (e) => ({ ...e, internal: -1 }), /internal must be/],
    ['an unlinked url with a bad scheme', (e) => ({ ...e, unlinked: [{ page: 1, url: 'ftp://example.com/' }] }), /url must be/],
    ['unlinked that is not a list', (e) => ({ ...e, unlinked: 'x' }), /unlinked must be a list/],
    ['over 500 unlinked', (e) => ({ ...e, unlinked: Array.from({ length: 501 }, () => e.unlinked[0]) }), /unlinked holds at most 500/],
    ['a bad unlinkedMore', (e) => ({ ...e, unlinkedMore: 1.5 }), /unlinkedMore must be/],
  ];
  it('accepts a well-formed extraction', () => {
    expect(parseExtraction(good())).toEqual(good());
  });
  it.each(cases)('refuses %s', (_name, mutate, message) => {
    expect(() => parseExtraction(mutate(good()))).toThrow(message);
  });
});
