// REDACT R3a: marked-content properties (ActualText, Alt, E, optional-content
// names) are text a reader copies or reads aloud, outside the glyphs. The
// redacted copy keeps the tags and drops the properties.
import { describe, expect, it } from 'vitest';
import { contentNames, stripMarkedContentProperties } from './content.js';

const strip = (value: string): string => Buffer.from(stripMarkedContentProperties(Buffer.from(value, 'latin1'))).toString('latin1');

describe('stripMarkedContentProperties', () => {
  it('turns an inline property list into a plain tag', () => {
    expect(strip('/Span <</ActualText (Perpetua Lindqvist)>> BDC BT (x) Tj ET EMC')).toBe('/Span BMC BT (x) Tj ET EMC');
  });

  it('turns a named property list into a plain tag', () => {
    expect(strip('q /OC /oc1 BDC 0 0 m EMC Q')).toBe('q /OC BMC 0 0 m EMC Q');
  });

  it('handles nested dictionaries, arrays, hex strings and strings holding delimiters', () => {
    const input = '/Span <</ActualText <FEFF0041> /E (a >> b \\) c) /K [1 <</X (y)>>]>>BDC';
    expect(strip(input)).toBe('/Span BMC');
  });

  it('handles nested parentheses in a string', () => {
    expect(strip('/P <</Alt (a (b) c)>> BDC')).toBe('/P BMC');
  });

  it('keeps everything else byte for byte, comments and other operators included', () => {
    const input = '% a comment with BDC in it\n/P BMC 1 0 0 1 72 700 cm [(A) -20 (B)] TJ EMC\n';
    expect(strip(input)).toBe(input);
  });

  it('skips the binary data of an inline image', () => {
    const input = 'BI /W 2 /H 1 /BPC 8 /CS /G ID \x00(\xff<<\nEI Q /Span <</Alt (z)>> BDC';
    expect(strip(input)).toBe('BI /W 2 /H 1 /BPC 8 /CS /G ID \x00(\xff<<\nEI Q /Span BMC');
  });

  it('refuses a BDC that does not have a tag and a property list (fail closed)', () => {
    expect(() => strip('<</Alt (z)>> BDC')).toThrow('marked content that cannot be read');
  });

  it('refuses an unterminated string, hex string, dictionary or inline image (fail closed)', () => {
    expect(() => strip('/P <</Alt (open')).toThrow('marked content that cannot be read');
    expect(() => strip('/P <</Alt <41')).toThrow('marked content that cannot be read');
    expect(() => strip('/P <</Alt (x)')).toThrow('marked content that cannot be read');
    expect(() => strip('BI /W 1 ID \x00')).toThrow('marked content that cannot be read');
  });
});

// BOXLABEL fix round 3 (R3-1): the names a content stream holds, as a reader's lexer reads them.
describe('contentNames', () => {
  const names = (value: string): string[] => contentNames(Buffer.from(value, 'latin1'));

  it('reads each name once decoded, #XX in either case, as pdf.js and PDFium decode it', () => {
    expect(names('/FXF1 12 Tf /GS#2331 gs /F#4a#4A Do /a#2 n')).toEqual(['FXF1', 'GS#31', 'FJJ', 'a#2']);
  });

  it('skips strings, hex strings, comments and an inline picture (its dictionary too, as the operand check skips it), and reads names in arrays and dictionaries', () => {
    expect(names('(a /b#23c \\) /x) Tj <2F79> Tj % /c#23d\n[/d] TJ /Span <</MCID 0>> BDC BI /W 1 ID /e#23 EI /f')).toEqual(['d', 'Span', 'MCID', 'f']);
  });

  it('reads no name past a string, hex string or inline picture that does not end: a reader reads the rest as its data', () => {
    expect(names('/a (b /c')).toEqual(['a']);
    expect(names('/a <2F /c')).toEqual(['a']);
    expect(names('/a BI /W 1 ID /c')).toEqual(['a']);
    expect(names('/a ) /b')).toEqual(['a', 'b']);
  });

  it('reads every name however deep arrays and dictionaries nest: it keeps no stack (round 4, B1)', () => {
    const deep = 200_000;
    expect(names(`${'[<</K '.repeat(deep)}/GS#2331${' >>]'.repeat(deep)} /b`)).toEqual([...Array.from({ length: deep }, () => 'K'), 'GS#31', 'b']);
  });
});
