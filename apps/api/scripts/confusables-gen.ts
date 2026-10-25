// ============================================================================
// Builds src/redaction/confusables.ts from Unicode confusables.txt (UTS #39),
// the release pinned below, read from scripts/unicode/ (gzip; the Unicode
// License v3 is beside it). No network: an input whose sha256 is not the
// pinned one is refused.
//
//   node scripts/confusables-gen.ts            writes src/redaction/confusables.ts
//   node scripts/confusables-gen.ts --check    exits 1 if the committed file differs
//   ... --out <file>                            another target, for the test
//
// The fold is the one render.ts uses and comes from the runtime's Unicode
// tables, so run it on the Node in .nvmrc. test/tooling/confusables-gen.test.ts
// regenerates the table and compares it byte for byte.
// ============================================================================
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const PINNED = {
  version: '18.0.0',
  // https://www.unicode.org/Public/18.0.0/security/confusables.txt
  sha256: '6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92',
  file: 'scripts/unicode/confusables-18.0.0.txt.gz',
  table: 'src/redaction/confusables.ts',
} as const;

/** The pinned confusables.txt, from its gzip, or an error if it is any other file. */
export function readPinned(gz: Buffer): string {
  const raw = gunzipSync(gz);
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== PINNED.sha256) throw new Error(`confusables.txt sha256 ${sha} is not the pinned ${PINNED.sha256}`);
  return raw.toString('utf8');
}

// The same fold as render.ts: NFKD, full case fold, NFKD, combining marks and ignorables removed.
const fold = (s: string): string =>
  s.normalize('NFKD').toUpperCase().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Default_Ignorable_Code_Point}/gu, '');

const hex = (cp: number): string => cp.toString(16).toUpperCase().padStart(4, '0');

/** The generated module, for the confusables.txt text given. */
export function generate(text: string): string {
  const version = /# Version: (\S+)/.exec(text)?.[1] ?? '';
  const date = /# Date: ([^,]+)/.exec(text)?.[1] ?? '';
  const byLatin = new Map<string, number[]>();
  let kept = 0;
  for (const line of text.split('\n')) {
    const m = /^([0-9A-F]+) ;\t([0-9A-F ]+?) ;\tMA/.exec(line);
    if (!m) continue;
    const source = String.fromCodePoint(parseInt(m[1] as string, 16));
    const target = (m[2] as string)
      .split(' ')
      .map((h) => String.fromCodePoint(parseInt(h, 16)))
      .join('');
    if (!/^[\p{L}\p{N}]$/u.test(source)) continue;
    const key = fold(source);
    const latin = fold(target);
    if ([...key].length !== 1 || !/^[\p{L}\p{N}]$/u.test(key) || /^[a-z]$/.test(key)) continue;
    if (!/^[a-z]$/.test(latin)) continue;
    const list = byLatin.get(latin) ?? [];
    list.push(source.codePointAt(0) as number);
    byLatin.set(latin, list);
    kept++;
  }
  const lines = [...byLatin.keys()].sort().map((latin) => {
    const cps = (byLatin.get(latin) as number[]).sort((a, b) => a - b);
    const chunks: string[] = [];
    for (let i = 0; i < cps.length; i += 12) chunks.push(`'${cps.slice(i, i + 12).map((cp) => `\\u{${hex(cp)}}`).join('')}'`);
    return `  ${latin}:\n    ${chunks.join(' +\n    ')},`;
  });
  const sha = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  const source = `// ============================================================================
// GENERATED from Unicode confusables.txt (UTS #39, version ${version}, ${date};
// sha256 ${sha}). Do not edit by hand.
//
// For each Latin letter a-z, the letters and digits that confusables.txt maps
// to it (its skeleton prototype): Cyrillic, Greek, Armenian, Cherokee, Latin
// variants and more. Kept: a single source letter or digit whose fold (NFKD,
// full case fold, NFKD, combining marks and ignorables removed; render.ts) is
// one letter or digit that is not already a-z, and whose prototype folds to
// one letter a-z. ${kept} entries.
//
// © Unicode, Inc. Used under the Unicode License v3
// (https://www.unicode.org/license.txt).
// ============================================================================
export const LOOKALIKES: Readonly<Record<string, string>> = {
${lines.join('\n')}
};
`;
  return source;
}

/** The command: 0 done (or up to date), 1 the committed table differs, 2 a usage error. */
export function main(argv: readonly string[], { root, log }: { root: string; log: (line: string) => void }): number {
  let check = false;
  let out = path.join(root, PINNED.table);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--out' && argv[i + 1] !== undefined) out = path.resolve(argv[++i] as string);
    else {
      log('usage: node scripts/confusables-gen.ts [--check] [--out <file>]');
      return 2;
    }
  }
  const source = generate(readPinned(readFileSync(path.join(root, PINNED.file))));
  const kept = /(\d+) entries\./.exec(source)?.[1];
  if (check) {
    const same = Buffer.from(source).equals(readFileSync(out));
    log(same ? `${out} is up to date (${kept} entries)` : `${out} differs from what confusables.txt ${PINNED.version} generates`);
    return same ? 0 : 1;
  }
  writeFileSync(out, source);
  log(`wrote ${out}: confusables.txt ${PINNED.version}, ${kept} entries`);
  return 0;
}

// The command line itself; the test also runs it as a child process.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), { root: path.resolve(import.meta.dirname, '..'), log: (line) => console.log(line) });
}
