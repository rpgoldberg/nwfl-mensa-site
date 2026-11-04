// A stand-in for a subverted engine child (UNTRUSTED-PDF-GATE M1, fix round 2): the first quote names
// an attack (test/pdf/attacks.ts), the second the sidecar's socket. It refuses its copy with what the
// attack managed, and stays alive when it serves a stolen socket. First quote "echo": the original
// handed back as the copy, bytes intact (a later job's own data, and nothing else). Containers only.
import { attack } from '../attacks.js';

process.once('message', (message) => {
  const { original, request } = message as { original: Uint8Array; request: { quotes: string[] } };
  const [mode, socket] = request.quotes as [string, string];
  if (mode === 'echo') {
    process.send?.({ ok: true, result: { kind: 'redacted', pdf: Uint8Array.from(original), boxes: [] } }, () => process.exit(0));
    return;
  }
  void attack(mode, socket).then(({ said, holds }) => process.send?.({ ok: true, result: { kind: 'refused', reason: said } }, () => holds || process.exit(0)));
});
