// A stand-in gate child, subverted by the copy it read: it answers something that is not a verdict.
process.once('message', () => {
  process.send?.({ verdict: 'pass', sha256: 'anything' }, () => process.exit(0));
});
