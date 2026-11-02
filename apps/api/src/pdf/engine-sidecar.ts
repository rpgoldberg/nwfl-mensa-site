// ============================================================================
// The PDF engine sidecar's entrypoint (UNTRUSTED-PDF-GATE):
// `node dist/pdf/engine-sidecar.js`, same image as the API and the worker, in
// a container of its own beside the worker (sidecar.ts). Argument, env and
// signal wiring only: sidecarMain is tested.
// ============================================================================
import { type Sidecar, sidecarMain } from './sidecar.js';

const log = (line: string): void => void process.stderr.write(`${line}\n`);
/** Set once it listens. */
const running: { sidecar?: Sidecar } = {};
let stopping = false;
const close = (sidecar: Sidecar): void => void sidecar.close().then(() => process.exit(0));

// Before it starts, so a SIGTERM that comes as soon as it says it listens still drains: without a
// listener Node would take the default action and die with the socket left behind.
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  log(`engine sidecar stopping (${signal})`);
  if (running.sidecar !== undefined) close(running.sidecar);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const started = await sidecarMain(process.argv.slice(2), process.env, log);
if ('code' in started) process.exit(started.code);
running.sidecar = started.sidecar;
if (stopping) close(started.sidecar);
