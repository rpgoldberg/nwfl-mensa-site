// A stand-in gate child for the "text" job (ARCHIVE-SEARCH S2): it answers one page naming the kind of job and the
// size of the copy it was sent, with the quotes as the extra; or, by its first quote, a refusal or a page over the cap.
import { createHash } from 'node:crypto';

process.once('message', (message) => {
  const { kind, copy, quotes } = message as { kind?: string; copy: Uint8Array; quotes: string[] };
  const sha256 = createHash('sha256').update(copy).digest('hex');
  let reply: object = { sha256, pages: [{ text: `${kind}:${copy.length}`, extra: quotes.join('|') }] };
  if (quotes[0] === 'refuse') reply = { sha256, code: 'withheld' };
  if (quotes[0] === 'big') reply = { sha256, pages: [{ text: 'a'.repeat(64 * 1024 + 1), extra: '' }] };
  if (quotes[0] === 'other') reply = { sha256: createHash('sha256').update('other bytes').digest('hex'), pages: [{ text: 'other', extra: '' }] };
  if (quotes[0] === 'code') reply = { sha256, code: 'rules' };
  process.send?.(reply, () => process.exit(0));
});
