// The secret-scanning gate, one for the whole repository: the root's
// .githooks/pre-commit runs the pinned gitleaks (scripts/gitleaks.sh) over the
// staged changes and refuses a commit that adds a secret, and the root's
// secrets workflow scans the whole history. Proven on a throwaway repository that uses this repo's hook,
// so nothing here commits to the real one. The fake token is assembled at run
// time; a literal would make gitleaks flag this file.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const HOOKS = path.join(ROOT, '.githooks');
const WRAPPER = path.join(ROOT, 'scripts', 'gitleaks.sh');

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

const dockerUp = (): Promise<boolean> => run('docker', ['info'], REPO).then((r) => r.code === 0);

describe('gitleaks', () => {
  it('pins one version, by tag and image digest, in one place', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    const version = /^VERSION=(\d+\.\d+\.\d+)$/m.exec(wrapper)?.[1];
    expect(version).toBe('8.30.1');
    expect(wrapper).toMatch(/^IMAGE=ghcr\.io\/gitleaks\/gitleaks:v8\.30\.1@sha256:[0-9a-f]{64}$/m);
  });

  it('ships an executable pre-commit hook that scans the staged changes', () => {
    const hook = path.join(HOOKS, 'pre-commit');
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(readFileSync(hook, 'utf8')).toMatch(/gitleaks\.sh" git --pre-commit --staged/);
  });

  it('has no copy of its own in the app: one hook and one script for the repository', () => {
    for (const own of ['.githooks', path.join('scripts', 'gitleaks.sh'), '.github']) expect(existsSync(path.join(REPO, own)), own).toBe(false);
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['secrets:scan']).toBe('sh ../../scripts/gitleaks.sh git --log-opts=--all');
  });

  it('is wired by npm prepare from the app folder, pointing git at the root hooks, and is a no-op outside a checkout', async () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const prepare = pkg.scripts['prepare'] ?? '';
    expect(prepare).not.toBe('');
    const checkout = mkdtempSync(path.join(os.tmpdir(), 'nwfl-prepare-'));
    const bare = mkdtempSync(path.join(os.tmpdir(), 'nwfl-prepare-nogit-'));
    try {
      await run('git', ['init', '-q'], checkout);
      const app = path.join(checkout, 'apps', 'web');
      mkdirSync(app, { recursive: true });
      expect((await run('sh', ['-c', prepare], app)).code).toBe(0);
      // Relative to the top of the work tree, where git runs hooks: the root's .githooks.
      expect((await run('git', ['config', 'core.hooksPath'], checkout)).out.trim()).toBe('.githooks');
      expect((await run('sh', ['-c', prepare], bare)).code).toBe(0);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('runs in CI once, from the root, over every commit', () => {
    const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'secrets.yml'), 'utf8');
    expect(ci).toMatch(/fetch-depth: 0/);
    expect(ci).toMatch(/run: sh scripts\/gitleaks\.sh git --log-opts=--all$/m);
    expect(ci).not.toMatch(/working-directory/);
  });

  it('uses a local gitleaks only when it is exactly the pinned version', async () => {
    const stubDir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-gitleaks-stub-'));
    const stub = (reported: string): void => {
      writeFileSync(path.join(stubDir, 'gitleaks'), `#!/bin/sh\nif [ "$1" = version ]; then echo ${reported}; else echo "STUB $*"; fi\n`, { mode: 0o755 });
    };
    const env = { ...process.env, PATH: `${stubDir}:${process.env['PATH'] ?? ''}` };
    try {
      stub('8.30.1');
      expect((await run('sh', [WRAPPER, 'git', '--help'], REPO, env)).out).toBe('STUB git --help --redact --verbose --no-banner .\n');
      stub('8.0.0');
      expect((await run('sh', [WRAPPER, 'git', '--help'], REPO, env)).out).not.toContain('STUB');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  describe('the hook on a throwaway repository', () => {
    let dir: string;
    let canRun = false;

    beforeAll(async () => {
      canRun = await dockerUp();
      dir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-gitleaks-'));
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['config', 'user.name', 'Test Author'],
        ['config', 'user.email', 'author@example.org'],
        ['config', 'commit.gpgsign', 'false'],
        ['config', 'core.hooksPath', HOOKS],
      ]) {
        await run('git', args, dir);
      }
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it.runIf(process.env['CI'] === 'true')('has Docker in CI', () => {
      expect(canRun).toBe(true);
    });

    it('lets a clean change through', async ({ skip }) => {
      if (!canRun) skip();
      writeFileSync(path.join(dir, 'notes.md'), 'Lunch moves to the second Friday.\n');
      await run('git', ['add', 'notes.md'], dir);
      const commit = await run('git', ['commit', '-q', '-m', 'Add notes'], dir);
      expect(commit.code, commit.out).toBe(0);
    });

    it('refuses a commit that adds a token, and redacts it in the report', async ({ skip }) => {
      if (!canRun) skip();
      const token = `gh${'p_'}${randomBytes(27).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 36)}`;
      writeFileSync(path.join(dir, 'config.env'), `GITHUB_TOKEN=${token}\n`);
      await run('git', ['add', 'config.env'], dir);
      const commit = await run('git', ['commit', '-q', '-m', 'Add config'], dir);
      expect(commit.code).not.toBe(0);
      expect(commit.out).toMatch(/leaks found: [1-9]/);
      expect(commit.out).not.toContain(token);
      expect((await run('git', ['log', '--oneline'], dir)).out).not.toMatch(/Add config/);
    });
  });
});
