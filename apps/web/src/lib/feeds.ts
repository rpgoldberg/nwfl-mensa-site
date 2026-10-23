// The calendar files (R4): /calendar.ics, the whole public calendar a phone
// subscribes to, and one event's .ics. Public events only, from the live data;
// with no API there are no events to list, and an API that does not answer is
// a plain-words 503 that nothing stores.
import type { LiveData } from '../data/live';
import { attempt } from './api/page';
import { addDays, eventIdFromParam, toIcsEvent, todayCentral } from './calendar';
import { calendarFile } from './ics';
import { SITE_NAME } from './site';

/** A month back and a year ahead: within the API's 400-day range. */
export const FEED_PAST_DAYS = 31;
export const FEED_FUTURE_DAYS = 365;

interface FeedContext {
  now: Date;
  /** This site's origin, for each event's link back. */
  origin: string;
}

const UNAVAILABLE = 'The calendar is temporarily unavailable. Please try again in a few minutes.\n';
const NOT_FOUND = 'We could not find that event.\n';

const plain = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

const ics = (body: string, filename: string) =>
  new Response(body, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="${filename}"` } });

export async function calendarFeed(live: LiveData | undefined, { now, origin }: FeedContext): Promise<Response> {
  const today = todayCentral(now);
  const loaded = live === undefined ? ({ ok: true, value: [] } as const) : await attempt(() => live.events(addDays(today, -FEED_PAST_DAYS), addDays(today, FEED_FUTURE_DAYS)));
  if (!loaded.ok) return plain(UNAVAILABLE, 503);
  return ics(calendarFile(loaded.value.map((e) => toIcsEvent(e, origin)), { now, name: SITE_NAME }), 'nwfl-mensa.ics');
}

/** `param` is the event page's own last path segment. */
export async function eventFeed(live: LiveData | undefined, param: string | undefined, { now, origin }: FeedContext): Promise<Response> {
  const id = eventIdFromParam(param);
  if (id === undefined || live === undefined) return plain(NOT_FOUND, 404);
  const loaded = await attempt(() => live.event(id));
  if (!loaded.ok) return plain(UNAVAILABLE, 503);
  if (loaded.value === undefined) return plain(NOT_FOUND, 404);
  const { event } = loaded.value;
  const name = `${event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${event.date}.ics`;
  return ics(calendarFile([toIcsEvent(event, origin)], { now, name: SITE_NAME }), name);
}
