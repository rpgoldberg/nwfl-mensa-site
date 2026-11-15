// ============================================================================
// LINKS-REPLACE and LINKS-REMEMBER (a): a different link given in place of one, and the editor's answers
// carried from one issue to the next.
//   - a replacement is an https address that parseKept accepts (no credentials, port, IP literal or local
//     name), held in its kept form; the check then treats it like any link (cli.ts replace);
//   - remember.json, written by the list step: one answer per kept URL (keep true or false, or a different
//     link), with the date it was given. The next issue's check pre-answers the same URL in its answers
//     template and its sheet, except on a fresh unsafe verdict (UNSAFE), which always asks again. Only rows
//     that wait on an answer are pre-answered (and a different link for a row that cannot be kept); an ok
//     link is never removed by an old answer.
// remember.json = { "format": "nwfl-link-remember/1", "answers": [ { "url", "keep" | "replace", "answered" } ] }
// ============================================================================
import type { CheckResult, Reason } from './check.js';
import { ListError } from './list.js';
import type { CheckReport } from './report.js';
import { keptForm, parseKept } from './urls.js';

export const REMEMBER_FORMAT = 'nwfl-link-remember/1';
const MAX_REMEMBERED = 5000;

/** Fresh verdicts no remembered answer stands over: a certificate failure, parking, or signs of a new owner. */
export const UNSAFE: readonly Reason[] = ['tls', 'parked', 're-registered', 'unrelated-redirect', 'redirect-to-http', 'bad-redirect'];

export type Choice = { keep: boolean } | { replace: string };
export type Remembered = Choice & { answered: string };
export type Memory = ReadonlyMap<string, Remembered>;

export interface RememberFile {
  format: typeof REMEMBER_FORMAT;
  answers: ({ url: string } & Remembered)[];
}

type Json = Record<string, unknown>;

export function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ListError(`${where} must be a JSON object`);
  return value as Json;
}

export function known(json: Json, where: string, keys: readonly string[]): void {
  for (const key of Object.keys(json)) if (!keys.includes(key)) throw new ListError(`${where}: unknown field ${key}`);
}

export const own = (json: Json, key: string): unknown => (Object.hasOwn(json, key) ? json[key] : undefined);

/** A different link as given: an https address the URL rules accept, in its kept form. */
export function replacementUrl(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ListError(`${where}.replace must be a web address`);
  const parsed = parseKept(value);
  if (!parsed.ok) throw new ListError(`${where}.replace cannot be used (${parsed.reason})`);
  if (parsed.link.scheme !== 'https') throw new ListError(`${where}.replace must start with https://`);
  return keptForm(value) as string;
}

/** keep or replace, exactly one. */
export function choiceOf(json: Json, where: string): Choice {
  const keep = own(json, 'keep');
  const replace = own(json, 'replace');
  if (keep !== undefined && replace !== undefined) throw new ListError(`${where}: give keep or replace, not both`);
  if (replace !== undefined) return { replace: replacementUrl(replace, where) };
  if (typeof keep !== 'boolean') throw new ListError(`${where}.keep must be true or false`);
  return { keep };
}

/** The URL an answer is remembered under: the kept form, also for a link that cannot be kept as written. */
export const memoryKey = (r: CheckResult): string | null => r.kept ?? keptForm(r.url);

export function parseRemember(input: unknown): Map<string, Remembered> {
  const json = object(input, 'the remembered answers');
  known(json, 'the remembered answers', ['format', 'answers']);
  if (own(json, 'format') !== REMEMBER_FORMAT) throw new ListError(`the remembered answers' format must be ${REMEMBER_FORMAT}`);
  const list = own(json, 'answers');
  if (!Array.isArray(list) || list.length > MAX_REMEMBERED) throw new ListError(`the remembered answers must be a list of at most ${MAX_REMEMBERED}`);
  const out = new Map<string, Remembered>();
  list.forEach((entry, n) => {
    const where = `remembered[${n}]`;
    const answer = object(entry, where);
    known(answer, where, ['url', 'keep', 'replace', 'answered']);
    const url = own(answer, 'url');
    if (typeof url !== 'string' || keptForm(url) !== url) throw new ListError(`${where}.url must be a kept https or mailto address`);
    const answered = own(answer, 'answered');
    if (typeof answered !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(answered)) throw new ListError(`${where}.answered must be YYYY-MM-DD`);
    const choice = choiceOf(answer, where);
    if (out.has(url)) throw new ListError(`${where}: the same URL is remembered twice`);
    out.set(url, { ...choice, answered });
  });
  return out;
}

export interface Recalled {
  remembered: Remembered;
  /** The fresh unsafe reason that makes it ask again, if any. */
  unsafe?: Reason;
}

/** The remembered answer for a result, if one applies to it (see the header). */
export function recall(memory: Memory | undefined, r: CheckResult, waits: boolean): Recalled | undefined {
  const key = memoryKey(r);
  const remembered = key === null ? undefined : memory?.get(key);
  if (remembered === undefined) return undefined;
  // A link that cannot be kept takes only a different link, and is never kept itself: nothing to ask again.
  if (!waits) return r.keepable || !('replace' in remembered) ? undefined : { remembered };
  const unsafe = r.reasons.find((reason) => UNSAFE.includes(reason));
  return unsafe === undefined ? { remembered } : { remembered, unsafe };
}

/** remember.json after this issue's answers: each answered URL now, over what was remembered before. */
export function rememberAnswers(prior: Memory, report: CheckReport, answers: ReadonlyMap<string, boolean | { replace: string }>, today: string): RememberFile {
  const merged = new Map<string, Remembered>(prior);
  for (const r of report.results) {
    const answer = answers.get(r.url);
    const key = memoryKey(r);
    if (answer === undefined || key === null) continue;
    merged.set(key, typeof answer === 'boolean' ? { keep: answer, answered: today } : { replace: answer.replace, answered: today });
  }
  const urls = [...merged.keys()].sort();
  return { format: REMEMBER_FORMAT, answers: urls.map((url) => ({ url, ...(merged.get(url) as Remembered) })) };
}
