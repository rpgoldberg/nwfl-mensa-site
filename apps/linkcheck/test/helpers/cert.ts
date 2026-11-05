// Throwaway X.509 certificates for the TLS stand-in servers, written in DER here with node:crypto
// (P-256, ECDSA-SHA256), so no key or certificate file is ever committed and no openssl is needed.
import { type KeyObject, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const len = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const bytes = [40 * a + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const int = (bytes: Buffer): Buffer => tlv(0x02, (bytes[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utc = (date: Date): Buffer => tlv(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const name = (cn: string): Buffer => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function certificate(subject: string, key: KeyObject, issuer: string, issuerKey: KeyObject, ca: boolean, dnsNames: string[]): string {
  const extensions: Buffer[] = [seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(...(ca ? [tlv(0x01, Buffer.from([0xff]))] : []))))];
  if (ca) extensions.push(seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x01, 0x06])))));
  if (dnsNames.length > 0) extensions.push(seq(oid('2.5.29.17'), tlv(0x04, seq(...dnsNames.map((n) => tlv(0x82, Buffer.from(n)))))));
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(randomBytes(8)),
    ECDSA_SHA256,
    name(issuer),
    seq(utc(new Date(now - 3_600_000)), utc(new Date(now + 86_400_000))),
    name(subject),
    key.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, issuerKey);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`;
}

export interface TestPki {
  ca: string;
  key: string;
  cert: string;
}

/** A CA, and a leaf for the given names signed by it. */
export function testPki(dnsNames: string[]): TestPki {
  const caPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leafPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ca = certificate('nwfl test CA', caPair.publicKey, 'nwfl test CA', caPair.privateKey, true, []);
  const cert = certificate(dnsNames[0] ?? 'leaf', leafPair.publicKey, 'nwfl test CA', caPair.privateKey, false, dnsNames);
  const key = leafPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { ca, key, cert };
}
