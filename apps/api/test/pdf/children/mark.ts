// A stand-in engine child that writes the file named by its first quote as soon as it gets a job, then
// refuses: a test can tell whether a child was ever forked and sent anything.
import { writeFileSync } from 'node:fs';

process.once('message', (message) => {
  const { request } = message as { request: { quotes: string[] } };
  writeFileSync(request.quotes[0] as string, 'ran');
  process.send?.({ ok: true, result: { kind: 'refused', reason: 'refused by the engine process' } }, () => process.exit(0));
});
