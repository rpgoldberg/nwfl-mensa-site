// A stand-in engine process that reports the names of every environment variable it was given
// (CF-ISO-0: the child parses untrusted PDFs, so it must not inherit the worker's secrets).
process.once('message', () => {
  process.send?.({ ok: true, result: { kind: 'refused', reason: JSON.stringify(Object.keys(process.env).sort()) } }, () => process.exit(0));
});
