// A stand-in engine child that tries, after its guard, the two writers Node's permission model does not
// check (fix round 5, S2): the first quote names a directory, the second the writer. "sqlite" opens a
// database file there through node:sqlite; "v8" sets V8 flags at run time that write trace files there,
// then runs hot code. It refuses its copy with what happened: "done", or the error's code. With the
// child's flags a "v8" child aborts instead. Containers only (test/pdf/contained/writers.ts).
import { attemptWrite } from '../writers.js';

process.once('message', (message) => {
  const { request } = message as { request: { quotes: string[] } };
  void attemptWrite(request.quotes[0] as string, request.quotes[1] as string).then((outcome) =>
    process.send?.({ ok: true, result: { kind: 'refused', reason: outcome } }, () => process.exit(0)),
  );
});
