// A stand-in engine child that writes 1 MiB to stderr and 1 MiB to stdout, then refuses (S2: what it
// writes must not reach the container log unbounded).
process.once('message', () => {
  process.stderr.write(`noisy-start ${'e'.repeat(1024 * 1024)}`);
  process.stdout.write('o'.repeat(1024 * 1024), () => process.send?.({ ok: true, result: { kind: 'refused', reason: 'refused by the noisy engine' } }, () => process.exit(0)));
});
