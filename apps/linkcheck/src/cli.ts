// ============================================================================
// The command line (README). Three steps, each run in its own container (scripts/linkcheck.sh):
//   extract --audience public|members --in <pdf> --out <dir>      no network; writes extract-<audience>.json
//   check --issue-date YYYY-MM-DD [--remember <remember.json>] --out <dir> <extract.json>...
//                                                                 network, no PDF; writes check.json, sheet.md and
//                                                                 answers-template.json, with earlier answers filled in
//   replace --check <check.json> --answers <answers.json> --out <dir>
//                                                                 network, no PDF; checks the different links given
//                                                                 (LINKS-REPLACE); writes check-replacements.json
//   list --check <check.json> --public <extract.json> --members <extract.json> [--answers <answers.json>]
//        [--replacements <check-replacements.json>] [--remember <remember.json>] --out <dir>
//                                                                 no network; writes links.json and remember.json,
//                                                                 prints linksSha256
//   items                                                         network; the officer pieces' links (L-ITEM, items.ts):
//                                                                 lists them from the API, checks them, records the
//                                                                 verdicts. Configured by the environment:
//                                                                 LINKCHECK_API_URL, LINKCHECK_TOKEN_URL,
//                                                                 LINKCHECK_PASSWORD_FILE (the service account's app
//                                                                 password), LINKCHECK_CLIENT_ID (nwfl-linkcheck),
//                                                                 LINKCHECK_USERNAME (svc-nwfl-linkcheck),
//                                                                 LINKCHECK_SCOPE (links.check)
// It prints counts and the hash only, never a URL or the text under a link (those go to the files on
// the officer's machine). An unexpected error is named by its class only.
// ============================================================================
import path from 'node:path';
import { answersTemplate, needsAnswer, parseAnswers, buildLinkList, replacementsOf } from './build.js';
import { type CheckDeps, type CheckResult, VERDICTS, assertKeptForms, checkAll } from './check.js';
import { EXTRACT_FORMAT, ExtractError, type Extraction, parseExtraction } from './extract.js';
import { AUDIENCES, type Audience, ListError } from './list.js';
import { ItemsError, clientCredentials, endpoint, newDomainSince, runItems } from './items.js';
import { CHECK_FORMAT, type CheckReport, ReportError, parseCheckReport } from './report.js';
import { parseRemember, rememberAnswers } from './remember.js';
import { renderSheet } from './sheet.js';

export const USAGE = `usage:
  linkcheck extract --audience public|members --in <pdf> --out <dir>
  linkcheck check --issue-date YYYY-MM-DD [--remember <remember.json>] --out <dir> <extract.json> [<extract.json>]
  linkcheck replace --check <check.json> --answers <answers.json> --out <dir>
  linkcheck list --check <check.json> --public <extract.json> --members <extract.json> [--answers <answers.json>]
                 [--replacements <check-replacements.json>] [--remember <remember.json>] --out <dir>
  linkcheck items   (configured by LINKCHECK_API_URL, LINKCHECK_TOKEN_URL and LINKCHECK_PASSWORD_FILE)`;

export interface Io {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string): Promise<void>;
  print(line: string): void;
  warn(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  now(): Date;
  checkDeps(issueDate: string): CheckDeps;
  extract(pdf: Uint8Array, audience: Audience): Promise<Extraction>;
  /** The identity provider's token endpoint is called with it (items); the global fetch by default. */
  fetch?: typeof fetch;
}

class UsageError extends Error {}
class CliError extends Error {}

const FLAGS: Record<string, readonly string[]> = {
  extract: ['audience', 'in', 'out'],
  check: ['issue-date', 'remember', 'out'],
  replace: ['check', 'answers', 'out'],
  list: ['check', 'public', 'members', 'answers', 'replacements', 'remember', 'out'],
  items: [],
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

const verdictCounts = (results: readonly CheckResult[]): string => VERDICTS.map((v) => `${results.filter((r) => r.verdict === v).length} ${v}`).join(', ');

/** LINKS-REPLACE: each different link in the answers, checked like any link, for the list step. */
async function replaceCommand(io: Io, flags: Map<string, string>): Promise<void> {
  const report = parseCheckReport(await readJson(io, need(flags, 'check')));
  const answers = parseAnswers(await readJson(io, need(flags, 'answers')), report);
  const out = need(flags, 'out');
  const results = await checkAll(replacementsOf(answers), io.checkDeps(report.issueDate));
  assertKeptForms(results);
  const checked: CheckReport = { format: CHECK_FORMAT, issueDate: report.issueDate, checkedAt: io.now().toISOString(), results };
  await io.writeFile(path.join(out, 'check-replacements.json'), json(checked));
  io.print(`replace: ${results.length} different link${results.length === 1 ? '' : 's'} checked: ${verdictCounts(results)}`);
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
  const rememberFile = flags.get('remember');
  const memory = rememberFile === undefined ? undefined : parseRemember(await readJson(io, rememberFile));
  const results = await checkAll(urls, io.checkDeps(issueDate));
  assertKeptForms(results);
  const report: CheckReport = { format: CHECK_FORMAT, issueDate, checkedAt: io.now().toISOString(), results };
  await io.writeFile(path.join(out, 'check.json'), json(report));
  await io.writeFile(path.join(out, 'sheet.md'), renderSheet(report, extractions, memory));
  await io.writeFile(path.join(out, 'answers-template.json'), json(answersTemplate(report, memory)));
  const counts = verdictCounts(results);
  io.print(`check: ${counts}; ${results.filter(needsAnswer).length} need an answer`);
}

async function listCommand(io: Io, flags: Map<string, string>): Promise<void> {
  const report = parseCheckReport(await readJson(io, need(flags, 'check')));
  const extractions = { public: parseExtraction(await readJson(io, need(flags, 'public'))), members: parseExtraction(await readJson(io, need(flags, 'members'))) };
  const answersFile = flags.get('answers');
  const answers = answersFile === undefined ? new Map<string, boolean>() : parseAnswers(await readJson(io, answersFile), report);
  const replacementsFile = flags.get('replacements');
  const replaced = replacementsFile === undefined ? undefined : parseCheckReport(await readJson(io, replacementsFile));
  const rememberFile = flags.get('remember');
  const prior = rememberFile === undefined ? new Map() : parseRemember(await readJson(io, rememberFile));
  const out = need(flags, 'out');
  const list = buildLinkList(extractions, report, answers, undefined, replaced);
  const remembered = rememberAnswers(prior, report, answers, io.now().toISOString().slice(0, 10));
  await io.writeFile(path.join(out, 'links.json'), json(list));
  await io.writeFile(path.join(out, 'remember.json'), json(remembered));
  io.print(`linksSha256 ${list.linksSha256}`);
  io.print(`list: ${list.links.public.length} public links, ${list.links.members.length} members links kept`);
  io.print(`remember: ${remembered.answers.length} answers kept for the next issue`);
}

/** L-ITEM: the officer pieces' links, from the API and back (items.ts). Prints counts only. */
async function itemsCommand(io: Io): Promise<void> {
  const api = endpoint('LINKCHECK_API_URL', io.env['LINKCHECK_API_URL']);
  const tokenUrl = endpoint('LINKCHECK_TOKEN_URL', io.env['LINKCHECK_TOKEN_URL']);
  const passwordFile = io.env['LINKCHECK_PASSWORD_FILE'];
  if (passwordFile === undefined || passwordFile === '') throw new CliError('LINKCHECK_PASSWORD_FILE is needed');
  const password = new TextDecoder().decode(await read(io, passwordFile)).trim();
  if (password === '') throw new CliError(`${passwordFile} is empty`);
  const token = await clientCredentials(
    {
      tokenUrl,
      clientId: io.env['LINKCHECK_CLIENT_ID'] ?? 'nwfl-linkcheck',
      username: io.env['LINKCHECK_USERNAME'] ?? 'svc-nwfl-linkcheck',
      password,
      scope: io.env['LINKCHECK_SCOPE'] ?? 'links.check',
    },
    io.fetch,
  );
  // A piece is about now, so "registered after the issue date" would never fire with today as the date:
  // here a domain registered in the last NEW_DOMAIN_DAYS days is flagged (re-registered), stored as CONFIRM.
  const since = newDomainSince(io.now());
  const totals = await runItems({
    api,
    token,
    check: async (urls) => {
      const results = await checkAll(urls, io.checkDeps(since));
      assertKeptForms(results);
      return results;
    },
  });
  io.print(
    `items: ${totals.checked} addresses checked: ${totals.ok} ok, ${totals.confirm} confirm, ${totals.drop} drop; ${totals.recorded} recorded, ${totals.notAwaiting} no longer waiting${totals.more ? '; more wait, run again' : ''}`,
  );
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
    else if (command === 'replace') await replaceCommand(io, flags);
    else if (command === 'items') await itemsCommand(io);
    else await listCommand(io, flags);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.warn(`linkcheck: ${error.message}\n${USAGE}`);
      return 2;
    }
    const known = error instanceof CliError || error instanceof ExtractError || error instanceof ListError || error instanceof ReportError || error instanceof ItemsError;
    io.warn(`linkcheck: ${known ? error.message : `an unexpected error (${(error as Error)?.constructor?.name ?? 'unknown'})`}`);
    return 1;
  }
}
