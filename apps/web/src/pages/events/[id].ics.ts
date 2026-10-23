// One public event as a calendar file: "Add to my calendar" (R4). On request.
import type { APIRoute } from 'astro';
import { liveData } from '../../data';
import { eventFeed } from '../../lib/feeds';

export const prerender = false;

export const GET: APIRoute = ({ params, url }) => eventFeed(liveData(), params['id'], { now: new Date(), origin: url.origin });
