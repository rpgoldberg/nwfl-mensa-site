// A stand-in gate child that writes what it was given (environment names, Node flags, heap limit)
// to the file named by the first quote, then passes.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import v8 from 'node:v8';
process.once('message', (message) => {
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  const report = { env: Object.keys(process.env).sort(), execArgv: process.execArgv, heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024), pid: process.pid };
  writeFileSync(quotes[0] as string, JSON.stringify(report));
  process.send?.({ verdict: { pass: true }, sha256: createHash('sha256').update(copy).digest('hex') }, () => process.exit(0));
});
