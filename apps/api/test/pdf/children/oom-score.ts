// A stand-in engine child that refuses with its own oom_score_adj, so a test can see the guard set it (S5).
import { readFileSync } from 'node:fs';

process.once('message', () => {
  process.send?.({ ok: true, result: { kind: 'refused', reason: readFileSync('/proc/self/oom_score_adj', 'utf8').trim() } }, () => process.exit(0));
});
