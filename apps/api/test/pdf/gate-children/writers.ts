// A stand-in gate child that tries, after its guard, the two writers Node's permission model does not
// check (fix round 5, S2): the first quote names a directory, the second the writer (test/pdf/writers.ts).
// It passes, and its "checked" bytes are what happened: "done", or the error's code. With the child's
// flags a "v8" child aborts instead. Containers only (test/pdf/contained/writers.ts).
import { createHash } from 'node:crypto';
import { attemptWrite } from '../writers.js';

process.once('message', (message) => {
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  void attemptWrite(quotes[0] as string, quotes[1] as string).then((outcome) => {
    const pdf = new TextEncoder().encode(outcome);
    const sha256 = createHash('sha256').update(copy).digest('hex');
    process.send?.({ verdict: { pass: true }, sha256, checked: { pdf, sha256: createHash('sha256').update(pdf).digest('hex') } }, () => process.exit(0));
  });
});
