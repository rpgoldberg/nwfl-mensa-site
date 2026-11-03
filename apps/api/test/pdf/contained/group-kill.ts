// In a capped container, with the no-fork limit off (a permissive guard and a limit that does nothing):
// the per-copy children leave processes behind, and the parent's process-group kill (isolated.ts,
// gate-isolated.ts) must still stop them. Prints what is left alive with the marker, for each.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isolatedGate } from '../../../src/pdf/gate-isolated.js';
import { isolatedRedact } from '../../../src/pdf/isolated.js';

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const guard = at('../guards/permissive.ts');
const limit = async (): Promise<void> => {};
const alive = (marker: string): number[] =>
  readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker) && !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
      } catch {
        return false;
      }
    })
    .map(Number);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const engine = await isolatedRedact({ module: at('../children/leave.ts'), guard, limit })(Uint8Array.from([1]), { quotes: ['group', 'nwfl-left-engine'], redactsAny: true });
await sleep(300);
const gate = await isolatedGate({ module: at('../gate-children/leave.ts'), guard, limit })({ copy: Uint8Array.from([1]), original: Uint8Array.from([2]), quotes: ['group', 'nwfl-left-gate'], image: 'blur' });
await sleep(300);
// Without the group kill (control): a child left behind and its process group not killed would show here.
process.stdout.write(`${JSON.stringify({ engine, engineLeft: alive('nwfl-left-engine'), gate: gate.verdict, gateLeft: alive('nwfl-left-gate') })}\n`);
