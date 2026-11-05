// ============================================================================
// From the check to links.json (SPEC D4 output): Ross's answers, then the approved list.
//   - ok and upgrade are kept unless Ross says no;
//   - confirm, review, flag and drop are kept only on his yes, and only when keepable;
//   - every kept link gets a fresh random id (list.ts mintId), its page and rect from the extraction,
//     its URL from the check (the https form), and confirm = true when Ross's own yes kept it from
//     the login-walled or no-fetch list;
//   - unanswered means removed (fail closed). An answer for a URL the check never saw, or a yes for a
//     link that cannot be kept, is refused rather than ignored.
// answers.json = { "format": "nwfl-link-answers/1", "answers": [ { "row"?: n, "url": "...", "keep": bool } ] }
// ============================================================================
import { randomBytes } from 'node:crypto';
import type { CheckResult } from './check.js';
import type { Extraction } from './extract.js';
import { AUDIENCES, type Audience, LIST_FORMAT, type LinkList, type LinksByAudience, ListError, linksSha256, mintId, parseLinkList } from './list.js';
import type { CheckReport } from './report.js';

export const ANSWERS_FORMAT = 'nwfl-link-answers/1';

const keptByDefault = (r: CheckResult): boolean => r.verdict === 'ok' || r.verdict === 'upgrade';

/** Whether a result waits on Ross's yes or no. */
export const needsAnswer = (r: CheckResult): boolean => r.keepable && !keptByDefault(r);

export interface AnswersFile {
  format: typeof ANSWERS_FORMAT;
  answers: { row?: number; url: string; keep: boolean }[];
}

/** The answers file to fill in: every URL that needs an answer, numbered as the sheet numbers it, "keep": false until Ross says yes. */
export function answersTemplate(report: CheckReport): AnswersFile {
  return { format: ANSWERS_FORMAT, answers: report.results.filter(needsAnswer).map((r, i) => ({ row: i + 1, url: r.url, keep: false })) };
}

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ListError(`${where} must be a JSON object`);
  return value as Json;
}

function known(json: Json, where: string, keys: readonly string[]): void {
  for (const key of Object.keys(json)) if (!keys.includes(key)) throw new ListError(`${where}: unknown field ${key}`);
}

const own = (json: Json, key: string): unknown => (Object.hasOwn(json, key) ? json[key] : undefined);

/** Ross's answers, by URL, each checked against the report. */
export function parseAnswers(input: unknown, report: CheckReport): Map<string, boolean> {
  const json = object(input, 'the answers');
  known(json, 'the answers', ['format', 'answers']);
  if (own(json, 'format') !== ANSWERS_FORMAT) throw new ListError(`the answers' format must be ${ANSWERS_FORMAT}`);
  const list = own(json, 'answers');
  if (!Array.isArray(list)) throw new ListError('answers must be a list');
  const byUrl = new Map(report.results.map((r) => [r.url, r]));
  const out = new Map<string, boolean>();
  list.forEach((entry, n) => {
    const where = `answers[${n}]`;
    const answer = object(entry, where);
    known(answer, where, ['row', 'url', 'keep']);
    const row = own(answer, 'row');
    if (row !== undefined && (typeof row !== 'number' || !Number.isInteger(row) || row < 1)) throw new ListError(`${where}.row must be a whole number from 1`);
    const url = own(answer, 'url');
    const result = typeof url === 'string' ? byUrl.get(url) : undefined;
    if (result === undefined) throw new ListError(`${where}.url is not in the check`);
    const keep = own(answer, 'keep');
    if (typeof keep !== 'boolean') throw new ListError(`${where}.keep must be true or false`);
    if (out.has(result.url)) throw new ListError(`${where}: the same URL is answered twice`);
    if (keep && !result.keepable) throw new ListError(`${where}: that link cannot be kept (${result.reasons[0] as string})`);
    out.set(result.url, keep);
  });
  return out;
}

/** links.json from the two extractions, the check and Ross's answers; checked by the strict reader before it is returned. */
export function buildLinkList(extractions: Record<Audience, Extraction>, report: CheckReport, answers: ReadonlyMap<string, boolean>, random: (size: number) => Uint8Array = randomBytes): LinkList {
  const byUrl = new Map(report.results.map((r) => [r.url, r]));
  const links = { public: [], members: [] } as LinksByAudience;
  for (const audience of AUDIENCES) {
    const extraction = extractions[audience];
    if (extraction.audience !== audience) throw new ListError(`the ${audience} file given is the ${extraction.audience} extraction`);
    for (const link of extraction.links) {
      const result = byUrl.get(link.url);
      if (result === undefined) throw new ListError(`the check has no result for a link on ${audience} page ${link.page}`);
      const answer = answers.get(link.url);
      const keep = result.kept !== undefined && result.kind !== undefined && (keptByDefault(result) ? answer !== false : answer === true && result.keepable);
      if (!keep) continue;
      links[audience].push({
        id: mintId(random),
        page: link.page,
        rect: link.rect,
        url: result.kept as string,
        kind: result.kind as 'web' | 'mail',
        confirm: result.verdict === 'confirm' || result.verdict === 'review',
      });
    }
  }
  const list = {
    format: LIST_FORMAT,
    sha256: { public: extractions.public.sha256, members: extractions.members.sha256 },
    links,
    linksSha256: linksSha256(links),
  };
  return parseLinkList(JSON.parse(JSON.stringify(list)));
}
