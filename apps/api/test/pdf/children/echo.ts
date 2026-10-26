// A stand-in engine process: replies with the original reversed as the "copy", then exits.
process.once('message', (message) => {
  const { original } = message as { original: Uint8Array };
  process.send?.({ ok: true, result: { kind: 'redacted', pdf: Uint8Array.from(original).reverse() } }, () => process.exit(0));
});
