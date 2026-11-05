// The links command: `node dist/load/links-cli.js -`, the nwfl-links/1 bundle on stdin. Everything
// it does is in attach.ts, which the tests drive directly; this file only hands it argv, the
// environment, stdin (its file type from fstat, and its bytes) and stdout.
import { fstatSync } from 'node:fs';
import { runAttach } from './attach.js';
import { stdinKind } from './input.js';

process.exitCode = await runAttach(process.argv.slice(2), process.env, { kind: stdinKind(fstatSync(0)), chunks: process.stdin }, (line) => process.stdout.write(`${line}\n`));
