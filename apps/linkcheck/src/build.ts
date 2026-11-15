// ============================================================================
// From the check to links.json (SPEC D4 output): the editor's answers, then the approved list.
//   - ok and upgrade are kept unless the editor says no;
//   - confirm, review, flag and drop are kept only on the editor's yes, and only when keepable;
//   - every kept link gets a fresh random id (list.ts mintId), its page and rect from the extraction,
//     its URL from the check (the https form), and confirm = true when the editor's own yes kept it from
//     the login-walled or no-fetch list;
//   - unanswered means removed (fail closed). An answer for a URL the check never saw, or a yes for a
//     link that cannot be kept, is refused rather than ignored;
//   - a different link (LINKS-REPLACE, remember.ts) takes the original's place over the same printed text
//     (its page and rect) in every copy, and the original is never listed. It must have been checked
//     (cli.ts replace) and be ok, or confirm or review (never fetched: the replace answer is the editor's
//     yes); anything else fails the list step, naming the answer. links.json's format does not change.
// answers.json = { "format": "nwfl-link-answers/1", "answers": [ { "row"?: n, "url": "...", "keep": bool | "replace": "https://..." } ] }
// ============================================================================
import { randomBytes } from 'node:crypto';
import type { CheckResult } from './check.js';
import type { Extraction } from './extract.js';
import { AUDIENCES, type Audience, LIST_FORMAT, type LinkList, type LinksByAudience, ListError, linksSha256, mintId, parseLinkList } from './list.js';
import { type Memory, choiceOf, known, object, own, recall } from './remember.js';
import type { CheckReport } from './report.js';

export const ANSWERS_FORMAT = 'nwfl-link-answers/1';

const keptByDefault = (r: CheckResult): boolean => r.verdict === 'ok' || r.verdict === 'upgrade';

/** Whether a result waits on the editor's yes or no. */
export const needsAnswer = (r: CheckResult): boolean => r.keepable && !keptByDefault(r);

export type TemplateAnswer = { row?: number; url: string } & ({ keep: boolean } | { replace: string });

export interface AnswersFile {
  format: typeof ANSWERS_FORMAT;
  answers: TemplateAnswer[];
}

/** A different link given in place of one; `where` names the answer for the list step's messages. */
export interface Replacement {
  replace: string;
  where: string;
}
export type Answers = ReadonlyMap<string, boolean | Replacement>;

/**
 * The answers file to fill in: every URL that needs an answer, numbered as the sheet numbers it, "keep": false
 * until the editor says yes, unless a remembered answer applies (remember.ts recall); then a remembered
 * different link for a link that cannot be kept, unnumbered.
 */
export function answersTemplate(report: CheckReport, memory?: Memory): AnswersFile {
  const filled = (r: CheckResult, waits: boolean): { keep: boolean } | { replace: string } | undefined => {
    const got = recall(memory, r, waits);
    if (got === undefined || got.unsafe !== undefined) return undefined;
    return 'replace' in got.remembered ? { replace: got.remembered.replace } : { keep: got.remembered.keep };
  };
  const asked = report.results.filter(needsAnswer).map((r, i): TemplateAnswer => ({ row: i + 1, url: r.url, ...(filled(r, true) ?? { keep: false }) }));
  const carried = report.results.filter((r) => !r.keepable).flatMap((r): TemplateAnswer[] => {
    const got = filled(r, false);
    return got === undefined ? [] : [{ url: r.url, ...got }];
  });
  return { format: ANSWERS_FORMAT, answers: [...asked, ...carried] };
}

/** The editor's answers, by URL, each checked against the report: true or false, or a different link. */
export function parseAnswers(input: unknown, report: CheckReport): Map<string, boolean | Replacement> {
  const json = object(input, 'the answers');
  known(json, 'the answers', ['format', 'answers']);
  if (own(json, 'format') !== ANSWERS_FORMAT) throw new ListError(`the answers' format must be ${ANSWERS_FORMAT}`);
  const list = own(json, 'answers');
  if (!Array.isArray(list)) throw new ListError('answers must be a list');
  const byUrl = new Map(report.results.map((r) => [r.url, r]));
  const out = new Map<string, boolean | Replacement>();
  list.forEach((entry, n) => {
    const where = `answers[${n}]`;
    const answer = object(entry, where);
    known(answer, where, ['row', 'url', 'keep', 'replace']);
    const row = own(answer, 'row');
    if (row !== undefined && (typeof row !== 'number' || !Number.isInteger(row) || row < 1)) throw new ListError(`${where}.row must be a whole number from 1`);
    const url = own(answer, 'url');
    const result = typeof url === 'string' ? byUrl.get(url) : undefined;
    if (result === undefined) throw new ListError(`${where}.url is not in the check`);
    const choice = choiceOf(answer, where);
    if (out.has(result.url)) throw new ListError(`${where}: the same URL is answered twice`);
    if ('replace' in choice) {
      out.set(result.url, { replace: choice.replace, where: row === undefined ? where : `${where} (row ${String(row)})` });
      return;
    }
    if (choice.keep && !result.keepable) throw new ListError(`${where}: that link cannot be kept (${result.reasons[0] as string})`);
    out.set(result.url, choice.keep);
  });
  return out;
}

/** The different links given, each once, for the check (cli.ts replace). */
export const replacementsOf = (answers: Answers): string[] => [...new Set([...answers.values()].flatMap((a) => (typeof a === 'boolean' ? [] : [a.replace])))];

const STANDS = new Set(['ok', 'upgrade', 'confirm', 'review']);

/** Each different link's checked result, by the original URL; refuses one not checked or not passing, naming its answer. */
function replacementsChecked(report: CheckReport, answers: Answers, replaced: CheckReport | undefined): Map<string, CheckResult> {
  if (replaced !== undefined && replaced.issueDate !== report.issueDate) throw new ListError('the different links were checked for another issue');
  const byUrl = new Map((replaced?.results ?? []).map((r) => [r.url, r]));
  const out = new Map<string, CheckResult>();
  for (const [url, answer] of answers) {
    if (typeof answer === 'boolean') continue;
    const result = byUrl.get(answer.replace);
    if (result === undefined) throw new ListError(`${answer.where}: the different link was not checked; run step 8 again with linkcheck.sh`);
    if (!STANDS.has(result.verdict) || result.kept === undefined || result.kind !== 'web') {
      throw new ListError(`${answer.where}: the different link did not pass the check (${result.verdict}: ${result.reasons[0] as string}); give another link, or answer keep instead`);
    }
    out.set(url, result);
  }
  return out;
}

/** links.json from the two extractions, the check and the editor's answers; checked by the strict reader before it is returned. */
export function buildLinkList(extractions: Record<Audience, Extraction>, report: CheckReport, answers: Answers, random: (size: number) => Uint8Array = randomBytes, replaced?: CheckReport): LinkList {
  const byUrl = new Map(report.results.map((r) => [r.url, r]));
  const replacements = replacementsChecked(report, answers, replaced);
  const links = { public: [], members: [] } as LinksByAudience;
  for (const audience of AUDIENCES) {
    const extraction = extractions[audience];
    if (extraction.audience !== audience) throw new ListError(`the ${audience} file given is the ${extraction.audience} extraction`);
    for (const link of extraction.links) {
      const result = byUrl.get(link.url);
      if (result === undefined) throw new ListError(`the check has no result for a link on ${audience} page ${link.page}`);
      const instead = replacements.get(link.url);
      if (instead !== undefined) {
        const confirm = instead.verdict === 'confirm' || instead.verdict === 'review';
        links[audience].push({ id: mintId(random), page: link.page, rect: link.rect, url: instead.kept as string, kind: 'web', confirm });
        continue;
      }
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
  const sha256 = { public: extractions.public.sha256, members: extractions.members.sha256 };
  const list = { format: LIST_FORMAT, sha256, links, linksSha256: linksSha256(links, sha256) };
  return parseLinkList(JSON.parse(JSON.stringify(list)));
}
