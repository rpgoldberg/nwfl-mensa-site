// REDACT R3a: the leak test's eyes, independent of the engine that redacts.
// pdf.js (not PDFium) extracts every text a reader or a tool can reach: the
// page text, annotations and form fields, the Info and XMP metadata, the
// outline, attachments (their content too), JavaScript and the structure
// tree. A raw search then looks at the file's bytes and every inflated
// stream for the text as ASCII, as UTF-16BE, and as hex of either.
import { inflateSync } from 'node:zlib';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | undefined;
const load = (): Promise<PdfJs> => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v)) ?? '';

/** Every text pdf.js can reach in the file, one string. */
export async function extractAll(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await load();
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true });
  const doc = await task.promise;
  const parts: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent({ includeMarkedContent: true });
      parts.push(content.items.map((item) => ('str' in item ? item.str : json(item))).join(' '));
      parts.push(json(await page.getAnnotations()));
      parts.push(json(await page.getStructTree()));
    }
    const meta = await doc.getMetadata();
    parts.push(json(meta.info), String(meta.metadata?.getRaw() ?? ''));
    parts.push(json(await doc.getOutline()));
    const attachments = (await doc.getAttachments()) as Record<string, { filename: string; content: Uint8Array; description?: string }> | null;
    for (const file of Object.values(attachments ?? {})) {
      parts.push(file.filename, file.description ?? '', Buffer.from(file.content).toString('utf8'));
    }
    parts.push(json(await doc.getFieldObjects()), json(await doc.getJSActions()));
  } finally {
    await task.destroy();
  }
  return parts.join('\n');
}

/** The file's bytes and every stream it holds, inflated where it can be, as latin1. */
export function rawText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const raw = buffer.toString('latin1');
  const out = [raw];
  const start = /stream\r?\n/g;
  for (let match = start.exec(raw); match !== null; match = start.exec(raw)) {
    const from = match.index + match[0].length;
    const to = raw.indexOf('endstream', from);
    if (to < 0) break;
    try {
      out.push(inflateSync(buffer.subarray(from, to)).toString('latin1'));
    } catch {
      // Not Flate: the raw copy above already holds it.
    }
  }
  return out.join('\n');
}

const utf16 = (value: string): string => Buffer.from(value, 'utf16le').swap16().toString('latin1');
const hex = (latin1: string): string => Buffer.from(latin1, 'latin1').toString('hex');

/** Whether a needle shows in pdf.js's text (folded, spacing ignored) or anywhere in the raw bytes, in any encoding. */
export function leaked(needle: string, extracted: string, raw: string): boolean {
  const fold = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (fold(extracted).includes(fold(needle))) return true;
  const haystack = raw.toLowerCase();
  const packed = haystack.replace(/\s+/g, '');
  const forms = [needle, utf16(needle)];
  return forms.some((form) => haystack.includes(form.toLowerCase()) || packed.includes(hex(form)));
}
