// ============================================================================
// check.json, the check's report, and its strict reader: the list and the sheet read it back, so a
// report edited by hand cannot keep a link its reasons drop. Each result's verdict, keepable and fix
// are recomputed from its reasons and must match; a kept URL must be https (or mailto) in its parsed
// form and of the result's kind. No page body is ever in a report, only status codes and URLs.
// ============================================================================
import { type CheckResult, NOTES, REASONS, type Reason, VERDICTS } from './check.js';
import { parseLink } from './urls.js';

export const CHECK_FORMAT = 'nwfl-link-check/1';
const MAX_RESULTS = 1000;
const MAX_CHAIN = 7;
const MAX_URL = 4096;

export interface CheckReport {
  format: typeof CHECK_FORMAT;
  issueDate: string;
  checkedAt: string;
  results: CheckResult[];
}

export class ReportError extends Error {
  override name = 'ReportError';
}

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ReportError(`${where} must be a JSON object`);
  return value as Json;
}

function known(json: Json, where: string, keys: readonly string[]): void {
  for (const key of Object.keys(json)) if (!keys.includes(key)) throw new ReportError(`${where}: unknown field ${key}`);
}

const own = (json: Json, key: string): unknown => (Object.hasOwn(json, key) ? json[key] : undefined);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
const isUrlText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_URL;

function codes<T extends string>(value: unknown, allowed: readonly T[], where: string): T[] {
  if (!Array.isArray(value) || !value.every((v) => (allowed as readonly unknown[]).includes(v))) throw new ReportError(`${where} must be a list of known codes`);
  return value as T[];
}

const SEVERITY = { ok: 0, upgrade: 1, confirm: 2, review: 3, flag: 4, drop: 5 } as const;

function result(value: unknown, where: string): CheckResult {
  const json = object(value, where);
  known(json, where, ['url', 'kind', 'verdict', 'reasons', 'notes', 'keepable', 'kept', 'chain', 'finalUrl', 'registered', 'fix']);
  const url = own(json, 'url');
  if (!isUrlText(url)) throw new ReportError(`${where}.url must be a URL`);
  const kind = own(json, 'kind');
  if (kind !== undefined && kind !== 'web' && kind !== 'mail') throw new ReportError(`${where}.kind must be web or mail`);
  const reasons = codes(own(json, 'reasons'), Object.keys(REASONS) as Reason[], `${where}.reasons`);
  const notes = codes(own(json, 'notes'), NOTES, `${where}.notes`);
  const verdict = own(json, 'verdict');
  const expected = reasons.reduce<(typeof VERDICTS)[number]>((worst, r) => (SEVERITY[REASONS[r][0]] > SEVERITY[worst] ? REASONS[r][0] : worst), 'ok');
  if (verdict !== expected) throw new ReportError(`${where}.verdict does not match its reasons`);
  const kept = own(json, 'kept');
  if (kept !== undefined) {
    const parsed = typeof kept === 'string' ? parseLink(kept) : undefined;
    if (parsed?.ok !== true || parsed.link.url !== kept || !['https', 'mailto'].includes(parsed.link.scheme) || parsed.link.kind !== kind) {
      throw new ReportError(`${where}.kept must be an https or mailto URL, in its parsed form, of the result's kind`);
    }
  }
  const keepable = own(json, 'keepable');
  if (keepable !== (kept !== undefined && reasons.every((r) => REASONS[r][1]))) throw new ReportError(`${where}.keepable does not match its reasons`);
  const chainJson = own(json, 'chain');
  if (!Array.isArray(chainJson) || chainJson.length > MAX_CHAIN) throw new ReportError(`${where}.chain must be a list of at most ${MAX_CHAIN} hops`);
  const chain = chainJson.map((entry, n) => {
    const hop = object(entry, `${where}.chain[${n}]`);
    known(hop, `${where}.chain[${n}]`, ['url', 'status']);
    const status = own(hop, 'status');
    const hopUrl = own(hop, 'url');
    if (!isUrlText(hopUrl) || (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 999))) {
      throw new ReportError(`${where}.chain[${n}] must hold a URL and a status`);
    }
    return status === undefined ? { url: hopUrl } : { url: hopUrl, status };
  });
  const finalUrl = own(json, 'finalUrl');
  if (finalUrl !== undefined && !isUrlText(finalUrl)) throw new ReportError(`${where}.finalUrl must be a URL`);
  const registered = own(json, 'registered');
  if (registered !== undefined && !isDate(registered)) throw new ReportError(`${where}.registered must be YYYY-MM-DD`);
  const fix = own(json, 'fix');
  const first = reasons[0];
  if (fix !== (first === undefined ? undefined : REASONS[first][2])) throw new ReportError(`${where}.fix does not match its reasons`);
  const out: CheckResult = { url, ...(kind === undefined ? {} : { kind }), verdict: expected, reasons, notes, keepable, chain };
  if (kept !== undefined) out.kept = kept;
  if (finalUrl !== undefined) out.finalUrl = finalUrl;
  if (registered !== undefined) out.registered = registered;
  if (fix !== undefined) out.fix = fix as string;
  return out;
}

export function parseCheckReport(input: unknown): CheckReport {
  const json = object(input, 'the check report');
  known(json, 'the check report', ['format', 'issueDate', 'checkedAt', 'results']);
  if (own(json, 'format') !== CHECK_FORMAT) throw new ReportError(`the check report's format must be ${CHECK_FORMAT}`);
  const issueDate = own(json, 'issueDate');
  if (!isDate(issueDate)) throw new ReportError('issueDate must be YYYY-MM-DD');
  const checkedAt = own(json, 'checkedAt');
  if (typeof checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(checkedAt)) throw new ReportError('checkedAt must be an ISO time in UTC');
  const list = own(json, 'results');
  if (!Array.isArray(list) || list.length > MAX_RESULTS) throw new ReportError(`results must be a list of at most ${MAX_RESULTS}`);
  const seen = new Set<string>();
  const results = list.map((entry, n) => {
    const one = result(entry, `results[${n}]`);
    if (seen.has(one.url)) throw new ReportError(`results[${n}]: the same URL is checked twice`);
    seen.add(one.url);
    return one;
  });
  return { format: CHECK_FORMAT, issueDate, checkedAt, results };
}
