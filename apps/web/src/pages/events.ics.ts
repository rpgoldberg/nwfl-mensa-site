// The whole public calendar under the page's new name (W-LOOK); /calendar.ics
// stays, as phones already subscribed to it must keep their feed. On request.
import type { APIRoute } from 'astro';
import { liveData } from '../data';
import { calendarFeed } from '../lib/feeds';

export const prerender = false;

export const GET: APIRoute = ({ url }) => calendarFeed(liveData(), { now: new Date(), origin: url.origin });
