// A stand-in gate child that passes, then is killed by SIGKILL, as the OOM killer would (S4: no answer then).
import { createHash } from 'node:crypto';

// The pass a gate child sends: the copy's sha256, and the bytes it checked (the real child: its own writing of the copy).
const passing = (copy: Uint8Array): object => {
  const sha256 = createHash('sha256').update(copy).digest('hex');
  return { verdict: { pass: true }, sha256, checked: { pdf: copy, sha256 } };
};

process.once('message', (message) => {
  const { copy } = message as { copy: Uint8Array };
  process.send?.(passing(copy), () => process.kill(process.pid, 'SIGKILL'));
});
