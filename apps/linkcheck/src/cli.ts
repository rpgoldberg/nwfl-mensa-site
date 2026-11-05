// ============================================================================
// The command line (README). Three steps, each run in its own container (scripts/linkcheck.sh):
//   extract --audience public|members --in <pdf> --out <dir>      no network; writes extract-<audience>.json
//   check --issue-date YYYY-MM-DD --out <dir> <extract.json>...    network, no PDF; writes check.json,
//                                                                 sheet.md and answers-template.json
//   list --check <check.json> --public <extract.json> --members <extract.json> [--answers <answers.json>] --out <dir>
//                                                                 no network; writes links.json, prints linksSha256
// It prints counts and the hash only, never a URL or the text under a link (those go to the files on
// the officer's machine). An unexpected error is named by its class only.
// ============================================================================
import path from 'node:path';
import { answersTemplate, needsAnswer, parseAnswers, buildLinkList } from './build.js';
import { type CheckDeps, VERDICTS, assertKeptForms, checkAll } from './check.js';
import { EXTRACT_FORMAT, ExtractError, type Extraction, parseExtraction } from './extract.js';
import { AUDIENCES, type Audience, ListError } from './list.js';
import { CHECK_FORMAT, type CheckReport, ReportError, parseCheckReport } from './report.js';
import { renderSheet } from './sheet.js';

export const USAGE = `usage:
  linkcheck extract --audience public|members --in <pdf> --out <dir>
  linkcheck check --issue-date YYYY-MM-DD --out <dir> <extract.json> [<extract.json>]
  linkcheck list --check <check.json> --public <extract.json> --members <extract.json> [--answers <answers.json>] --out <dir>`;

export interface Io {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string): Promise<void>;
  print(line: string): void;
  warn(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  now(): Date;
  checkDeps(issueDate: string): CheckDeps;
  extract(pdf: Uint8Array, audience: Audience): Promise<Extraction>;
}

class UsageError extends Error {}
class CliError extends Error {}

const FLAGS: Record<string, readonly string[]> = {
  extract: ['audience', 'in', 'out'],
  check: ['issue-date', 'out'],
  list: ['check', 'public', 'members', 'answers', 'out'],
};

function parseArgs(command: string, argv: readonly string[]): { flags: Map<string, string>; rest: string[] } {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!(FLAGS[command] as readonly string[]).includes(name)) throw new UsageError(`unknown flag --${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
    i += 1;
  }
  return { flags, rest };
}

function need(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new CliError(`--${name} is needed`);
  return value;
}

async function read(io: Io, file: string): Promise<Uint8Array> {
  try {
    return await io.readFile(file);
  } catch {
    throw new CliError(`cannot read ${file}`);
  }
}

async function readJson(io: Io, file: string): Promise<unknown> {
  const bytes = await read(io, file);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new CliError(`${file} is not JSON`);
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const empty = (audience: Audience): Extraction => ({ format: EXTRACT_FORMAT, audience, sha256: '0'.repeat(64), pages: 1, links: [], refused: [], internal: 0, unlinked: [], unlinkedMore: 0 });

async function extractCommand(io: Io, flags: Map<string, string>): Promise<void> {
  const audience = need(flags, 'audience');
  if (!(AUDIENCES as readonly string[]).includes(audience)) throw new CliError('--audience must be public or members');
  const pdf = await read(io, need(flags, 'in'));
  const out = need(flags, 'out');
  const extraction = await io.extract(pdf, audience as Audience);
  await io.writeFile(path.join(out, `extract-${audience}.json`), json(extraction));
  io.print(`extract ${audience}: ${extraction.links.length} links, ${extraction.refused.length} refused, ${extraction.unlinked.length + extraction.unlinkedMore} printed with no link`);
}

async function checkCommand(io: Io, flags: Map<string, string>, files: readonly string[]): Promise<void> {
  const issueDate = need(flags, 'issue-date');
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(issueDate)) throw new CliError('--issue-date must be YYYY-MM-DD');
  const out = need(flags, 'out');
  if (files.length < 1 || files.length > 2) throw new CliError('check takes one or two extraction files');
  const extractions = { public: empty('public'), members: empty('members') };
  const seen = new Set<Audience>();
  for (const file of files) {
    const extraction = parseExtraction(await readJson(io, file));
    if (seen.has(extraction.audience)) throw new CliError(`two extraction files are both for ${extraction.audience}`);
    seen.add(extraction.audience);
    extractions[extraction.audience] = extraction;
  }
  if (io.env['NWFL_SAFE_BROWSING_KEY'] !== undefined) io.warn('linkcheck: a Safe Browsing key is set, but this version does not consult Safe Browsing yet');
  const urls = AUDIENCES.flatMap((audience) => extractions[audience].links.map((l) => l.url));
  const results = await checkAll(urls, io.checkDeps(issueDate));
  assertKeptForms(results);
  const report: CheckReport = { format: CHECK_FORMAT, issueDate, checkedAt: io.now().toISOString(), results };
  await io.writeFile(path.join(out, 'check.json'), json(report));
  await io.writeFile(path.join(out, 'sheet.md'), renderSheet(report, extractions));
  await io.writeFile(path.join(out, 'answers-template.json'), json(answersTemplate(report)));
  const counts = VERDICTS.map((v) => `${results.filter((r) => r.verdict === v).length} ${v}`).join(', ');
  io.print(`check: ${counts}; ${results.filter(needsAnswer).length} need an answer`);
}

async function listCommand(io: Io, flags: Map<string, string>): Promise<void> {
  const report = parseCheckReport(await readJson(io, need(flags, 'check')));
  const extractions = { public: parseExtraction(await readJson(io, need(flags, 'public'))), members: parseExtraction(await readJson(io, need(flags, 'members'))) };
  const answersFile = flags.get('answers');
  const answers = answersFile === undefined ? new Map<string, boolean>() : parseAnswers(await readJson(io, answersFile), report);
  const out = need(flags, 'out');
  const list = buildLinkList(extractions, report, answers);
  await io.writeFile(path.join(out, 'links.json'), json(list));
  io.print(`linksSha256 ${list.linksSha256}`);
  io.print(`list: ${list.links.public.length} public links, ${list.links.members.length} members links kept`);
}

/** Runs one command; the exit code: 0 done, 1 refused or failed, 2 a usage error. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command = 'help', ...rest] = argv;
  try {
    if (command === 'help' || command === '--help') {
      io.print(USAGE);
      return 0;
    }
    if (!(command in FLAGS)) throw new UsageError(`unknown command ${command}`);
    const { flags, rest: files } = parseArgs(command, rest);
    if (command === 'extract') await extractCommand(io, flags);
    else if (command === 'check') await checkCommand(io, flags, files);
    else await listCommand(io, flags);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.warn(`linkcheck: ${error.message}\n${USAGE}`);
      return 2;
    }
    const known = error instanceof CliError || error instanceof ExtractError || error instanceof ListError || error instanceof ReportError;
    io.warn(`linkcheck: ${known ? error.message : `an unexpected error (${(error as Error)?.constructor?.name ?? 'unknown'})`}`);
    return 1;
  }
}
