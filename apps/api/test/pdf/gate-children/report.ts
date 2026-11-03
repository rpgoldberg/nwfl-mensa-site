// A stand-in gate child that writes what it was given (environment names, Node flags, heap limit, its process limit)
// and its oom_score_adj to the file named by the first quote, then passes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import v8 from 'node:v8';

// The pass a gate child sends: the copy's sha256, and the bytes it checked (the real child: its own writing of the copy).
const passing = (copy: Uint8Array): object => {
  const sha256 = createHash('sha256').update(copy).digest('hex');
  return { verdict: { pass: true }, sha256, checked: { pdf: copy, sha256 } };
};

process.once('message', (message) => {
  const { copy, quotes } = message as { copy: Uint8Array; quotes: string[] };
  const report = {
    env: Object.keys(process.env).sort(),
    execArgv: process.execArgv,
    heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024),
    pid: process.pid,
    limits: readFileSync('/proc/self/limits', 'utf8').split('\n').find((line) => line.startsWith('Max processes')),
    oomScoreAdj: readFileSync('/proc/self/oom_score_adj', 'utf8').trim(),
  };
  writeFileSync(quotes[0] as string, JSON.stringify(report));
  process.send?.(passing(copy), () => process.exit(0));
});
