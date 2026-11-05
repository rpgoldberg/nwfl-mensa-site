// A stand-in gate child that passes, its "checked" bytes the links it was given (JSON): origin, links and kept
// (LINKS L3), so a test sees what the sidecar hands its child.
import { createHash } from 'node:crypto';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

process.once('message', (message) => {
  const { copy, origin, links, kept } = message as { copy: Uint8Array; origin?: unknown; links?: unknown; kept?: unknown };
  const pdf = new TextEncoder().encode(JSON.stringify({ origin: origin ?? null, links: links ?? null, kept: kept ?? null }));
  process.send?.({ verdict: { pass: true }, sha256: sha(copy), checked: { pdf, sha256: sha(pdf) } }, () => process.exit(0));
});
