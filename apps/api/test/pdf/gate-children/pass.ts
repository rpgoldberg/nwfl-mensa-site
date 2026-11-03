// A stand-in gate child that passes every copy, with the sha256 of the bytes it was sent.
import { createHash } from 'node:crypto';
process.once('message', (message) => {
  const { copy } = message as { copy: Uint8Array };
  process.send?.({ verdict: { pass: true }, sha256: createHash('sha256').update(copy).digest('hex') }, () => process.exit(0));
});
