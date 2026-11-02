// A stand-in engine process whose copy is one byte over the 20 MiB output cap (engine-protocol.ts
// MAX_OUTPUT_BYTES, the size pdf_copy accepts).
process.once('message', () => {
  process.send?.({ ok: true, result: { kind: 'redacted', pdf: new Uint8Array(20 * 1024 * 1024 + 1), boxes: [] } }, () => process.exit(0));
});
