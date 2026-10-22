// What the on-request pages read (R22): the roster, the newsletter issues,
// the minutes and the treasurer's summaries. The API adapter replaces the
// fixture adapter when the API lands; the pages do not change.
import type { ContentSource } from '../lib/content';

export interface Office {
  slug: string;
  title: string;
  /** The holder's display name; none for a vacant seat. */
  holder?: string;
  /** The role address, e.g. president@nwflorida.us. */
  alias: string;
  /** Shown only once a test message to it has been delivered (R2, C2a). */
  aliasVerified: boolean;
  source: ContentSource;
}

export interface Issue {
  /** The first month the issue covers, YYYY-MM. */
  period: string;
  label: string;
  volume?: number;
  number?: number;
  /** No copy is known to exist anywhere. */
  missing?: boolean;
  source: ContentSource;
}

export interface Meeting {
  date: string;
  kind: string;
  /** The area, never a street address (R3). */
  place: string;
  summary: string;
  /** By office, plus a count of other members; other members are never named (R6). */
  attendance: { offices: string[]; others: number };
  reports: { office: string; title: string }[];
  source: ContentSource;
}

/** One period of the treasurer's summary, in cents (R7: totals only). */
export interface FinancePeriod {
  label: string;
  opening: number;
  deposits: number;
  debits: number;
  closing: number;
  /** The day the Executive Committee accepted it. */
  acceptedOn: string;
  source: ContentSource;
}

export interface SiteData {
  /** Made-up data: the pages say so. */
  isSample: boolean;
  offices(): Promise<Office[]>;
  issues(): Promise<Issue[]>;
  meetings(): Promise<Meeting[]>;
  finances(): Promise<FinancePeriod[]>;
}

export interface RosterEntry {
  slug: string;
  title: string;
  holder: string | undefined;
  email: string | undefined;
  vacant: boolean;
  source: ContentSource;
}

export function rosterView(offices: readonly Office[]): RosterEntry[] {
  return offices.map((o) => ({
    slug: o.slug,
    title: o.title,
    holder: o.holder,
    email: o.aliasVerified ? o.alias : undefined,
    vacant: o.holder === undefined,
    source: o.source,
  }));
}

const newestFirst = (a: Issue, b: Issue) => b.period.localeCompare(a.period);

/** The newest issue we have a copy of. */
export function currentIssue(issues: readonly Issue[]): Issue | undefined {
  return issues.filter((i) => !i.missing).sort(newestFirst)[0];
}

/** Every other issue, by year, newest first; missing issues are listed too. */
export function issuesByYear(issues: readonly Issue[]): [string, Issue[]][] {
  const current = currentIssue(issues);
  const years = new Map<string, Issue[]>();
  for (const issue of [...issues].sort(newestFirst)) {
    if (issue === current) continue;
    const year = issue.period.slice(0, 4);
    years.set(year, [...(years.get(year) ?? []), issue]);
  }
  return [...years];
}

export function balanced(p: FinancePeriod): boolean {
  return p.opening + p.deposits - p.debits === p.closing;
}

export function attendanceText({ offices, others }: Meeting['attendance']): string {
  const rest = others === 0 ? '' : `, and ${others} other member${others === 1 ? '' : 's'}`;
  return `${offices.join(', ')}${rest}`;
}
