// A stand-in gate child that writes 1 MiB to stderr and 1 MiB to stdout, then passes (S2: what it
// writes must not reach the container log unbounded; the answer still counts).
import { createHash } from 'node:crypto';

process.once('message', (message) => {
  const { copy } = message as { copy: Uint8Array };
  const sha256 = createHash('sha256').update(copy).digest('hex');
  process.stderr.write(`noisy-start ${'e'.repeat(1024 * 1024)}`);
  process.stdout.write('o'.repeat(1024 * 1024), () => process.send?.({ verdict: { pass: true }, sha256, checked: { pdf: copy, sha256 } }, () => process.exit(0)));
});
