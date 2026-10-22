// On request, as the answer depends on the host the reader asked for.
import type { APIRoute } from 'astro';
import { robotsTxt } from '../lib/seo';

export const prerender = false;

export const GET: APIRoute = ({ url }) => new Response(robotsTxt(url.hostname), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
