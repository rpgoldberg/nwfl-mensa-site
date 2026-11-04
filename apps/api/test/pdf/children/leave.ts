// A stand-in engine child that leaves a process behind in its own process group (UNTRUSTED-PDF-GATE
// M1, the in-pod mode): the second quote is a marker in that process's arguments, so a test can find
// it in /proc. It waits until the process is surely running, then refuses the copy and exits, so
// only what kills its process group stops the process it left.
import { spawn } from 'node:child_process';

process.once('message', (message) => {
  const { request } = message as { request: { quotes: string[] } };
  const marker = request.quotes[1] as string;
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' }).unref();
  setTimeout(() => process.send?.({ ok: true, result: { kind: 'refused', reason: 'left a process in its group' } }, () => process.exit(0)), 500);
});
