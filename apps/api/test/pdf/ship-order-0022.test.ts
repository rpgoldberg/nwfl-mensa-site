// REDACT-LOOK fix round (challenger F3): 0022 gives the public image "show". The PDF gate on the
// pdf-iso branch matches the withheld quotes against the glyphs pdf.js draws (drawn.ts, r4 N3: a
// /ToUnicode can lie to the text layer, not to the glyphs), but only under "blur" and "hide". Once
// both land, public copies would lose that check. This file is the ship-order gate: it is skipped
// until the gate's rules (src/pdf/gate-rules.ts) are on the branch, and after the rebase it stays red
// until the gate runs the glyph match whatever the image action. Every name is made up.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RULES = new URL('../../src/pdf/gate-rules.ts', import.meta.url);

/** A one-page PDF from raw objects, with a correct cross-reference table. */
function rawPdf(objects: ReadonlyArray<[number, string]>): Uint8Array {
  let body = '%PDF-1.7\n';
  const at = new Map<number, number>();
  for (const [num, text] of objects) {
    at.set(num, Buffer.byteLength(body, 'latin1'));
    body += `${num} 0 obj\n${text}\nendobj\n`;
  }
  const size = Math.max(...at.keys()) + 1;
  const rows = Array.from({ length: size }, (_, n) => (at.has(n) ? `${String(at.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n'));
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${size}\n${rows.join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

const stream = (data: string): string => `<< /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;

/** "Kestrel Ambry" drawn in Helvetica, its /ToUnicode mapping every letter to "x": the text layer reads no quote. */
function lyingCopy(quote: string): Uint8Array {
  const letters = [...new Set(quote.replace(/ /g, ''))].sort();
  const code = (c: string): number => (c === ' ' ? 0x20 : 0x41 + letters.indexOf(c));
  const hex = [...quote].map((c) => code(c).toString(16).padStart(2, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00> <FF> endcodespacerange ${letters.length + 1} beginbfchar <20> <0020> ${letters.map((c) => `<${code(c).toString(16)}> <0078>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  return rawPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> >>'],
    [4, stream(`BT /F2 12 Tf 72 720 Td (Picnic flyer) Tj ET BT /F1 14 Tf 72 690 Td <${hex}> Tj ET`)],
    [5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 ${letters.map((c) => `/${c}`).join(' ')}] >> /ToUnicode 6 0 R >>`],
    [6, stream(cmap)],
    [7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
}

interface GateRules {
  gateVerdict(job: { copy: Uint8Array; original: Uint8Array; quotes: readonly string[]; image: 'show' | 'blur' | 'hide' }): Promise<{ pass: boolean; code?: string }>;
}

describe('ship order: 0022 (public image "show") ships only once the gate matches drawn glyphs under "show"', () => {
  it.skipIf(!existsSync(RULES))('refuses, under every image action, a copy whose glyphs draw a withheld quote its /ToUnicode hides', async () => {
    const rules = (await import(/* @vite-ignore */ RULES.href)) as GateRules;
    const quote = 'Kestrel Ambry';
    const copy = lyingCopy(quote);
    const verdicts: Record<string, unknown> = {};
    for (const image of ['hide', 'blur', 'show'] as const) verdicts[image] = await rules.gateVerdict({ copy, original: copy, quotes: [quote], image });
    expect(verdicts).toEqual({ hide: { pass: false, code: 'withheld' }, blur: { pass: false, code: 'withheld' }, show: { pass: false, code: 'withheld' } });
  });
});
