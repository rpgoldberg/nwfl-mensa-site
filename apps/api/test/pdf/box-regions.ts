// BOXLABEL: what a label change may not touch. For a set of synthetic fixtures, each copy's redaction regions
// (RedactResult.boxes) and a sha256 of its rendered pixels outside every box (each box blanked a pixel wider each
// side, for its anti-aliased edge). box-regions.golden.json holds these as main's engine (b3668e4, "withheld")
// made them; box-labels.test.ts checks the labelled engine against it. Every name is made up.
import { createHash } from 'node:crypto';
import type { Region } from '../../src/pdf/match.js';
import type { RedactRequest, RedactResult } from '../../src/pdf/redact.js';
import { askLine, FIT_FIXTURES, fitPdf, LOOK_OLD_PUBLIC_QUOTES, LOOK_PUBLIC_QUOTES, lookFixture, NEWSLETTER_QUOTES, newsletterPage } from './fit-fixtures.js';
import { twoMarksFixture } from './fixtures.js';
import { type Raster, SCALE, render } from './pixels.js';

export interface RegionCase {
  name: string;
  pdf: () => Promise<Uint8Array>;
  quotes: string[];
}

/** The fixtures: the exact-fit set, the look page, the newsletter page under each quote set, and three of the labels' own. */
export function regionCases(): RegionCase[] {
  return [
    { name: 'two marks', pdf: twoMarksFixture, quotes: ['Bo', 'Quillon'] },
    { name: 'one long name', pdf: () => fitPdf(askLine('(Quillon Brask) Tj')), quotes: ['Quillon Brask'] },
    { name: 'two lines', pdf: () => fitPdf(`${askLine('(Quillon Brask) Tj', { y: 100 })}\n${askLine('(Ottoline Varga) Tj', { y: 40 })}`), quotes: ['Quillon Brask', 'Ottoline Varga'] },
    { name: 'look, public', pdf: lookFixture, quotes: [...LOOK_PUBLIC_QUOTES] },
    { name: 'look, old public', pdf: lookFixture, quotes: [...LOOK_OLD_PUBLIC_QUOTES] },
    ...Object.entries(NEWSLETTER_QUOTES).map(([name, quotes]) => ({ name: `newsletter, ${name}`, pdf: newsletterPage, quotes })),
    ...FIT_FIXTURES.map((fixture) => ({ name: `${fixture.surface}: ${fixture.name}`, pdf: fixture.pdf, quotes: fixture.quotes })),
  ];
}

export interface RegionRecord {
  kind: RedactResult['kind'];
  boxes?: Region[];
  /** By page (0-based), for the pages with boxes. */
  outside?: Record<string, string>;
}

/** The pixels of `raster` outside every box on its page, hashed. */
export function outsideHash(raster: Raster, boxes: readonly Region[]): string {
  const rgb = Buffer.from(raster.rgb);
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.left * SCALE) - 1);
    const x1 = Math.min(raster.width, Math.ceil(box.right * SCALE) + 1);
    const y0 = Math.max(0, Math.floor((raster.pageHeight - box.top) * SCALE) - 1);
    const y1 = Math.min(raster.height, Math.ceil((raster.pageHeight - box.bottom) * SCALE) + 1);
    for (let y = y0; y < y1; y++) rgb.fill(0, (y * raster.width + x0) * 3, (y * raster.width + x1) * 3);
  }
  return createHash('sha256').update(rgb).digest('hex');
}

/** One case through an engine (`redact`), with `extra` added to its request. */
export async function regionRecord(redact: (pdf: Uint8Array, request: RedactRequest) => Promise<RedactResult>, c: RegionCase, extra: Partial<RedactRequest> = {}): Promise<RegionRecord> {
  const result = await redact(await c.pdf(), { quotes: c.quotes, redactsAny: true, ...extra });
  if (result.kind !== 'redacted') return { kind: result.kind };
  const outside: Record<string, string> = {};
  for (const page of [...new Set(result.boxes.map((box) => box.page))]) {
    outside[String(page)] = outsideHash(await render(result.pdf, page), result.boxes.filter((box) => box.page === page));
  }
  return { kind: 'redacted', boxes: result.boxes, outside };
}
