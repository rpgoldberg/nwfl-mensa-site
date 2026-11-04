// A stand-in for a subverted gate child (UNTRUSTED-PDF-GATE M1, fix round 2): the first quote names an
// attack (test/pdf/attacks.ts), the second the gate sidecar's socket. Then it passes the copy, with
// the sha256 of the bytes it was sent, and stays alive when it serves a stolen socket. What the attack
// managed rides as the bytes it "checked" (fix round 4: a child under the permission model writes no
// file). First quote "echo": it only passes, with the copy as its checked bytes. Containers only.
import { createHash } from 'node:crypto';
import { attack } from '../attacks.js';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
// The pass a gate child sends: the copy's sha256, and the bytes it checked.
const passing = (copy: Uint8Array, checked: Uint8Array): object => ({ verdict: { pass: true }, sha256: sha(copy), checked: { pdf: checked, sha256: sha(checked) } });

process.once('message', (message) => {
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  const [mode, socket] = quotes as [string, string];
  if (mode === 'echo') {
    process.send?.(passing(copy, copy), () => process.exit(0));
    return;
  }
  void attack(mode, socket).then(({ said, holds }) => process.send?.(passing(copy, new TextEncoder().encode(said)), () => holds || process.exit(0)));
});
