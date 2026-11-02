// A stand-in engine process that answers after 1.5 s, and leaves at once when its parent goes (the
// IPC channel closes), so killing the sidecar mid-copy leaves nothing running.
process.once('disconnect', () => process.exit(0));
process.once('message', () => {
  setTimeout(() => process.send?.({ ok: true, result: { kind: 'refused', reason: 'slow but done' } }, () => process.exit(0)), 1_500);
});
