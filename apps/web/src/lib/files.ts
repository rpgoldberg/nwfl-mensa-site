// /documents/<id>.pdf (REDACT R3c): a PDF streamed from the API as the public may
// have it (the API picks the redacted copy, or the original when nothing is
// withheld). Inline, under the name the API built from the redacted title,
// kept only when it is plain ASCII; otherwise the file's id. The cache rule is
// the site's (server/policy.mjs): public briefly when anonymous, private and
// never stored with a session cookie, never stored for a 404 or a 503.
import type { LiveData } from '../data/live';
import { ApiUnavailable } from './api/client';

export const NOT_READY_TEXT = 'This file is being prepared; try again in a minute.';
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,79}\.pdf$/;

/** A plain page: the site's text only, readable without the site's styles. */
function page(status: number, title: string, text: string, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Northwest Florida Mensa</title></head>
<body><main><h1>${title}</h1><p>${text}</p><p><a href="/">Go to the home page</a></p></main></body>
</html>
`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra } });
}

const notFound = () => page(404, 'No such file', 'There is no file at this address. It may have been moved or taken down.');

export async function serveFile(live: Pick<LiveData, 'file'> | undefined, id: string | undefined): Promise<Response> {
  if (live === undefined || id === undefined) return notFound();
  let file;
  try {
    file = await live.file(id);
  } catch (error) {
    if (error instanceof ApiUnavailable) return page(503, 'File temporarily unavailable', 'This file is temporarily unavailable. Please try again later.');
    throw error;
  }
  if (file.kind === 'not_found') return notFound();
  if (file.kind === 'not_ready') return page(503, 'File not ready yet', NOT_READY_TEXT, { 'Retry-After': '60' });
  const filename = SAFE_NAME.test(file.filename) ? file.filename : `${id}.pdf`;
  return new Response(file.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': String(file.size),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
