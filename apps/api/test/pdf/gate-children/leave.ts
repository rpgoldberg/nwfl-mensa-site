// A stand-in gate child that leaves a process behind (UNTRUSTED-PDF-GATE M1): the first quote says
// how ("group": in its own process group; "session": a grandchild of its own session, by setsid),
// and the second is a marker in the process's arguments, so a test can find it in /proc. Then it
// passes, so only what kills its process set stops the process it left.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

// The pass a gate child sends: the copy's sha256, and the bytes it checked (the real child: its own writing of the copy).
const passing = (copy: Uint8Array): object => {
  const sha256 = createHash('sha256').update(copy).digest('hex');
  return { verdict: { pass: true }, sha256, checked: { pdf: copy, sha256 } };
};

process.once('message', (message) => {
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  const [mode, marker] = quotes as [string, string];
  const stay = 'setInterval(() => {}, 1000)';
  if (mode === 'session') {
    // Double fork: an intermediate in a session of its own starts the stayer, then exits, so the stayer is an orphan.
    const middle = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(stay)}, ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => process.exit(0), 200);`;
    spawn(process.execPath, ['-e', middle], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.execPath, ['-e', stay, marker], { stdio: 'ignore' }).unref();
  }
  setTimeout(() => process.send?.(passing(copy), () => process.exit(0)), 500);
});
