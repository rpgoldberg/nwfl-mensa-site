// The process entrypoint: argv, the real filesystem, stdio, env and exit wiring only (cli.ts main is tested).
import { readFile, writeFile } from 'node:fs/promises';
import { main } from './cli.js';
import { systemDns } from './dns.js';
import { extract } from './extract.js';
import { makeConnect } from './net.js';
import { makeRdap } from './rdap.js';

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(130));

process.exitCode = await main(process.argv.slice(2), {
  readFile: (path) => readFile(path),
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  print: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  now: () => new Date(),
  checkDeps: (issueDate) => {
    const net = { dns: systemDns(), connect: makeConnect() };
    return { ...net, rdap: makeRdap(net), issueDate };
  },
  extract: (pdf, audience) => extract(pdf, audience),
});
