// The repository is public with its whole history, so fixtures and tests use
// made-up people only. One script (scripts/made-up-people.mjs at the root)
// walks every tracked text file of the repository and allows email addresses
// only at reserved example domains or the group's role aliases, and phone
// numbers only in the fictional 555-01xx range; CI runs it, and so does this
// suite. Real people's names cannot be checked mechanically; this catches the
// contact details that come with them.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, encoding: 'utf8' }).trim();

const scan = (): Promise<{ code: number; report: { files: string[]; findings: string[] } }> =>
  new Promise((resolve) =>
    execFile('node', [path.join(ROOT, 'scripts', 'made-up-people.mjs'), '--json'], { cwd: REPO, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve({ code: error === null ? 0 : 1, report: JSON.parse(stdout || '{"files":[],"findings":["no report"]}') as { files: string[]; findings: string[] } }),
    ),
  );

describe('made-up people only', () => {
  it('scans the tracked text files of the whole repository, but not vendored or generated code', async () => {
    const { report } = await scan();
    expect(report.files).toEqual(expect.arrayContaining(['apps/api/test/migrations/schema.test.ts', 'apps/api/migrations/0005_membership.sql', 'apps/web/src/lib/site.ts']));
    expect(report.files.filter((file) => /^apps\/api\/(vendor|src\/gen)\/|package-lock\.json$/.test(file))).toEqual([]);
  });

  it('finds no real-looking email address or phone number, and is run by CI', async () => {
    const { code, report } = await scan();
    expect(report.findings).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(path.join(ROOT, '.github', 'workflows', 'secrets.yml'), 'utf8')).toMatch(/run: node scripts\/made-up-people\.mjs$/m);
  });
});
