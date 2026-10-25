// ============================================================================
// REDACT R3a fix 1: a JPEG (a DCTDecode picture) with only what draws it.
//
// Kept: the frame, tables and every scan, and the three application segments
// that change how the pixels decode (JFIF, the ICC colour profile, Adobe's
// colour transform). Dropped: comments, every other application segment
// (EXIF and GPS, XMP, Photoshop, thumbnails) and anything after the end of
// the image. The pixels are untouched. A JPEG that cannot be walked to its
// end is not given at all.
// ============================================================================

const UNREADABLE = 'a picture cannot be read';
const KEPT_APPS: ReadonlyArray<[number, string]> = [
  [0xe0, 'JFIF\0'],
  [0xe2, 'ICC_PROFILE\0'],
  [0xee, 'Adobe'],
];

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
/** A marker with no length after it: a restart, or TEM. */
const standalone = (marker: number): boolean => (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
const isApp = (marker: number): boolean => marker >= 0xe0 && marker <= 0xef;

function kept(marker: number, segment: Uint8Array): boolean {
  if (marker === COM) return false;
  if (!isApp(marker)) return true;
  const tag = Buffer.from(segment.subarray(4)).toString('latin1');
  return KEPT_APPS.some(([app, prefix]) => app === marker && tag.startsWith(prefix));
}

/** The end of a scan's entropy-coded data: the first marker that is not a stuffed byte or a restart. */
function scanEnd(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.length; i++) {
    const next = bytes[i + 1] as number;
    if (bytes[i] === 0xff && next !== 0x00 && next !== 0xff && !standalone(next)) return i;
  }
  throw new Error(UNREADABLE);
}

/** The JPEG with only its drawing segments. Throws when it cannot be read to its end. */
export function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) throw new Error(UNREADABLE);
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error(UNREADABLE);
    if (bytes[at + 1] === 0xff) {
      at += 1; // A fill byte.
      continue;
    }
    const marker = bytes[at + 1] as number;
    if (marker === EOI) {
      out.push(bytes.subarray(at, at + 2));
      return new Uint8Array(Buffer.concat(out));
    }
    if (standalone(marker)) {
      out.push(bytes.subarray(at, at + 2));
      at += 2;
      continue;
    }
    const end = at + 2 + (((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
    if (at + 4 > bytes.length || end > bytes.length) throw new Error(UNREADABLE);
    const segment = bytes.subarray(at, end);
    if (kept(marker, segment)) out.push(segment);
    at = end;
    if (marker === SOS) {
      const stop = scanEnd(bytes, at);
      out.push(bytes.subarray(at, stop));
      at = stop;
    }
  }
  throw new Error(UNREADABLE);
}
