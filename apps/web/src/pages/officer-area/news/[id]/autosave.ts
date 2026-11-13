// EDITOR E3 round 2: the edit page's auto-save (public/scripts/editor.js), for a draft only. The script
// posts the edit form here as it stands, with the base the page was opened from; the API saves it as an
// automatic save (SaveDraft auto), which saves a draft only and refuses a base someone else has changed
// since, writing nothing. The answer is for the script, never a page, and never cached:
//   200 { base, savedAt }  saved: the new base, and the time in Central ("2:05 pm");
//   409                     someone else changed it since: the script stops, the text kept;
//   401                     no session or no sign-in: the script stops; Save draft keeps the text;
//   422                     no longer a draft (sent for approval, approved, published): the script stops;
//   400                     a field not right yet (a title being typed): the script tries again later;
//   413 / 415               not the form; 403 / 404 not this person's item; 503 the API is not there.
// Like the edit page, it answers 404 for an item none of the person's offices writes (E7A-FIX), before any
// save: at once for someone who holds no office, else once the roster and the item are read.
// Astro's origin check (security.checkOrigin) refuses a cross-site post first, as for the form.
import type { APIRoute } from 'astro';
import { ApiNotFound } from '../../../../lib/api/client';
import { DraftChanged, EditorRefused, NotAllowed, SignInAgain, editorAdmits, editorApi, editorReader } from '../../../../lib/api/editor';
import { runtimeDeps } from '../../../../lib/auth/flow';
import { EDIT_FORM_LIMIT, parseDraft } from '../../../../lib/editor/form';
import { clockText, mayHoldAnOffice, mayWriteFor, postingOffices } from '../../../../lib/editor/writer';
import { readForm } from '../../../../lib/form';

export const prerender = false;

/** The API's refusal of an automatic save of anything but a draft. */
const NOT_A_DRAFT = 'an automatic save only saves a draft';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An answer for the script: JSON, never cached; a refusal of the body closes the connection. */
function answer(status: number, body: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      ...(status === 413 ? { Connection: 'close' } : {}),
      ...(status === 405 ? { Allow: 'POST' } : {}),
    },
  });
}

/** Only a post saves; anything else finds nothing to read. */
export const GET: APIRoute = () => answer(405);

export const POST: APIRoute = async ({ params, request, locals }) => {
  const id = params['id'] ?? '';
  if (!UUID.test(id)) return answer(404);
  const session = locals.session;
  if (!session) return answer(401, { problem: 'sign-in' });
  if (!editorAdmits(session) || !mayHoldAnOffice(session.groups)) return answer(404);
  const api = editorApi();
  if (api === undefined) return answer(503);
  const deps = runtimeDeps();
  const { reader } = editorReader(session, deps);
  if (reader === undefined) return answer(401, { problem: 'sign-in' });
  try {
    const [roster, current] = await Promise.all([api.offices(), api.getWorkingItem(reader, id)]);
    if (!mayWriteFor(postingOffices(session.groups, roster), current)) return answer(404);
    const read = await readForm(request, EDIT_FORM_LIMIT);
    if (!read.ok) return answer(read.status);
    const parsed = parseDraft(read.field);
    if (!parsed.ok) return answer(400, { problem: 'form' });
    const { item } = await api.saveDraft(reader, { itemId: id, ...parsed.value, base: read.field('base') ?? '', auto: true });
    return answer(200, { base: item.working?.base ?? '', savedAt: clockText(new Date(deps.now() * 1000)) });
  } catch (error) {
    if (error instanceof DraftChanged) return answer(409, { problem: 'changed' });
    if (error instanceof SignInAgain) return answer(401, { problem: 'sign-in' });
    if (error instanceof EditorRefused) return error.reason === NOT_A_DRAFT ? answer(422, { problem: 'not-draft' }) : answer(400, { problem: 'refused' });
    if (error instanceof NotAllowed) return answer(403);
    if (error instanceof ApiNotFound) return answer(404);
    return answer(503);
  }
};
