// In a capped container, as PID 1, with the no-fork limit off: a child starts 8 fork-and-exit chains
// (attacks.ts "hop"), then clearNamespace runs as it does before a sidecar's reply. Prints its answer
// and what is still running (not zombies) after it. Chains that ran are reparented to PID 1 and, once
// killed, are zombies nobody reaps: the clear names them as doubt, which makes a sidecar exit 1.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isolatedRedact } from '../../../src/pdf/isolated.js';
import { clearNamespace } from '../../../src/pdf/pidns.js';

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const reply = await isolatedRedact({ module: at('../children/hostile.ts'), guard: at('../guards/permissive.ts'), limit: async () => {} })(Uint8Array.from([1]), {
  quotes: ['hop', '/tmp/none.sock'],
  redactsAny: true,
});
const problem = await clearNamespace({ self: process.pid, kill: (pid, signal) => void process.kill(pid, signal) });
const running = readdirSync('/proc')
  .filter((entry) => /^\d+$/.test(entry) && entry !== '1')
  .filter((pid) => {
    try {
      return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
    } catch {
      return false;
    }
  });
process.stdout.write(`${JSON.stringify({ pid: process.pid, reply, problem, running: running.length })}\n`);
