// In a capped container: real engine and gate children, with the real guard and flags, try the writers the
// permission model does not check (test/pdf/writers.ts), started by a parent whose own flags would turn both
// back on (--experimental-sqlite, --no-freeze-flags-after-init): the child's flags come after them (fix
// round 5, S2). Prints, for each child, writer and mode, what the child said and what is in its directory
// after: "with" the permission model's flags, "without" them (the layer they close).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isolatedGate } from '../../../src/pdf/gate-isolated.js';
import { isolatedRedact } from '../../../src/pdf/isolated.js';
import { PRLIMIT } from '../../../src/pdf/no-fork.js';

// A core limit of 1 B: a child that aborts writes no core, even through a piped core_pattern.
execFileSync(PRLIMIT, ['--pid', String(process.pid), '--core=1:1']);
process.execArgv.push('--experimental-sqlite', '--no-freeze-flags-after-init');
const stand = (dir: string): string => fileURLToPath(new URL(`../${dir}/writers.ts`, import.meta.url));
const said = async (kind: 'engine' | 'gate', writer: string, permission: boolean): Promise<{ said: string; files: string[] }> => {
  const dir = mkdtempSync('/tmp/writers-');
  let text: string;
  try {
    if (kind === 'engine') text = ((await isolatedRedact({ module: stand('children'), permission })(Uint8Array.from([1]), { quotes: [dir, writer], redactsAny: true })) as { reason: string }).reason;
    else {
      const outcome = await isolatedGate({ module: stand('gate-children'), permission })({ copy: Uint8Array.from([1]), original: Uint8Array.from([1]), quotes: [dir, writer], image: 'show' });
      text = outcome.checked === undefined ? `no pass: ${outcome.cause ?? (outcome.verdict.pass ? 'pass' : outcome.verdict.code)}` : new TextDecoder().decode(outcome.checked.pdf);
    }
  } catch (error) {
    text = `no answer: ${(error as Error).message}`;
  }
  return { said: text, files: readdirSync(dir) };
};
const result: Record<string, Record<string, Record<string, { said: string; files: string[] }>>> = {};
for (const kind of ['engine', 'gate'] as const) {
  result[kind] = {};
  for (const writer of ['sqlite', 'v8']) result[kind][writer] = { with: await said(kind, writer, true), without: await said(kind, writer, false) };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
