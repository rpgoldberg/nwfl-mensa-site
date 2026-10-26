// A stand-in engine process whose engine threw.
process.once('message', () => {
  process.send?.({ ok: false, message: 'the engine threw' }, () => process.exit(0));
});
