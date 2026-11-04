// A stand-in gate child that passes with checked bytes one over the output cap (20 MiB), or with checked
// bytes that are not bytes, as the first quote says (M1: no pass then).
import { createHash } from 'node:crypto';

process.once('message', (message) => {
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  const sha = createHash('sha256').update(copy).digest('hex');
  const pdf = quotes[0] === 'text' ? 'not bytes' : new Uint8Array(20 * 1024 * 1024 + 1);
  process.send?.({ verdict: { pass: true }, sha256: sha, checked: { pdf, sha256: sha } }, () => process.exit(0));
});
