// The secret-scanning gate: .githooks/pre-commit runs the pinned gitleaks over
// the staged changes and refuses a commit that adds a secret. Proven on a
// throwaway repository that uses this repo's hook, so nothing here commits to
// the real one. The fake token is assembled at run time; a literal would make
// gitleaks flag this file.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOKS = path.join(REPO, '.githooks');
const WRAPPER = path.join(REPO, 'scripts', 'gitleaks.sh');

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
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
    expect(version).toBeDefined();
    expect(wrapper).toMatch(new RegExp(`^IMAGE=ghcr\\.io/gitleaks/gitleaks:v${version?.replace(/\./g, '\\.')}@sha256:[0-9a-f]{64}$`, 'm'));
  });

  it('ships an executable pre-commit hook that scans the staged changes', () => {
    const hook = path.join(HOOKS, 'pre-commit');
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(readFileSync(hook, 'utf8')).toMatch(/gitleaks\.sh" git --pre-commit --staged/);
  });

  it('runs in CI over the whole history', () => {
    const ci = readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/sh scripts\/gitleaks\.sh git --log-opts=--all/);
  });

  it('uses a local gitleaks only when it is exactly the pinned version', async () => {
    const version = /^VERSION=(\S+)$/m.exec(readFileSync(WRAPPER, 'utf8'))?.[1] ?? '';
    const stubDir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-gitleaks-stub-'));
    const stub = (reported: string): void => {
      writeFileSync(path.join(stubDir, 'gitleaks'), `#!/bin/sh\nif [ "$1" = version ]; then echo ${reported}; else echo "STUB $*"; fi\n`, { mode: 0o755 });
    };
    const viaWrapper = (): Promise<{ code: number; out: string }> =>
      new Promise((resolve) => {
        execFile('sh', [WRAPPER, 'git', '--help'], { cwd: REPO, env: { ...process.env, PATH: `${stubDir}:${process.env['PATH'] ?? ''}` } }, (error, stdout, stderr) =>
          resolve({ code: error === null ? 0 : 1, out: `${stdout}${stderr}` }),
        );
      });
    try {
      stub(version);
      expect((await viaWrapper()).out).toBe('STUB git --help --redact --verbose --no-banner .\n');
      stub('8.0.0');
      expect((await viaWrapper()).out).not.toContain('STUB');
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
      const log = await run('git', ['log', '--oneline'], dir);
      expect(log.out).not.toMatch(/Add config/);
    });
  });
});
