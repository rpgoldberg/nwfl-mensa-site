// The issue loader: `node dist/load/cli.js -`, the bundle on stdin. Everything
// it does is in load.ts, which the tests drive directly; this file only hands it
// argv, the environment, stdin (its file type from fstat, and its bytes) and stdout.
import { fstatSync } from 'node:fs';
import { runLoad, stdinKind } from './load.js';

process.exitCode = await runLoad(process.argv.slice(2), process.env, { kind: stdinKind(fstatSync(0)), chunks: process.stdin }, (line) => process.stdout.write(`${line}\n`));
