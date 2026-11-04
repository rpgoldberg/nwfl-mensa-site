// A stand-in gate child that tries, after its guard, everything a child of the sidecar's uid could do to its
// socket directory or to itself (fix round 4, S2 and N2): write a file, make a directory, rename and remove
// one, change a mode, load native code, start a process, listen on a unix socket (three ways). The first quote names a directory. It passes, and
// its "checked" bytes are what happened as JSON: each attempt's error code, or "done".
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net, { createServer } from 'node:net';
import * as netExports from 'node:net';
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
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  const dir = quotes[0] as string;
  const outcome = {
    write: attempt(() => writeFileSync(path.join(dir, 'written'), 'x')),
    mkdir: attempt(() => mkdirSync(path.join(dir, 'made'))),
    rename: attempt(() => renameSync(path.join(dir, 'kept'), path.join(dir, 'moved'))),
    remove: attempt(() => rmSync(path.join(dir, 'kept'))),
    chmod: attempt(() => chmodSync(path.join(dir, 'kept'), 0)),
    dlopen: attempt(() => process.dlopen({ exports: {} }, path.join(dir, 'none.node'))),
    spawn: attempt(() => spawnSync('/bin/true', [], { stdio: 'ignore' })),
    // Fix round 5b (S2): a listen binds a socket file in the directory, which the permission model does not check.
    listen: attempt(() => createServer().listen(path.join(dir, 'listening.sock'))),
    // Fix round 6 (S2-6): the two ways under listen, called directly; each binds a socket file when it is let through.
    listen2: attempt(() => (new net.Server() as unknown as { _listen2(...args: unknown[]): void })._listen2(path.join(dir, 'listen2.sock'), -1, -1, 511)),
    createServerHandle: attempt(() => {
      const handle = (net as unknown as { _createServerHandle(...args: unknown[]): unknown })._createServerHandle(path.join(dir, 'handle.sock'), -1, -1);
      return typeof handle === 'number' ? { error: { code: `errno ${handle}` } } : undefined;
    }),
    // The same, through node:net's ES module named export, which the guard brings in line too.
    namedHandle: attempt(() => {
      const handle = (netExports as unknown as { _createServerHandle(...args: unknown[]): unknown })._createServerHandle(path.join(dir, 'named.sock'), -1, -1);
      return typeof handle === 'number' ? { error: { code: `errno ${handle}` } } : undefined;
    }),
  };
  const left = readdirSync(dir).sort().join(',');
  const pdf = new TextEncoder().encode(JSON.stringify({ ...outcome, left }));
  const sha256 = createHash('sha256').update(copy).digest('hex');
  process.send?.({ verdict: { pass: true }, sha256, checked: { pdf, sha256: createHash('sha256').update(pdf).digest('hex') } }, () => process.exit(0));
});
