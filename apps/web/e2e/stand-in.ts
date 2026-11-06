// What the stand-in API (e2e/api.mjs) serves, for the specs that check it.
// Kept by hand in step with api.mjs, which is plain Node and loads no TypeScript.

/** Two events the site must never show: a members event sent in full, and one with no status. */
export const CANARIES = { membersInFull: { id: '7c8d9eaf-b0c1-42d3-a4f5-a6b7c8d9e0f1', title: 'MEMBERS-ONLY CANARY PICNIC' }, noStatus: { id: '8d9eafb0-c1d2-43e4-b5a6-b7c8d9e0f1a2', title: 'UNPUBLISHED CANARY' } };

/** Every Sunday, withheld: the public gets its date and area only. */
export const MEMBERS_SERIES = '2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6';

/** Every Wednesday at Sample Bistro; the third Wednesday from today is cancelled. */
export const LUNCH_SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';

/** Three days from today, at a member's home (the President hosts). */
export const BOARD_GAMES = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';

/** A month with no events at all (api.mjs lists nothing before 2020). */
export const EMPTY_MONTH = '2019-06';

/** Today in Central, YYYY-MM-DD. */
export function centralToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next Sunday after today, when the members series meets. */
export function nextSunday(): string {
  const today = centralToday();
  return addDays(today, 7 - new Date(`${today}T00:00:00Z`).getUTCDay());
}

export function monthAfter(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}

/**
 * The newsletter, as the issue loader publishes it: each issue one public DOCUMENT holding a public
 * PDF and a members PDF. api.mjs sends each members file in the list too, as a buggy API might, and
 * every file's hash and size: the site must show none of them. Newest issue first, as /news lists
 * them; the API's own order is by approval, and the August issue was approved last.
 */
export const NEWSLETTER = {
  issues: [
    { title: 'Pensa Mensa, October-November 2026', summary: 'Volume 30, Number 5', id: 'd0c00000-0000-4000-8000-000000000010', publicPdf: 'f0000000-0000-4000-8000-000000000010', membersPdf: 'f1000000-0000-4000-8000-000000000010' },
    // The API gives this one's id in its slug field, as it does when anything in an item is withheld.
    { title: 'Pensa Mensa, August-September 2026', summary: 'Volume 30, Number 4', id: 'd0c00000-0000-4000-8000-000000000008', publicPdf: 'f0000000-0000-4000-8000-000000000008', membersPdf: 'f1000000-0000-4000-8000-000000000008' },
    { title: 'Pensa Mensa, June-July 2026', summary: 'Volume 30, Number 3', id: 'd0c00000-0000-4000-8000-000000000006', publicPdf: 'f0000000-0000-4000-8000-000000000006', membersPdf: 'f1000000-0000-4000-8000-000000000006' },
    { title: 'Pensa Mensa, February-March 2025', summary: 'Volume 29, Number 2', id: 'd0c00000-0000-4000-8000-000000000002', publicPdf: 'f0000000-0000-4000-8000-000000000002', membersPdf: 'f1000000-0000-4000-8000-000000000002' },
  ],
  /** A members item in an issue's shape, sent in full: never listed for the public. */
  membersOnly: { title: 'Pensa Mensa, April-May 2026', id: 'd0c00000-0000-4000-8000-000000000004', publicPdf: 'f0000000-0000-4000-8000-000000000004', membersPdf: 'f1000000-0000-4000-8000-000000000004' },
  /** A public document that is not an issue, with its PDF: not on /news. */
  other: { title: 'Our bylaws', id: 'd0c00000-0000-4000-8000-0000000000b1', publicPdf: 'f0000000-0000-4000-8000-0000000000b1' },
  /** The hash every file carries, in hex, and its size in bytes. */
  sha256Hex: 'ab'.repeat(32),
  sizeBytes: 987_654,
};

/** A14: the test identity provider's people (e2e/idp.mjs), by login, with their subjects. */
export const ACCOUNTS = {
  officer: '00000000-0000-4000-8000-0000000000a1',
  member: '00000000-0000-4000-8000-0000000000b2',
  mixed: '00000000-0000-4000-8000-0000000000b3',
  pending: '00000000-0000-4000-8000-0000000000c3',
  refused: '00000000-0000-4000-8000-0000000000e5',
  lapsed: '00000000-0000-4000-8000-0000000000f6',
  'articles-down': '00000000-0000-4000-8000-0000000000a7',
  stale: '00000000-0000-4000-8000-0000000000b8',
  'officer-only': '00000000-0000-4000-8000-0000000000a9',
  enrolee: '00000000-0000-4000-8000-0000000000c1',
  'enrolee-pending': '00000000-0000-4000-8000-0000000000c2',
  'lapsed-outsider': '00000000-0000-4000-8000-0000000000c4',
  admin: '00000000-0000-4000-8000-0000000000ad',
  webmaster: '00000000-0000-4000-8000-0000000000eb',
  'lone-admin': '00000000-0000-4000-8000-0000000000ae',
  'lapsed-admin': '00000000-0000-4000-8000-0000000000af',
  newcomer: '00000000-0000-4000-8000-0000000000d1',
  invitee: '00000000-0000-4000-8000-0000000000d2',
  approver: '00000000-0000-4000-8000-0000000000d3',
  'turned-down': '00000000-0000-4000-8000-0000000000d5',
  'lone-approver': '00000000-0000-4000-8000-0000000000d6',
  'lone-webmaster': '00000000-0000-4000-8000-0000000000d7',
};

/**
 * W-SIGNUP: the sign-ups waiting in api.mjs's queue (SIGNUP_QUEUE there), oldest first. The stand-in
 * keeps sign-ups and decisions per sign-in (the access token's jti), so tests in parallel cannot
 * disturb each other. "Blair Example" is the approver's own sign-up, which they may not decide;
 * "Harper Placeholder" was found in another local group, so it is never approved as a member.
 * The member accounts were last checked on October 20, 2026.
 */
export const SIGNUP_QUEUE = [
  { name: 'Jesse Example', email: 'jesse@example.org', route: 'Invited by an officer', check: 'Found on our group\u2019s membership list, on November 2, 2026' },
  { name: 'Kendall Sample', email: 'kendall@example.org', route: 'Signed up on the site', check: 'Not found on the membership list (members who opted out or lapsed may not appear), on November 2, 2026' },
  { name: 'Harper Placeholder', email: 'harper@example.org', route: 'Signed up on the site', check: 'Found as a member of another local group, on November 3, 2026' },
  { name: 'Blair Example', email: 'blair@example.org', route: 'Signed up on the site', check: 'Not checked yet' },
] as const;
export const MEMBER_CHECKED_ON = 'October 20, 2026';

/**
 * SOLO-APPROVE: the approval rule as api.mjs answers each officer. The real API holds one setting for
 * everyone; the stand-in keeps one per signed-in subject, so tests in parallel cannot disturb each
 * other: "officer" reads publishing content as set to one approver (by the Admin on November 3, 2026),
 * "long-name" reads two approvers, and the Admin's own setting starts at two approvers and is the one
 * the Admin's switch changes.
 */
export const APPROVAL = {
  oneApproverNote: "One approver: a second person's approval is not required right now (set by the Admin on November 3, 2026).",
  /** src/lib/approval-rules.ts NOTE_UNKNOWN: what an officer reads when the setting could not be read. */
  unknownNote: 'We could not check the approval setting just now.',
};

/**
 * A14: the newsletter's articles (api.mjs ARTICLES). The public article carries a members passage and a
 * members PDF; the members and officers articles are listed for the public too, in full, as a buggy API
 * might. A member sees the passage, the members article and the members PDF; nobody sees the officers
 * article on /news; the public sees the members articles by title and summary only (D1 teasers), and none of the rest. A member's answer also carries redacted nodes, as the API
 * sends a member a privacy mark its members lens withholds: one beside the passage, one in the members
 * article, and a members article withheld whole (a lone redacted node), which a member sees by its title.
 */
export const ARTICLES = {
  open: { title: 'A new home for the Wednesday lunch', plain: 'The new place has a quiet back room.', passage: 'MEMBERS PASSAGE CANARY: the side gate code is 4321.', publicPdf: 'e0f00000-0000-4000-8000-000000000001', membersPdf: 'e1f00000-0000-4000-8000-000000000001', sourcePdf: 'e3f00000-0000-4000-8000-000000000001' },
  members: { title: 'Members picnic sign-up', summary: 'Bring a dish to share.', body: 'MEMBERS ARTICLE CANARY: the picnic is at the north shelter.' },
  officers: { title: 'OFFICERS ARTICLE CANARY', body: 'OFFICERS BODY CANARY', pdf: 'e2f00000-0000-4000-8000-000000000003' },
  withheld: { title: 'Members trip notes, withheld whole', summary: 'Notes from the trip.' },
};

/** A14: the members source files api.mjs lists before each members copy, to anyone but the public (api.mjs sourceOf): never linked. */
export const SOURCE_PDFS = [...NEWSLETTER.issues.map((i) => `f3${i.membersPdf.slice(2)}`), ARTICLES.open.sourcePdf];

/**
 * PDFVIEW fix 2: the issues the stand-in API lists as a public copy alone to the "mixed" member (api.mjs
 * MIXED_PUBLIC_ONLY): the newest, which is the card, and the oldest, which is a row. The other issues
 * keep their members copies for that member.
 */
export const MIXED = { card: NEWSLETTER.issues[0]!, row: NEWSLETTER.issues[3]! };

/** The marker line in a members copy's bytes (api.mjs MEMBERS_PDF). */
export const MEMBERS_PDF_MARK = '% members copy';

/**
 * LINKS L4: the links the stand-in API resolves (e2e/api.mjs LINKS), all on the newest issue's public PDF,
 * last checked (or turned off) on November 4, 2026. `members`: for a member only. The last three are what
 * a buggy API might send, and the site must refuse to render: each is the leaving page's 404.
 */
export const LINKS = {
  web: { id: 'outwebaaaaaaaaaaaaaaaaaaaa', url: 'https://club.example/picnic?day=sat', host: 'club.example', page: 2 },
  social: { id: 'outsocialaaaaaaaaaaaaaaaaa', url: 'https://www.facebook.com/groups/nwfl-sample', host: 'www.facebook.com', page: 1 },
  mail: { id: 'outmailaaaaaaaaaaaaaaaaaaa', url: 'mailto:events@example.org', host: 'example.org', page: 1 },
  off: { id: 'outoffaaaaaaaaaaaaaaaaaaaa', url: 'https://parked.example/', host: 'parked.example', page: 3 },
  members: { id: 'outmembersaaaaaaaaaaaaaaaa', url: 'https://club.example/members-night', host: 'club.example', page: 1 },
  long: { id: 'outlongaaaaaaaaaaaaaaaaaaa', host: 'club.example', page: 1 },
  script: { id: 'outscriptaaaaaaaaaaaaaaaaa' },
  angles: { id: 'outanglesaaaaaaaaaaaaaaaaa' },
  rtl: { id: 'outrtlaaaaaaaaaaaaaaaaaaaa' },
  /** No link at all. */
  unknown: { id: 'outnoneaaaaaaaaaaaaaaaaaaa' },
  file: 'f0000000-0000-4000-8000-000000000010',
  checked: 'November 4, 2026',
} as const;
