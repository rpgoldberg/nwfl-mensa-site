// scripts/items-cron.sh run for real, with a stand-in `docker` and a stand-in `bao` on PATH: no test
// reaches a real OpenBao or starts a container. The secret, the addresses and the image are made up.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/items-cron.sh', import.meta.url));
const IMAGE = 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:' + '0'.repeat(64);
const PASSWORD = 'made-up-app-password-7Qx';
const SECRET = { client_id: 'made-up-client', username: 'svc-made-up', password: PASSWORD };
const CONF = `# made-up settings\nLINKCHECK_IMAGE=${IMAGE}\n\nLINKCHECK_API_URL=https://api.example.org/\nLINKCHECK_TOKEN_URL=https://id.example.org/application/o/token/\n`;
const COUNTS = 'items: 2 addresses checked: 1 ok, 1 confirm, 0 drop; 2 recorded, 0 no longer waiting';
const STAMP = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d`;

// The stand-in docker records its arguments and environment, and what the mounted password file
// held and how private it was while "the container" ran. ctl/ files steer it: docker-out (stdout),
// docker-err (stderr), docker-exit (the exit code), docker-block (wait for ctl/release or a TERM).
const DOCKER = (dir: string): string => `#!/bin/sh
D='${dir}'
for a in "$@"; do printf '%s\\037' "$a"; done >> "$D/docker.log"
echo >> "$D/docker.log"
env > "$D/docker.env"
prev=
for a in "$@"; do
  if [ "$prev" = -v ]; then
    src=\${a%%:*}
    cat "$src" > "$D/seen-password"
    stat -c %a "$src" "$(dirname "$src")" | tr '\\n' ' ' > "$D/seen-modes"
  fi
  prev=$a
done
if [ -e "$D/ctl/docker-block" ]; then
  trap 'echo term >> "$D/docker-term"; exit 143' TERM
  : > "$D/started"
  while [ ! -e "$D/ctl/release" ]; do sleep 0.05; done
fi
[ ! -e "$D/ctl/docker-out" ] || cat "$D/ctl/docker-out"
[ ! -e "$D/ctl/docker-err" ] || cat "$D/ctl/docker-err" >&2
exit "$(cat "$D/ctl/docker-exit" 2>/dev/null || echo 0)"
`;

// The stand-in bao answers `status` with ctl/bao-status (0 by default) and `kv get -field=<f> <path>`
// with ctl/secret-<f>, for the one path the wrapper may read. ctl/bao-block makes it wait for ctl/release.
const BAO = (dir: string): string => `#!/bin/sh
D='${dir}'
echo "$*" >> "$D/bao.log"
echo "BAO_ADDR=\${BAO_ADDR:-}" > "$D/bao.env"
if [ -e "$D/ctl/bao-block" ]; then
  : > "$D/bao-started"
  while [ ! -e "$D/ctl/release" ]; do sleep 0.05; done
fi
case $1 in
  status) exit "$(cat "$D/ctl/bao-status" 2>/dev/null || echo 0)" ;;
  kv)
    [ "$2" = get ] && [ "$4" = secret/nwfl-mensa/linkcheck/client ] || exit 2
    f="$D/ctl/secret-\${3#-field=}"
    [ -e "$f" ] || { echo "No value found" >&2; exit 2; }
    cat "$f"
    ;;
  *) exit 1 ;;
esac
`;

interface Box {
  dir: string;
  state: string;
  env: Record<string, string>;
}

interface Setup {
  conf?: string | null;
  secret?: Partial<Record<keyof typeof SECRET, string>>;
  bao?: boolean;
  ctl?: Record<string, string>;
}

function box({ conf = CONF, secret = SECRET, bao = true, ctl = { 'docker-out': `${COUNTS}\n` } }: Setup = {}): Box {
  const dir = mkdtempSync(path.join(tmpdir(), 'items-cron-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  for (const d of [bin, home, path.join(dir, 'ctl'), path.join(home, '.config', 'nwfl-linkcheck')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, 'docker'), DOCKER(dir), { mode: 0o700 });
  if (bao) writeFileSync(path.join(bin, 'bao'), BAO(dir), { mode: 0o700 });
  if (conf !== null) writeFileSync(path.join(home, '.config', 'nwfl-linkcheck', 'items.conf'), conf);
  for (const [field, value] of Object.entries(secret)) writeFileSync(path.join(dir, 'ctl', `secret-${field}`), value);
  for (const [name, value] of Object.entries(ctl)) writeFileSync(path.join(dir, 'ctl', name), value);
  return { dir, state: path.join(home, '.local', 'state', 'nwfl-linkcheck'), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } };
}

const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const logLines = (b: Box): string[] => read(path.join(b.state, 'items.log')).split('\n').filter(Boolean);
const dockerRuns = (b: Box): string[][] => read(path.join(b.dir, 'docker.log')).split('\n').filter(Boolean).map((line) => line.split('\u001f').filter(Boolean));
const baoCalls = (b: Box): string[] => read(path.join(b.dir, 'bao.log')).split('\n').filter(Boolean);
const runDirs = (b: Box): string[] => (existsSync(b.state) ? readdirSync(b.state).filter((name) => name.startsWith('run.')) : []);
const mode = (file: string): number => statSync(file).mode & 0o777;

function runOnce(b: Box): { status: number | null; stdout: string; stderr: string } {
  const done = spawnSync('sh', [SCRIPT], { env: b.env, encoding: 'utf8', timeout: 20_000 });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

function start(b: Box): { child: ChildProcess; exit: Promise<number | null> } {
  const child = spawn('sh', [SCRIPT], { env: b.env, stdio: 'ignore' });
  return { child, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

async function seen(file: string): Promise<void> {
  for (let i = 0; i < 400 && !existsSync(file); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(existsSync(file)).toBe(true);
}

/** Everything a run left behind that a person or a process list could read. */
function everythingWritten(b: Box, run: { stdout: string; stderr: string }): string {
  return [run.stdout, run.stderr, read(path.join(b.state, 'items.log')), read(path.join(b.dir, 'docker.log')), read(path.join(b.dir, 'docker.env')), read(path.join(b.dir, 'bao.log'))].join('\n');
}

describe('scripts/items-cron.sh', () => {
  it('reads the secret, runs items with the pinned image and logs one line: time, exit code, counts', () => {
    const b = box({ conf: `${CONF}LINKCHECK_SCOPE=links.made-up\nBAO_ADDR=https://bao.example.org:8200\n` });
    const run = runOnce(b);
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' });
    const lines = logLines(b);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${STAMP} exit=0 ${COUNTS}$`));
    expect(baoCalls(b)).toEqual(['status', ...['client_id', 'username', 'password'].map((f) => `kv get -field=${f} secret/nwfl-mensa/linkcheck/client`)]);
    expect(read(path.join(b.dir, 'bao.env'))).toBe('BAO_ADDR=https://bao.example.org:8200\n');
    const runs = dockerRuns(b);
    expect(runs).toHaveLength(1);
    const argv = runs[0] as string[];
    expect(argv.slice(-2)).toEqual([IMAGE, 'items']);
    expect(argv).toContain('--read-only');
    const env = read(path.join(b.dir, 'docker.env'));
    for (const line of ['LINKCHECK_API_URL=https://api.example.org/', 'LINKCHECK_TOKEN_URL=https://id.example.org/application/o/token/', 'LINKCHECK_CLIENT_ID=made-up-client', 'LINKCHECK_USERNAME=svc-made-up', 'LINKCHECK_SCOPE=links.made-up']) expect(env.split('\n')).toContain(line);
    for (const name of ['LINKCHECK_API_URL', 'LINKCHECK_TOKEN_URL', 'LINKCHECK_CLIENT_ID', 'LINKCHECK_USERNAME', 'LINKCHECK_SCOPE', 'LINKCHECK_PASSWORD_FILE=/in/password']) expect(argv[argv.indexOf(name) - 1]).toBe('-e');
    expect(mode(b.state)).toBe(0o700);
    expect(mode(path.join(b.state, 'items.log'))).toBe(0o600);
  });

  it('hands the password over only as a 0600 file in a fresh 0700 folder: never an argument, an environment value or a log', () => {
    const b = box();
    const run = runOnce(b);
    expect(run.status).toBe(0);
    expect(read(path.join(b.dir, 'seen-password'))).toBe(PASSWORD);
    expect(read(path.join(b.dir, 'seen-modes'))).toBe('600 700 ');
    const mount = (dockerRuns(b)[0] as string[]).find((a) => a.endsWith(':/in/password:ro')) as string;
    expect(mount).toMatch(new RegExp(`^${b.state}/run\\.[A-Za-z0-9]{6}/password:/in/password:ro$`));
    expect(everythingWritten(b, run)).not.toContain(PASSWORD);
    // The client id and the username go by name through docker's own environment, never as arguments.
    expect(read(path.join(b.dir, 'docker.log'))).not.toMatch(/made-up-client|svc-made-up/);
    expect(logLines(b).join('\n')).not.toMatch(/made-up-client|svc-made-up/);
  });

  it('appends one line per run', () => {
    const b = box();
    expect(runOnce(b).status).toBe(0);
    writeFileSync(path.join(b.dir, 'ctl', 'docker-out'), 'items: 0 addresses checked: 0 ok, 0 confirm, 0 drop; 0 recorded, 0 no longer waiting; more wait, run again\n');
    expect(runOnce(b).status).toBe(0);
    const lines = logLines(b);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^${STAMP} exit=0 items: 0 addresses checked: 0 ok, 0 confirm, 0 drop; 0 recorded, 0 no longer waiting; more wait, run again$`));
  });

  it('removes the private folder after a good run, and one a killed run left behind', () => {
    const b = box();
    mkdirSync(path.join(b.state, 'run.dead01'), { recursive: true });
    writeFileSync(path.join(b.state, 'run.dead01', 'password'), 'an-older-made-up-password');
    expect(runOnce(b).status).toBe(0);
    expect(runDirs(b)).toEqual([]);
    expect(readdirSync(b.state).sort()).toEqual(['items.lock', 'items.log']);
  });

  it.each([
    ['the checker says why', { 'docker-exit': '1', 'docker-err': 'linkcheck: the identity provider could not be reached\n' }, 'the run failed: linkcheck: the identity provider could not be reached'],
    ['docker itself fails', { 'docker-exit': '125', 'docker-err': 'some noise\ndocker: Cannot connect to the Docker daemon.\n' }, 'the run failed: docker: Cannot connect to the Docker daemon.'],
    ['nothing was said', { 'docker-exit': '7' }, 'the run failed: exit code 7 and no message'],
    ['a message is long or holds control characters', { 'docker-exit': '1', 'docker-err': `linkcheck: \u001b[31mred\u0007 ${'x'.repeat(400)}\n` }, `the run failed: linkcheck: [31mred ${'x'.repeat(181)}`],
    ['a message holds the password', { 'docker-exit': '1', 'docker-err': `linkcheck: refused ${PASSWORD}\n` }, 'the run failed: the message is withheld, it holds the password'],
    ['a good exit printed no counts', { 'docker-out': 'https://example.org/ a line that is not counts\n' }, 'the run ended without a counts line'],
    ['a counts line holds more than counts', { 'docker-out': 'items: 1 addresses checked at https://example.org/\n' }, 'the run ended without a counts line'],
  ])('exits 1 and says why in plain words when %s, and removes the private folder', (_, ctl, words) => {
    const b = box({ ctl });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`items-cron: ${words}\n`);
    const lines = logLines(b);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${STAMP} exit=1 `));
    expect((lines[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe(words);
    expect(runDirs(b)).toEqual([]);
    expect(everythingWritten(b, run)).not.toContain(PASSWORD);
  });

  it.each([
    ['unreachable', { 'bao-status': '1' }, true, 'OpenBao cannot be reached'],
    ['sealed', { 'bao-status': '2' }, true, 'OpenBao is sealed'],
    ['not installed', {}, false, 'OpenBao cannot be reached: there is no bao command'],
  ])('exits 2 when OpenBao is %s, says so, and starts no container', (_, ctl, bao, words) => {
    const b = box({ ctl, bao });
    const run = runOnce(b);
    expect(run.status).toBe(2);
    expect(run.stderr).toBe(`items-cron: ${words}\n`);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=2 ${words}$`));
    expect(dockerRuns(b)).toEqual([]);
    expect(baoCalls(b).some((call) => call.startsWith('kv'))).toBe(false);
    expect(runDirs(b)).toEqual([]);
  });

  it.each([
    ['no client id', { username: 'svc-made-up', password: PASSWORD }],
    ['no username', { client_id: 'made-up-client', password: PASSWORD }],
    ['no password', { client_id: 'made-up-client', username: 'svc-made-up' }],
    ['an empty client id', { ...SECRET, client_id: '' }],
    ['an empty username', { ...SECRET, username: '' }],
    ['an empty password', { ...SECRET, password: '' }],
  ])('exits 1 when OpenBao answers but the secret has %s, and starts no container', (_, secret) => {
    const b = box({ secret });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 OpenBao did not give the linkcheck client secret: sign in to OpenBao, or the secret is not there yet$`));
    expect(dockerRuns(b)).toEqual([]);
    expect(runDirs(b)).toEqual([]);
    expect(everythingWritten(b, run)).not.toContain(PASSWORD);
  });

  it.each([
    ['there is no settings file', null, /^no settings file at \/.*\/\.config\/nwfl-linkcheck\/items\.conf$/],
    ['the image is missing', CONF.replace(/^LINKCHECK_IMAGE=.*\n/m, ''), /^LINKCHECK_IMAGE is missing from /],
    ['the API address is missing', CONF.replace(/^LINKCHECK_API_URL=.*\n/m, 'LINKCHECK_API_URL=\n'), /^LINKCHECK_API_URL is missing from /],
    ['the token address is missing', CONF.replace(/^LINKCHECK_TOKEN_URL=.*\n/m, ''), /^LINKCHECK_TOKEN_URL is missing from /],
    ['a line is not a setting', `${CONF}PATH=/somewhere/else\n`, /^line 6 of \/.*items\.conf is not a setting this script knows$/],
  ])('exits 1 when %s, before it asks OpenBao for anything', (_, conf, words) => {
    const b = box({ conf });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)).toHaveLength(1);
    expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toMatch(words);
    expect(baoCalls(b)).toEqual([]);
    expect(dockerRuns(b)).toEqual([]);
  });

  it('exits 1 when the settings pin the image by a tag: no container starts, and the folder is removed', () => {
    const b = box({ conf: CONF.replace(/@sha256:0+/, ':latest') });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)[0]).toMatch(/ exit=1 the run failed: linkcheck\.sh: give the image by its digest /);
    expect(dockerRuns(b)).toEqual([]);
    expect(runDirs(b)).toEqual([]);
  });

  it('reads a settings file whose last line has no newline', () => {
    const b = box({ conf: CONF.trimEnd() });
    expect(runOnce(b).status).toBe(0);
    expect(read(path.join(b.dir, 'docker.env'))).toContain('LINKCHECK_TOKEN_URL=https://id.example.org/application/o/token/\n');
  });

  it('lets one run go at a time: a second exits 3, touches nothing of the first, and the first ends well', async () => {
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n`, 'docker-block': '' } });
    const first = start(b);
    await seen(path.join(b.dir, 'started'));
    const callsBefore = baoCalls(b).length;
    const second = runOnce(b);
    expect(second.status).toBe(3);
    expect(second.stderr).toBe('items-cron: already running\n');
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=3 already running$`));
    expect(baoCalls(b)).toHaveLength(callsBefore);
    expect(dockerRuns(b)).toHaveLength(1);
    // The first run's private folder is still there, with its password, while its container runs.
    expect(runDirs(b)).toHaveLength(1);
    expect(read(path.join(b.state, runDirs(b)[0] as string, 'password'))).toBe(PASSWORD);
    writeFileSync(path.join(b.dir, 'ctl', 'release'), '');
    expect(await first.exit).toBe(0);
    expect(logLines(b)).toHaveLength(2);
    expect(logLines(b)[1]).toMatch(new RegExp(`^${STAMP} exit=0 ${COUNTS}$`));
    expect(runDirs(b)).toEqual([]);
    // The lock is free again.
    expect(runOnce(b).status).toBe(0);
  });

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)('on %s stops the container, removes the private folder, logs it and exits 1', async (signal) => {
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n`, 'docker-block': '' } });
    const run = start(b);
    await seen(path.join(b.dir, 'started'));
    expect(runDirs(b)).toHaveLength(1);
    run.child.kill(signal);
    expect(await run.exit).toBe(1);
    expect(read(path.join(b.dir, 'docker-term'))).toBe('term\n');
    expect(runDirs(b)).toEqual([]);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 stopped by a signal$`));
  }, 30_000);

  it('on a signal that arrives while OpenBao is being asked, starts no container and leaves no folder', async () => {
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n`, 'bao-block': '' } });
    const run = start(b);
    await seen(path.join(b.dir, 'bao-started'));
    run.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(path.join(b.dir, 'ctl', 'release'), '');
    expect(await run.exit).toBe(1);
    expect(dockerRuns(b)).toEqual([]);
    expect(runDirs(b)).toEqual([]);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 stopped by a signal$`));
  }, 30_000);

  it('exits 1 when the lock cannot be taken for another reason than a run in progress', () => {
    const b = box();
    writeFileSync(path.join(b.dir, 'bin', 'flock'), '#!/bin/sh\nexit 66\n', { mode: 0o700 });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 the lock on /.*/items\\.lock could not be taken$`));
    expect(baoCalls(b)).toEqual([]);
  });

  it('exits 1 with a plain message when its state folder cannot be made', () => {
    const b = box();
    writeFileSync(path.join(b.dir, 'not-a-folder'), '');
    const done = spawnSync('sh', [SCRIPT], { env: { ...b.env, HOME: path.join(b.dir, 'not-a-folder') }, encoding: 'utf8', timeout: 20_000 });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`items-cron: ${b.dir}/not-a-folder/.local/state/nwfl-linkcheck cannot be made\n`);
    expect(baoCalls(b)).toEqual([]);
    expect(dockerRuns(b)).toEqual([]);
  });

  it('stops a run that takes over 20 minutes, and says so', () => {
    const b = box();
    // A stand-in `timeout` that records its arguments and reports the time limit as reached.
    writeFileSync(path.join(b.dir, 'bin', 'timeout'), `#!/bin/sh\necho "$*" > '${b.dir}/timeout.args'\nexit 124\n`);
    chmodSync(path.join(b.dir, 'bin', 'timeout'), 0o700);
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(read(path.join(b.dir, 'timeout.args'))).toMatch(/^-k 30 1200 sh \/.*\/scripts\/linkcheck\.sh items ghcr\.io\S+\n$/);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 the run took over 20 minutes and was stopped$`));
    expect(runDirs(b)).toEqual([]);
  });
});
