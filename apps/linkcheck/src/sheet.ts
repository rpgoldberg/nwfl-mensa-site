// ============================================================================
// The sheet (SPEC D4 output): what the editor reads and answers, one Markdown file per issue, on their own
// machine only. Every URL that needs the editor's answer gets one numbered row (all its files and pages on
// it), with the text under the link, the URL, the final URL, the verdict, the reason and the fix.
// Then what is kept, what cannot be kept, what was refused when the links were read, and the URLs
// printed with no link.
//
// Everything in it came from a PDF or a check, so all of it is data: control, bidi and zero-width
// characters become U+FFFD, Markdown is escaped in text, and URLs sit in code spans with any
// backtick or pipe percent-encoded, so no cell can break out of its table or pose as an instruction.
// No page body is ever shown.
// ============================================================================
import { type CheckResult, VERDICTS } from './check.js';
import type { Extraction, RefusalReason } from './extract.js';
import { AUDIENCES, type Audience } from './list.js';
import type { CheckReport } from './report.js';
import { needsAnswer } from './build.js';
import { CONTROLS, parseLink } from './urls.js';

const MAX_CELL = 200;
const MAX_URL_SHOWN = 300;

const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}\u2026` : text;
};

/** Text from a PDF, safe in a table cell. */
const cell = (text: string): string =>
  cut(text.replace(CONTROLS, '\ufffd').replace(/\s+/g, ' ').trim(), MAX_CELL).replace(/[\\`*_{}[\]<>()#+!|~]/g, '\\$&');

/** A URL in a code span, with its host in ASCII when it parses. */
function code(url: string | undefined): string {
  if (url === undefined || url === '') return '';
  const parsed = parseLink(url);
  const shown = parsed.ok ? parsed.link.url : url;
  return `\`${cut(shown.replace(CONTROLS, '\ufffd').replace(/`/g, '%60').replace(/\|/g, '%7C'), MAX_URL_SHOWN)}\``;
}

const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;
const table = (head: readonly string[], rows: readonly string[]): string[] => (rows.length === 0 ? ['None.'] : [row(head), row(head.map(() => '---')), ...rows]);

const REFUSED: Record<RefusalReason, string> = {
  scheme: 'a link with a scheme that is never kept',
  control: 'a link holding hidden control characters',
  'too-long': 'a link over 2048 characters',
  action: 'a link that runs an action (script, launch or another file), not an address',
  rect: 'a link whose area is off the page',
};

interface Occurrence {
  audience: Audience;
  page: number;
  text: string;
}

export function renderSheet(report: CheckReport, extractions: Record<Audience, Extraction>): string {
  const byUrl = new Map(report.results.map((r) => [r.url, r]));
  const where = new Map<string, Occurrence[]>();
  for (const audience of AUDIENCES) {
    for (const link of extractions[audience].links) {
      const list = where.get(link.url) ?? [];
      list.push({ audience, page: link.page, text: link.text });
      where.set(link.url, list);
    }
  }
  const counts = VERDICTS.map((v) => `${report.results.filter((r) => r.verdict === v).length} ${v}`).join(', ');
  const asking = report.results.filter(needsAnswer);
  const occurrences = (r: CheckResult): Occurrence[] => where.get(r.url) ?? [];
  const files = (r: CheckResult): string => [...new Set(occurrences(r).map((o) => o.audience))].join(', ');
  const pages = (r: CheckResult): string => {
    const all = occurrences(r);
    const byFile = AUDIENCES.map((audience) => [audience, all.filter((o) => o.audience === audience).map((o) => o.page)] as const).filter(([, list]) => list.length > 0);
    return byFile.length > 1 ? byFile.map(([audience, list]) => `${audience} ${list.join(', ')}`).join('; ') : all.map((o) => o.page).join(', ');
  };
  const text = (r: CheckResult): string => cell(occurrences(r).find((o) => o.text !== '')?.text ?? '');
  const reason = (r: CheckResult): string => r.reasons.join(', ');

  const out: string[] = [
    '# Link check sheet',
    '',
    `Issue date ${report.issueDate}. Checked ${report.checkedAt}. Verdicts: ${counts}.`,
    '',
    'Answer yes or no for each numbered row below, for example "LINKS: 1 yes, 2 no". A row you do not answer is removed.',
    'Rows under "Cannot be kept" need no answer. Safe Browsing was not consulted (no key is configured).',
    '',
    '## Your answer needed',
    '',
    ...(asking.length === 0
      ? ['Nothing needs your answer.']
      : table(
          ['Row', 'File', 'Page', 'Text under the link', 'Link', 'Final address', 'Verdict', 'Reason', 'Suggested fix'],
          asking.map((r, i) => row([i + 1, files(r), pages(r), text(r), code(r.url), code(r.finalUrl), r.verdict, reason(r), cell(r.fix ?? '')])),
        )),
    '',
    '## Kept',
    '',
    ...table(
      ['File', 'Page', 'Text under the link', 'Link kept', 'Verdict'],
      AUDIENCES.flatMap((audience) =>
        extractions[audience].links.flatMap((link) => {
          const r = byUrl.get(link.url);
          return r !== undefined && (r.verdict === 'ok' || r.verdict === 'upgrade') ? [row([audience, link.page, cell(link.text), code(r.kept), r.verdict])] : [];
        }),
      ),
    ),
    '',
    '## Cannot be kept',
    '',
    ...table(
      ['File', 'Page', 'Text under the link', 'Link', 'Reason', 'Why'],
      AUDIENCES.flatMap((audience) =>
        extractions[audience].links.flatMap((link) => {
          const r = byUrl.get(link.url);
          return r !== undefined && !r.keepable ? [row([audience, link.page, cell(link.text), code(link.url), reason(r), cell(r.fix ?? '')])] : [];
        }),
      ),
    ),
    '',
    '## Refused when the links were read',
    '',
    ...table(
      ['File', 'Page', 'What'],
      AUDIENCES.flatMap((audience) => extractions[audience].refused.map((f) => row([audience, f.page, `${REFUSED[f.reason]}${f.scheme === undefined ? '' : ` (${f.scheme})`}`]))),
    ),
    ...AUDIENCES.flatMap((audience) => (extractions[audience].internal > 0 ? ['', `The ${audience} file has ${extractions[audience].internal} links to places inside the file (not kept in this version).`] : [])),
    '',
    '## Addresses printed with no link',
    '',
    ...table(
      ['File', 'Page', 'Address'],
      AUDIENCES.flatMap((audience) => extractions[audience].unlinked.map((u) => row([audience, u.page, code(u.url)]))),
    ),
    ...AUDIENCES.flatMap((audience) => (extractions[audience].unlinkedMore > 0 ? ['', `The ${audience} file has these and ${extractions[audience].unlinkedMore} more.`] : [])),
    '',
  ];
  return out.join('\n');
}
