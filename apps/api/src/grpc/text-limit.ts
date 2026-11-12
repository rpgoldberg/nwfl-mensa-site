// ============================================================================
// The API's own cap on long free text (MARKUP-DOS round 2). The web form caps
// the officers' text box at 48 KiB as a browser posts it (apps/web/src/lib/
// editor/form.ts), but a caller that skips the site must meet the same cap
// here, before a handler parses or stores anything: the markup parser and
// the database are never handed more than this per field. The server's
// receive limit (READ_MAX_BYTES, grpc/server.ts) bounds the whole message.
// ============================================================================
import { Code, ConnectError } from '@connectrpc/connect';

/** 48 KiB: the web form's MARKUP_MAX_BYTES. */
export const TEXT_MAX_BYTES = 48 * 1024;

/** The size of `text` as a browser posts it: UTF-8 bytes, each line break (LF, CRLF or a lone CR) as CRLF. */
export function postedBytes(text: string): number {
  const lines = text.replace(/\r\n?/g, '\n');
  let breaks = 0;
  for (let at = lines.indexOf('\n'); at !== -1; at = lines.indexOf('\n', at + 1)) breaks += 1;
  return Buffer.byteLength(lines, 'utf8') + breaks;
}

/** Refuses the call, InvalidArgument, if any field is over the cap: "Too long: 49 KB of 48 KB in body_markup". */
export function refuseLongText(fields: Readonly<Record<string, string>>): void {
  for (const [field, text] of Object.entries(fields)) {
    // Each UTF-16 unit is at most 3 bytes, a line break at most 2: short text needs no count.
    if (text.length * 3 <= TEXT_MAX_BYTES) continue;
    const bytes = postedBytes(text);
    if (bytes > TEXT_MAX_BYTES) {
      throw new ConnectError(`Too long: ${Math.ceil(bytes / 1024)} KB of ${TEXT_MAX_BYTES / 1024} KB in ${field}`, Code.InvalidArgument);
    }
  }
}
