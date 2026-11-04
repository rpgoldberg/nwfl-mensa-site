// A stand-in engine that skipped its own output gate: it hands the original back as the "redacted"
// copy, marked text and all (UNTRUSTED-PDF-GATE gate re-run: the worker must catch it).
process.once('message', (message) => {
  const { original } = message as { original: Uint8Array };
  process.send?.({ ok: true, result: { kind: 'redacted', pdf: Uint8Array.from(original), boxes: [] } }, () => process.exit(0));
});
