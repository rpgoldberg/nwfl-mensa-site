// The whole public calendar, for a phone to subscribe to (R4). On request.
import type { APIRoute } from 'astro';
import { liveData } from '../data';
import { calendarFeed } from '../lib/feeds';

export const prerender = false;

export const GET: APIRoute = ({ url }) => calendarFeed(liveData(), { now: new Date(), origin: url.origin });
