// A stand-in gate child that reports what it was given (environment names, Node flags, heap limit, its process
// limit) and its oom_score_adj, then passes: the report rides as its "checked" bytes (JSON), since a child under
// the permission model can write no file (fix round 4, S2).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import v8 from 'node:v8';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

process.once('message', (message) => {
  const { copy } = message as { copy: Uint8Array };
  const report = {
    env: Object.keys(process.env).sort(),
    execArgv: process.execArgv,
    heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024),
    pid: process.pid,
    limits: readFileSync('/proc/self/limits', 'utf8').split('\n').find((line) => line.startsWith('Max processes')),
    oomScoreAdj: readFileSync('/proc/self/oom_score_adj', 'utf8').trim(),
  };
  const pdf = new TextEncoder().encode(JSON.stringify(report));
  process.send?.({ verdict: { pass: true }, sha256: sha(copy), checked: { pdf, sha256: sha(pdf) } }, () => process.exit(0));
});
