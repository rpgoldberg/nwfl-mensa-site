// A stand-in engine child that signals the process named by its first quote (SIGURG, which nothing ends by
// default) as soon as it gets a job, then refuses: a test can tell whether a child was ever forked and sent
// anything. A signal, not a file: under the permission model a child writes no file (fix round 4, S2).
process.once('message', (message) => {
  const { request } = message as { request: { quotes: string[] } };
  process.kill(Number(request.quotes[0]), 'SIGURG');
  process.send?.({ ok: true, result: { kind: 'refused', reason: 'refused by the engine process' } }, () => process.exit(0));
});
