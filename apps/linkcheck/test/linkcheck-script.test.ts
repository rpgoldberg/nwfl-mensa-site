// scripts/linkcheck.sh run for real against a stand-in `docker` that only records its arguments, so
// each container's hardening is checked as the officer's machine would get it.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/linkcheck.sh', import.meta.url));
const IMAGE = 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:' + '0'.repeat(64);

// Every folder is removed after its test, so the suite does not fill the container's small /tmp.
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], setup: (dir: string) => void = () => undefined, env: Record<string, string> = {}): { runs: string[][]; dir: string; status: number; stderr: string; dockerEnv: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'linkcheck-sh-'));
  made.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'docker.log');
  writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> "${log}"\necho >> "${log}"\nenv > "${dir}/docker.env"\n`);
  chmodSync(path.join(bin, 'docker'), 0o700);
  writeFileSync(path.join(dir, 'public.pdf'), '%PDF-1.7');
  writeFileSync(path.join(dir, 'members.pdf'), '%PDF-1.7');
  writeFileSync(path.join(dir, 'answers.json'), '{}');
  setup(dir);
  let status = 0;
  let stderr = '';
  try {
    execFileSync('sh', [SCRIPT, ...args.map((a) => a.replace('$DIR', dir))], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('$DIR', dir)])) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  let dockerEnv = '';
  try {
    dockerEnv = readFileSync(path.join(dir, 'docker.env'), 'utf8');
  } catch {
    // no docker run
  }
  return { runs, dir, status, stderr, dockerEnv };
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
const envFlags = (argv: string[]): string[] => argv.flatMap((a, i) => (argv[i - 1] === '-e' ? [a] : []));

// The items mode (LINKCHECK-CRON): a made-up app password in a private file, and made-up addresses.
const PASSWORD = 'made-up-app-password-7Qx';
const ITEMS_ENV = {
  LINKCHECK_API_URL: 'https://api.example.org/',
  LINKCHECK_TOKEN_URL: 'https://id.example.org/application/o/token/',
  LINKCHECK_PASSWORD_FILE: '$DIR/secret/password',
};
function passwordFile(mode = 0o600): (dir: string) => void {
  return (dir) => {
    mkdirSync(path.join(dir, 'secret'), { mode: 0o700 });
    writeFileSync(path.join(dir, 'secret', 'password'), PASSWORD, { mode });
    chmodSync(path.join(dir, 'secret', 'password'), mode);
  };
}

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

  it('passes an earlier remember file to check, read-only, and goes on without one on the first issue', () => {
    const withMemory = run(['check', IMAGE, '2026-10-01', '$DIR/public.pdf', '$DIR/members.pdf', '$DIR/out', '$DIR/remember.json'], (dir) => writeFileSync(path.join(dir, 'remember.json'), '{}'));
    expect(withMemory.status).toBe(0);
    const check = withMemory.runs[2] as string[];
    expect(mounts(check)).toEqual([`${withMemory.dir}/out:/out`, `${withMemory.dir}/remember.json:/in/remember.json:ro`]);
    expect(check.slice(check.indexOf(IMAGE))).toEqual([IMAGE, 'check', '--issue-date', '2026-10-01', '--remember', '/in/remember.json', '--out', '/out', '/out/extract-public.json', '/out/extract-members.json']);
    const first = run(['check', IMAGE, '2026-10-01', '$DIR/public.pdf', '$DIR/members.pdf', '$DIR/out', '$DIR/remember.json']);
    expect(first.status).toBe(0);
    expect((first.runs[2] as string[]).join(' ')).not.toContain('remember');
  });

  it('checks the different links with DNS and no PDF, then runs list with no network', () => {
    const withAnswers = run(['list', IMAGE, '$DIR', '$DIR/answers.json']);
    expect(withAnswers.status).toBe(0);
    expect(withAnswers.runs).toHaveLength(2);
    const [replace, argv] = withAnswers.runs as [string[], string[]];
    expectHardened(replace);
    expect(flag(replace, '--dns')).toBe('1.1.1.1');
    expect(replace).not.toContain('--network');
    expect(replace).toContain('--memory=512m');
    expect(mounts(replace)).toEqual([`${withAnswers.dir}:/out`, `${withAnswers.dir}/answers.json:/in/answers.json:ro`]);
    expect(replace.join(' ')).not.toMatch(/\.pdf/);
    expect(replace.slice(replace.indexOf(IMAGE) + 1)).toEqual(['replace', '--check', '/out/check.json', '--answers', '/in/answers.json', '--out', '/out']);
    expectHardened(argv);
    expect(flag(argv, '--network')).toBe('none');
    expect(mounts(argv)).toEqual([`${withAnswers.dir}:/out`, `${withAnswers.dir}/answers.json:/in/answers.json:ro`]);
    expect(argv.slice(argv.indexOf(IMAGE) + 1)).toEqual(['list', '--check', '/out/check.json', '--public', '/out/extract-public.json', '--members', '/out/extract-members.json', '--answers', '/in/answers.json', '--replacements', '/out/check-replacements.json', '--out', '/out']);
    const without = run(['list', IMAGE, '$DIR']);
    expect(without.status).toBe(0);
    expect((without.runs[0] as string[]).join(' ')).not.toContain('answers');
    expect(flag(without.runs[0] as string[], '--network')).toBe('none');
  });

  it('reads the remember file into list, read-only, and carries the new one back to it', () => {
    const later = run(['list', IMAGE, '$DIR', '$DIR/answers.json', '$DIR/keep/remember.json'], (dir) => {
      mkdirSync(path.join(dir, 'keep'));
      writeFileSync(path.join(dir, 'keep', 'remember.json'), 'OLD');
      writeFileSync(path.join(dir, 'remember.json'), 'NEW');
    });
    expect(later.status).toBe(0);
    const argv = later.runs[1] as string[];
    expect(flag(argv, '--network')).toBe('none');
    expect(mounts(argv)).toEqual([`${later.dir}:/out`, `${later.dir}/answers.json:/in/answers.json:ro`, `${later.dir}/keep/remember.json:/in/remember.json:ro`]);
    expect(argv.slice(argv.indexOf('--replacements'))).toEqual(['--replacements', '/out/check-replacements.json', '--remember', '/in/remember.json', '--out', '/out']);
    expect(readFileSync(path.join(later.dir, 'keep', 'remember.json'), 'utf8')).toBe('NEW');
    const first = run(['list', IMAGE, '$DIR', '$DIR/answers.json', '$DIR/keep/remember.json'], (dir) => {
      mkdirSync(path.join(dir, 'keep'));
      writeFileSync(path.join(dir, 'remember.json'), 'NEW');
    });
    expect(first.status).toBe(0);
    expect((first.runs[1] as string[]).join(' ')).not.toContain('--remember');
    expect(readFileSync(path.join(first.dir, 'keep', 'remember.json'), 'utf8')).toBe('NEW');
  });

  it.each([
    [['check', IMAGE, 'soon', '$DIR/public.pdf', '$DIR/members.pdf', '$DIR/out']],
    [['check', IMAGE, '2026-09-01', '$DIR/missing.pdf', '$DIR/members.pdf', '$DIR/out']],
    [['check', IMAGE]],
    [['probe', IMAGE, 'x']],
    [['items']],
    [['list', IMAGE, '$DIR', '$DIR/answers.json', '$DIR/b', '$DIR/c']],
    [['list', IMAGE, '$DIR', '$DIR/missing.json']],
    [['list', IMAGE, '$DIR', '$DIR/answers.json', '$DIR/nowhere/remember.json']],
    [['check', IMAGE, '2026-09-01', '$DIR/public.pdf', '$DIR/members.pdf', '$DIR/out', '$DIR/nowhere/remember.json']],
  ])('refuses %j and starts no container', (args) => {
    const { runs, status } = run(args);
    expect(status).toBe(2);
    expect(runs).toEqual([]);
  });

  it('runs items hardened, with DNS and no PDF, the password as a read-only file and never as a value', () => {
    const { runs, dir, status, dockerEnv } = run(['items', IMAGE], passwordFile(), ITEMS_ENV);
    expect(status).toBe(0);
    expect(runs).toHaveLength(1);
    const argv = runs[0] as string[];
    expect(argv[0]).toBe('run');
    expectHardened(argv);
    expect(flag(argv, '--dns')).toBe('1.1.1.1');
    expect(argv).not.toContain('--network');
    expect(argv).toContain('--memory=512m');
    expect(argv).toContain('--memory-swap=512m');
    expect(mounts(argv)).toEqual([`${dir}/secret/password:/in/password:ro`]);
    expect(argv.join(' ')).not.toMatch(/\.pdf/);
    expect(envFlags(argv)).toEqual(['LINKCHECK_API_URL', 'LINKCHECK_TOKEN_URL', 'LINKCHECK_PASSWORD_FILE=/in/password']);
    expect(argv.slice(argv.indexOf(IMAGE))).toEqual([IMAGE, 'items']);
    // The password is in no argument and no environment value; the addresses travel by name, through docker's own environment.
    expect(argv.join(' ')).not.toContain(PASSWORD);
    expect(dockerEnv).not.toContain(PASSWORD);
    expect(dockerEnv).toContain('LINKCHECK_API_URL=https://api.example.org/');
    expect(dockerEnv).toContain('LINKCHECK_TOKEN_URL=https://id.example.org/application/o/token/');
  });

  it('becomes docker for items (exec), so a signal sent to the script reaches docker itself', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'linkcheck-sh-'));
    made.push(dir);
    mkdirSync(path.join(dir, 'bin'));
    writeFileSync(path.join(dir, 'bin', 'docker'), `#!/bin/sh\necho $$ > '${dir}/docker.pid'\n`, { mode: 0o700 });
    passwordFile()(dir);
    const done = spawnSync('sh', [SCRIPT, 'items', IMAGE], { cwd: dir, env: { PATH: `${dir}/bin:/usr/bin:/bin`, ...ITEMS_ENV, LINKCHECK_PASSWORD_FILE: `${dir}/secret/password` } });
    expect(done.status).toBe(0);
    expect(readFileSync(path.join(dir, 'docker.pid'), 'utf8').trim()).toBe(String(done.pid));
  });

  it('reads the image name in the C locale, whatever locale it is given', () => {
    const { status, dockerEnv } = run(['items', IMAGE], passwordFile(), { ...ITEMS_ENV, LC_ALL: 'en_US.UTF-8' });
    expect(status).toBe(0);
    expect(dockerEnv.split('\n')).toContain('LC_ALL=C');
  });

  it('passes the optional client, username and scope through by name, and only when they are set', () => {
    const { runs, status, dockerEnv } = run(['items', IMAGE], passwordFile(), { ...ITEMS_ENV, LINKCHECK_CLIENT_ID: 'made-up-client', LINKCHECK_USERNAME: 'svc-made-up', LINKCHECK_SCOPE: 'links.made-up' });
    expect(status).toBe(0);
    const argv = runs[0] as string[];
    expect(envFlags(argv)).toEqual(['LINKCHECK_API_URL', 'LINKCHECK_TOKEN_URL', 'LINKCHECK_CLIENT_ID', 'LINKCHECK_USERNAME', 'LINKCHECK_SCOPE', 'LINKCHECK_PASSWORD_FILE=/in/password']);
    expect(argv.join(' ')).not.toMatch(/made-up-client|svc-made-up|links\.made-up/);
    expect(dockerEnv).toContain('LINKCHECK_CLIENT_ID=made-up-client');
    expect(dockerEnv).toContain('LINKCHECK_USERNAME=svc-made-up');
    expect(dockerEnv).toContain('LINKCHECK_SCOPE=links.made-up');
    const one = run(['items', IMAGE], passwordFile(), { ...ITEMS_ENV, LINKCHECK_CLIENT_ID: '', LINKCHECK_SCOPE: 'links.made-up' });
    expect(envFlags(one.runs[0] as string[])).toEqual(['LINKCHECK_API_URL', 'LINKCHECK_TOKEN_URL', 'LINKCHECK_SCOPE', 'LINKCHECK_PASSWORD_FILE=/in/password']);
  });

  it.each([
    ['a tag', 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck:3f1e5a2'],
    ['no tag at all', 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck'],
    ['a short digest', 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:' + '0'.repeat(63)],
    ['a long digest', 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:' + '0'.repeat(65)],
    ['a digest that is not lower-case hex', 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:' + 'G'.repeat(64)],
    ['another digest kind', 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha512:' + '0'.repeat(64)],
    ['a digest with no name', '@sha256:' + '0'.repeat(64)],
    ['a flag in front of the digest (--volume)', '--volume=/:/host@sha256:' + '0'.repeat(64)],
    ['a flag alone in front of the digest (--privileged)', '--privileged@sha256:' + '0'.repeat(64)],
    ['a flag in front of the digest (--mount)', '--mount=type=bind,src=/,dst=/host@sha256:' + '0'.repeat(64)],
    ['a bare 64-character image ID', 'b6768d51cf8ff5352ffd6b080449852a8b3ef30cdd7e490a7421da906cf3a9ff'],
    ['a name that starts with a dot', '.ghcr.io/made-up/linkcheck@sha256:' + '0'.repeat(64)],
    ['a name with a space', 'ghcr.io/made-up/linkcheck --privileged@sha256:' + '0'.repeat(64)],
    ['a name with upper-case letters', 'GHCR.IO/made-up/linkcheck@sha256:' + '0'.repeat(64)],
    ['two digests', 'ghcr.io/made-up/linkcheck@sha256:' + '1'.repeat(64) + '@sha256:' + '0'.repeat(64)],
    ['a trailing newline', IMAGE + '\n'],
    ['a trailing carriage return', IMAGE + '\r'],
    ['a second line', 'ghcr.io/made-up/linkcheck\n--privileged@sha256:' + '0'.repeat(64)],
  ])('refuses items on an image given by %s, and starts no container', (_, image) => {
    const { runs, status, stderr } = run(['items', image], passwordFile(), ITEMS_ENV);
    expect(status).toBe(2);
    expect(runs).toEqual([]);
    expect(stderr).toContain('give the image by its digest');
  });

  it.each([
    ['no API address', { LINKCHECK_API_URL: '' }, passwordFile(), [], 'LINKCHECK_API_URL and LINKCHECK_TOKEN_URL'],
    ['no token address', { LINKCHECK_TOKEN_URL: '' }, passwordFile(), [], 'LINKCHECK_API_URL and LINKCHECK_TOKEN_URL'],
    ['no password file named', { LINKCHECK_PASSWORD_FILE: '' }, passwordFile(), [], 'LINKCHECK_PASSWORD_FILE'],
    ['a password file that is not there', {}, () => undefined, [], 'LINKCHECK_PASSWORD_FILE'],
    ['a password file others can read', {}, passwordFile(0o640), [], 'chmod 600'],
    ['a password file anyone can write', {}, passwordFile(0o602), [], 'chmod 600'],
    ['an extra argument', {}, passwordFile(), ['more'], 'usage'],
    ['a password file whose path holds a colon', { LINKCHECK_PASSWORD_FILE: '$DIR/se:cret/password' }, (dir: string) => { mkdirSync(path.join(dir, 'se:cret')); writeFileSync(path.join(dir, 'se:cret', 'password'), PASSWORD, { mode: 0o600 }); }, [], 'colon'],
  ] as const)('refuses items with %s, and starts no container', (_, env, setup, extra, message) => {
    const { runs, status, stderr } = run(['items', IMAGE, ...extra], setup, { ...ITEMS_ENV, ...env });
    expect(status).toBe(2);
    expect(runs).toEqual([]);
    expect(stderr).toContain(message);
    expect(stderr).not.toContain(PASSWORD);
  });
});
