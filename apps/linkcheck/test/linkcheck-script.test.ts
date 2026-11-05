// scripts/linkcheck.sh run for real against a stand-in `docker` that only records its arguments, so
// each container's hardening is checked as the officer's machine would get it.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/linkcheck.sh', import.meta.url));
const IMAGE = 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:' + '0'.repeat(64);

function run(args: string[]): { runs: string[][]; dir: string; status: number; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'linkcheck-sh-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'docker.log');
  writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> "${log}"\necho >> "${log}"\n`);
  chmodSync(path.join(bin, 'docker'), 0o700);
  writeFileSync(path.join(dir, 'public.pdf'), '%PDF-1.7');
  writeFileSync(path.join(dir, 'members.pdf'), '%PDF-1.7');
  writeFileSync(path.join(dir, 'answers.json'), '{}');
  let status = 0;
  let stderr = '';
  try {
    execFileSync('sh', [SCRIPT, ...args.map((a) => a.replace('$DIR', dir))], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    status = (error as { status: number }).status;
    stderr = String((error as { stderr: Buffer }).stderr);
  }
  let text = '';
  try {
    text = readFileSync(log, 'utf8');
  } catch {
    // no docker run
  }
  const runs = text.split('\n').filter(Boolean).map((line) => line.split('\u001f').filter(Boolean));
  return { runs, dir, status, stderr };
}

const HARDENING = ['--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--cpus', '1'];

function expectHardened(argv: string[]): void {
  for (const flag of HARDENING) expect(argv).toContain(flag);
  expect(argv).toContain('--tmpfs');
  expect(argv[argv.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,noexec,nosuid,size=64m');
  const user = argv[argv.indexOf('--user') + 1] as string;
  expect(user).toMatch(/^\d+:\d+$/);
  expect(user.startsWith('0:')).toBe(false);
}

const flag = (argv: string[], name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const mounts = (argv: string[]): string[] => argv.flatMap((a, i) => (argv[i - 1] === '-v' ? [a] : []));

describe('scripts/linkcheck.sh', () => {
  it('runs extract twice with no network, then check with DNS and no PDF', () => {
    const { runs, dir, status } = run(['check', IMAGE, '2026-09-01', '$DIR/public.pdf', '$DIR/members.pdf', '$DIR/out']);
    expect(status).toBe(0);
    expect(runs).toHaveLength(3);
    const [pub, mem, check] = runs as [string[], string[], string[]];
    for (const [argv, audience, pdf] of [[pub, 'public', 'public.pdf'], [mem, 'members', 'members.pdf']] as const) {
      expect(argv[0]).toBe('run');
      expectHardened(argv);
      expect(flag(argv, '--network')).toBe('none');
      expect(argv).not.toContain('--dns');
      expect(flag(argv, '--memory')).toBe(undefined);
      expect(argv).toContain('--memory=1g');
      expect(mounts(argv)).toEqual([`${dir}/${pdf}:/in/file.pdf:ro`, `${dir}/out:/out`]);
      expect(argv.slice(argv.indexOf(IMAGE))).toEqual([IMAGE, 'extract', '--audience', audience, '--in', '/in/file.pdf', '--out', '/out']);
    }
    expectHardened(check);
    expect(flag(check, '--dns')).toBe('1.1.1.1');
    expect(check).not.toContain('--network');
    expect(check).toContain('--memory=512m');
    expect(mounts(check)).toEqual([`${dir}/out:/out`]);
    expect(check.join(' ')).not.toMatch(/\.pdf/);
    expect(check.slice(check.indexOf(IMAGE))).toEqual([IMAGE, 'check', '--issue-date', '2026-09-01', '--out', '/out', '/out/extract-public.json', '/out/extract-members.json']);
  });

  it('runs list with no network, with and without answers', () => {
    const withAnswers = run(['list', IMAGE, '$DIR', '$DIR/answers.json']);
    expect(withAnswers.status).toBe(0);
    const [argv] = withAnswers.runs as [string[]];
    expectHardened(argv);
    expect(flag(argv, '--network')).toBe('none');
    expect(mounts(argv)).toEqual([`${withAnswers.dir}:/out`, `${withAnswers.dir}/answers.json:/in/answers.json:ro`]);
    expect(argv.slice(argv.indexOf(IMAGE) + 1)).toEqual(['list', '--check', '/out/check.json', '--public', '/out/extract-public.json', '--members', '/out/extract-members.json', '--answers', '/in/answers.json', '--out', '/out']);
    const without = run(['list', IMAGE, '$DIR']);
    expect(without.status).toBe(0);
    expect((without.runs[0] as string[]).join(' ')).not.toContain('answers');
    expect(flag(without.runs[0] as string[], '--network')).toBe('none');
  });

  it.each([
    [['check', IMAGE, 'soon', '$DIR/public.pdf', '$DIR/members.pdf', '$DIR/out']],
    [['check', IMAGE, '2026-09-01', '$DIR/missing.pdf', '$DIR/members.pdf', '$DIR/out']],
    [['check', IMAGE]],
    [['probe', IMAGE, 'x']],
    [['list', IMAGE, '$DIR', '$DIR/a', '$DIR/b']],
  ])('refuses %j and starts no container', (args) => {
    const { runs, status } = run(args);
    expect(status).toBe(2);
    expect(runs).toEqual([]);
  });
});
