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
