// A stand-in engine child that refuses with its own process limit line (/proc/self/limits), so a test
// can see the limit it was given before its job (no-fork.ts).
import { readFileSync } from 'node:fs';

process.once('message', () => {
  const line = readFileSync('/proc/self/limits', 'utf8').split('\n').find((entry) => entry.startsWith('Max processes')) ?? 'none';
  process.send?.({ ok: true, result: { kind: 'refused', reason: line } }, () => process.exit(0));
});
