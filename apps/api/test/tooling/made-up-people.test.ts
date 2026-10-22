// The repository may go public with its whole history, so fixtures and tests
// use made-up people only. This walks every tracked text file and allows email
// addresses only at reserved example domains or the group's role aliases, and
// phone numbers only in the fictional 555-01xx range. Real people's names
// cannot be checked mechanically; this catches the contact details that come
// with them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Generated or third-party bytes, not fixtures.
const SKIP = [/^package-lock\.json$/, /^vendor\//, /^src\/gen\//];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const ALLOWED_DOMAIN = /^(example\.(com|org|net)|nwflorida\.us)$/i;
const PHONE = /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;
const FICTIONAL_PHONE = /555[-. ]01\d\d$/;

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && !SKIP.some((pattern) => pattern.test(file)))
    .filter((file) => !readFileSync(path.join(REPO, file)).subarray(0, 8000).includes(0));
}

function findings(pattern: RegExp, allowed: (match: RegExpMatchArray) => boolean): string[] {
  return trackedTextFiles().flatMap((file) =>
    [...readFileSync(path.join(REPO, file), 'utf8').matchAll(pattern)].filter((m) => !allowed(m)).map((m) => `${file}: ${m[0]}`),
  );
}

describe('made-up people only', () => {
  it('scans the tracked files', () => {
    expect(trackedTextFiles()).toEqual(expect.arrayContaining(['test/migrations/schema.test.ts', 'migrations/0005_membership.sql']));
  });

  it('has email addresses only at example domains or nwflorida.us role aliases', () => {
    expect(findings(EMAIL, (m) => ALLOWED_DOMAIN.test(m[1] ?? ''))).toEqual([]);
  });

  it('has phone numbers only in the fictional 555-01xx range', () => {
    expect(findings(PHONE, (m) => FICTIONAL_PHONE.test(m[0]))).toEqual([]);
  });
});
