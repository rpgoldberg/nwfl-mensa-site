// In a capped container: the worker's in-pod transport (the identity engine child, then the real gate
// child, capped) on a hostile copy (test/pdf/hostile.ts), and the gate child on its own for why it
// stopped. Arguments: bomb | shows | pages, the gate's memory cap in MiB, its deadline in ms.
import { GATE_CHILD_SOURCE, NODE_FLAGS, standIn } from '../../helpers/sidecar.js';
import { isolatedGate } from '../../../src/pdf/gate-isolated.js';
import { workerRedact } from '../../../src/pdf/worker.js';
import { flateBomb, manyPages, manyShows } from '../hostile.js';

const [kind, capMb, deadline] = process.argv.slice(2) as [string, string, string];
const copy = kind === 'bomb' ? await flateBomb(1024) : kind === 'shows' ? manyShows(2_000_000) : manyPages(20_000);
const caps = { gateMaxRssBytes: Number(capMb) * 1024 * 1024, gateChildTimeoutMs: Number(deadline) };
let t0 = Date.now();
const result = await workerRedact({}, { engine: standIn('identity'), gateChild: GATE_CHILD_SOURCE, gateNodeFlags: NODE_FLAGS, ...caps })(copy, { quotes: ['Kestrel Ambry'], redactsAny: true });
const ms = Date.now() - t0;
t0 = Date.now();
const outcome = await isolatedGate({ module: GATE_CHILD_SOURCE, nodeFlags: NODE_FLAGS, maxRssBytes: caps.gateMaxRssBytes, timeoutMs: caps.gateChildTimeoutMs })({ copy, original: copy, quotes: ['Kestrel Ambry'], image: 'blur' });
process.stdout.write(`${JSON.stringify({ result, ms, cause: outcome.cause ?? null, causeMs: Date.now() - t0 })}\n`);
