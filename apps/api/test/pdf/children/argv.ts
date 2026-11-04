// A stand-in engine child that refuses with its own Node flags (process.execArgv) as JSON, so a test can see
// the order the parent gave them in (fix round 5, S2).
process.once('message', () => {
  process.send?.({ ok: true, result: { kind: 'refused', reason: JSON.stringify(process.execArgv) } }, () => process.exit(0));
});
