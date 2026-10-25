// REDACT R3a: marked-content properties (ActualText, Alt, E, optional-content
// names) are text a reader copies or reads aloud, outside the glyphs. The
// redacted copy keeps the tags and drops the properties.
import { describe, expect, it } from 'vitest';
import { stripMarkedContentProperties } from './content.js';

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
