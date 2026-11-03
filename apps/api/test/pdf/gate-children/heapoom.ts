// A stand-in gate child that ends as V8 does when its heap runs out: the fatal line on stderr, then an
// abnormal exit (N1: the parent says "memory", not "crash"). It allocates nothing.
process.once('message', () => {
  process.stderr.write('\n<--- Last few GCs --->\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n', () => process.exit(134));
});
