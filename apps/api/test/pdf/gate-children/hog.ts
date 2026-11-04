// A stand-in gate child that takes memory outside the V8 heap (as an inflated stream does) and then
// stops: about 512 MiB, then it idles until it is killed. Under a cap of 128 to 256 MiB the watchdog
// kills it for memory within a second or so; without the watchdog it idles to the deadline instead,
// so a missing watchdog shows up as a deadline kill, never as a runaway. Run only in a capped
// container (test/pdf/gate-rerun.test.ts).
const held: Buffer[] = [];
const STOP_AT = 512 * 1024 * 1024;
process.once('message', () => {
  const grow = setInterval(() => {
    if (held.length * 32 * 1024 * 1024 >= STOP_AT) clearInterval(grow);
    else held.push(Buffer.alloc(32 * 1024 * 1024, 1));
  }, 5);
  setInterval(() => {}, 1_000);
});
