// The whole public calendar, for a phone to subscribe to (R4). On request.
import type { APIRoute } from 'astro';
import { liveData } from '../data';
import { calendarFeed } from '../lib/feeds';
import { publicOrigin } from '../lib/origin';

export const prerender = false;

export const GET: APIRoute = ({ request, site }) => calendarFeed(liveData(), { now: new Date(), origin: publicOrigin(request, site) });
