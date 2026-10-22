// ============================================================================
// The content JSON the newsletter generator reads today (R12, P20), contract
// v1: the generator renders it unchanged, twice. Key names and value types
// follow the generator's loader (config, officers, articles, minutes, events);
// two keys are added beside them and ignored by it: `contract_version` and
// the variable-length `roster`.
//
//   MEMBERS  members passages resolved as ordinary text: the printed and
//            emailed issue.
//   PUBLIC   each members passage, inline or block, becomes PUBLIC_PLACEHOLDER,
//            the same string whatever it replaced, so no length shows; a
//            members item gives its title, summary and the placeholder; a
//            members event gives only its date and area. The PDF hosted on
//            the site is rendered from this.
//
// What never appears, in either audience: an event's contact name or phone, a
// personal email (a mailto link outside nwflorida.us keeps only its text), or
// a home address (a member's home is stored as an area and a host office).
// Officers are display names under the generator's fixed nine keys, plus the
// whole roster; contact is by role alias only.
// ============================================================================
import type { Block, Inline, Tree } from '../content/tree.js';
import type { Entry } from '../events/service.js';
import { ZONE } from '../events/zone.js';

export const CONTRACT_VERSION = '1';
export const ORGANIZATION = 'Northwest Florida Mensa';
export const PUBLIC_PLACEHOLDER = 'Members-only passage. Sign in at nwflorida.us to read.';
export const MEMBERS_EVENT_TITLE = 'Members event, sign in for details';
export const VACANT = 'Vacant';

/** The generator's fixed officer keys (contract v1), mapped to office slugs. */
export const OFFICER_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['President', 'president'],
  ['Vice President', 'vice-president'],
  ['Treasurer', 'treasurer'],
  ['Membership Officer', 'membership'],
  ['Member at Large', 'member-at-large'],
  ['Past President', 'past-president'],
  ['Editor', 'editor'],
  ['Publications Officer', 'publications'],
  ['Webmaster', 'webmaster'],
];

export type ExportAudience = 'members' | 'public';

const AREA_LABELS: Record<string, string> = {
  okaloosa: 'Okaloosa',
  walton: 'Walton',
  bay: 'Bay',
  escambia_santa_rosa: 'Escambia and Santa Rosa',
  virtual: 'Online',
  elsewhere: 'Elsewhere',
};

const clock = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });

export interface ExportInput {
  audience: ExportAudience;
  edition: { slug: string; title: string; volume: number | null; issueNumber: number | null; calendarMonths: Array<{ year: number; month: number }> };
  /** In print order. For PUBLIC, `tree` is the public tree. */
  items: Array<{ kind: string; title: string; summary: string | null; visibility: 'public' | 'members'; tree: Tree }>;
  offices: Array<{ slug: string; title: string; holders: string[]; roleAlias: string }>;
  events: Array<{
    date: string;
    time: string | null;
    title: string;
    location: string;
    url: string;
    status: string;
    statusNote: string;
    visibility: 'public' | 'members';
    area: string;
  }>;
}

type ExportEvent = ExportInput['events'][number];

/**
 * A calendar entry as the export sees it. A business venue is its name,
 * address and city; a member's home is only its area and the host office's
 * role alias. The entry's detail (free text) is never carried.
 */
export function exportEvent(entry: Entry, aliasOf: ReadonlyMap<string, string>): ExportEvent {
  const { venue } = entry;
  const area = AREA_LABELS[venue?.area ?? entry.series?.area ?? ''] ?? '';
  let location = '';
  let venueUrl = '';
  if (venue?.kind === 'member_home') {
    const alias = aliasOf.get(venue.host_office_id ?? '') ?? '';
    location = `A member's home, ${area}${alias === '' ? '' : ` (contact ${alias})`}`;
  } else if (venue !== undefined) {
    location = [venue.name, venue.business_address, venue.city].filter((part) => part !== null && part !== '').join(', ');
    venueUrl = venue.url ?? '';
  }
  return {
    date: entry.localDate,
    time: entry.startsAt === null ? null : clock.format(entry.startsAt).replace(/\u202f/g, ' '),
    title: entry.title,
    location,
    url: entry.url !== '' ? entry.url : venueUrl,
    status: entry.status,
    statusNote: entry.statusNote,
    visibility: entry.visibility === 'members' ? 'members' : 'public',
    area,
  };
}

/** The months a calendar range touches, in order. */
export function monthsBetween(from: string, to: string): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  const end = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)) - 1;
  for (let index = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1; index <= end; index += 1) {
    months.push({ year: Math.floor(index / 12), month: (index % 12) + 1 });
  }
  return months;
}

export interface ContentJson {
  contract_version: string;
  audience: ExportAudience;
  config: { organization: string; volume: string; issue: string; month_year: string; calendar_months: Array<{ month: number; year: number }> };
  officers: Record<string, string>;
  roster: Array<{ office: string; holder: string; role_alias: string }>;
  articles: Array<{ title: string; content: string }>;
  minutes?: string;
  events: Record<string, Array<{ time?: string; title: string; location?: string; url?: string }>>;
}

const ROLE_ALIAS = /^mailto:([a-z0-9][a-z0-9.-]*@nwflorida\.us)$/;

/** Whether an inline node is, or holds at any depth, something members-only or withheld. */
function holdsMembers(node: Inline): boolean {
  if (node.type === 'text') return false;
  return node.type !== 'link' || node.children.some(holdsMembers);
}

function inlineText(node: Inline, audience: ExportAudience): string {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'link': {
      // A link whose text holds a members passage, at any depth, is members-only whole,
      // target included; a link of public text only, nested links too, is kept: both as
      // the public filter has it (content/tree.ts), so the export says what the site says.
      if (audience === 'public' && holdsMembers(node)) return PUBLIC_PLACEHOLDER;
      const label = node.children.map((child) => inlineText(child, audience)).join('');
      if (node.href.startsWith('https://')) return `${label} (${node.href})`;
      const alias = ROLE_ALIAS.exec(node.href)?.[1];
      return alias === undefined ? label : `${label} (${alias})`;
    }
    case 'members':
      return audience === 'members' ? node.children.map((child) => inlineText(child, audience)).join('') : PUBLIC_PLACEHOLDER;
    default:
      return PUBLIC_PLACEHOLDER;
  }
}

function blockText(node: Block, audience: ExportAudience): string {
  const inlines = (children: Inline[]): string => children.map((child) => inlineText(child, audience)).join('');
  const blocks = (children: Block[], separator: string): string =>
    children
      .map((child) => blockText(child, audience))
      .filter((text) => text !== '')
      .join(separator);
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inlines(node.children);
    case 'list':
      return node.items.map((item, index) => `${node.ordered ? `${index + 1}.` : '•'} ${blocks(item, ' ')}`).join('\n');
    case 'quote':
      return blocks(node.children, '\n\n');
    case 'image':
      return '';
    case 'members':
      return audience === 'members' ? blocks(node.children, '\n\n') : PUBLIC_PLACEHOLDER;
    default:
      return PUBLIC_PLACEHOLDER;
  }
}

/** A body tree as the generator's plain text: paragraphs separated by a blank line. */
export function treeText(tree: Tree, audience: ExportAudience): string {
  return tree.blocks
    .map((node) => blockText(node, audience))
    .filter((text) => text !== '')
    .join('\n\n');
}

function eventTitle(event: ExportEvent): string {
  if (event.status === 'scheduled') return event.statusNote === '' ? event.title : `${event.title} (${event.statusNote})`;
  return event.statusNote === '' ? `${event.title} (${event.status})` : `${event.title} (${event.status}: ${event.statusNote})`;
}

export function buildContentJson(input: ExportInput): ContentJson {
  const { audience } = input;
  const holders = (office: ExportInput['offices'][number] | undefined): string =>
    office === undefined || office.holders.length === 0 ? VACANT : office.holders.join(' and ');
  const bySlug = new Map(input.offices.map((office) => [office.slug, office]));

  const articles: ContentJson['articles'] = [];
  const minutes: string[] = [];
  for (const item of input.items) {
    const content =
      item.visibility === 'members' && audience === 'public'
        ? [item.summary ?? '', PUBLIC_PLACEHOLDER].filter((part) => part !== '').join('\n\n')
        : treeText(item.tree, audience);
    if (item.kind === 'minutes') minutes.push(`${item.title}\n\n${content}`);
    else articles.push({ title: item.title, content });
  }

  const events: ContentJson['events'] = {};
  for (const event of input.events) {
    const entry =
      event.visibility === 'members' && audience === 'public'
        ? { title: MEMBERS_EVENT_TITLE, ...(event.area !== '' ? { location: event.area } : {}) }
        : {
            ...(event.time !== null ? { time: event.time } : {}),
            title: eventTitle(event),
            ...(event.location !== '' ? { location: event.location } : {}),
            ...(event.url !== '' ? { url: event.url } : {}),
          };
    (events[event.date] ??= []).push(entry);
  }

  return {
    contract_version: CONTRACT_VERSION,
    audience,
    config: {
      organization: ORGANIZATION,
      volume: input.edition.volume === null ? '' : String(input.edition.volume),
      issue: input.edition.issueNumber === null ? '' : String(input.edition.issueNumber),
      month_year: input.edition.title,
      calendar_months: input.edition.calendarMonths.map(({ month, year }) => ({ month, year })),
    },
    officers: Object.fromEntries(OFFICER_KEYS.map(([key, slug]) => [key, holders(bySlug.get(slug))])),
    roster: input.offices.map((office) => ({ office: office.title, holder: holders(office), role_alias: office.roleAlias })),
    articles,
    ...(minutes.length > 0 ? { minutes: minutes.join('\n\n') } : {}),
    events,
  };
}
