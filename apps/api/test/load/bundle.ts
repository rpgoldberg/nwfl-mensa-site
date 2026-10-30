// Synthetic issue bundles for the loader's tests (MLOGIN S3). Every person,
// phone, address and email here is made up; no real newsletter is used.
import { createHash } from 'node:crypto';
import { type Mark, marksSha256 } from '../../src/load/load.js';
import { inputHash } from '../../src/pdf/store.js';
import { linesPdf } from '../pdf/fixtures.js';

export const NAME = 'Quillon Brask';
export const PHONE = '850-555-0142';
export const ADDRESS = '12 Example Lane';
export const EMAIL = 'q.brask@example.org';
export const KEPT = 'Everyone is welcome.';
export const MEMBERS_ONLY = 'Members note: the board meets in Destin.';

export const MARKS: Mark[] = [
  { quote: NAME, category: 'member_name' },
  { quote: PHONE, category: 'member_phone' },
  { quote: ADDRESS, category: 'member_address' },
  { quote: EMAIL, category: 'member_email' },
];

const LINES = [`Game night host: ${NAME}`, `Rides: call ${PHONE} by Friday.`, `Potluck at ${ADDRESS} on Sunday.`, `Write to ${EMAIL} to join.`, KEPT];

export const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

/** The public PDF of an issue: the lines above, plus a label so each issue's bytes differ. */
export const publicPdf = (label: string): Promise<Uint8Array> => linesPdf([`Pensa Mensa ${label}`, ...LINES]);
/** The full (members) PDF: the same, plus a members-only line. */
export const membersPdf = (label: string): Promise<Uint8Array> => linesPdf([`Pensa Mensa ${label}`, ...LINES, MEMBERS_ONLY]);

/** The public copy's input hash under the default policy: the public redacts every mark's category and blurs images. */
export const publicInputHash = (pdf: Uint8Array, marks: readonly Mark[]): string =>
  inputHash(sha256(pdf), { quotes: marks.map((mark) => mark.quote), redactsAny: true, image: 'blur' }).toString('hex');

export interface BundleOptions {
  period?: string;
  volume?: number;
  number?: number;
  office?: string;
  reference?: string;
  marks?: Mark[];
  publicPdf?: Uint8Array;
  membersPdf?: Uint8Array;
  /** Overrides the approved hashes (by default they are the bundle's own). */
  marksSha256?: string;
  publicInputHash?: string;
  membersSha256?: string;
}

/** A bundle as the loader reads it from stdin (JSON, PDFs in base64), approved for its own marks and public copy. */
export async function bundleJson(options: BundleOptions = {}): Promise<Record<string, unknown>> {
  const period = options.period ?? '2026-10';
  const pub = options.publicPdf ?? (await publicPdf(period));
  const members = options.membersPdf ?? (await membersPdf(period));
  const marks = options.marks ?? MARKS;
  return {
    format: 'nwfl-issue/1',
    issue: { period, volume: options.volume ?? 30, number: options.number ?? 5 },
    office: options.office ?? 'editor',
    approval: {
      reference: options.reference ?? 'PUBCOPY',
      marksSha256: options.marksSha256 ?? marksSha256(marks),
      publicInputHash: options.publicInputHash ?? publicInputHash(pub, marks),
      membersSha256: options.membersSha256 ?? sha256(members).toString('hex'),
    },
    pdfs: { public: Buffer.from(pub).toString('base64'), members: Buffer.from(members).toString('base64') },
    marks: marks.map((mark) => ({ ...mark })),
  };
}

/** stdin as the loader sees it: its kind and its chunks. */
export function stdinOf(text: string | Buffer, kind: 'pipe' | 'socket' | 'file' | 'device' | 'other' = 'pipe') {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  return {
    kind,
    chunks: (function* () {
      // Two chunks, so a split read is exercised.
      yield bytes.subarray(0, Math.floor(bytes.length / 2));
      yield bytes.subarray(Math.floor(bytes.length / 2));
    })(),
  };
}
