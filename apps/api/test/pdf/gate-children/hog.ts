// A stand-in gate child that takes memory outside the V8 heap until it is stopped, as a Flate bomb's
// decoded stream does (Buffers are not counted by --max-old-space-size).
const held: Buffer[] = [];
process.once('message', () => {
  setInterval(() => held.push(Buffer.alloc(32 * 1024 * 1024, 1)), 5);
});
