// PDFVIEW: /read/<id>, an issue read inside the site (src/pages/read/[id].astro,
// public/scripts/reader.js). The page never chooses a copy: the browser fetches
// the same-origin /documents/<id>.pdf with the reader's cookies, and the site
// serves whatever copy the API gives that reader (src/lib/files.ts). Here the
// page only learns, from the file's head and never its bytes, whether the
// reader may have the file at all (else the same 404 as a missing file) and
// which copy it is: the public's, or one with more in it than the public's (a
// members copy, or a member's or officer's copy of a public file), so the page
// can say so. Every path it gives is built from the id, a
// file id or nothing; no URL ever comes from the query.
import type { LiveData } from '../data/live';
import type { FileRead, Reader } from './api/client';

export const PUBLIC_COPY = 'Public copy: some personal details are hidden for privacy. Members can sign in for the full issue.';
export const MEMBERS_COPY = 'Members copy';
export const NEEDS_SCRIPT = 'Reading the issue on this page needs JavaScript, which is off or blocked. You can still open it in another app, or download it.';

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Copy = 'public' | 'members';
export type ReadView = { kind: 'not_found' } | { kind: 'not_ready' } | ({ kind: 'ok'; copy: Copy; filename: string } & ReturnType<typeof readPaths>);

/** The file the reader shows, the same file to download, and the reader's own page. */
export function readPaths(id: string): { pdf: string; download: string; read: string } {
  return { pdf: `/documents/${id}.pdf`, download: `/documents/${id}.pdf?download=1`, read: `/read/${id}` };
}

const FILE_PATH = /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/;

/** Where /news sends a reader for a file: /read/<id> for /documents/<id>.pdf, and the file itself for anything else. */
export function readerPath(href: string): string {
  const id = FILE_PATH.exec(href)?.[1];
  return id === undefined ? href : readPaths(id).read;
}

/** The head was enough: the bytes are let go unread. */
async function letGo(read: FileRead): Promise<void> {
  if (read.kind !== 'pdf') return;
  try {
    await read.body.cancel();
  } catch {
    // Nothing was waiting on it.
  }
}

/**
 * What /read/<id> shows this reader: their copy and which it is, not ready, or not found. A signed-in
 * reader's copy is the public's when the public may have the same file; otherwise it is a members copy.
 * The API being unavailable is let through (ApiUnavailable), for the page to say so.
 */
export async function readView(live: Pick<LiveData, 'file'> | undefined, id: string | undefined, as: Reader | undefined): Promise<ReadView> {
  if (live === undefined || id === undefined || !FILE_ID.test(id)) return { kind: 'not_found' };
  const mine = await live.file(id, as);
  await letGo(mine);
  if (mine.kind !== 'pdf') return { kind: mine.kind };
  let copy: Copy = 'public';
  if (as !== undefined) {
    // The public's copy of the same file, by its head: the reader's is the public's only when the public
    // has it too, under the same name and at the same size. Otherwise it is a members copy, or a member's
    // or an officer's own copy of a public file, with more in it than the public's: never "public".
    const publics = await live.file(id);
    await letGo(publics);
    if (publics.kind !== 'pdf' || publics.size !== mine.size || publics.filename !== mine.filename) copy = 'members';
  }
  return { kind: 'ok', copy, filename: mine.filename, ...readPaths(id) };
}
