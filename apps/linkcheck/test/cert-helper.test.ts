// The throwaway certificate helper must emit minimal DER for any serial: a serial of 00 7f.. made
// OpenSSL fail with "asn1 illegal padding" about one random certificate in 512.
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificate } from './helpers/cert.js';

const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });

describe('cert helper serials', () => {
  it.each([
    ['00 7f ..', '007f112233445566', '7f112233445566'],
    ['00 00 01 ..', '0000010203040506', '010203040506'],
    ['80 ..', '8011223344556677', '8011223344556677'],
    ['ff ..', 'ff11223344556677', 'ff11223344556677'],
    ['00 80 .. (padding is needed)', '0080112233445566', '0080112233445566'],
    ['01 ..', '0111223344556677', '0111223344556677'],
  ])('encodes serial %s so node:crypto parses it', (_label, hex, minimal) => {
    const pem = certificate('t', pair.publicKey, 't', pair.privateKey, false, ['t.test'], Buffer.from(hex, 'hex'));
    const parsed = new X509Certificate(pem);
    expect(parsed.serialNumber.toLowerCase().replace(/^0+(?=.)/, '')).toBe(minimal.replace(/^0+(?=.)/, ''));
  });
});
