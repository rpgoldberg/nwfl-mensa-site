// One public event as a calendar file: "Add to my calendar" (R4). On request.
import type { APIRoute } from 'astro';
import { liveData } from '../../data';
import { eventFeed } from '../../lib/feeds';
import { publicOrigin } from '../../lib/origin';

export const prerender = false;

export const GET: APIRoute = ({ params, request, site }) => eventFeed(liveData(), params['id'], { now: new Date(), origin: publicOrigin(request, site) });
