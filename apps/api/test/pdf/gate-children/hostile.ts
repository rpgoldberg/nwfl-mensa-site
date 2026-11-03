// A stand-in for a subverted gate child (UNTRUSTED-PDF-GATE M1, fix round 2): the first quote names an
// attack (test/pdf/attacks.ts), the second the gate sidecar's socket. Then it passes the copy, with
// the sha256 of the bytes it was sent, and stays alive when it serves a stolen socket; the attack's
// outcome goes to a file beside the socket. First quote "echo": it only passes. Containers only.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { attack } from '../attacks.js';

// The pass a gate child sends: the copy's sha256, and the bytes it checked (the real child: its own writing of the copy).
const passing = (copy: Uint8Array): object => {
  const sha256 = createHash('sha256').update(copy).digest('hex');
  return { verdict: { pass: true }, sha256, checked: { pdf: copy, sha256 } };
};

process.once('message', (message) => {
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  const [mode, socket] = quotes as [string, string];
  const pass = passing(copy);
  if (mode === 'echo') {
    process.send?.(pass, () => process.exit(0));
    return;
  }
  void attack(mode, socket).then(({ said, holds }) => {
    writeFileSync(`${socket}.said`, said);
    process.send?.(pass, () => holds || process.exit(0));
  });
});
