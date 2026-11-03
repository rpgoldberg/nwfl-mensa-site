// ============================================================================
// UNTRUSTED-PDF-GATE (2), fix round 1 M2: the output gate as a sidecar process
// of its own, `node dist/pdf/gate-sidecar.js`, from the same image, meant for
// a third container in the worker's pod: its own uid and gid (10004), no
// Secret, a read-only root, no ports, its own emptyDir at /run/pdf-gate that
// only it and the worker mount (README, "The gate sidecar";
// fc-manifest-needs.md). It is served by the engine sidecar's code
// (sidecar.ts): the same allow-listed environment, directory rule, framing,
// caps, socket watch, PID-1 rule and namespace clearing before every reply.
//
// Per connection: one gate request (engine-protocol.ts), the copy and its
// original with their sha256s. A body whose hash is not the one named is
// refused ("mismatch") before any child reads it. Otherwise one capped child
// checks it (gate-isolated.ts, gate-child.ts); a child that names other bytes
// than it was sent is a "mismatch" too; one that crashes, runs out of memory
// or time is "unfinished". The reply is the verdict and the sha256 of the
// copy checked; a pass also carries the bytes the child checked, its own
// writing of the copy (fix round 3, M1), and the worker stores only those,
// on a pass naming the copy's hash.
// ============================================================================
import { GATE_REQUEST_MAGIC, MAX_GATE_BODY_BYTES, MAX_REQUEST_HEADER_BYTES, decodeGateRequest, encodeGateReply, sha256Hex } from './engine-protocol.js';
import { GATE_CHILD, isolatedGate } from './gate-isolated.js';
import { type MainOptions, type ServeOptions, type Sidecar, type SidecarSpec, prepareSidecar, serveFrames, startPrepared, wholeArgument } from './sidecar.js';

export const GATE_SOCKET_DIR = '/run/pdf-gate';
export const DEFAULT_GATE_SOCKET = `${GATE_SOCKET_DIR}/gate.sock`;
const MAX_RSS_MB = 4096;

export interface GateSidecarOptions extends ServeOptions {
  /** The gate child (default the built gate-child.js); another module, for tests. */
  module?: string;
  timeoutMs?: number;
  maxRssBytes?: number;
  /** Node flags for each child beside the sidecar's own. */
  nodeFlags?: readonly string[];
}

/** The gate sidecar: a verdict per connection, each from a capped child of its own. */
export function startGateSidecar(options: GateSidecarOptions): Promise<Sidecar> {
  return serveFrames(options, {
    magic: GATE_REQUEST_MAGIC,
    maxHeader: MAX_REQUEST_HEADER_BYTES,
    maxBody: MAX_GATE_BODY_BYTES,
    decode: decodeGateRequest,
    run: async (request, signal) => {
      const sha256 = sha256Hex(request.copy);
      if (sha256 !== request.sha256 || sha256Hex(request.original) !== request.originalSha256) return encodeGateReply({ verdict: { pass: false, code: 'mismatch' }, sha256 });
      const outcome = await isolatedGate({
        module: options.module ?? GATE_CHILD,
        signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxRssBytes === undefined ? {} : { maxRssBytes: options.maxRssBytes }),
        ...(options.nodeFlags === undefined ? {} : { nodeFlags: options.nodeFlags }),
      })({ copy: request.copy, original: request.original, quotes: request.quotes, image: request.image });
      if (outcome.cause !== undefined) options.log(`a check was unfinished (${outcome.cause})`);
      if (outcome.sha256 !== null && outcome.sha256 !== sha256) return encodeGateReply({ verdict: { pass: false, code: 'mismatch' }, sha256 });
      // A pass carries the bytes the child checked, its own writing of the copy (M1): the worker stores only those.
      return encodeGateReply({ verdict: outcome.verdict, sha256, ...(outcome.checked === undefined ? {} : { checked: outcome.checked }) });
    },
  });
}

const GATE_SPEC: SidecarSpec = {
  what: 'gate',
  dir: GATE_SOCKET_DIR,
  file: 'gate.sock',
  options: { gate: { type: 'string' }, 'max-rss-mb': { type: 'string' } },
  usage: 'gate-sidecar [--socket <path in /run/pdf-gate>] [--timeout-ms <ms>] [--max-rss-mb <MiB>] [--gate <module>] [--socket-dir <dir>] [--shared-pid-namespace]',
};

/**
 * The gate entry's logic (gate-sidecar.ts): sidecar.ts prepareSidecar's checks (exit 2), then listen
 * (exit 1 when it cannot). Its own arguments: --max-rss-mb <MiB> (each child's memory cap, default 768),
 * --gate <module> (the built gate-child.js by default; a stand-in, for tests). --timeout-ms is per
 * check, default 120000.
 */
export async function gateSidecarMain(argv: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void, options: MainOptions = {}): Promise<{ code: number } | { sidecar: Sidecar }> {
  const prepared = prepareSidecar(GATE_SPEC, argv, env, log, options);
  if ('code' in prepared) return prepared;
  const rss = wholeArgument(prepared.values['max-rss-mb'], MAX_RSS_MB);
  if (Number.isNaN(rss)) {
    log(`--max-rss-mb must be a whole number from 1 to ${MAX_RSS_MB}`);
    return { code: 2 };
  }
  const module = prepared.values['gate'] as string | undefined;
  return startPrepared('gate', prepared, log, () =>
    startGateSidecar({
      path: prepared.socket,
      log,
      onFatal: prepared.onFatal,
      ...(prepared.sweep === undefined ? {} : { sweep: prepared.sweep }),
      ...(module === undefined ? {} : { module }),
      ...(prepared.timeoutMs === undefined ? {} : { timeoutMs: prepared.timeoutMs }),
      ...(rss === undefined ? {} : { maxRssBytes: rss * 1024 * 1024 }),
    }),
  );
}
