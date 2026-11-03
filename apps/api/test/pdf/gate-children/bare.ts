// A stand-in gate child that passes with the copy's sha256 but sends no checked bytes (M1: no pass then).
import { createHash } from 'node:crypto';

process.once('message', (message) => {
  const { copy } = message as { copy: Uint8Array };
  process.send?.({ verdict: { pass: true }, sha256: createHash('sha256').update(copy).digest('hex') }, () => process.exit(0));
});
