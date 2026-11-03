// A stand-in engine child that tries, after its guard, everything a child of the sidecar's uid could do to
// its socket directory or to itself (fix round 4, S2 and N2): write a file, make a directory, rename and
// remove one, change a mode, load native code, start a process. The first quote names a directory. It
// refuses its copy with what happened as JSON: each attempt's error code, or "done".
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error);
const attempt = (step: () => unknown): string => {
  try {
    const result = step();
    const failed = (result as { error?: unknown } | undefined)?.error;
    return failed === undefined ? 'done' : code(failed);
  } catch (error) {
    return code(error);
  }
};

process.once('message', (message) => {
  const { request } = message as { request: { quotes: string[] } };
  const dir = request.quotes[0] as string;
  const outcome = {
    write: attempt(() => writeFileSync(path.join(dir, 'written'), 'x')),
    mkdir: attempt(() => mkdirSync(path.join(dir, 'made'))),
    rename: attempt(() => renameSync(path.join(dir, 'kept'), path.join(dir, 'moved'))),
    remove: attempt(() => rmSync(path.join(dir, 'kept'))),
    chmod: attempt(() => chmodSync(path.join(dir, 'kept'), 0)),
    dlopen: attempt(() => process.dlopen({ exports: {} }, path.join(dir, 'none.node'))),
    spawn: attempt(() => spawnSync('/bin/true', [], { stdio: 'ignore' })),
  };
  process.send?.({ ok: true, result: { kind: 'refused', reason: JSON.stringify(outcome) } }, () => process.exit(0));
});
