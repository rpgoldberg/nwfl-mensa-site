// ============================================================================
// UNTRUSTED-PDF-GATE (NEEDS.md, "UNTRUSTED-PDF-GATE"): no untrusted PDF may reach the parser until
// (1) the engine runs as a sidecar with its own uid and no secrets and (2) the redaction output gate
// is re-run outside the engine on every copy. Until then the only PDFs parsed are the issue loader's,
// which Ross runs by hand. This static test, part of the normal API suite (a required check), is the
// fast first line; untrusted-pdf-catalog.test.ts is the backstop on a migrated database. It aims at
// accidental and lazy paths, so it reads plainly and freezes what it cannot judge:
//
//   (a) the source (src/, every .ts .mts .cts .js .mjs .cjs but tests; comments count too):
//       - storeOriginal and any word holding original_put appear only in pdf/store.ts and load/load.ts;
//       - any other word holding pdf_original appears only in src/pdf/ or as frozen in PDF_ORIGINAL_SEEN;
//       - pdf/store is imported (statically, dynamically, by require, or named in any string) only by
//         the frozen STORE_IMPORTERS, never as a namespace or default import;
//       - no import() or require() takes anything but a plain string, so no path is built at run time.
//   (b) the migrations, read as text with nothing blanked: EXECUTE on pdf_original_put, any write on
//       pdf_original, or membership in nwfl, granted to a role beyond today's; an owner change on
//       either. A grant built at run time, or one the text misses, fails the catalog test instead.
//   (c) the protos: no RPC request carries a bytes field, nested or not, but the frozen exemptions;
//       and every RPC's request tree (each field's name, number, type and label, recursively) matches
//       the committed snapshot untrusted-pdf.requests.json, so any new RPC or request field is reviewed.
//   (d) the lift: UNTRUSTED_PDF_READY (src/pdf/untrusted.ts) may be true only when both LIFT_TESTS
//       exist, each with a real, unskipped test under its pinned title. Then (a), (b) and the bytes
//       rule are lifted; the snapshot and the catalog are not (a change there is still reviewed).
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNTRUSTED_PDF_READY } from '../../src/pdf/untrusted.js';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEE = 'see NEEDS UNTRUSTED-PDF-GATE';
const violation = (reason: string, where: string): string => `UNTRUSTED-PDF-GATE: ${reason} at ${where}; ${SEE}`;

// --- frozen and pinned -------------------------------------------------------

const STORE_DEFINITION = 'src/pdf/store.ts';
const LOADER = 'src/load/load.ts';
const READY_FILE = 'src/pdf/untrusted.ts';
const SNAPSHOT_FILE = 'test/gates/untrusted-pdf.requests.json';
const SOURCE_SUFFIXES = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** Modules that import pdf/store today, each for something other than storeOriginal. Frozen. */
const STORE_IMPORTERS = new Set([LOADER, 'src/content/files.ts', 'src/ledger/ledger.ts', 'src/pdf/regenerate.ts']);
/** Outside src/pdf, the words holding pdf_original each file uses today (reads only). Frozen. */
const PDF_ORIGINAL_SEEN: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'src/ledger/ledger.ts': { pdf_original: 2 },
  'src/redaction/file-marks.ts': { pdf_original: 1, pdf_original_read: 1 },
};
/** Today's grantees (0015:297 EXECUTE on pdf_original_put; nobody writes pdf_original or joins nwfl). */
const PUT_GRANTEES = new Set(['nwfl']);
/** Bytes fields a request may carry, by full name, and why none can hold a PDF. Frozen. */
const REQUEST_BYTES_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['nwfl.mensa.v1.ApproveRequest.content_hash', 'the sha256 the approver saw; the handler compares it with the stored hash (content/workflow.ts)'],
]);
/** The two tests that lift the gate, pinned HERE (not in untrusted.ts), each with the title one real test must start with. */
export const LIFT_TESTS = [
  { label: 'sidecar test', file: 'test/pdf/engine-sidecar.test.ts', title: 'UNTRUSTED-PDF-GATE sidecar:' },
  { label: 'out-of-child gate re-run test', file: 'test/pdf/gate-rerun.test.ts', title: 'UNTRUSTED-PDF-GATE gate re-run:' },
] as const;

// --- helpers ---------------------------------------------------------------

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;
const rel = (full: string): string => path.relative(API, full).split(path.sep).join('/');

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, keep);
    return keep(entry.name) ? [full] : [];
  });
}

const isSource = (name: string): boolean => SOURCE_SUFFIXES.some((suffix) => name.endsWith(suffix)) && !/\.test\.[cm]?[jt]s$/.test(name) && !name.endsWith('.d.ts');

/** Where a module specifier points, without its extension, relative to apps/api; undefined for a package. */
function target(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.[cm]?[jt]s$/, '');
}

// --- (a) the source ------------------------------------------------------------

export function sourceProblems(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const found: string[] = [];
  for (const { file, source } of files) {
    const at = (offset: number): string => `${file}:${lineOf(source, offset)}`;
    const mayStore = file === STORE_DEFINITION || file === LOADER;
    for (const match of source.matchAll(/\w*(?:storeOriginal|original_put)\w*/g)) {
      if (!mayStore) found.push(violation(`${match[0]} appears outside the issue loader and pdf/store.ts (only src/load/load.ts may store an original)`, at(match.index)));
    }
    if (!mayStore && !file.startsWith('src/pdf/')) {
      const seen: Record<string, number> = {};
      const first: Record<string, number> = {};
      for (const match of source.matchAll(/\w*pdf_original\w*/g)) {
        if (match[0].includes('original_put')) continue;
        seen[match[0]] = (seen[match[0]] ?? 0) + 1;
        first[match[0]] ??= match.index;
      }
      const frozen = PDF_ORIGINAL_SEEN[file] ?? {};
      for (const word of new Set([...Object.keys(seen), ...Object.keys(frozen)])) {
        if ((seen[word] ?? 0) !== (frozen[word] ?? 0)) {
          found.push(violation(`${word} appears ${seen[word] ?? 0} times in ${file}, frozen at ${frozen[word] ?? 0}; a new use of the originals is reviewed against the gate, then PDF_ORIGINAL_SEEN is updated`, at(first[word] ?? 0)));
        }
      }
    }
    // Every module specifier: import/export ... from '...', import '...', import('...'), require('...').
    const specifiers = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]*)\1/g;
    for (const match of source.matchAll(specifiers)) {
      const spec = match[2] as string;
      if (target(file, spec) !== 'src/pdf/store' && !spec.includes('pdf/store')) continue;
      if (file === STORE_DEFINITION) continue;
      if (!STORE_IMPORTERS.has(file)) {
        found.push(violation(`${file} imports pdf/store, and only the frozen STORE_IMPORTERS may`, at(match.index)));
        continue;
      }
      const statement = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index);
      if (/\bimport\s*\*|\bexport\s*\*|\bimport\s+[\w$]+\s*(?:,|from\b)|\bimport\s*\(|\brequire\s*\(/.test(statement + match[0].slice(0, 9))) {
        found.push(violation('pdf/store is imported whole (a namespace, default, dynamic or require import), which hands out storeOriginal under another name', at(match.index)));
      }
    }
    for (const match of source.matchAll(/['"`][^'"`\n]*pdf\/store[^'"`\n]*['"`]/g)) {
      if (!STORE_IMPORTERS.has(file) && file !== STORE_DEFINITION && !found.some((line) => line.includes(`at ${at(match.index)};`))) {
        found.push(violation('a string names pdf/store outside the frozen STORE_IMPORTERS', at(match.index)));
      }
    }
    for (const match of source.matchAll(/\b(import|require)\s*\(\s*(?!(['"])[^'"`$+]*\2\s*\))/g)) {
      found.push(violation(`${match[1]}() takes something other than a plain string, so its path could be built at run time`, at(match.index)));
    }
  }
  return found;
}

// --- (b) the migrations, as text ---------------------------------------------

const roleList = (list: string): string[] =>
  list
    .replace(/\bWITH\s+(?:GRANT|ADMIN|INHERIT|SET)\s+(?:OPTION|TRUE|FALSE)\b[\s\S]*$/i, '')
    .replace(/\bGRANTED\s+BY\b[\s\S]*$/i, '')
    .split(',')
    .map((role) => role.trim().replace(/^GROUP\s+/i, '').replace(/['"()]/g, '').trim().toLowerCase())
    .filter((role) => role !== '');

export function migrationProblems(migrations: ReadonlyArray<{ file: string; source: string }>): string[] {
  const found: string[] = [];
  for (const { file, source } of migrations) {
    // Nothing is blanked: a GRANT in a comment or a string is read too (a false alarm is cheap). Each
    // statement runs from its keyword to the next ';', wherever it sits (DO blocks, function bodies).
    const statements = source.matchAll(/\b(GRANT|CREATE\s+ROLE|CREATE\s+USER|CREATE\s+GROUP|ALTER\s+GROUP|ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE|TABLE)|ALTER\s+DEFAULT\s+PRIVILEGES)\b[^;]*/gi);
    for (const match of statements) {
      const statement = match[0].replace(/\s+/g, ' ').trim();
      const where = `${file}:${lineOf(source, match.index)}`;
      const bad = (reason: string): void => void found.push(violation(reason, where));
      const keyword = (match[1] as string).replace(/\s+/g, ' ').toUpperCase();
      if (keyword === 'ALTER DEFAULT PRIVILEGES') {
        const grant = /\bGRANT (.+?) ON (FUNCTIONS|ROUTINES|TABLES) TO (.+)$/i.exec(statement);
        if (grant !== null && /\b(EXECUTE|ALL|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(grant[1] as string)) {
          for (const role of roleList(grant[3] as string)) if (!PUT_GRANTEES.has(role)) bad(`a migration grants ${grant[1] as string} on future ${(grant[2] as string).toLowerCase()} to ${role} by default privileges, which would cover a re-created pdf_original_put or pdf_original`);
        }
        continue;
      }
      if (keyword === 'GRANT') {
        const privilege = /^GRANT (.+?) ON (.+?) TO (.+)$/i.exec(statement);
        if (privilege !== null) {
          const [, privileges, on, to] = privilege as unknown as [string, string, string, string];
          const put = /\bpdf_original_put\b/i.test(on) || /\bALL\s+(FUNCTIONS|ROUTINES|PROCEDURES)\b/i.test(on);
          const table = /(?:^|[\s,.])pdf_original(?![\w])/i.test(on) || /\bALL\s+TABLES\b/i.test(on);
          for (const role of roleList(to)) {
            if (PUT_GRANTEES.has(role) && !table) continue;
            if (put && /\b(EXECUTE|ALL)\b/i.test(privileges)) bad(`a migration grants EXECUTE on pdf_original_put to ${role} (allowed: ${[...PUT_GRANTEES].join(', ')})`);
            if (table && /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i.test(privileges)) bad(`a migration grants a write on pdf_original to ${role}`);
          }
          continue;
        }
        const membership = /^GRANT (.+?) TO (.+)$/i.exec(statement);
        if (membership !== null) {
          for (const role of roleList(membership[1] as string).filter((granted) => PUT_GRANTEES.has(granted))) {
            for (const member of roleList(membership[2] as string)) bad(`a migration grants the role ${role}, and with it EXECUTE on pdf_original_put, to ${member}`);
          }
        }
        continue;
      }
      if (/^(CREATE|ALTER) (ROLE|USER|GROUP)/.test(keyword)) {
        const joins = /\bIN\s+(?:ROLE|GROUP)\s+([^;]*)$/i.exec(statement);
        const adds = /^ALTER GROUP\s+"?(\w+)"?\s+ADD\s+USER\b/i.exec(statement);
        const into = [...(joins === null ? [] : roleList((joins[1] as string).split(/\s(?:ROLE|ADMIN|USER|PASSWORD|LOGIN|NOLOGIN|CONNECTION|VALID|INHERIT|NOINHERIT)\b/i)[0] as string)), ...(adds === null ? [] : [(adds[1] as string).toLowerCase()])];
        if (into.some((role) => PUT_GRANTEES.has(role))) bad('a migration makes a role a member of nwfl, which holds EXECUTE on pdf_original_put');
        continue;
      }
      if (/\bpdf_original(?:_put)?\b/i.test(statement) && /\bOWNER\s+TO\b/i.test(statement)) bad('a migration changes the owner of pdf_original or pdf_original_put');
    }
  }
  return found;
}

// --- (c) the protos -----------------------------------------------------------

interface FieldJson { name: string; number: number; type: string; label?: string; typeName?: string; oneofIndex?: number; proto3Optional?: boolean }
interface MessageJson { name: string; field?: FieldJson[]; nestedType?: MessageJson[] }
interface FileJson {
  name: string;
  package?: string;
  messageType?: MessageJson[];
  service?: Array<{ name: string; method: Array<{ name: string; inputType: string }> }>;
  sourceCodeInfo?: { location?: Array<{ path?: number[]; span: number[] }> };
}
interface Indexed { message: MessageJson; file: FileJson; path: number[] }
export interface FieldTree { name: string; number: number; type: string; label: string; message?: string; fields?: FieldTree[] | 'cycle' }
export type RequestSnapshot = Record<string, { input: string; fields: FieldTree[] }>;

function indexMessages(set: { file: FileJson[] }): Map<string, Indexed> {
  const messages = new Map<string, Indexed>();
  const index = (scope: string, message: MessageJson, file: FileJson, at: number[]): void => {
    const name = `${scope}.${message.name}`;
    messages.set(name, { message, file, path: at });
    (message.nestedType ?? []).forEach((nested, k) => index(name, nested, file, [...at, 3, k]));
  };
  for (const file of set.file) (file.messageType ?? []).forEach((message, k) => index(file.package === undefined ? '' : `.${file.package}`, message, file, [4, k]));
  return messages;
}

const lineFor = (file: FileJson, at: number[]): number => {
  const location = file.sourceCodeInfo?.location?.find((loc) => loc.path?.join(',') === at.join(','));
  return location === undefined ? 0 : (location.span[0] as number) + 1;
};

const rpcs = (set: { file: FileJson[] }): Array<{ rpc: string; input: string }> =>
  set.file.flatMap((file) => (file.service ?? []).flatMap((service) => service.method.map((method) => ({ rpc: `${service.name}.${method.name}`, input: method.inputType }))));

export function requestBytes(set: { file: FileJson[] }): string[] {
  const messages = indexMessages(set);
  const found: string[] = [];
  const visit = (typeName: string, rpc: string, trail: string[], seen: Set<string>): void => {
    if (seen.has(typeName)) return;
    seen.add(typeName);
    const entry = messages.get(typeName);
    if (entry === undefined) return;
    (entry.message.field ?? []).forEach((field, k) => {
      const full = `${typeName.slice(1)}.${field.name}`;
      if (field.type === 'TYPE_BYTES' && !REQUEST_BYTES_EXEMPT.has(full)) {
        found.push(violation(`request message ${trail[0] as string} (input of ${rpc}) carries a bytes field (${[...trail.slice(1), field.name].join('.')})`, `proto/${entry.file.name}:${lineFor(entry.file, [...entry.path, 2, k])}`));
      }
      if (field.type === 'TYPE_MESSAGE' && field.typeName !== undefined) visit(field.typeName, rpc, [...trail, field.name], seen);
    });
  };
  for (const { rpc, input } of rpcs(set)) visit(input, rpc, [input.slice(1)], new Set());
  return found;
}

export function requestSnapshot(set: { file: FileJson[] }): RequestSnapshot {
  const messages = indexMessages(set);
  const tree = (typeName: string, path: readonly string[]): FieldTree[] =>
    (messages.get(typeName)?.message.field ?? []).map((field) => {
      const node: FieldTree = {
        name: field.name,
        number: field.number,
        type: field.type.replace(/^TYPE_/, '').toLowerCase(),
        label: field.proto3Optional === true ? 'proto3_optional' : (field.label ?? 'LABEL_OPTIONAL').replace(/^LABEL_/, '').toLowerCase(),
      };
      if (field.typeName !== undefined) node.message = field.typeName.slice(1);
      if (field.type === 'TYPE_MESSAGE' && field.typeName !== undefined) {
        node.fields = path.includes(field.typeName) ? 'cycle' : tree(field.typeName, [...path, field.typeName]);
      }
      return node;
    });
  const snapshot: RequestSnapshot = {};
  for (const { rpc, input } of rpcs(set).sort((x, y) => x.rpc.localeCompare(y.rpc))) snapshot[rpc] = { input: input.slice(1), fields: tree(input, [input]) };
  return snapshot;
}

export function snapshotProblems(set: { file: FileJson[] }, frozen: RequestSnapshot): string[] {
  const actual = requestSnapshot(set);
  const messages = indexMessages(set);
  const found: string[] = [];
  const update = `review it against UNTRUSTED-PDF-GATE, then update ${SNAPSHOT_FILE} in the same PR (UPDATE_REQUEST_SNAPSHOT=1 npx vitest run test/gates/untrusted-pdf.test.ts)`;
  for (const rpc of [...new Set([...Object.keys(actual), ...Object.keys(frozen)])].sort()) {
    const now = actual[rpc];
    const then = frozen[rpc];
    if (JSON.stringify(now) === JSON.stringify(then)) continue;
    const entry = now === undefined ? undefined : messages.get(`.${now.input}`);
    const where = entry === undefined ? SNAPSHOT_FILE : `proto/${entry.file.name}:${lineFor(entry.file, entry.path)}`;
    const what = then === undefined ? 'is new' : now === undefined ? 'is gone' : 'has a changed request field tree';
    found.push(violation(`RPC ${rpc} ${what}; ${update}`, where));
  }
  return found;
}

// --- (d) the lift ----------------------------------------------------------------

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `source` holds a real test titled `title...`: no skip, todo, only or fails, and no condition but `!live`. */
export function hasRealTest(source: string, title: string): boolean {
  if (!new RegExp(`\\b(?:it|test)\\s*\\(\\s*(['"\`])${escape(title)}`).test(source)) return false;
  if (/\.(?:skip|todo|only|fails)\b|\bx(?:it|test|describe)\s*\(/.test(source)) return false;
  return [...source.matchAll(/\b(?:skipIf|runIf)\s*\(([^)]*)\)/g)].every((match) => (match[1] as string).trim() === '!live');
}

export function liftState(ready: string, read: (file: string) => string | undefined): { lifted: boolean; problems: string[] } {
  const flag = /export const UNTRUSTED_PDF_READY\s*(?::\s*boolean\s*)?=\s*(true|false)\s*;/.exec(ready);
  if (flag === null) return { lifted: false, problems: [violation('UNTRUSTED_PDF_READY is not a plain true or false constant', `${READY_FILE}:1`)] };
  const where = `${READY_FILE}:${lineOf(ready, flag.index)}`;
  const problems: string[] = [];
  for (const { label, file } of LIFT_TESTS) {
    if (!ready.includes(file)) problems.push(violation(`the comment on UNTRUSTED_PDF_READY must name the ${label} ${file}, as pinned in test/gates/untrusted-pdf.test.ts`, where));
  }
  if (flag[1] === 'true') {
    for (const { label, file, title } of LIFT_TESTS) {
      const source = read(file);
      if (source === undefined) problems.push(violation(`UNTRUSTED_PDF_READY is true but the ${label} ${file} does not exist`, where));
      else if (!hasRealTest(source, title)) problems.push(violation(`UNTRUSTED_PDF_READY is true but the ${label} ${file} has no real, unskipped test titled "${title} ..."`, where));
    }
  }
  return { lifted: flag[1] === 'true' && problems.length === 0, problems };
}

// --- the gate ------------------------------------------------------------------

function readTree(dir: string, keep: (name: string) => boolean): Array<{ file: string; source: string }> {
  return filesUnder(path.join(API, dir), keep).map((full) => ({ file: rel(full), source: readFileSync(full, 'utf8') }));
}

function descriptors(): { file: FileJson[] } {
  const out = execFileSync(path.join(API, 'node_modules/.bin/buf'), ['build', '-o', '-#format=json'], { cwd: API, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(out) as { file: FileJson[] };
}

function failOn(problems: string[]): void {
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

const readIfThere = (file: string): string | undefined => (existsSync(path.join(API, file)) ? readFileSync(path.join(API, file), 'utf8') : undefined);

describe('UNTRUSTED-PDF-GATE', () => {
  it('no untrusted PDF can reach the parser until the engine sidecar and the out-of-child gate re-run exist', () => {
    const lift = liftState(readFileSync(path.join(API, READY_FILE), 'utf8'), readIfThere);
    expect(lift.lifted || !UNTRUSTED_PDF_READY || lift.problems.length > 0).toBe(true);
    const set = descriptors();
    const problems = [...lift.problems];
    if (!lift.lifted) {
      problems.push(...sourceProblems(readTree('src', isSource)));
      problems.push(...migrationProblems(readTree('migrations', (name) => name.endsWith('.sql'))));
      problems.push(...requestBytes(set));
    }
    if (process.env['UPDATE_REQUEST_SNAPSHOT'] === '1' && process.env['CI'] !== 'true') {
      writeFileSync(path.join(API, SNAPSHOT_FILE), `${JSON.stringify(requestSnapshot(set), null, 2)}\n`);
    }
    problems.push(...snapshotProblems(set, JSON.parse(readFileSync(path.join(API, SNAPSHOT_FILE), 'utf8')) as RequestSnapshot));
    failOn(problems);
  });
});

describe('UNTRUSTED-PDF-GATE: each check catches what it guards', () => {
  const outside = 'storeOriginal appears outside the issue loader and pdf/store.ts (only src/load/load.ts may store an original)';

  it('(a) flags any mention, import or run-time path to the store outside the frozen places', () => {
    const files = [
      { file: STORE_DEFINITION, source: 'export async function storeOriginal() { await db.query(`SELECT pdf_original_put($1)`); }' },
      { file: LOADER, source: "import { storeOriginal } from '../pdf/store.js';\n// pdf_original_put\nawait storeOriginal(client, x);" },
      { file: 'src/pdf/regenerate.ts', source: "import { readCopy } from './store.js';\nconst q = `SELECT 1 FROM pdf_original`;" },
      { file: 'src/ledger/ledger.ts', source: 'const a = `pdf_original`;\nconst b = `JOIN pdf_original o`;\nconst re = /[/*]/;' },
      { file: 'src/redaction/file-marks.ts', source: '`SELECT pdf_original_read(f.id) FROM x JOIN pdf_original o`' },
      { file: 'src/content/upload.ts', source: "import { storeOriginal } from '../pdf/store.js';\n// storeOriginal\n" },
      { file: 'src/content/ns.ts', source: "import * as s from '../pdf/store.js';\nawait s['store' + 'Original'](db, x);" },
      { file: 'src/content/dyn.mts', source: "const m = await import('../pdf/' + 'store.js');" },
      { file: 'src/content/raw.cjs', source: "const name = 'pdf_' + 'original_put';\nrequire(`../pdf/${'store'}.js`);" },
      { file: 'src/content/str.ts', source: "const where = 'see ../pdf/store.js';" },
      { file: 'src/content/reads.ts', source: 'const q = `SELECT bytes FROM pdf_original`;' },
      { file: 'src/ledger/ledger2.ts', source: "import * as store from '../pdf/store.js';" },
    ];
    expect(sourceProblems(files)).toEqual([
      violation(outside, 'src/content/upload.ts:1'),
      violation(outside, 'src/content/upload.ts:2'),
      violation('src/content/upload.ts imports pdf/store, and only the frozen STORE_IMPORTERS may', 'src/content/upload.ts:1'),
      violation('src/content/ns.ts imports pdf/store, and only the frozen STORE_IMPORTERS may', 'src/content/ns.ts:1'),
      violation('import() takes something other than a plain string, so its path could be built at run time', 'src/content/dyn.mts:1'),
      violation('original_put appears outside the issue loader and pdf/store.ts (only src/load/load.ts may store an original)', 'src/content/raw.cjs:1'),
      violation('require() takes something other than a plain string, so its path could be built at run time', 'src/content/raw.cjs:2'),
      violation('a string names pdf/store outside the frozen STORE_IMPORTERS', 'src/content/str.ts:1'),
      violation('pdf_original appears 1 times in src/content/reads.ts, frozen at 0; a new use of the originals is reviewed against the gate, then PDF_ORIGINAL_SEEN is updated', 'src/content/reads.ts:1'),
      violation('src/ledger/ledger2.ts imports pdf/store, and only the frozen STORE_IMPORTERS may', 'src/ledger/ledger2.ts:1'),
    ]);
    // A frozen importer that imports the whole module still fails.
    expect(sourceProblems([{ file: 'src/content/files.ts', source: "import * as store from '../pdf/store.js';" }])).toEqual([
      violation('pdf/store is imported whole (a namespace, default, dynamic or require import), which hands out storeOriginal under another name', 'src/content/files.ts:1'),
    ]);
    expect(sourceProblems([{ file: 'src/content/files.ts', source: "import store from '../pdf/store.js';\nconst s = await import('../pdf/store.js');" }])).toHaveLength(2);
  });

  it('(b) flags grants, writes, memberships and owner changes for any role but today\'s, with nothing blanked', () => {
    const sql = [
      'GRANT EXECUTE ON FUNCTION pdf_file_items(uuid), pdf_original_put(uuid, bytea, text, text[], text) TO nwfl;',
      '-- GRANT EXECUTE ON FUNCTION pdf_original_put(uuid, bytea, text, text[], text) TO nwfl_worker;',
      "SELECT $q$--$q$, 1; GRANT EXECUTE ON FUNCTION pdf_original_put(uuid, bytea, text, text[], text) TO nwfl_worker;",
      'GRANT INSERT (bytes) ON pdf_original TO nwfl;',
      'CREATE ROLE sneaky IN ROLE nwfl;',
      'ALTER GROUP nwfl ADD USER nwfl_worker;',
      'ALTER FUNCTION pdf_original_put(uuid, bytea, text, text[], text) OWNER TO nwfl;',
      "DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION pdf_original_put(uuid, bytea, text, text[], text) TO %I', 'x'); END $$;",
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
      'GRANT nwfl TO nwfl_importer;',
      'GRANT SELECT ON tenant TO nwfl_worker;',
      'GRANT EXECUTE ON FUNCTION pdf_copy_put(uuid) TO nwfl_worker;',
    ].join('\n');
    const at = (line: number): string => `migrations/0099_x.sql:${line}`;
    expect(migrationProblems([{ file: 'migrations/0099_x.sql', source: sql }])).toEqual([
      violation('a migration grants EXECUTE on pdf_original_put to nwfl_worker (allowed: nwfl)', at(2)),
      violation('a migration grants EXECUTE on pdf_original_put to nwfl_worker (allowed: nwfl)', at(3)),
      violation('a migration grants a write on pdf_original to nwfl', at(4)),
      violation('a migration makes a role a member of nwfl, which holds EXECUTE on pdf_original_put', at(5)),
      violation('a migration makes a role a member of nwfl, which holds EXECUTE on pdf_original_put', at(6)),
      violation('a migration changes the owner of pdf_original or pdf_original_put', at(7)),
      violation('a migration grants EXECUTE on pdf_original_put to %i (allowed: nwfl)', at(8)),
      violation('a migration grants EXECUTE on pdf_original_put to x (allowed: nwfl)', at(8)),
      violation('a migration grants EXECUTE on future functions to public by default privileges, which would cover a re-created pdf_original_put or pdf_original', at(9)),
      violation('a migration grants the role nwfl, and with it EXECUTE on pdf_original_put, to nwfl_importer', at(11)),
    ]);
  });

  const at = (path: number[], line: number) => ({ path, span: [line - 1, 0, 10] });
  const fixtureSet = (extra: FieldJson[] = []): { file: FileJson[] } => ({
    file: [
      {
        name: 'nwfl/mensa/v1/x.proto',
        package: 'nwfl.mensa.v1',
        messageType: [
          {
            name: 'UploadRequest',
            field: [{ name: 'id', number: 1, type: 'TYPE_STRING' }, { name: 'part', number: 2, type: 'TYPE_MESSAGE', typeName: '.nwfl.mensa.v1.UploadRequest.Part' }, ...extra],
            nestedType: [{ name: 'Part', field: [{ name: 'blob', number: 1, type: 'TYPE_BYTES' }] }],
          },
          { name: 'PutRequest', field: [{ name: 'pdf', number: 1, type: 'TYPE_BYTES' }, { name: 'self', number: 2, type: 'TYPE_MESSAGE', typeName: '.nwfl.mensa.v1.PutRequest' }] },
          { name: 'GetResponse', field: [{ name: 'pdf', number: 1, type: 'TYPE_BYTES' }] },
          { name: 'ApproveRequest', field: [{ name: 'content_hash', number: 2, type: 'TYPE_BYTES' }] },
        ],
        service: [{ name: 'S', method: [{ name: 'Upload', inputType: '.nwfl.mensa.v1.UploadRequest' }, { name: 'Put', inputType: '.nwfl.mensa.v1.PutRequest' }, { name: 'Approve', inputType: '.nwfl.mensa.v1.ApproveRequest' }, { name: 'Ext', inputType: '.google.protobuf.Empty' }] }],
        sourceCodeInfo: { location: [at([4, 0], 3), at([4, 0, 3, 0, 2, 0], 7), at([4, 1, 2, 0], 12)] },
      },
    ],
  });

  it('(c) flags a bytes field in a request message, nested or direct, and not in a response or an exempt field', () => {
    expect(requestBytes(fixtureSet())).toEqual([
      violation('request message nwfl.mensa.v1.UploadRequest (input of S.Upload) carries a bytes field (part.blob)', 'proto/nwfl/mensa/v1/x.proto:7'),
      violation('request message nwfl.mensa.v1.PutRequest (input of S.Put) carries a bytes field (pdf)', 'proto/nwfl/mensa/v1/x.proto:12'),
    ]);
  });

  it('(c) flags any change to a request field tree, a new RPC or a gone one, against the snapshot', () => {
    const frozen = requestSnapshot(fixtureSet());
    expect(snapshotProblems(fixtureSet(), frozen)).toEqual([]);
    expect(frozen['S.Put']?.fields[1]).toEqual({ name: 'self', number: 2, type: 'message', label: 'optional', message: 'nwfl.mensa.v1.PutRequest', fields: 'cycle' });
    const update = `review it against UNTRUSTED-PDF-GATE, then update ${SNAPSHOT_FILE} in the same PR (UPDATE_REQUEST_SNAPSHOT=1 npx vitest run test/gates/untrusted-pdf.test.ts)`;
    for (const extra of [
      { name: 'data', number: 3, type: 'TYPE_STRING' },
      { name: 'chunks', number: 3, type: 'TYPE_UINT32', label: 'LABEL_REPEATED' },
      { name: 'list', number: 3, type: 'TYPE_MESSAGE', typeName: '.google.protobuf.ListValue' },
    ]) {
      expect(snapshotProblems(fixtureSet([extra]), frozen)).toEqual([violation(`RPC S.Upload has a changed request field tree; ${update}`, 'proto/nwfl/mensa/v1/x.proto:3')]);
    }
    const without = Object.fromEntries(Object.entries(frozen).filter(([rpc]) => rpc !== 'S.Put'));
    expect(snapshotProblems(fixtureSet(), without)).toEqual([violation(`RPC S.Put is new; ${update}`, 'proto/nwfl/mensa/v1/x.proto:0')]);
    expect(snapshotProblems(fixtureSet(), { ...frozen, 'S.Gone': { input: 'x.Y', fields: [] } })).toEqual([violation(`RPC S.Gone is gone; ${update}`, SNAPSHOT_FILE)]);
  });

  describe('(d) the lift, on fixtures', () => {
    const comment = LIFT_TESTS.map(({ file }) => `//   ${file}`).join('\n');
    const ready = (value: string, names = comment): string => `${names}\nexport const UNTRUSTED_PDF_READY: boolean = ${value};\n`;
    const real = (title: string): string => `import { it } from 'vitest';\nit('${title} the engine holds no secret', () => {});\n`;
    const both: Record<string, string> = Object.fromEntries(LIFT_TESTS.map(({ file, title }) => [file, real(title)]));
    const reading = (files: Record<string, string>) => (file: string) => files[file];
    const [sidecar, rerun] = LIFT_TESTS;

    it('stays closed and quiet while false', () => {
      expect(liftState(ready('false'), reading({}))).toEqual({ lifted: false, problems: [] });
    });

    it('lifts when true and both pinned files hold a real test under the pinned title', () => {
      expect(liftState(ready('true'), reading(both))).toEqual({ lifted: true, problems: [] });
      expect(liftState(ready('true'), reading({ ...both, [sidecar.file]: `describe.skipIf(!live)('x', () => { ${real(sidecar.title)} });` }))).toMatchObject({ lifted: true });
    });

    it('refuses when the files are missing, empty, renamed, skipped or pointed elsewhere', () => {
      const missing = liftState(ready('true'), reading({}));
      expect(missing.lifted).toBe(false);
      expect(missing.problems).toEqual(LIFT_TESTS.map(({ label, file }) => violation(`UNTRUSTED_PDF_READY is true but the ${label} ${file} does not exist`, `${READY_FILE}:${LIFT_TESTS.length + 1}`)));
      const cases: Array<Record<string, string>> = [
        { ...both, [sidecar.file]: '' },
        { ...both, [sidecar.file]: real('UNTRUSTED-PDF-GATE side car:') },
        { ...both, [rerun.file]: real(rerun.title).replace("it('", "it.skip('") },
        { ...both, [rerun.file]: real(rerun.title).replace("it('", "it.todo('") },
        { ...both, [rerun.file]: `describe.skipIf(true)('x', () => { ${real(rerun.title)} });` },
        { ...both, [rerun.file]: `// it('${rerun.title}', () => {})\nxit('${rerun.title} x', () => {});` },
      ];
      for (const files of cases) expect(liftState(ready('true'), reading(files)).lifted, JSON.stringify(files)).toBe(false);
      // Renamed: the tests exist under other names, which the gate does not read.
      const renamed = { 'test/pdf/sidecar.test.ts': real(sidecar.title), 'test/pdf/rerun.test.ts': real(rerun.title) };
      expect(liftState(ready('true', '//   test/pdf/sidecar.test.ts\n//   test/pdf/rerun.test.ts'), reading(renamed)).lifted).toBe(false);
      // Pointed elsewhere: the comment names other files; the pinned ones still decide, and the comment must name them.
      const elsewhere = liftState(ready('true', '//   test/other/a.test.ts\n//   test/other/b.test.ts'), reading(both));
      expect(elsewhere.lifted).toBe(false);
      expect(elsewhere.problems[0]).toContain(`must name the sidecar test ${sidecar.file}`);
    });

    it('refuses a value that is not a plain true or false', () => {
      expect(liftState('export const UNTRUSTED_PDF_READY = process.env.X === "1";', reading(both)).problems).toEqual([
        violation('UNTRUSTED_PDF_READY is not a plain true or false constant', `${READY_FILE}:1`),
      ]);
    });

    it('today\'s untrusted.ts names the pinned files and is false', () => {
      expect(liftState(readFileSync(path.join(API, READY_FILE), 'utf8'), reading({}))).toEqual({ lifted: false, problems: [] });
    });
  });
});

// Kept for the self-tests: the frozen paths are real files.
describe('UNTRUSTED-PDF-GATE: the frozen places exist', () => {
  it('names files that are there', () => {
    for (const file of [STORE_DEFINITION, LOADER, ...STORE_IMPORTERS, ...Object.keys(PDF_ORIGINAL_SEEN)]) expect(existsSync(path.join(API, file)), file).toBe(true);
  });
});
