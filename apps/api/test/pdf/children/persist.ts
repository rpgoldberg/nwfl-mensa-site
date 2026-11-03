// A stand-in for a subverted engine child (UNTRUSTED-PDF-GATE M1). With the first quote "persist" or
// "steal" it leaves a grandchild behind by a double fork (an intermediate in a session of its own,
// so neither the child's pid nor its process group reaches it), carrying the second quote as a
// marker in its arguments. The grandchild takes over the sidecar's socket path (after 300 ms for
// "persist", at once for "steal") and answers every later job with a leak of its own. The child
// waits until the grandchild is up ("persist") or holds the socket ("steal"), then answers its own
// copy. Any other first quote: the original handed back as the copy, bytes intact.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

process.once('message', (message) => {
  const { original, request } = message as { original: Uint8Array; request: { quotes: string[] } };
  const [mode, marker] = request.quotes as [string, string];
  if (mode !== 'persist' && mode !== 'steal') {
    process.send?.({ ok: true, result: { kind: 'redacted', pdf: Uint8Array.from(original), boxes: [] } }, () => process.exit(0));
    return;
  }
  const argv = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0');
  const socket = argv[argv.indexOf('--socket') + 1] as string;
  const flag = `${socket}.${marker}.${mode === 'steal' ? 'stolen' : 'up'}`;
  const thief = `
    const fs = require('node:fs'); const net = require('node:net');
    const socket = ${JSON.stringify(socket)};
    ${mode === 'persist' ? `fs.writeFileSync(${JSON.stringify(flag)}, String(process.pid));` : ''}
    setTimeout(() => {
      try { fs.unlinkSync(socket); } catch {}
      const leak = Buffer.from('LEAKED by ' + ${JSON.stringify(marker)});
      net.createServer((conn) => {
        conn.on('error', () => {});
        conn.once('data', () => {
          const head = Buffer.from(JSON.stringify({ v: 1, kind: 'redacted' }));
          const prefix = Buffer.alloc(12); prefix.write('NWA1', 0, 'latin1'); prefix.writeUInt32BE(head.length, 4); prefix.writeUInt32BE(leak.length, 8);
          conn.end(Buffer.concat([prefix, head, leak]));
        });
      }).listen(socket, () => { fs.chmodSync(socket, 0o660); ${mode === 'steal' ? `fs.writeFileSync(${JSON.stringify(flag)}, String(process.pid));` : ''} });
    }, ${mode === 'steal' ? 0 : 300});
    setTimeout(() => process.exit(0), 120000);
  `;
  const middle = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(thief)}, ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => process.exit(0), 100);`;
  spawn(process.execPath, ['-e', middle], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 10_000;
  const wait = setInterval(() => {
    if (!existsSync(flag) && Date.now() < deadline) return;
    clearInterval(wait);
    process.send?.({ ok: true, result: { kind: 'refused', reason: 'left a grandchild' } }, () => process.exit(0));
  }, 20);
});
