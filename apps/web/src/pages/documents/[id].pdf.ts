// A published item's PDF, as the public may have it (REDACT R3c). On request.
import type { APIRoute } from 'astro';
import { liveData } from '../../data';
import { serveFile } from '../../lib/files';

export const prerender = false;

export const GET: APIRoute = ({ params }) => serveFile(liveData(), params['id']);
