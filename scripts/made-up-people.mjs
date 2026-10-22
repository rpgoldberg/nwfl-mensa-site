#!/usr/bin/env node
// made-up-people.mjs [--json] - the repository is public with its whole
// history, so fixtures, test pages and placeholders use made-up people only.
// Walks every tracked text file of the repository, from its top whichever
// folder it runs from, and allows email addresses only at reserved example
// domains or the group's role aliases, and phone numbers only in the fictional
// 555-01xx range. Real names cannot be checked mechanically; this catches the
// contact details that come with them. Exits 1 with the findings listed.
// --json prints { files, findings } for the apps' tests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Generated or third-party text, not ours: lockfiles, the font licences, the
// vendored package and the generated protobuf code.
const SKIP = [/(^|\/)package-lock\.json$/, /^apps\/web\/public\/fonts\/OFL-/, /^apps\/api\/vendor\//, /^apps\/api\/src\/gen\//];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const ALLOWED_DOMAIN = /^(example\.(com|org|net)|nwflorida\.us)$/i;
const PHONE = /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;
const FICTIONAL_PHONE = /555[-. ]01\d\d$/;

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '' && !SKIP.some((pattern) => pattern.test(file)))
  .filter((file) => !readFileSync(path.join(root, file)).subarray(0, 8000).includes(0));

const findings = files.flatMap((file) => {
  const text = readFileSync(path.join(root, file), 'utf8');
  return [
    ...[...text.matchAll(EMAIL)].filter((m) => !ALLOWED_DOMAIN.test(m[1] ?? '')),
    ...[...text.matchAll(PHONE)].filter((m) => !FICTIONAL_PHONE.test(m[0])),
  ].map((m) => `${file}: ${m[0]}`);
});

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ files, findings })}\n`);
else if (findings.length > 0) console.error(`made-up-people: FAIL, real-looking contact details:\n${findings.join('\n')}`);
else console.log(`made-up-people: ${files.length} files, none found`);
process.exitCode = findings.length > 0 ? 1 : 0;
