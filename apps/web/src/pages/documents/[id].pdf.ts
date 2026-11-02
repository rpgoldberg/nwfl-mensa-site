// A published item's PDF, as the public, or the signed-in reader, may have it (REDACT R3c, A14). On request.
import type { APIRoute } from 'astro';
import { liveData } from '../../data';
import { readerFor } from '../../lib/auth/bearer';
import { runtimeDeps } from '../../lib/auth/flow';
import { serveFile } from '../../lib/files';

export const prerender = false;

export const GET: APIRoute = ({ params, locals }) => serveFile(liveData(), params['id'], readerFor(locals.session, runtimeDeps()).reader);
