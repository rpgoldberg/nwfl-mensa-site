// MLOGIN S3, the issue loader's input rules: stdin only (and, in production,
// only a pipe), one bounded JSON bundle, known fields only, and the section 3
// refusals that need no database. Every person here is made up.
import { describe, expect, it } from 'vitest';
import {
  LoadError,
  MARK_CATEGORIES,
  MAX_BUNDLE_BYTES,
  type Mark,
  issueContract,
  marksSha256,
  parseBundle,
  runLoad,
  stdinKind,
} from '../../src/load/load.js';
import { MAX_ORIGINAL_BYTES } from '../../src/pdf/store.js';
import { MARKS, NAME, PHONE, bundleJson, stdinOf } from './bundle.js';

const NO_DB = { DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' };
const PRODUCTION = { ...NO_DB, NODE_ENV: 'production' };

async function run(argv: string[], env: Record<string, string>, stdin = stdinOf('{}')): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runLoad(argv, env, stdin, (line) => lines.push(line));
  return { code, lines };
}

/** A copy of a JSON value with one path set (or deleted with undefined). */
function withPath(json: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const copy = structuredClone(json);
  let at: Record<string, unknown> = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

describe('the source: stdin only', () => {
  it.each([
    ['no argument', []],
    ['a file path', ['/mnt/secret/bundle.json']],
    ['a URL', ['https://example.org/bundle.json']],
    ['stdin and a path', ['-', '/tmp/bundle.json']],
  ])('refuses %s, in production mode and out of it', async (_label, argv) => {
    for (const env of [PRODUCTION, NO_DB]) {
      const { code, lines } = await run(argv, env);
      expect(code).toBe(2);
      expect(lines.join('\n')).toMatch(/stdin only/);
    }
  });

  it.each([
    ['a file redirected into stdin', 'file'],
    ['a terminal or device', 'device'],
    ['anything else', 'other'],
  ] as const)('refuses %s in production mode: the bundle must arrive on a pipe', async (_label, kind) => {
    const { code, lines } = await run(['-'], PRODUCTION, stdinOf('{}', kind));
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/production.*pipe/);
  });

  it.each(['pipe', 'socket'] as const)('accepts a %s in production mode (and reads on, to the bundle check)', async (kind) => {
    const { code, lines } = await run(['-'], PRODUCTION, stdinOf('not json', kind));
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/not valid JSON/);
  });

  it('accepts a file redirect outside production mode, for a local run', async () => {
    const { code, lines } = await run(['-'], NO_DB, stdinOf('not json', 'file'));
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/not valid JSON/);
  });

  it('classifies stdin by its file type', () => {
    const stat = (type: string) => ({
      isFIFO: () => type === 'fifo',
      isSocket: () => type === 'socket',
      isFile: () => type === 'file',
      isCharacterDevice: () => type === 'char',
    });
    expect(['fifo', 'socket', 'file', 'char', 'dir'].map((type) => stdinKind(stat(type)))).toEqual(['pipe', 'socket', 'file', 'device', 'other']);
  });
});

describe('reading the bundle', () => {
  it('refuses a bundle over the cap without reading all of it', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let read = 0;
    const chunks = (function* () {
      for (let n = 0; n < 64; n++) {
        read++;
        yield chunk;
      }
    })();
    const { code, lines } = await run(['-'], NO_DB, { kind: 'pipe', chunks });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/larger than 32 MiB/);
    expect(read).toBe(MAX_BUNDLE_BYTES / chunk.length + 1);
  });

  it('refuses bytes that are not UTF-8', async () => {
    const { code, lines } = await run(['-'], NO_DB, stdinOf(Buffer.from([0x7b, 0xff, 0x7d])));
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/not valid JSON/);
  });
});

describe('parseBundle', () => {
  it('reads a bundle: the issue, the office, the approval, both PDFs and the marks', async () => {
    const json = await bundleJson();
    const bundle = parseBundle(json);
    expect(bundle.issue).toEqual({ period: '2026-10', volume: 30, number: 5 });
    expect(bundle.office).toBe('editor');
    expect(bundle.approval.reference).toBe('PUBCOPY');
    expect(Buffer.from(bundle.pdfs.public).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(bundle.pdfs.members).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bundle.marks).toEqual(MARKS);
  });

  it.each([
    ['not an object', () => [], /the bundle must be a JSON object/],
    ['an unknown field', (j: Record<string, unknown>) => ({ ...j, notes: 'x' }), /unknown field notes/],
    ['a __proto__ field', (j: Record<string, unknown>) => ({ ...j, ...(JSON.parse('{"__proto__": {"x": 1}}') as object) }), /unknown field __proto__/],
    ['another format', (j: Record<string, unknown>) => withPath(j, ['format'], 'nwfl-issue/2'), /format/],
    ['an unknown issue field', (j: Record<string, unknown>) => withPath(j, ['issue', 'title'], 'Free text'), /issue: unknown field title/],
    ['a period that is not YYYY-MM', (j: Record<string, unknown>) => withPath(j, ['issue', 'period'], '2026-1'), /issue\.period/],
    ['a December period', (j: Record<string, unknown>) => withPath(j, ['issue', 'period'], '2026-12'), /December/],
    ['a volume that is not a whole number', (j: Record<string, unknown>) => withPath(j, ['issue', 'volume'], 30.5), /issue\.volume/],
    ['a number out of range', (j: Record<string, unknown>) => withPath(j, ['issue', 'number'], 13), /issue\.number/],
    ['no office', (j: Record<string, unknown>) => withPath(j, ['office'], undefined), /office/],
    ['an office that is not a slug', (j: Record<string, unknown>) => withPath(j, ['office'], 'Pat Example'), /office/],
    ['an approval reference with free text', (j: Record<string, unknown>) => withPath(j, ['approval', 'reference'], 'ok from Pat'), /approval\.reference/],
    ['a marks hash that is not hex', (j: Record<string, unknown>) => withPath(j, ['approval', 'marksSha256'], 'zz'), /approval\.marksSha256/],
    ['an input hash that is not hex', (j: Record<string, unknown>) => withPath(j, ['approval', 'publicInputHash'], 'A'.repeat(64)), /approval\.publicInputHash/],
    ['an unknown approval field', (j: Record<string, unknown>) => withPath(j, ['approval', 'by'], 'x'), /approval: unknown field by/],
    ['a PDF that is not base64', (j: Record<string, unknown>) => withPath(j, ['pdfs', 'public'], '%PDF-1.7 raw'), /pdfs\.public/],
    ['a PDF that is not a PDF', (j: Record<string, unknown>) => withPath(j, ['pdfs', 'members'], Buffer.from('<html>').toString('base64')), /pdfs\.members.*not a PDF/],
    ['an empty PDF', (j: Record<string, unknown>) => withPath(j, ['pdfs', 'public'], ''), /pdfs\.public/],
    ['a third PDF', (j: Record<string, unknown>) => withPath(j, ['pdfs', 'officers'], 'JVBERi0='), /pdfs: unknown field officers/],
    ['marks that are not a list', (j: Record<string, unknown>) => withPath(j, ['marks'], {}), /marks must be a list/],
    ['a mark that is not an object', (j: Record<string, unknown>) => withPath(j, ['marks'], ['x']), /marks\[0\] must be a JSON object/],
    ['a mark with an unknown field', (j: Record<string, unknown>) => withPath(j, ['marks'], [{ ...MARKS[0], field: 'title' }]), /marks\[0\]: unknown field field/],
    ['a quote with spaces around it', (j: Record<string, unknown>) => withPath(j, ['marks'], [{ quote: ` ${NAME}`, category: 'member_name' }]), /marks\[0\]\.quote/],
    ['a quote too short', (j: Record<string, unknown>) => withPath(j, ['marks'], [{ quote: 'Jo', category: 'member_name' }]), /marks\[0\]\.quote/],
    ['a quote too long', (j: Record<string, unknown>) => withPath(j, ['marks'], [{ quote: 'x'.repeat(501), category: 'member_name' }]), /marks\[0\]\.quote/],
    ['the same quote twice', (j: Record<string, unknown>) => withPath(j, ['marks'], [MARKS[0], { quote: NAME, category: 'member_address' }]), /marks\[1\]: the same quote/],
  ])('refuses %s', async (_label, edit, message) => {
    const json = edit(await bundleJson());
    expect(() => parseBundle(json)).toThrow(LoadError);
    expect(() => parseBundle(json)).toThrow(message);
  });

  it('refuses more than 1000 marks', async () => {
    const marks = Array.from({ length: 1001 }, (_v, n): Mark => ({ quote: `Made-up person ${n}`, category: 'member_name' }));
    const json = await bundleJson({ marks });
    expect(() => parseBundle(json)).toThrow(/at most 1000 marks/);
  });

  it('never repeats a quote in a refusal', async () => {
    for (const json of [
      withPath(await bundleJson(), ['marks'], [{ quote: NAME, category: 'business_venue' }]),
      withPath(await bundleJson(), ['marks'], [{ quote: ` ${PHONE}`, category: 'member_phone' }]),
      withPath(await bundleJson(), ['marks'], [{ quote: NAME, category: 'member_name' }, { quote: NAME, category: 'member_name' }]),
    ]) {
      let message = '';
      try {
        parseBundle(json);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('Quillon');
      expect(message).not.toContain('555');
    }
  });
});

describe('the section 3 refusals that need no database', () => {
  it('refuses a public file with no marks', async () => {
    const json = await bundleJson({ marks: [] });
    expect(() => parseBundle(json)).toThrow(/no marks/);
  });

  it('refuses marks whose hash is not the approved one, naming the hash it computed', async () => {
    const json = await bundleJson({ marksSha256: 'a'.repeat(64) });
    expect(() => parseBundle(json)).toThrow(LoadError);
    expect(() => parseBundle(json)).toThrow(new RegExp(`marks.*not the approved.*${marksSha256(MARKS)}`));
  });

  it('refuses a marks list that differs from the approved one by a single category', async () => {
    const changed = MARKS.map((mark) => (mark.quote === NAME ? { ...mark, category: 'private_venue' as const } : mark));
    const json = withPath(await bundleJson(), ['marks'], changed);
    expect(() => parseBundle(json)).toThrow(/not the approved/);
  });

  it.each([MAX_ORIGINAL_BYTES + 1])('refuses a PDF over 10 MiB (%i bytes)', async (size) => {
    const big = Buffer.alloc(size, 0x20);
    big.write('%PDF-1.7\n', 0, 'latin1');
    for (const which of ['public', 'members']) {
      const json = withPath(await bundleJson(), ['pdfs', which], big.toString('base64'));
      expect(() => parseBundle(json)).toThrow(new RegExp(`pdfs\\.${which}.*10 MiB`));
    }
  });

  it.each(['business_venue', 'image', 'hide', 'members_only', ''])('refuses the mark category %j: only the personal-data categories', async (category) => {
    const json = withPath(await bundleJson(), ['marks'], [{ quote: NAME, category }]);
    expect(() => parseBundle(json)).toThrow(/marks\[0\]\.category/);
  });

  it('allows exactly the personal-data categories', () => {
    expect([...MARK_CATEGORIES]).toEqual(['member_name', 'member_address', 'member_phone', 'member_email', 'private_venue', 'officer_contact']);
  });
});

describe('the S4 contract', () => {
  it('builds the title, summary and slug from the period, volume and number alone', () => {
    expect(issueContract({ period: '2026-10', volume: 30, number: 5 })).toEqual({
      slug: 'pensa-mensa-2026-10',
      title: 'Pensa Mensa, October-November 2026',
      summary: 'Volume 30, Number 5',
    });
    expect(issueContract({ period: '2026-08', volume: 30, number: 4 }).title).toBe('Pensa Mensa, August-September 2026');
    expect(issueContract({ period: '2025-01', volume: 29, number: 1 }).title).toBe('Pensa Mensa, January-February 2025');
  });
});

describe('marksSha256', () => {
  it('is the same for the same marks in any order, and changes with a category or a quote', () => {
    const reversed = [...MARKS].reverse();
    expect(marksSha256(reversed)).toBe(marksSha256(MARKS));
    expect(marksSha256(MARKS)).toMatch(/^[0-9a-f]{64}$/);
    expect(marksSha256([{ ...MARKS[0]!, category: 'officer_contact' }])).not.toBe(marksSha256([MARKS[0]!]));
    expect(marksSha256([{ ...MARKS[0]!, quote: 'Ysolde Pemberton' }])).not.toBe(marksSha256([MARKS[0]!]));
    // A mark the database holds twice (an officer's, added by hand) still hashes, and differs from once.
    expect(marksSha256([MARKS[0]!, MARKS[0]!])).not.toBe(marksSha256([MARKS[0]!]));
  });
});

describe('runLoad before the database', () => {
  it('stops a bundle the parser refuses with exit 2, before connecting', async () => {
    const json = await bundleJson({ marks: [] });
    const { code, lines } = await run(['-'], PRODUCTION, stdinOf(JSON.stringify(json)));
    expect(code).toBe(2);
    expect(lines).toEqual(['load: the bundle has no marks: a public file is never loaded without them']);
  });

  it('exits 1 with the driver code only, never its message, when the database cannot be reached', async () => {
    const json = await bundleJson({ period: '2025-04' });
    const { code, lines } = await run(['-'], { DATABASE_URL: 'postgres://nobody:secret-pw@127.0.0.1:1/none' }, stdinOf(JSON.stringify(json)));
    expect(code).toBe(1);
    expect(lines).toEqual(['load failed, nothing applied: ECONNREFUSED']);
  });

  it('exits 1 with no detail, never a crash, when the connection settings themselves are refused', async () => {
    const json = await bundleJson({ period: '2025-04' });
    const { code, lines } = await run(['-'], { ...NO_DB, PGSSLMODE: 'prefer' }, stdinOf(JSON.stringify(json)));
    expect(code).toBe(1);
    expect(lines).toEqual(['load failed, nothing applied: error']);
  });
});
