// The repository is public with its whole history, so fixtures, test pages
// and placeholders use made-up people only; the roster comes from the API at
// run time. One script (scripts/made-up-people.mjs at the root) walks every
// tracked text file of the repository and allows email addresses only at
// reserved example domains or the group's role aliases, and phone numbers only
// in the fictional 555-01xx range; CI runs it, and so does this suite.
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SCRIPT = path.join(ROOT, 'scripts', 'made-up-people.mjs');

const scan = (cwd: string): Promise<{ code: number; report: { files: string[]; findings: string[] } }> =>
  new Promise((resolve) =>
    execFile('node', [SCRIPT, '--json'], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ code: error === null ? 0 : 1, report: JSON.parse(stdout || '{"files":[],"findings":["no report"]}') })),
  );

describe('made-up people only', () => {
  it('scans the tracked text files of the whole repository, both apps included', async () => {
    const { report } = await scan(process.cwd());
    expect(report.files).toEqual(expect.arrayContaining(['apps/web/src/lib/site.ts', 'apps/web/src/layouts/Base.astro', 'apps/api/migrations/0005_membership.sql']));
    expect(report.files.filter((file) => /package-lock\.json$|\/OFL-|apps\/api\/vendor\/|apps\/api\/src\/gen\//.test(file))).toEqual([]);
  });

  it('finds no real-looking email address or phone number, and is run by CI', async () => {
    const { code, report } = await scan(process.cwd());
    expect(report.findings).toEqual([]);
    expect(code).toBe(0);
    expect(execFileSync('cat', [path.join(ROOT, '.github', 'workflows', 'secrets.yml')], { encoding: 'utf8' })).toMatch(/run: node scripts\/made-up-people\.mjs$/m);
  });

  it('flags a real-looking address or number in another app, whichever folder it runs from', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'nwfl-people-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(path.join(repo, 'scripts'));
      cpSync(SCRIPT, path.join(repo, 'scripts', 'made-up-people.mjs'));
      for (const app of ['web', 'api']) mkdirSync(path.join(repo, 'apps', app), { recursive: true });
      // Assembled at run time, so this file holds no such address or number itself.
      const [email, phone] = [['someone', 'gmail.com'].join('@'), ['850', '555', '2368'].join('-')];
      writeFileSync(path.join(repo, 'apps', 'api', 'seed.json'), JSON.stringify({ email, phone, ok: 'member@example.org 850-555-0142' }));
      execFileSync('git', ['add', '-A'], { cwd: repo });
      const { code, report } = await new Promise<{ code: number; report: { findings: string[] } }>((resolve) =>
        execFile('node', ['../../scripts/made-up-people.mjs', '--json'], { cwd: path.join(repo, 'apps', 'web') }, (error, stdout) =>
          resolve({ code: error === null ? 0 : 1, report: JSON.parse(stdout || '{"files":[],"findings":["no report"]}') }),
        ),
      );
      expect(code).toBe(1);
      expect(report.findings).toEqual([`apps/api/seed.json: ${email}`, `apps/api/seed.json: ${phone}`]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
