// A stand-in for child-guard.ts that reports EAGAIN without trying a spawn: with a limit that does
// nothing, the child can start processes, so the layers behind the no-fork limit (the process-group
// kill, the namespace clear) can be tested on their own. Containers only (test/pdf/contained).
import process from 'node:process';

await new Promise<void>((resolve) => {
  const limited = (message: unknown): void => {
    if ((message as { guard?: unknown } | null)?.guard !== 'limited') return;
    process.off('message', limited);
    resolve();
  };
  process.on('message', limited);
  process.send?.({ guard: 'ready' });
});
const tell = (event: string | symbol): void => {
  if (event !== 'message') return;
  process.off('newListener', tell);
  setImmediate(() => process.send?.({ guard: 'listening', probe: 'EAGAIN' }));
};
process.on('newListener', tell);
