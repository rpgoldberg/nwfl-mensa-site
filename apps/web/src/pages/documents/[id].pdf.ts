// A published item's PDF, as the public, or the signed-in reader, may have it (REDACT R3c, A14). On request.
// PDFVIEW: ?download=1, and only that, asks for it as an attachment (the reader's Download).
import type { APIRoute } from 'astro';
import { liveData } from '../../data';
import { readerFor } from '../../lib/auth/bearer';
import { runtimeDeps } from '../../lib/auth/flow';
import { serveFile } from '../../lib/files';

export const prerender = false;

export const GET: APIRoute = ({ params, locals, url }) =>
  serveFile(liveData(), params['id'], readerFor(locals.session, runtimeDeps()).reader, { download: url.searchParams.get('download') === '1' });
