// MT-06: the site installs only from the public npm registry. A private
// registry address or its token variable in any tracked file of the
// repository would tie a build to an fc credential, so neither may appear
// anywhere. One script checks the whole repository (scripts/no-fc-credentials.sh
// at the root), in CI and here. The patterns are assembled at run time so this
// file does not match itself.
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SCRIPT = path.join(ROOT, 'scripts', 'no-fc-credentials.sh');
const BANNED = [['NODE', 'AUTH', 'TOKEN'].join('_'), ['npm', 'pkg', 'github', 'com'].join('.')];

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '');
}

const sh = (args: string[], cwd: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => execFile('sh', args, { cwd }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : 1, out: `${stdout}${stderr}` })));

describe('no private registry (MT-06)', () => {
  it('scans every tracked file of the repository, both apps, lockfiles, npm config and workflows included', () => {
    expect(tracked()).toEqual(
      expect.arrayContaining(['apps/web/package-lock.json', 'apps/web/.npmrc', 'apps/api/package-lock.json', '.github/workflows/web.yml', '.github/workflows/secrets.yml']),
    );
  });

  it('names neither the private registry nor its token variable in any tracked file', () => {
    const hits = tracked().flatMap((file) => {
      const text = readFileSync(path.join(ROOT, file)).toString('latin1');
      return BANNED.filter((word) => text.includes(word)).map((word) => `${file}: ${word}`);
    });
    expect(hits).toEqual([]);
  });

  it('is checked in CI by the root script, which passes here', async () => {
    expect(readFileSync(path.join(ROOT, '.github', 'workflows', 'secrets.yml'), 'utf8')).toMatch(/run: sh scripts\/no-fc-credentials\.sh$/m);
    const result = await sh([SCRIPT], process.cwd());
    expect(result.code, result.out).toBe(0);
  });

  it('finds one anywhere in the repository, whichever folder it runs from', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'nwfl-mt06-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(path.join(repo, 'scripts'));
      cpSync(SCRIPT, path.join(repo, 'scripts', 'no-fc-credentials.sh'));
      for (const app of ['web', 'api']) mkdirSync(path.join(repo, 'apps', app), { recursive: true });
      writeFileSync(path.join(repo, 'apps', 'api', '.npmrc'), `//${BANNED[1]}/:_authToken=\${${BANNED[0]}}\n`);
      execFileSync('git', ['add', '-A'], { cwd: repo });
      const result = await sh(['../../scripts/no-fc-credentials.sh'], path.join(repo, 'apps', 'web'));
      expect(result.code).not.toBe(0);
      expect(result.out).toContain('apps/api/.npmrc');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
