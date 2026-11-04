// A stand-in engine process that never answers when the first quote is "hang", and refuses at once
// otherwise; so one sidecar can take a stuck copy and then a quick one.
process.once('message', (message) => {
  const { request } = message as { request: { quotes: string[] } };
  if (request.quotes[0] === 'hang') setInterval(() => {}, 1_000);
  else process.send?.({ ok: true, result: { kind: 'refused', reason: 'answered' } }, () => process.exit(0));
});
