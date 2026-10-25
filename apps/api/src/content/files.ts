// ============================================================================
// REDACT R3c: ContentService.ReadFile, a PDF's bytes as the caller's audience
// may have them. The audience comes from the verified caller (auth/caller.ts).
//
// A file is served only when its owner is: the live version of a published
// item the audience may see (the published reads' rule, service.ts), not
// hidden from it by the lens, or a published edition's issue PDF. Then
// pdf/store.ts decides the bytes: the current redacted copy, or the original
// only when every one of the audience's cells is "show"; never a stale copy.
//
// Two answers besides the bytes: "not ready" (the copy is still being made)
// and NOT_FOUND "file not found", given alike for a missing file, a withheld
// one (hidden, refused, another audience's, unpublished) and one over the cap.
// ============================================================================
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import { type Audience, callerOf } from '../auth/caller.js';
import type { Db } from '../db/pool.js';
import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ReadFileResponseSchema } from '../gen/nwfl/mensa/v1/content_pb.js';
import { loadLens } from '../redaction/lens.js';
import { subjectKey } from '../redaction/render.js';
import { type ReadResult, readPdf } from '../pdf/store.js';
import { itemHidden } from './redact.js';

type Query = Pick<Db, 'query'>;

/** R11: the most a file read serves. */
export const MAX_SERVED_BYTES = 10 * 1024 * 1024;
/** Each streamed chunk, well under the web's 4 MiB message cap. */
export const CHUNK_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME = 80;

/** A file's download name: the title in lower-case ASCII letters, digits and hyphens, else the id; ends in .pdf. */
export function fileName(title: string | null, id: string): string {
  const base = (title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_NAME)
    .replace(/^-+|-+$/g, '');
  return `${base === '' ? id : base}.pdf`;
}

/** The file's title as this audience sees it, or null when the audience may not have the file. */
export async function servableFile(db: Query, fileId: string, audience: Audience): Promise<{ title: string | null } | null> {
  const { rows } = await db.query<{ item_id: string | null; version_id: string | null; title: string | null; on_behalf_of: string | null; edition_title: string | null }>(
    `SELECT i.id AS item_id, v.id AS version_id, v.title, v.on_behalf_of, e.title AS edition_title
     FROM stored_file f
     LEFT JOIN content_version v ON v.id = f.version_id
     LEFT JOIN content_item i ON i.live_version_id = v.id AND i.state = 'published' AND ($2 OR v.visibility <> 'officers')
     LEFT JOIN edition e ON e.id = f.edition_id AND e.status = 'published'
     WHERE f.id = $1 AND f.mime_type = 'application/pdf' AND (i.id IS NOT NULL OR e.id IS NOT NULL)`,
    [fileId, audience === 'officers'],
  );
  const row = rows[0];
  const items = row?.item_id ? [row.item_id] : [];
  const lens = await loadLens(db, audience, { items, versions: row?.version_id ? [row.version_id] : [] }, { uniform: true });
  if (row === undefined) return null;
  if (row.item_id === null) return { title: row.edition_title };
  if (itemHidden({ id: row.item_id, on_behalf_of: row.on_behalf_of }, row.version_id as string, lens)) return null;
  return { title: lens.text(row.title as string, [subjectKey('content_item', row.item_id)]) };
}

export interface FileDeps {
  db: Db;
  /** Seams for the unit tests. */
  find?: typeof servableFile;
  read?: (db: Db, fileId: string, audience: string) => Promise<ReadResult>;
}

type Part = MessageInitShape<typeof ReadFileResponseSchema>;

const notFound = (): ConnectError => new ConnectError('file not found', Code.NotFound);

export function fileHandlers(deps: FileDeps): { readFile: (request: { fileId: string }, ctx: HandlerContext) => AsyncGenerator<Part> } {
  const find = deps.find ?? servableFile;
  const read = deps.read ?? readPdf;
  return {
    async *readFile(request, ctx): AsyncGenerator<Part> {
      const audience = callerOf(ctx.values).audience;
      if (!UUID.test(request.fileId)) throw notFound();
      const file = await find(deps.db, request.fileId, audience);
      if (file === null) throw notFound();
      const result = await read(deps.db, request.fileId, audience);
      if (result.kind === 'not_ready') {
        yield { part: { case: 'notReady', value: {} } };
        return;
      }
      if (result.kind !== 'pdf' || result.pdf.length > MAX_SERVED_BYTES) throw notFound();
      yield { part: { case: 'head', value: { filename: fileName(file.title, request.fileId), mimeType: 'application/pdf', sizeBytes: BigInt(result.pdf.length) } } };
      for (let at = 0; at < result.pdf.length; at += CHUNK_BYTES) {
        // A cancelled call, or the server's drain deadline, stops the stream between chunks.
        ctx.signal.throwIfAborted();
        yield { part: { case: 'chunk', value: result.pdf.subarray(at, at + CHUNK_BYTES) } };
      }
    },
  };
}
