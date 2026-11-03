// ============================================================================
// The PDF engine sidecar's entrypoint (UNTRUSTED-PDF-GATE):
// `command: ["node", "--disable-sigusr1", "dist/pdf/engine-sidecar.js"]`,
// same image as the API and the worker, in a container of its own beside the
// worker (sidecar.ts), with node as PID 1 and no init (fix round 2: it must
// be PID 1, exit 2 otherwise). Argument, env and signal wiring only:
// sidecarMain is tested. SIGTERM and SIGINT close the listener and exit 0; a
// replaced socket or a namespace not clear before a reply exits 1, so the
// kubelet restarts the container.
// ============================================================================
import { type Sidecar, holdSignals, sidecarMain } from './sidecar.js';

// First: as PID 1 it still gets SIGUSR1, and Node's own handler would open the inspector to a child;
// and a signal that ends a process by default could end it (N2).
holdSignals();
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

const started = await sidecarMain(process.argv.slice(2), process.env, log, {
  onFatal: (reason) => {
    log(`the engine sidecar stops: ${reason}`);
    process.exit(1);
  },
});
if ('code' in started) process.exit(started.code);
running.sidecar = started.sidecar;
if (stopping) close(started.sidecar);
