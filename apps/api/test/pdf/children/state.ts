// A stand-in engine process that reports what it inherited (UNTRUSTED-PDF-GATE sidecar: per-copy
// isolation): its pid and parent, a module counter and a global marker (both fresh in a new
// process), and the names of its environment variables. The report is the refusal's reason.
const holder = globalThis as { nwflEngineMarker?: number };
let copies = 0;
process.once('message', () => {
  copies += 1;
  const sawMarker = holder.nwflEngineMarker !== undefined;
  holder.nwflEngineMarker = process.pid;
  const report = { pid: process.pid, ppid: process.ppid, copies, sawMarker, env: Object.keys(process.env).sort() };
  process.send?.({ ok: true, result: { kind: 'refused', reason: JSON.stringify(report) } }, () => process.exit(0));
});
