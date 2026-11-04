// A stand-in gate child that passes, naming the sha256 of other bytes than it was sent, and checked bytes of its own.
import { createHash } from 'node:crypto';

// The pass a gate child sends: the copy's sha256, and the bytes it checked (the real child: its own writing of the copy).
const passing = (copy: Uint8Array): object => {
  const sha256 = createHash('sha256').update(copy).digest('hex');
  return { verdict: { pass: true }, sha256, checked: { pdf: copy, sha256 } };
};

process.once('message', () => {
  process.send?.(passing(new TextEncoder().encode('other bytes')), () => process.exit(0));
});
