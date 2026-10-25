// REDACT R3a fix 1: the output gate on its own. Each PDF here is built by
// hand so one place holds the name, mostly in an object no page draws, so only
// the full decode can find it. Every name is made up.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkCopy } from '../../src/pdf/gate.js';

const B = (s: string | Buffer): Buffer => (typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
const stream = (dict: string, data: string | Buffer): Buffer => Buffer.concat([B(`<< ${dict} /Length ${B(data).length} >>\nstream\n`), B(data), B('\nendstream')]);

/** A one-page PDF (objects 1 to 5), with `extra` objects from 6 on that nothing draws. */
function pdf(content: string, extra: Array<string | Buffer> = []): Uint8Array {
  const objects: Array<string | Buffer> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream('', content),
    ...extra,
  ];
  const parts: Buffer[] = [B('%PDF-1.7\n')];
  let at = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([B(`${i + 1} 0 obj\n`), B(body), B('\nendobj\n')]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(B(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

const PAGE = 'BT /F1 12 Tf 72 700 Td (Hello from the editor.) Tj ET';
const NAME = 'Yorick Dalgleish';
const hidden = (data: string | Buffer, dict = ''): Uint8Array => pdf(PAGE, [stream(dict, data)]);
const IN_FILE = 'object 6: withheld text is still in the file';

function lzw(data: Buffer): Buffer {
  // Literal codes only (no dictionary hits), 9 bits each, with a clear code first and EOD last.
  const codes = [256, ...data, 257];
  let bits = '';
  for (const code of codes) bits += code.toString(2).padStart(9, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
}

function a85(data: Buffer): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = Buffer.alloc(4);
    data.copy(chunk, 0, i, i + 4);
    const n = Math.min(4, data.length - i);
    let v = chunk.readUInt32BE(0);
    const c: string[] = [];
    for (let k = 0; k < 5; k++) {
      c.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += c.slice(0, n + 1).join('');
  }
  return `${out}~>`;
}

/** PNG predictor rows: each row a filter byte then `columns` bytes. */
function png(data: Buffer, columns: number, filter: number): Buffer {
  const rows: Buffer[] = [];
  let prior = Buffer.alloc(columns);
  for (let i = 0; i < data.length; i += columns) {
    const row = Buffer.alloc(columns);
    data.copy(row, 0, i, i + columns);
    const out = Buffer.alloc(columns);
    for (let k = 0; k < columns; k++) {
      const left = k > 0 ? row[k - 1]! : 0;
      const up = prior[k]!;
      const upLeft = k > 0 ? prior[k - 1]! : 0;
      const p = left + up - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!;
      out[k] = (row[k]! - predicted) & 0xff;
    }
    rows.push(Buffer.from([filter]), out);
    prior = row;
  }
  return Buffer.concat(rows);
}

describe('checkCopy: a clean copy', () => {
  it('passes a copy with no withheld text anywhere', async () => {
    expect(await checkCopy(hidden(deflateSync(B('BT (Nothing to see) Tj ET')), '/Filter /FlateDecode'), [NAME])).toBeNull();
  });

  it('passes anything when nothing is withheld', async () => {
    expect(await checkCopy(hidden(`(${NAME}) Tj`), [])).toBeNull();
  });

  it('gives no copy of a file it cannot read', async () => {
    expect(await checkCopy(B('%PDF-1.7\nnot a pdf'), [NAME])).toBe('the copy could not be read');
  });
});

describe('checkCopy: an independent reader (pdf.js)', () => {
  it('finds the name in the page text, naming the page', async () => {
    expect(await checkCopy(pdf(`BT /F1 12 Tf 72 700 Td (Call ${NAME} now.) Tj ET`), [NAME])).toBe('page 1: withheld text can still be read by another reader');
  });

  it('finds a name whose pieces are drawn in another order than written', async () => {
    // "Dalgleish" drawn right of "Yorick" though written first: only the positions put them in order.
    const content = 'BT /F1 12 Tf 130 700 Td (Dalgleish) Tj ET BT /F1 12 Tf 72 700 Td (Yorick) Tj ET';
    expect(await checkCopy(pdf(content), [NAME])).toBe('page 1: withheld text can still be read by another reader');
  });
});

describe('checkCopy: every stream, fully decoded', () => {
  it('finds the name in a stream no page draws', async () => {
    expect(await checkCopy(hidden(`BT (${NAME}) Tj ET`), [NAME])).toBe(IN_FILE);
  });

  it('decodes a chain of ASCIIHex, ASCII85 and Flate', async () => {
    const data = `${Buffer.from(a85(deflateSync(B(`(${NAME}) Tj`))), 'latin1').toString('hex')}>`;
    expect(await checkCopy(hidden(data, '/Filter [/ASCIIHexDecode /ASCII85Decode /FlateDecode]'), [NAME])).toBe(IN_FILE);
  });

  it('decodes LZW', async () => {
    expect(await checkCopy(hidden(lzw(B(`(${NAME}) Tj`)), '/Filter /LZWDecode'), [NAME])).toBe(IN_FILE);
  });

  it('decodes RunLength', async () => {
    const data = B(`(${NAME}) Tj`);
    expect(await checkCopy(hidden(Buffer.concat([Buffer.from([data.length - 1]), data, Buffer.from([128])]), '/Filter /RunLengthDecode'), [NAME])).toBe(IN_FILE);
  });

  for (const [filter, name] of [[1, 'Sub'], [2, 'Up'], [3, 'Average'], [4, 'Paeth']] as const) {
    it(`undoes the PNG ${name} predictor`, async () => {
      const data = png(B(`(${NAME} and more text here) Tj`), 8, filter);
      expect(await checkCopy(hidden(deflateSync(data), '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 8 >>'), [NAME])).toBe(IN_FILE);
    });
  }

  it('gives no copy for a predictor it cannot undo', async () => {
    expect(await checkCopy(hidden(deflateSync(B('abc')), '/Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 3 >>'), [NAME])).toBe('object 6: a stream cannot be decoded');
  });

  it('gives no copy for a PNG row with an unknown filter byte', async () => {
    expect(await checkCopy(hidden(deflateSync(Buffer.from([9, 1, 2, 3])), '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 3 >>'), [NAME])).toBe('object 6: a stream cannot be decoded');
  });

  it('gives no copy for a filter it cannot decode', async () => {
    expect(await checkCopy(hidden('xx', '/Filter /JBIG2Decode'), [NAME])).toBe('object 6: a stream uses a filter that cannot be checked (/JBIG2Decode)');
  });

  it('gives no copy for a stream whose data does not decode', async () => {
    expect(await checkCopy(hidden('this is not deflate data', '/Filter /FlateDecode'), [NAME])).toBe('object 6: a stream cannot be decoded');
  });

  it('searches a JPEG\'s bytes as they are', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 18]), B(NAME), Buffer.from([0xff, 0xd9])]);
    expect(await checkCopy(hidden(jpeg, '/Subtype /Image /Filter /DCTDecode'), [NAME])).toBe(IN_FILE);
  });

  it('searches a JPEG behind another filter', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 18]), B(NAME), Buffer.from([0xff, 0xd9])]);
    expect(await checkCopy(hidden(deflateSync(jpeg), '/Subtype /Image /Filter [/FlateDecode /DCTDecode]'), [NAME])).toBe(IN_FILE);
  });

  it('finds the name in UTF-16, big- and little-endian, at either byte alignment', async () => {
    const be = Buffer.from(NAME, 'utf16le').swap16();
    const le = Buffer.from(NAME, 'utf16le');
    for (const data of [be, le, Buffer.concat([Buffer.from([0]), be]), Buffer.concat([Buffer.from([0]), le])]) {
      expect(await checkCopy(hidden(data), [NAME])).toBe(IN_FILE);
    }
  });

  it('finds the name in hex strings, octal escapes and kerning-split TJ inside a stream', async () => {
    const hex = `<${Buffer.from(NAME, 'latin1').toString('hex')}> Tj`;
    expect(await checkCopy(hidden(hex), [NAME])).toBe(IN_FILE);
    expect(await checkCopy(hidden('(\\131orick \\104algleish) Tj'), [NAME])).toBe(IN_FILE);
    expect(await checkCopy(hidden('[(Yor) -20 (ick Dal) 15.5 <676c65697368>] TJ'), [NAME])).toBe(IN_FILE);
    expect(await checkCopy(hidden('(\\(Yorick\\) \\\nDalgleish\\r\\t) Tj'), [NAME])).toBe(IN_FILE);
  });

  it('finds the name across two strings, a word hyphenated between them, and letter-spaced', async () => {
    expect(await checkCopy(hidden('(Yorick) Tj 0 -14 Td (Dalgleish) Tj'), [NAME])).toBe(IN_FILE);
    expect(await checkCopy(hidden('(Yorick Dal-) Tj 0 -14 Td (gleish) Tj'), [NAME])).toBe(IN_FILE);
    expect(await checkCopy(hidden('(Y o r i c k Dalgleish) Tj'), [NAME])).toBe(IN_FILE);
  });

  it('finds the name in a font encoding (Windows-1252) and in look-alike letters', async () => {
    expect(await checkCopy(hidden(B('(Zo\x9a Pike) Tj')), ['Zoš Pike'])).toBe(IN_FILE);
    expect(await checkCopy(hidden(Buffer.from('Yоrick Dalgleish', 'utf16le').swap16()), [NAME])).toBe(IN_FILE);
  });
});

describe('checkCopy: every string and name object', () => {
  it('finds the name in a literal string in any dictionary', async () => {
    expect(await checkCopy(pdf(PAGE, [`<< /Comment (${NAME}) >>`]), [NAME])).toBe(IN_FILE);
  });

  it('finds the name in a UTF-16BE hex string, and in UTF-16LE', async () => {
    const be = `<FEFF${Buffer.from(NAME, 'utf16le').swap16().toString('hex')}>`;
    const le = `<${Buffer.from(NAME, 'utf16le').toString('hex')}>`;
    expect(await checkCopy(pdf(PAGE, [`<< /Comment ${be} >>`]), [NAME])).toBe(IN_FILE);
    expect(await checkCopy(pdf(PAGE, [`<< /Comment [${le}] >>`]), [NAME])).toBe(IN_FILE);
  });

  it('finds the name in PDFDocEncoding (a ligature byte)', async () => {
    expect(await checkCopy(pdf(PAGE, ['<< /Comment <936f6e61204d61727368> >>']), ['Fiona Marsh'])).toBe(IN_FILE);
  });

  it('finds the name in a name object', async () => {
    expect(await checkCopy(pdf(PAGE, ['<< /Yorick#20Dalgleish true >>']), [NAME])).toBe(IN_FILE);
  });

  it('finds the name in a stream\'s dictionary', async () => {
    expect(await checkCopy(hidden('q Q', `/Comment (${NAME})`), [NAME])).toBe(IN_FILE);
  });
});
