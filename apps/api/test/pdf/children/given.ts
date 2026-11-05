// A stand-in engine, subverted: it hands back as its "copy" the bytes of the file its first quote
// names, whatever the original (fix round 3, M1: a copy made to read one way to the gate's object
// reader and another to a viewer). The gate gets the same quotes, so the name is one more quote.
// It says it kept every link it was given (LINKS L3 fix 1, N8), whatever the copy holds.
import { readFileSync } from 'node:fs';

process.once('message', (message) => {
  const { request } = message as { request: { quotes: string[]; links?: Array<{ id: string }> } };
  const pdf = new Uint8Array(readFileSync(request.quotes[0] as string));
  process.send?.({ ok: true, result: { kind: 'redacted', pdf, boxes: [], kept: (request.links ?? []).map((link) => link.id) } }, () => process.exit(0));
});
