// ============================================================================
// UNTRUSTED-PDF-GATE (NEEDS.md, "UNTRUSTED-PDF-GATE"): no untrusted PDF may reach the parser until
// (1) the engine runs as a sidecar with its own uid and no secrets and (2) the redaction output gate
// is re-run outside the engine on every copy. Until then the only PDFs parsed are the issue loader's,
// which Ross runs by hand. This static test, part of the normal API suite (a required check), fails
// when that could change without the two pieces:
//
//   (a) storeOriginal is referenced anywhere in src/ but its definition (pdf/store.ts) and the issue
//       loader (load/load.ts), or pdf_original_put anywhere in src/ but pdf/store.ts;
//   (b) a migration grants EXECUTE on pdf_original_put (by name, through ALL FUNCTIONS or ROUTINES,
//       through default privileges, or by granting a role that holds it) to any role but today's: nwfl;
//   (c) a request message (an RPC's input) under proto/ carries a bytes field, directly or in a nested
//       message, except the frozen exemptions below;
//   (d) UNTRUSTED_PDF_READY (src/pdf/untrusted.ts) is true while either test file its comment names
//       is missing. When it is true and both exist, (a) to (c) are lifted: those tests then guard the
//       parser instead, and they run in this same suite.
//
// Comments are ignored (a comment naming pdf_original_put is not a call); string literals are not
// (SQL lives in them).
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNTRUSTED_PDF_READY } from '../../src/pdf/untrusted.js';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEE = 'see NEEDS UNTRUSTED-PDF-GATE';
const violation = (reason: string, where: string): string => `UNTRUSTED-PDF-GATE: ${reason} at ${where}; ${SEE}`;

/** Today's grantees of EXECUTE on pdf_original_put (0015:297). Frozen: a new one needs the gate lifted. */
const PUT_GRANTEES = new Set(['nwfl']);
/** Bytes fields a request may carry, by full name, and why none can hold a PDF. Frozen. */
const REQUEST_BYTES_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['nwfl.mensa.v1.ApproveRequest.content_hash', 'the sha256 the approver saw; the handler compares it with the stored hash (content/workflow.ts)'],
]);
const STORE_DEFINITION = 'src/pdf/store.ts';
const LOADER = 'src/load/load.ts';
const READY_FILE = 'src/pdf/untrusted.ts';

// --- helpers ---------------------------------------------------------------

/** The source with comments blanked to spaces (newlines kept), so offsets still give the right line. */
export function stripComments(source: string, kind: 'ts' | 'sql'): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const ch = source[i] as string;
    if ((kind === 'ts' && two === '//') || (kind === 'sql' && two === '--')) {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || (kind === 'ts' && ch === '`')) {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' && kind === 'ts' ? 2 : 1;
      i = j + 1;
    } else i += 1;
  }
  return out.join('');
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

function filesUnder(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, suffix);
    return entry.name.endsWith(suffix) ? [full] : [];
  });
}

// --- (a) who stores an original ----------------------------------------------

export function storeCallers(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const found: string[] = [];
  for (const { file, source } of files) {
    const code = stripComments(source, 'ts');
    for (const match of code.matchAll(/\bstoreOriginal\b/g)) {
      if (file !== STORE_DEFINITION && file !== LOADER) {
        found.push(violation('storeOriginal is referenced outside the issue loader (only src/load/load.ts may store an original)', `${file}:${lineOf(code, match.index)}`));
      }
    }
    for (const match of code.matchAll(/\bpdf_original_put\b/g)) {
      if (file !== STORE_DEFINITION) found.push(violation('pdf_original_put is called outside src/pdf/store.ts (storeOriginal is the one way in)', `${file}:${lineOf(code, match.index)}`));
    }
    for (const match of code.matchAll(/\bexport\s*\*\s*from\s*['"][^'"]*\bstore\.js['"]/g)) {
      found.push(violation('a module re-exports all of pdf/store.js, which would hand out storeOriginal under no name', `${file}:${lineOf(code, match.index)}`));
    }
  }
  return found;
}

// --- (b) who may execute pdf_original_put --------------------------------------

const grantees = (list: string): string[] =>
  list
    .replace(/\bWITH\s+GRANT\s+OPTION\b[\s\S]*$/i, '')
    .replace(/\bGRANTED\s+BY\b[\s\S]*$/i, '')
    .split(',')
    .map((role) => role.trim().replace(/^GROUP\s+/i, '').replace(/^"|"$/g, '').toLowerCase())
    .filter((role) => role !== '');

export function putGrants(migrations: ReadonlyArray<{ file: string; source: string }>): string[] {
  const found: string[] = [];
  for (const { file, source } of migrations) {
    const sql = stripComments(source, 'sql');
    // Statements end at ';' everywhere, function bodies included, so a GRANT inside a DO block or a
    // grants function (0017's nwfl_worker_grants) is read too.
    let start = 0;
    for (const statement of sql.split(';')) {
      const at = statement.search(/\bGRANT\b/i);
      if (at !== -1) {
        const grant = statement.slice(at).replace(/\s+/g, ' ').trim();
        const where = `${file}:${lineOf(sql, start + at)}`;
        const defaults = /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(statement.slice(0, at));
        const privilege = /^GRANT (.+?) ON (.+?) TO (.+)$/i.exec(grant);
        const membership = /^GRANT (.+?) TO (.+)$/i.exec(grant);
        if (privilege !== null) {
          const [, privileges, target, to] = privilege as unknown as [string, string, string, string];
          const executes = /\b(EXECUTE|ALL)\b/i.test(privileges);
          const covers = /\bpdf_original_put\b/i.test(target) || /\bALL\s+(FUNCTIONS|ROUTINES|PROCEDURES)\b/i.test(target) || (defaults && /^(FUNCTIONS|ROUTINES)\b/i.test(target.trim()));
          if (executes && covers) {
            for (const role of grantees(to)) {
              if (!PUT_GRANTEES.has(role)) found.push(violation(`a migration grants EXECUTE on pdf_original_put to ${role} (allowed: ${[...PUT_GRANTEES].join(', ')})`, where));
            }
          }
        } else if (membership !== null) {
          const [, roles, to] = membership as unknown as [string, string, string];
          const held = grantees(roles).filter((role) => PUT_GRANTEES.has(role));
          for (const role of held) {
            for (const member of grantees(to)) found.push(violation(`a migration grants the role ${role}, and with it EXECUTE on pdf_original_put, to ${member}`, where));
          }
        }
      }
      start += statement.length + 1;
    }
  }
  return found;
}

// --- (c) no request message carries bytes ------------------------------------

interface FieldJson { name: string; type: string; typeName?: string }
interface MessageJson { name: string; field?: FieldJson[]; nestedType?: MessageJson[] }
interface FileJson {
  name: string;
  package?: string;
  messageType?: MessageJson[];
  service?: Array<{ name: string; method: Array<{ name: string; inputType: string }> }>;
  sourceCodeInfo?: { location?: Array<{ path?: number[]; span: number[] }> };
}

export function requestBytes(set: { file: FileJson[] }): string[] {
  const messages = new Map<string, { message: MessageJson; file: FileJson; path: number[] }>();
  const index = (scope: string, message: MessageJson, file: FileJson, at: number[]): void => {
    const name = `${scope}.${message.name}`;
    messages.set(name, { message, file, path: at });
    (message.nestedType ?? []).forEach((nested, k) => index(name, nested, file, [...at, 3, k]));
  };
  for (const file of set.file) (file.messageType ?? []).forEach((message, k) => index(file.package === undefined ? '' : `.${file.package}`, message, file, [4, k]));
  const lineFor = (file: FileJson, at: number[]): number => {
    const location = file.sourceCodeInfo?.location?.find((loc) => loc.path?.join(',') === at.join(','));
    return location === undefined ? 0 : (location.span[0] as number) + 1;
  };
  const found: string[] = [];
  const reported = new Set<string>();
  const visit = (typeName: string, rpc: string, trail: string[], seen: Set<string>): void => {
    if (seen.has(typeName)) return;
    seen.add(typeName);
    const entry = messages.get(typeName);
    if (entry === undefined) return;
    (entry.message.field ?? []).forEach((field, k) => {
      const full = `${typeName.slice(1)}.${field.name}`;
      if (field.type === 'TYPE_BYTES' && !REQUEST_BYTES_EXEMPT.has(full) && !reported.has(`${rpc} ${full}`)) {
        reported.add(`${rpc} ${full}`);
        found.push(violation(`request message ${trail[0]} (input of ${rpc}) carries a bytes field (${[...trail.slice(1), field.name].join('.')})`, `proto/${entry.file.name}:${lineFor(entry.file, [...entry.path, 2, k])}`));
      }
      if (field.type === 'TYPE_MESSAGE' && field.typeName !== undefined) visit(field.typeName, rpc, [...trail, field.name], seen);
    });
  };
  for (const file of set.file) {
    for (const service of file.service ?? []) {
      for (const method of service.method) visit(method.inputType, `${service.name}.${method.name}`, [method.inputType.slice(1)], new Set());
    }
  }
  return found;
}

// --- (d) the lift condition ---------------------------------------------------

export function liftState(source: string, exists: (file: string) => boolean): { lifted: boolean; problems: string[] } {
  const code = stripComments(source, 'ts');
  const flag = /export const UNTRUSTED_PDF_READY\s*(?::\s*boolean\s*)?=\s*(true|false)\s*;/.exec(code);
  if (flag === null) return { lifted: false, problems: [violation('UNTRUSTED_PDF_READY is not a plain true or false constant', `${READY_FILE}:1`)] };
  const where = `${READY_FILE}:${lineOf(code, flag.index)}`;
  const named = (label: string): string | undefined => new RegExp(`${label}:\\s*(\\S+\\.test\\.ts)`).exec(source)?.[1];
  const tests = { 'sidecar test': named('sidecar test'), 'out-of-child gate re-run test': named('gate re-run test') };
  const problems: string[] = [];
  for (const [label, file] of Object.entries(tests)) {
    if (file === undefined) problems.push(violation(`the comment on UNTRUSTED_PDF_READY must name the ${label} file`, where));
    else if (flag[1] === 'true' && !exists(file)) problems.push(violation(`UNTRUSTED_PDF_READY is true but the ${label} ${file} does not exist`, where));
  }
  return { lifted: flag[1] === 'true' && problems.length === 0, problems };
}

// --- the gate ------------------------------------------------------------------

const rel = (full: string): string => path.relative(API, full).split(path.sep).join('/');

function readTree(dir: string, suffix: string, skip: (file: string) => boolean = () => false): Array<{ file: string; source: string }> {
  return filesUnder(path.join(API, dir), suffix)
    .map((full) => ({ file: rel(full), source: readFileSync(full, 'utf8') }))
    .filter(({ file }) => !skip(file));
}

function descriptors(): { file: FileJson[] } {
  const out = execFileSync(path.join(API, 'node_modules/.bin/buf'), ['build', '-o', '-#format=json'], { cwd: API, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(out) as { file: FileJson[] };
}

function failOn(problems: string[]): void {
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

describe('UNTRUSTED-PDF-GATE', () => {
  it('no untrusted PDF can reach the parser until the engine sidecar and the out-of-child gate re-run exist', () => {
    const ready = readFileSync(path.join(API, READY_FILE), 'utf8');
    const lift = liftState(ready, (file) => existsSync(path.join(API, file)));
    expect(lift.lifted || !UNTRUSTED_PDF_READY || lift.problems.length > 0).toBe(true);
    const problems = [...lift.problems];
    if (!lift.lifted) {
      problems.push(...storeCallers(readTree('src', '.ts', (file) => file.endsWith('.test.ts'))));
      problems.push(...putGrants(readTree('migrations', '.sql')));
      problems.push(...requestBytes(descriptors()));
    }
    failOn(problems);
  });
});

describe('UNTRUSTED-PDF-GATE: each check catches what it guards', () => {
  it('(a) flags a new caller of storeOriginal or pdf_original_put, and not a comment or the two allowed files', () => {
    const files = [
      { file: STORE_DEFINITION, source: 'export async function storeOriginal() { await db.query(`SELECT pdf_original_put($1)`); }' },
      { file: LOADER, source: "import { storeOriginal } from '../pdf/store.js';\nawait storeOriginal(client, x);" },
      { file: 'src/ledger/ledger.ts', source: '// pdf_original_put stores only bytes whose sha256 is the file\'s\n/* storeOriginal */ const u = "http://x//y";' },
      { file: 'src/content/upload.ts', source: "import { storeOriginal } from '../pdf/store.js';\n\nawait storeOriginal(db, input);" },
      { file: 'src/content/raw.ts', source: 'await db.query(`SELECT pdf_original_put($1, $2)`);' },
      { file: 'src/content/barrel.ts', source: "export * from '../pdf/store.js';" },
    ];
    expect(storeCallers(files)).toEqual([
      violation('storeOriginal is referenced outside the issue loader (only src/load/load.ts may store an original)', 'src/content/upload.ts:1'),
      violation('storeOriginal is referenced outside the issue loader (only src/load/load.ts may store an original)', 'src/content/upload.ts:3'),
      violation('pdf_original_put is called outside src/pdf/store.ts (storeOriginal is the one way in)', 'src/content/raw.ts:1'),
      violation('a module re-exports all of pdf/store.js, which would hand out storeOriginal under no name', 'src/content/barrel.ts:1'),
    ]);
  });

  it('(b) flags EXECUTE on pdf_original_put for any role but nwfl, however it is granted', () => {
    const sql = [
      '-- GRANT EXECUTE ON FUNCTION pdf_original_put(uuid, bytea, text, text[], text) TO nwfl_worker;',
      'GRANT EXECUTE ON FUNCTION pdf_file_items(uuid), pdf_original_put(uuid, bytea, text, text[], text) TO nwfl;',
      'GRANT EXECUTE ON FUNCTION pdf_original_put(uuid, bytea, text, text[], text) TO nwfl_worker, "nwfl";',
      'CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN',
      '  GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO nwfl_uploader WITH GRANT OPTION;',
      'END $fn$;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
      'GRANT nwfl TO nwfl_importer;',
      'GRANT SELECT ON tenant TO nwfl_worker;',
      'GRANT EXECUTE ON FUNCTION pdf_copy_put(uuid) TO nwfl_worker;',
    ].join('\n');
    expect(putGrants([{ file: 'migrations/0099_x.sql', source: sql }])).toEqual([
      violation('a migration grants EXECUTE on pdf_original_put to nwfl_worker (allowed: nwfl)', 'migrations/0099_x.sql:3'),
      violation('a migration grants EXECUTE on pdf_original_put to nwfl_uploader (allowed: nwfl)', 'migrations/0099_x.sql:5'),
      violation('a migration grants EXECUTE on pdf_original_put to public (allowed: nwfl)', 'migrations/0099_x.sql:7'),
      violation('a migration grants the role nwfl, and with it EXECUTE on pdf_original_put, to nwfl_importer', 'migrations/0099_x.sql:9'),
    ]);
  });

  it('(c) flags a bytes field in a request message, nested or direct, and not in a response or an exempt field', () => {
    const at = (path: number[], line: number) => ({ path, span: [line - 1, 0, 10] });
    const set = {
      file: [
        {
          name: 'nwfl/mensa/v1/x.proto',
          package: 'nwfl.mensa.v1',
          messageType: [
            { name: 'UploadRequest', field: [{ name: 'id', type: 'TYPE_STRING' }, { name: 'part', type: 'TYPE_MESSAGE', typeName: '.nwfl.mensa.v1.UploadRequest.Part' }], nestedType: [{ name: 'Part', field: [{ name: 'blob', type: 'TYPE_BYTES' }] }] },
            { name: 'PutRequest', field: [{ name: 'pdf', type: 'TYPE_BYTES' }, { name: 'self', type: 'TYPE_MESSAGE', typeName: '.nwfl.mensa.v1.PutRequest' }] },
            { name: 'GetResponse', field: [{ name: 'pdf', type: 'TYPE_BYTES' }] },
            { name: 'ApproveRequest', field: [{ name: 'content_hash', type: 'TYPE_BYTES' }] },
          ],
          service: [{ name: 'S', method: [{ name: 'Upload', inputType: '.nwfl.mensa.v1.UploadRequest' }, { name: 'Put', inputType: '.nwfl.mensa.v1.PutRequest' }, { name: 'Approve', inputType: '.nwfl.mensa.v1.ApproveRequest' }, { name: 'Ext', inputType: '.google.protobuf.Empty' }] }],
          sourceCodeInfo: { location: [at([4, 0, 3, 0, 2, 0], 7), at([4, 1, 2, 0], 12)] },
        },
      ],
    };
    expect(requestBytes(set)).toEqual([
      violation('request message nwfl.mensa.v1.UploadRequest (input of S.Upload) carries a bytes field (part.blob)', 'proto/nwfl/mensa/v1/x.proto:7'),
      violation('request message nwfl.mensa.v1.PutRequest (input of S.Put) carries a bytes field (pdf)', 'proto/nwfl/mensa/v1/x.proto:12'),
    ]);
  });

  it('(d) refuses UNTRUSTED_PDF_READY = true without both named test files, and lifts only with both', () => {
    const today = readFileSync(path.join(API, READY_FILE), 'utf8');
    expect(liftState(today, () => false)).toEqual({ lifted: false, problems: [] });
    const flipped = today.replace(/(export const UNTRUSTED_PDF_READY\s*(?::\s*boolean\s*)?=\s*)false/, '$1true');
    expect(flipped).not.toBe(today);
    const missing = liftState(flipped, () => false);
    expect(missing.lifted).toBe(false);
    expect(missing.problems).toHaveLength(2);
    expect(missing.problems[0]).toMatch(/^UNTRUSTED-PDF-GATE: UNTRUSTED_PDF_READY is true but the sidecar test \S+\.test\.ts does not exist at src\/pdf\/untrusted\.ts:\d+; see NEEDS UNTRUSTED-PDF-GATE$/);
    expect(liftState(flipped, (file) => file.includes('sidecar')).problems).toHaveLength(1);
    expect(liftState(flipped, () => true)).toEqual({ lifted: true, problems: [] });
    expect(liftState('export const UNTRUSTED_PDF_READY = process.env.X === "1";', () => true).problems).toEqual([
      violation('UNTRUSTED_PDF_READY is not a plain true or false constant', 'src/pdf/untrusted.ts:1'),
    ]);
    expect(liftState('export const UNTRUSTED_PDF_READY = true;', () => true).problems).toEqual([
      violation('the comment on UNTRUSTED_PDF_READY must name the sidecar test file', 'src/pdf/untrusted.ts:1'),
      violation('the comment on UNTRUSTED_PDF_READY must name the out-of-child gate re-run test file', 'src/pdf/untrusted.ts:1'),
    ]);
  });
});
