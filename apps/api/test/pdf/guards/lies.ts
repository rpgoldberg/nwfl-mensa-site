// A stand-in for child-guard.ts that tells the parent a process started, without starting one: the
// parent must refuse the child (no-fork.ts). It keeps the real guard's handshake otherwise.
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
  setImmediate(() => process.send?.({ guard: 'listening', probe: 'a process started (exit 0)' }));
};
process.on('newListener', tell);
