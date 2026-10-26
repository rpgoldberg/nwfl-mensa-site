// A stand-in engine process that refuses every file, so a test can tell the copy came from it.
process.once('message', () => {
  process.send?.({ ok: true, result: { kind: 'refused', reason: 'refused by the engine process' } }, () => process.exit(0));
});
