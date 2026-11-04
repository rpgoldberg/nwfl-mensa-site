// Hostile but valid PDFs for the gate re-run lift test (UNTRUSTED-PDF-GATE M2), each under the 20 MiB
// copy cap: what a subverted engine could hand the gate as its "copy". Written by hand, object by
// object, so each is exactly what its name says. After the challenger's chal-scratch/scripts/gen.mjs.
import { createDeflate, deflateSync } from 'node:zlib';

/** A PDF of these objects (1..n, bodies only), with object 1 as its catalog. */
function pdf(objects: ReadonlyArray<string | Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = (parts[0] as Buffer).length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const bytes = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(offset);
    parts.push(head, bytes, tail);
    offset += head.length + bytes.length + tail.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const stream = (dict: string, data: Buffer): Buffer => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
const TEXT = Buffer.from('BT /F1 12 Tf 72 720 Td (Picnic flyer) Tj ET', 'latin1');
const PAGE = (contents: string): string => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents ${contents} >>`;

/** `bytes` spaces, deflated (about 1000 to 1). */
function deflatedSpaces(bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const deflate = createDeflate({ level: 9 });
    const chunks: Buffer[] = [];
    deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
    deflate.on('end', () => resolve(Buffer.concat(chunks)));
    deflate.on('error', reject);
    const block = Buffer.alloc(16 * 1024 * 1024, 0x20);
    let left = bytes;
    const pump = (): void => {
      while (left > 0) {
        const n = Math.min(left, block.length);
        left -= n;
        if (!deflate.write(block.subarray(0, n))) {
          deflate.once('drain', pump);
          return;
        }
      }
      deflate.end();
    };
    pump();
  });
}

/** A page whose second content stream inflates to `mib` MiB of spaces. */
export async function flateBomb(mib: number): Promise<Uint8Array> {
  const bomb = await deflatedSpaces(mib * 1024 * 1024);
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', PAGE('[5 0 R 6 0 R]'), FONT, stream('', TEXT), stream('/Filter /FlateDecode', bomb)]);
}

/** One page drawing a two-letter string `count` times: a small file whose text is millions of items. */
export function manyShows(count: number): Uint8Array {
  const body = Buffer.from(`BT /F1 1 Tf 0 0 Td ${'(ab) Tj '.repeat(count)}ET`, 'latin1');
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', PAGE('5 0 R'), FONT, stream('/Filter /FlateDecode', deflateSync(body, { level: 9 }))]);
}

/** `count` pages sharing one font (object 3) and one content stream (object 4). */
export function manyPages(count: number): Uint8Array {
  const kids = Array.from({ length: count }, (_, i) => `${5 + i} 0 R`);
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>';
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`, FONT, stream('', TEXT), ...kids.map(() => page)]);
}
