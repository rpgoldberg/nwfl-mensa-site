// scripts/items-cron.sh run for real, with a stand-in `docker` and a stand-in `bao` on PATH: no test
// reaches a real OpenBao or starts a container. The secret, the addresses and the image are made up.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/items-cron.sh', import.meta.url));
const IMAGE = 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:' + '0'.repeat(64);
const PASSWORD = 'made-up-app-password-7Qx';
const SECRET = { client_id: 'made-up-client', username: 'svc-made-up', password: PASSWORD };
const CONF = `# made-up settings\nLINKCHECK_IMAGE=${IMAGE}\n\nLINKCHECK_API_URL=https://api.example.org/\nLINKCHECK_TOKEN_URL=https://id.example.org/application/o/token/\n`;
const COUNTS = 'items: 2 addresses checked: 1 ok, 1 confirm, 0 drop; 2 recorded, 0 no longer waiting';
// What docker 29.1.3 itself printed, captured for this test; only the image name and the socket path are changed.
// Its reason is NOT its last line, and when its daemon is away the line does not start with "docker:" (exit 1).
const DOCKER_MANIFEST_UNKNOWN = `Unable to find image '${IMAGE}' locally\ndocker: Error response from daemon: manifest for ${IMAGE} not found: manifest unknown: manifest unknown\n\nRun 'docker run --help' for more information\n`;
const DOCKER_BAD_MOUNT = `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /made-up/password\n\nRun 'docker run --help' for more information\n`;
const DOCKER_DAEMON_REFUSES = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
const DOCKER_NO_SOCKET = 'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory\n';
// Not captured: the older form, with no "docker:" in front.
const DOCKER_DENIED = `Unable to find image '${IMAGE}' locally\nError response from daemon: Head "https://ghcr.io/v2/made-up/none/manifests/sha256:made-up": denied\nRun 'docker run --help' for more information\n`;
const CID = 'ab12'.repeat(16);
// The cron's own OpenBao token (made up), the one its token file holds, and a made-up token of another
// login that the environment and the token helper's file may still hold: the wrapper must use only the first.
const CRON_TOKEN = 'made-up-cron-token-Zk3';
const OTHER_TOKEN = 'made-up-other-login-token-Pq8';
const REMINT = 'the cron token is gone or expired: re-mint: tenants/nwfl/APPLY.md step 35j (LINKCRON-TOKEN)';
const BAD_TOKEN_FILE = (file: string): string =>
  `${file} must hold the token and nothing else, on one line of plain text (it holds a Windows line ending, a second line, a blank inside the token or a character outside ASCII): re-mint: tenants/nwfl/APPLY.md step 35j (LINKCRON-TOKEN)`;
const STAMP = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d`;

// The stand-in docker records its arguments and environment, and what the mounted password file
// held and how private it was while "the container" ran. ctl/ files steer it: docker-out (stdout),
// docker-err (stderr), docker-exit (the exit code), docker-block (wait for ctl/release or a TERM),
// docker-stop-slow (with docker-block: take a while to stop after the TERM, as a container does).
// Like docker, it writes the container's id to the --cidfile once "the container" exists: always, but
// for exit 125 (docker failed before it made one); ctl/docker-cid (yes or no) overrides that.
// \`docker rm -f <id>\` is noted in docker-rm.log and exits with ctl/docker-rm-exit (0 by default).
const DOCKER = (dir: string): string => `#!/bin/sh
D='${dir}'
if [ "$1" = rm ]; then
  echo "$*" >> "$D/docker-rm.log"
  [ ! -e "$D/ctl/docker-rm-hang" ] || exec sleep 60
  exit "$(cat "$D/ctl/docker-rm-exit" 2>/dev/null || echo 0)"
fi
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
  [ "$prev" != --cidfile ] || cidfile=$a
  prev=$a
done
code=$(cat "$D/ctl/docker-exit" 2>/dev/null || echo 0)
made=$(cat "$D/ctl/docker-cid" 2>/dev/null || { [ "$code" = 125 ] && echo no || echo yes; })
[ "$made" != yes ] || [ -z "\${cidfile:-}" ] || printf '%s' '${CID}' > "$cidfile"
if [ -e "$D/ctl/docker-block" ]; then
  trap 'echo term >> "$D/docker-term"; [ ! -e "$D/ctl/docker-stop-slow" ] || { sleep 0.6; : > "$D/docker-stopped"; }; exit 143' TERM
  : > "$D/started"
  while [ ! -e "$D/ctl/release" ]; do sleep 0.05; done
fi
[ ! -e "$D/ctl/docker-out" ] || cat "$D/ctl/docker-out"
[ ! -e "$D/ctl/docker-err" ] || cat "$D/ctl/docker-err" >&2
exit "$(cat "$D/ctl/docker-exit" 2>/dev/null || echo 0)"
`;

// The stand-in bao answers `status` with ctl/bao-status (0 by default), `token renew` (the renewal of the
// token it is given) with ctl/bao-renew (0 by default) and `kv get -field=<f> <path>` with ctl/secret-<f>,
// for the one path the wrapper may read. Like the real CLI, it takes its token from BAO_TOKEN, or when that
// is empty from VAULT_TOKEN, then from the token helper's file (BAO_TOKEN_PATH or ~/.vault-token). The
// renewal and the read are refused unless that token is ctl/bao-token. Each call's token settings go to
// bao-env.log (not one of the files a person sees). The renewal prints the token, as the real one does in
// its table, and so does a refusal here: the wrapper must show none of it. ctl/bao-block makes it wait for
// ctl/release; ctl/bao-renew-hang makes the renewal never answer. Whatever else its environment holds goes
// to bao-other.env.
const BAO = (dir: string): string => `#!/bin/sh
D='${dir}'
echo "$*" >> "$D/bao.log"
echo "BAO_ADDR=\${BAO_ADDR:-}" > "$D/bao.env"
echo "$1 BAO_TOKEN=\${BAO_TOKEN-(unset)} BAO_TOKEN_PATH=\${BAO_TOKEN_PATH-(unset)} VAULT_TOKEN=\${VAULT_TOKEN-(unset)} VAULT_TOKEN_PATH=\${VAULT_TOKEN_PATH-(unset)}" >> "$D/bao-env.log"
env | grep -v '^BAO_TOKEN=' >> "$D/bao-other.env"
if [ -e "$D/ctl/bao-block" ]; then
  : > "$D/bao-started"
  while [ ! -e "$D/ctl/release" ]; do sleep 0.05; done
fi
tok=\${BAO_TOKEN:-\${VAULT_TOKEN:-}}
[ -n "$tok" ] || tok=$(cat "\${BAO_TOKEN_PATH:-$HOME/.vault-token}" 2>/dev/null)
signed() { [ -n "$tok" ] && [ "$tok" = "$(cat "$D/ctl/bao-token" 2>/dev/null)" ]; }
case $1 in
  status) exit "$(cat "$D/ctl/bao-status" 2>/dev/null || echo 0)" ;;
  token)
    [ "$2" = renew ] && [ $# -eq 2 ] || { echo "Usage: bao token <subcommand>" >&2; exit 127; }
    [ ! -e "$D/ctl/bao-renew-hang" ] || { : > "$D/renew-started"; exec sleep 60; }
    code=$(cat "$D/ctl/bao-renew" 2>/dev/null || echo 0)
    signed || code=2
    if [ "$code" -ne 0 ]; then echo "Error renewing token $tok: Code: 403. Errors: * permission denied" >&2; exit "$code"; fi
    printf 'Key Value\\ntoken %s\\ntoken_renewable true\\n' "$tok"
    ;;
  kv)
    [ "$2" = get ] && [ "$4" = secret/nwfl-mensa/linkcheck/client ] || exit 2
    signed || { echo "Error reading with $tok: Code: 403. Errors: * permission denied" >&2; exit 2; }
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
  home?: string;
  /** What ~/.config/nwfl-linkcheck/bao.token holds (made 0600), or null for no file. */
  token?: string | null;
}

// Every box is removed after its test, so the suite does not fill the container's small /tmp.
const boxes: string[] = [];
afterEach(() => {
  for (const dir of boxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function box({ conf = CONF, secret = SECRET, bao = true, ctl = { 'docker-out': `${COUNTS}\n` }, home: homeName = 'home', token = `${CRON_TOKEN}\n` }: Setup = {}): Box {
  const dir = mkdtempSync(path.join(tmpdir(), 'items-cron-'));
  boxes.push(dir);
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, homeName);
  for (const d of [bin, home, path.join(dir, 'ctl'), path.join(home, '.config', 'nwfl-linkcheck')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, 'docker'), DOCKER(dir), { mode: 0o700 });
  if (bao) writeFileSync(path.join(bin, 'bao'), BAO(dir), { mode: 0o700 });
  if (conf !== null) writeFileSync(path.join(home, '.config', 'nwfl-linkcheck', 'items.conf'), conf);
  for (const [field, value] of Object.entries(secret)) writeFileSync(path.join(dir, 'ctl', `secret-${field}`), value);
  for (const [name, value] of Object.entries(ctl)) writeFileSync(path.join(dir, 'ctl', name), value);
  writeFileSync(path.join(dir, 'ctl', 'bao-token'), CRON_TOKEN);
  if (token !== null) writeFileSync(path.join(home, '.config', 'nwfl-linkcheck', 'bao.token'), token, { mode: 0o600 });
  return { dir, state: path.join(home, '.local', 'state', 'nwfl-linkcheck'), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } };
}

const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const logLines = (b: Box): string[] => read(path.join(b.state, 'items.log')).split('\n').filter(Boolean);
const dockerRuns = (b: Box): string[][] => read(path.join(b.dir, 'docker.log')).split('\n').filter(Boolean).map((line) => line.split('\u001f').filter(Boolean));
const removals = (b: Box): string[] => read(path.join(b.dir, 'docker-rm.log')).split('\n').filter(Boolean);
const baoCalls = (b: Box): string[] => read(path.join(b.dir, 'bao.log')).split('\n').filter(Boolean);
const baoEnv = (b: Box): string[] => read(path.join(b.dir, 'bao-env.log')).split('\n').filter(Boolean);
const tokenFile = (b: Box): string => path.join(b.env['HOME'] as string, '.config', 'nwfl-linkcheck', 'bao.token');
const runDirs = (b: Box): string[] => (existsSync(b.state) ? readdirSync(b.state).filter((name) => name.startsWith('run.')) : []);
const mode = (file: string): number => statSync(file).mode & 0o777;

/**
 * A stand-in `date` that notes, each time the wrapper asks the time, whether the password file is on
 * disk. With ctl/clock (one number per line) it answers `date +%s` from that file, line after line.
 */
function fakeDate(b: Box): void {
  writeFileSync(
    path.join(b.dir, 'bin', 'date'),
    `#!/bin/sh
D='${b.dir}'
if ls "$HOME"/.local/state/nwfl-linkcheck/run.*/password > /dev/null 2>&1; then echo "$1 there" >> "$D/date-saw"; else echo "$1 gone" >> "$D/date-saw"; fi
if [ "$1" = +%s ] && [ -e "$D/ctl/clock" ]; then
  n=$(($(cat "$D/date-n" 2> /dev/null || echo 0) + 1))
  echo "$n" > "$D/date-n"
  sed -n "\${n}p" "$D/ctl/clock"
  exit 0
fi
exec /usr/bin/date "$@"
`,
    { mode: 0o700 },
  );
}
const dateSaw = (b: Box): string[] => read(path.join(b.dir, 'date-saw')).split('\n').filter(Boolean);

/**
 * Every message the items command can stop with, read from its source: the literal texts of each
 * `new ItemsError(...)`, a template's holes filled from TEMPLATE_SAMPLES. A template with no samples, or a
 * call this reading cannot take apart, fails the test; the wrapper must know each message.
 */
const ITEMS_SOURCE = readFileSync(fileURLToPath(new URL('../src/items.ts', import.meta.url)), 'utf8');
const CLOUDFLARE_5XX = ['520', '521', '522', '523', '524', '525', '526', '527', '530'];
const TEMPLATE_SAMPLES: Record<string, string[]> = {
  '`${name} must be an https URL`': ['LINKCHECK_API_URL must be an https URL', 'LINKCHECK_TOKEN_URL must be an https URL'],
  '`the API refused the call: HTTP ${status}`': ['400', '401', '403', '404', '405', '408', '413', '415', '429', '431', '500', '501', '502', '503', '504', '505', ...CLOUDFLARE_5XX].map((s) => `the API refused the call: HTTP ${s}`),
  "`the API refused the call: ${code.toUpperCase()}${said === '' ? '' : ` (${said})`}`": [
    ...['CANCELED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'].map((c) => `the API refused the call: ${c}`),
    'the API refused the call: UNAUTHENTICATED (made-up words from the API)',
  ],
  '`the API could not be reached (${(error as Error).constructor.name})`': ['TypeError', 'DOMException', 'Error'].map((n) => `the API could not be reached (${n})`),
  '`the identity provider refused the sign-in (HTTP ${response.status})`': ['400', '401', '403', '500', '502', ...CLOUDFLARE_5XX].map((s) => `the identity provider refused the sign-in (HTTP ${s})`),
};

/** The end of a quoted string or template starting at `at`, a template's holes (nested templates and all) skipped whole. */
function literalEnd(src: string, at: number): number {
  const quote = src[at] as string;
  for (let i = at + 1; i < src.length; i += 1) {
    if (src[i] === '\\') i += 1;
    else if (src[i] === quote) return i + 1;
    else if (quote === '`' && src.startsWith('${', i)) i = holeEnd(src, i + 2) - 1;
  }
  throw new Error(`an unclosed literal at ${String(at)}`);
}

/** The index past the brace that closes a hole or call opened just before `at`. */
function holeEnd(src: string, at: number, open = '{', close = '}'): number {
  let depth = 1;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i] as string;
    if (c === "'" || c === '"' || c === '`') i = literalEnd(src, i) - 1;
    else if (c === open) depth += 1;
    else if (c === close && (depth -= 1) === 0) return i + 1;
  }
  throw new Error(`an unclosed ${open} at ${String(at)}`);
}

/** The literals at the top of each `new ItemsError(...)`'s argument: quoted texts as they are, templates by their source. */
function itemsErrorLiterals(src: string): Array<{ plain: string } | { template: string }> {
  const out: Array<{ plain: string } | { template: string }> = [];
  for (const call of src.matchAll(/new ItemsError\(/g)) {
    const start = call.index + call[0].length;
    const end = holeEnd(src, start, '(', ')') - 1;
    let found = 0;
    for (let i = start; i < end; i += 1) {
      const c = src[i] as string;
      if (c !== "'" && c !== '"' && c !== '`') continue;
      const close = literalEnd(src, i);
      const text = src.slice(i, close);
      out.push(c === '`' && text.includes('${') ? { template: text } : { plain: text.slice(1, -1) });
      found += 1;
      i = close - 1;
    }
    if (found === 0) throw new Error(`new ItemsError at ${String(call.index)} has no literal text`);
  }
  return out;
}

const LITERALS = itemsErrorLiterals(ITEMS_SOURCE);
const FIXED_MESSAGES = [
  ...new Set(
    LITERALS.flatMap((l) => {
      if ('plain' in l) return [l.plain];
      const samples = TEMPLATE_SAMPLES[l.template];
      if (samples === undefined) throw new Error(`no samples for the message template ${l.template}`);
      return samples;
    }),
  ),
];

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
    expect(baoCalls(b)).toEqual(['status', 'token renew', ...['client_id', 'username', 'password'].map((f) => `kv get -field=${f} secret/nwfl-mensa/linkcheck/client`)]);
    // Every call is given the cron's own token, in its environment only.
    expect(baoEnv(b)).toEqual(['status', 'token', 'kv', 'kv', 'kv'].map((c) => `${c} BAO_TOKEN=${CRON_TOKEN} BAO_TOKEN_PATH=(unset) VAULT_TOKEN=(unset) VAULT_TOKEN_PATH=(unset)`));
    expect(read(path.join(b.dir, 'bao.env'))).toBe('BAO_ADDR=https://bao.example.org:8200\n');
    const runs = dockerRuns(b);
    expect(runs).toHaveLength(1);
    const argv = runs[0] as string[];
    expect(argv.slice(-2)).toEqual([IMAGE, 'items']);
    // docker writes the container's id into the private folder; with it the wrapper makes sure, once,
    // that no container of this run is left (docker's client alone does not, when it is killed).
    expect(argv[argv.indexOf('--cidfile') + 1]).toMatch(new RegExp(`^${b.state}/run\\.[A-Za-z0-9]{6}/cid$`));
    expect(removals(b)).toEqual([`rm -f ${CID}`]);
    expect(argv).toContain('--read-only');
    const env = read(path.join(b.dir, 'docker.env'));
    // docker and OpenBao are asked in the C locale, so their words are the ones this script knows.
    expect(env.split('\n')).toContain('LC_ALL=C');
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
    mkdirSync(path.join(b.state, 'run.dead02'));
    const run = runOnce(b);
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(runDirs(b)).toEqual([]);
    expect(readdirSync(b.state).sort()).toEqual(['items.lock', 'items.log']);
    // One line says that a killed run left its folder (however many folders), then the run's own line.
    const lines = logLines(b);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^${STAMP} note: a run was killed before it could clean up; the private folder it left behind is removed$`));
    expect(lines[1]).toMatch(new RegExp(`^${STAMP} exit=0 ${COUNTS}$`));
    expect(lines.join('\n')).not.toContain('an-older-made-up-password');
    // The next run finds nothing left, and says nothing of it.
    expect(runOnce(b).status).toBe(0);
    expect(logLines(b)).toHaveLength(3);
  });

  it('keeps the password file on disk only while the container runs: it is gone before anything is logged', () => {
    const b = box();
    fakeDate(b);
    expect(runOnce(b).status).toBe(0);
    expect(read(path.join(b.dir, 'seen-password'))).toBe(PASSWORD);
    // The time is asked just before the container starts (the file is there) and for the log line (gone).
    expect(dateSaw(b)).toEqual(['+%s there', '-Iseconds gone']);
    const failed = box({ ctl: { 'docker-exit': '1', 'docker-err': 'linkcheck: the identity provider could not be reached\n' } });
    fakeDate(failed);
    expect(runOnce(failed).status).toBe(1);
    expect(dateSaw(failed)).toEqual(['+%s there', '-Iseconds gone']);
  });

  it('makes its state folder private again when it has become readable by others', () => {
    const b = box();
    mkdirSync(b.state, { recursive: true });
    chmodSync(b.state, 0o755);
    expect(runOnce(b).status).toBe(0);
    expect(mode(b.state)).toBe(0o700);
  });

  it.each([
    ['the checker says why', { 'docker-exit': '1', 'docker-err': 'linkcheck: the identity provider could not be reached\n' }, 'the run failed: linkcheck: the identity provider could not be reached'],
    ['docker cannot find the image (its own words, with its trailer after them)', { 'docker-exit': '125', 'docker-err': DOCKER_MANIFEST_UNKNOWN }, `the run failed: docker: Error response from daemon: manifest for ${IMAGE} not found: manifest unknown: manifest unknown`],
    ['docker cannot use a mount', { 'docker-exit': '125', 'docker-err': DOCKER_BAD_MOUNT }, 'the run failed: docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /made-up/password'],
    ['docker is refused the image', { 'docker-exit': '125', 'docker-err': DOCKER_DENIED }, 'the run failed: Error response from daemon: Head "https://ghcr.io/v2/made-up/none/manifests/sha256:made-up": denied'],
    ['the docker daemon refuses the connection', { 'docker-exit': '1', 'docker-err': DOCKER_DAEMON_REFUSES }, 'the run failed: docker could not be reached (is its daemon running?)'],
    ['the docker daemon has no socket', { 'docker-exit': '1', 'docker-err': DOCKER_NO_SOCKET }, 'the run failed: docker could not be reached (is its daemon running?)'],
    ['nothing was said', { 'docker-exit': '7' }, 'the run failed: exit code 7 and no message'],
    ['docker says something long or with control characters', { 'docker-exit': '125', 'docker-err': `docker: \u001b[31mred\u0007 ${'x'.repeat(400)}\n` }, `the run failed: docker: [31mred ${'x'.repeat(284)}`],
    ['a message holds the password', { 'docker-exit': '1', 'docker-err': `linkcheck: refused ${PASSWORD}\n` }, 'the run failed: the message is withheld, it holds the password'],
    ['docker holds the password in its own words', { 'docker-exit': '125', 'docker-err': `docker: refused ${PASSWORD}\n` }, 'the run failed: the message is withheld, it holds the password'],
    ['the checker says something it is not known to say', { 'docker-exit': '1', 'docker-err': 'linkcheck: the token endpoint said 400 for the body username=svc-made-up\n' }, 'the run failed (unrecognised message): exit code 1'],
    ['the container prints a line dressed as one of docker\'s own', { 'docker-exit': '1', 'docker-err': 'docker: Error response from daemon: made-up words from inside the container\n' }, 'the run failed (unrecognised message): exit code 1'],
    ['a line dressed as docker\'s comes with an exit code that is not docker\'s own', { 'docker-exit': '139', 'docker-err': 'docker: Error response from daemon: made-up words from inside the container\n' }, 'the run failed (unrecognised message): exit code 139'],
    ['a known message has more after it', { 'docker-exit': '1', 'docker-err': 'linkcheck: the identity provider could not be reached at https://id.example.org/?made-up\n' }, 'the run failed (unrecognised message): exit code 1'],
    ['a known message has more before it', { 'docker-exit': '1', 'docker-err': 'made-up words; linkcheck: the API did not answer in time\n' }, 'the run failed (unrecognised message): exit code 1'],
    ['docker itself says something else', { 'docker-exit': '125', 'docker-err': "unknown flag: --made-up\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun 'docker run --help' for more information\n" }, 'the run failed (unrecognised message): exit code 125'],
    ['the runtime ends on its own error', { 'docker-exit': '134', 'docker-err': 'FATAL ERROR: made-up words of the runtime\n' }, 'the run failed (unrecognised message): exit code 134'],
    ['the API refuses the call, with words of its own', { 'docker-exit': '1', 'docker-err': 'linkcheck: the API refused the call: PERMISSION_DENIED (made-up words (of the server) here)\n' }, 'the run failed: linkcheck: the API refused the call: PERMISSION_DENIED'],
    ['the API refuses the call with a status it does not name', { 'docker-exit': '1', 'docker-err': 'linkcheck: the API refused the call: HTTP 524\n' }, 'the run failed: linkcheck: the API refused the call: HTTP 524'],
    ['the API refuses the call with a status that is not a number', { 'docker-exit': '1', 'docker-err': 'linkcheck: the API refused the call: status made-up-words\n' }, 'the run failed (unrecognised message): exit code 1'],
    ['the identity provider refuses the sign-in', { 'docker-exit': '1', 'docker-err': 'linkcheck: the identity provider refused the sign-in (HTTP 401)\n' }, 'the run failed: linkcheck: the identity provider refused the sign-in (HTTP 401)'],
    ['the API cannot be reached', { 'docker-exit': '1', 'docker-err': 'linkcheck: the API could not be reached (Error)\n' }, 'the run failed: linkcheck: the API could not be reached (Error)'],
    ['an address is not https', { 'docker-exit': '1', 'docker-err': 'linkcheck: LINKCHECK_TOKEN_URL must be an https URL\n' }, 'the run failed: linkcheck: LINKCHECK_TOKEN_URL must be an https URL'],
    ['the checker meets an error it does not know', { 'docker-exit': '1', 'docker-err': 'linkcheck: an unexpected error (TypeError)\n' }, 'the run failed: linkcheck: an unexpected error (TypeError)'],
    ['the image is older than the items command', { 'docker-exit': '2', 'docker-err': 'linkcheck: unknown command items\nusage: linkcheck extract --audience <public|members>\n' }, 'the run failed: linkcheck: unknown command items'],
    ['a known message follows other lines', { 'docker-exit': '1', 'docker-err': '(node:1) Warning: made-up\nlinkcheck: the API did not answer in time\n' }, 'the run failed: linkcheck: the API did not answer in time'],
    ['the container itself exits 126 with a line dressed as docker\'s', { 'docker-exit': '126', 'docker-err': 'docker: Error response from daemon: bWFkZS11cC1jb3B5\n' }, 'the run failed (unrecognised message): exit code 126'],
    ['the container itself exits 127 with a line dressed as docker\'s', { 'docker-exit': '127', 'docker-err': 'Error response from daemon: bWFkZS11cC1jb3B5\n' }, 'the run failed (unrecognised message): exit code 127'],
    ['the container itself exits 125 with a line dressed as docker\'s', { 'docker-exit': '125', 'docker-cid': 'yes', 'docker-err': 'docker: Error response from daemon: bWFkZS11cC1jb3B5\n' }, 'the run failed (unrecognised message): exit code 125'],
    ['docker fails with 126 before it makes a container', { 'docker-exit': '126', 'docker-cid': 'no', 'docker-err': 'docker: Error response from daemon: made-up words of docker\n' }, 'the run failed: docker: Error response from daemon: made-up words of docker'],
    ['a NUL byte follows a known message', { 'docker-exit': '1', 'docker-err': 'linkcheck: the token is not a bearer token\n\u0000bWFkZS11cC1jb3B5\n' }, 'the run failed: linkcheck: the token is not a bearer token'],
    ['a NUL byte follows docker\'s reason', { 'docker-exit': '125', 'docker-err': 'docker: Error response from daemon: made-up\n\u0000\n' }, 'the run failed: docker: Error response from daemon: made-up'],
    ['a NUL byte follows the daemon-away line', { 'docker-exit': '1', 'docker-err': `${DOCKER_DAEMON_REFUSES}\u0000\n` }, 'the run failed: docker could not be reached (is its daemon running?)'],
    ['docker\'s reason holds bytes outside printable ASCII', { 'docker-exit': '125', 'docker-err': 'docker: x\u0085 made-up \u2028 \u009b 2J \u00e9\n' }, 'the run failed: docker: x made-up   2J '],
    ['the container runs out of memory', { 'docker-exit': '137' }, 'the run ran out of memory and was killed (exit 137)'],
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

  it.each([
    ['by a tag', 'ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck:latest'],
    ['as a flag in front of a digest (--volume)', `--volume=/:/host@sha256:${'0'.repeat(64)}`],
    ['as a flag in front of a digest (--mount)', `--mount=type=bind,src=/,dst=/host@sha256:${'0'.repeat(64)}`],
    ['as a bare 64-character image ID', 'b6768d51cf8ff5352ffd6b080449852a8b3ef30cdd7e490a7421da906cf3a9ff'],
    ['as a flag alone in front of a digest (--privileged)', `--privileged@sha256:${'0'.repeat(64)}`],
    ['with a name that starts with a dot', `.ghcr.io/made-up/linkcheck@sha256:${'0'.repeat(64)}`],
    ['with a space and a flag in the name', `ghcr.io/made-up/linkcheck --privileged@sha256:${'0'.repeat(64)}`],
    ['with upper-case letters', `GHCR.IO/made-up/linkcheck@sha256:${'0'.repeat(64)}`],
    ['with a digest that is too short', `ghcr.io/made-up/linkcheck@sha256:${'0'.repeat(63)}`],
    ['with a digest that is not hex', `ghcr.io/made-up/linkcheck@sha256:${'g'.repeat(64)}`],
    ['with two digests', `ghcr.io/made-up/linkcheck@sha256:${'1'.repeat(64)}@sha256:${'0'.repeat(64)}`],
    ['with no name', `@sha256:${'0'.repeat(64)}`],
  ])('exits 1 when the settings give the image %s, before it asks OpenBao for anything', (_, image) => {
    const b = box({ conf: CONF.replace(/^LINKCHECK_IMAGE=.*$/m, `LINKCHECK_IMAGE=${image}`) });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 LINKCHECK_IMAGE in /.*/items\\.conf is not an image by its digest \\(ghcr\\.io/\\.\\.\\.@sha256:<64 hex characters>\\)$`));
    expect(baoCalls(b)).toEqual([]);
    expect(dockerRuns(b)).toEqual([]);
    expect(runDirs(b)).toEqual([]);
  });

  it.each([
    ['the settings file can be written by its group', 0o664, 0o755],
    ['the settings file can be written by anyone', 0o646, 0o755],
    ['the settings folder can be written by its group', 0o644, 0o775],
    ['the settings folder can be written by anyone', 0o600, 0o757],
  ])('exits 1 when %s, before it reads a setting or asks OpenBao for anything', (_, fileMode, folderMode) => {
    const b = box();
    const folder = path.join(b.env['HOME'] as string, '.config', 'nwfl-linkcheck');
    chmodSync(path.join(folder, 'items.conf'), fileMode);
    chmodSync(folder, folderMode);
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 /.*/items\\.conf and its folder must be writable by you alone \\(chmod go-w\\)$`));
    expect(baoCalls(b)).toEqual([]);
    expect(dockerRuns(b)).toEqual([]);
  });

  it('runs with a settings file and folder that others can read but not write', () => {
    const b = box();
    const folder = path.join(b.env['HOME'] as string, '.config', 'nwfl-linkcheck');
    chmodSync(path.join(folder, 'items.conf'), 0o644);
    chmodSync(folder, 0o755);
    expect(runOnce(b).status).toBe(0);
  });

  it('reads a settings file whose last line has no newline', () => {
    const b = box({ conf: CONF.trimEnd() });
    expect(runOnce(b).status).toBe(0);
    expect(read(path.join(b.dir, 'docker.env'))).toContain('LINKCHECK_TOKEN_URL=https://id.example.org/application/o/token/\n');
  });

  it('reads the counts line when a NUL byte follows it', () => {
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n\u0000\n` } });
    expect(runOnce(b).status).toBe(0);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=0 ${COUNTS}$`));
  });

  it('knows every fixed message of the items command, and logs each as it is (a refusal without the server\'s words)', () => {
    // Every template has samples, and every sample is of a template in use.
    const templates = LITERALS.flatMap((l) => ('template' in l ? [l.template] : []));
    expect(Object.keys(TEMPLATE_SAMPLES).sort()).toEqual([...new Set(templates)].sort());
    // The messages a Connect client adds: a refusal by its HTTP status (Cloudflare's 5xx included), a body cut short, an answer of another kind.
    for (const message of ['the API refused the call: HTTP 502', 'the API refused the call: HTTP 524', 'the API answer was cut short', 'the API answer is not one plain Connect message', 'the API did not answer in time']) expect(FIXED_MESSAGES).toContain(message);
    for (const message of FIXED_MESSAGES) {
      const b = box({ ctl: { 'docker-exit': '1', 'docker-err': `linkcheck: ${message}\n` } });
      expect(runOnce(b).status).toBe(1);
      // A refusal's words in brackets are the server's own: only the status is logged.
      const logged = message.startsWith('the API refused the call: ') ? message.replace(/ \(.*$/, '') : message;
      expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe(`the run failed: linkcheck: ${logged}`);
    }
  });

  // A password with characters that URL-encoding changes; the checker's messages are fixed, so a copy of
  // the password in any form is in none of them.
  const ODD = 'made up/pw+7Qx&=z%Zq81';
  it.each([
    ['URL-encoded', encodeURIComponent(ODD)],
    ['form-encoded', new URLSearchParams({ p: ODD }).toString().slice(2)],
    ['base64 of user:password', Buffer.from(`svc-made-up:${ODD}`).toString('base64')],
    ['base64', Buffer.from(ODD).toString('base64')],
    ['cut to its first 12 characters', ODD.slice(0, 12)],
    ['reversed', [...ODD].reverse().join('')],
  ])('logs no copy of the password that a message holds %s', (_, copy) => {
    expect(copy).not.toContain(ODD);
    for (const err of [`linkcheck: the token endpoint said 400 for password=${copy}\n`, `linkcheck items: Authorization: Basic ${copy}\n`, `docker: Error response from daemon: ${copy}\n`, `${copy}\n`]) {
      const b = box({ secret: { ...SECRET, password: ODD }, ctl: { 'docker-exit': '1', 'docker-err': err } });
      const run = runOnce(b);
      expect(run.status).toBe(1);
      expect(logLines(b)).toHaveLength(1);
      expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe('the run failed (unrecognised message): exit code 1');
      expect(everythingWritten(b, run)).not.toContain(copy);
    }
  });

  it('matches the password as plain text, not as a pattern, when it looks for it in a message', () => {
    const odd = 'made-up[pw.7Q*';
    const b = box({ secret: { ...SECRET, password: odd }, ctl: { 'docker-exit': '125', 'docker-err': `docker: refused ${odd}\n` } });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe('the run failed: the message is withheld, it holds the password');
    expect(everythingWritten(b, run)).not.toContain(odd);
    // And a message that only looks like it under a pattern reading (. for any character) is not withheld.
    const near = box({ secret: { ...SECRET, password: 'made.up' }, ctl: { 'docker-exit': '125', 'docker-err': 'docker: made-up words\n' } });
    expect(runOnce(near).status).toBe(1);
    expect((logLines(near)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe('the run failed: docker: made-up words');
  });

  it("logs linkcheck.sh's own refusal when the state folder's path holds a colon", () => {
    const b = box({ home: 'ho:me' });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe("the run failed: linkcheck.sh: the password file's path may not hold a colon");
    expect(dockerRuns(b)).toEqual([]);
  });

  it.each([
    ['in under the limit: out of memory', '1000\n1100\n', 'the run ran out of memory and was killed (exit 137)'],
    ['just under the limit: out of memory', '1000\n2199\n', 'the run ran out of memory and was killed (exit 137)'],
    ['at the limit: it was killed for its time, having ignored the stop', '1000\n2200\n', 'the run took over 20 minutes and was stopped'],
    ['past the limit', '1000\n2231\n', 'the run took over 20 minutes and was stopped'],
  ])('reads an exit of 137 by the time the run took, %s', (_, clock, words) => {
    const b = box({ ctl: { 'docker-exit': '137', clock } });
    fakeDate(b);
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)).toHaveLength(1);
    expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe(words);
    expect(runDirs(b)).toEqual([]);
  });

  it.each([
    ['a folder', (lock: string) => mkdirSync(lock)],
    ['a file it may not write', (lock: string) => writeFileSync(lock, '', { mode: 0o400 })],
    ['a link to a file it may write', (lock: string, b: Box) => { writeFileSync(path.join(b.dir, 'decoy'), 'decoy-made-up'); symlinkSync(path.join(b.dir, 'decoy'), lock); }],
    ['a link to nothing', (lock: string, b: Box) => symlinkSync(path.join(b.dir, 'nothing-here'), lock)],
    ['a pipe (which would wait for ever to be opened)', (lock: string) => expect(spawnSync('mkfifo', [lock]).status).toBe(0)],
  ] as const)('exits 1, not 2, and says so in the log when the lock file is %s', (_, make) => {
    const b = box();
    mkdirSync(b.state, { recursive: true });
    make(path.join(b.state, 'items.lock'), b);
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`items-cron: the lock file ${b.state}/items.lock cannot be opened: it must be a plain file of yours\n`);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 the lock file /.*/items\\.lock cannot be opened: it must be a plain file of yours$`));
    expect(baoCalls(b)).toEqual([]);
    expect(dockerRuns(b)).toEqual([]);
    expect(read(path.join(b.dir, 'decoy'))).toMatch(/^(decoy-made-up)?$/);
    expect(existsSync(path.join(b.dir, 'nothing-here'))).toBe(false);
  });

  it.each([
    ['a folder', (log: string) => mkdirSync(log)],
    ['a file it may not write', (log: string) => writeFileSync(log, '', { mode: 0o400 })],
    ['a link', (log: string, b: Box) => { writeFileSync(path.join(b.dir, 'decoy'), 'decoy-made-up'); symlinkSync(path.join(b.dir, 'decoy'), log); }],
    ['a pipe', (log: string) => expect(spawnSync('mkfifo', [log]).status).toBe(0)],
  ] as const)('writes its line to stderr when the log is %s, and the exit code stays', (_, make) => {
    const b = box();
    mkdirSync(b.state, { recursive: true });
    make(path.join(b.state, 'items.log'), b);
    const good = runOnce(b);
    expect(good.status).toBe(0);
    expect(good.stderr).toMatch(new RegExp(`^items-cron: ${b.state}/items\\.log cannot be written; its line: ${STAMP} exit=0 ${COUNTS}\n$`));
    expect(read(path.join(b.dir, 'decoy'))).toMatch(/^(decoy-made-up)?$/);
    // With the lock unusable as well: both are said on stderr, and the exit is 1.
    spawnSync('chmod', ['400', path.join(b.state, 'items.lock')]);
    const bad = runOnce(b);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(new RegExp(`^items-cron: ${b.state}/items\\.log cannot be written; its line: ${STAMP} exit=1 the lock file \\S+ cannot be opened: it must be a plain file of yours\nitems-cron: the lock file \\S+ cannot be opened: it must be a plain file of yours\n$`));
  });

  it.each([
    ['a NUL byte in a value', CONF.replace('linkcheck@sha256', 'linkcheck\u0000@sha256')],
    ['a NUL byte in a comment', `${CONF}# made\u0000up\n`],
    ['Windows line endings', CONF.replaceAll('\n', '\r\n')],
    ['a carriage return after the image', CONF.replace(/^(LINKCHECK_IMAGE=.*)$/m, '$1\r')],
    ['an escape character', `${CONF}# \u001b[31mmade-up\n`],
    ['a tab', `${CONF}LINKCHECK_SCOPE=links.made-up\t\n`],
    ['a character that is not ASCII', `${CONF}# made-up \u00e9\n`],
  ])('exits 1 when the settings hold %s, before it asks OpenBao for anything', (_, conf) => {
    const b = box({ conf });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 /.*/items\\.conf holds a character that is not plain text \\(a tab, a Windows line ending, a NUL byte or a letter outside ASCII\\)$`));
    expect(baoCalls(b)).toEqual([]);
    expect(dockerRuns(b)).toEqual([]);
  });

  it('exits 1 when the settings file is a link, before it reads a setting', () => {
    const b = box({ conf: null });
    writeFileSync(path.join(b.dir, 'elsewhere.conf'), CONF);
    symlinkSync(path.join(b.dir, 'elsewhere.conf'), path.join(b.env['HOME'] as string, '.config', 'nwfl-linkcheck', 'items.conf'));
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 /.*/items\\.conf is a link: the settings must be a plain file$`));
    expect(baoCalls(b)).toEqual([]);
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
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n`, 'docker-block': '', 'docker-stop-slow': '' } });
    fakeDate(b);
    const run = start(b);
    await seen(path.join(b.dir, 'started'));
    expect(runDirs(b)).toHaveLength(1);
    run.child.kill(signal);
    expect(await run.exit).toBe(1);
    // The wrapper waited until the container had stopped: only then is the password file removed and the line written.
    expect(existsSync(path.join(b.dir, 'docker-stopped'))).toBe(true);
    expect(dateSaw(b)).toEqual(['+%s there', '-Iseconds gone']);
    expect(read(path.join(b.dir, 'docker-term'))).toBe('term\n');
    expect(removals(b)).toEqual([`rm -f ${CID}`]);
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
    // A stand-in `timeout` that records the run's arguments and reports its time limit as reached (the
    // renewal, under its own limit, goes to the real one).
    writeFileSync(path.join(b.dir, 'bin', 'timeout'), `#!/bin/sh\ncase "$*" in *' token renew') exec /usr/bin/timeout "$@" ;; esac\necho "$*" > '${b.dir}/timeout.args'\nexit 124\n`);
    chmodSync(path.join(b.dir, 'bin', 'timeout'), 0o700);
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(read(path.join(b.dir, 'timeout.args'))).toMatch(/^-k 30 1200 sh \/.*\/scripts\/linkcheck\.sh items ghcr\.io\S+\n$/);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 the run took over 20 minutes and was stopped$`));
    expect(runDirs(b)).toEqual([]);
    // No container was made (no cid file), so docker is not asked to remove one.
    expect(removals(b)).toEqual([]);
  });

  it.each([
    ['the run was killed (137: timeout\'s KILL of a run that ignored the stop, or the memory limit)', '137', 'the run ran out of memory and was killed (exit 137)'],
    ['the time limit was reached (124)', '124', 'the run took over 20 minutes and was stopped'],
    ['the run ended on its own', '1', 'the run failed: exit code 1 and no message'],
  ])('removes the container by its id when %s, before the lock is let go', (_, code, words) => {
    const b = box({ ctl: { 'docker-exit': code } });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(removals(b)).toEqual([`rm -f ${CID}`]);
    expect(logLines(b)).toHaveLength(1);
    expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe(words);
  });

  it('says so in one fixed line when the container cannot be removed, and asks docker once only', () => {
    const b = box({ ctl: { 'docker-exit': '137', 'docker-rm-exit': '1' } });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(removals(b)).toEqual([`rm -f ${CID}`]);
    const lines = logLines(b);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^${STAMP} exit=1 the run ran out of memory and was killed \\(exit 137\\)$`));
    expect(lines[1]).toMatch(new RegExp(`^${STAMP} note: this run's container could not be removed; remove it by hand: docker rm -f ${CID.slice(0, 12)}$`));
    expect(runDirs(b)).toEqual([]);
  });

  it('gives docker ten seconds to remove the container, then says it could not and ends', () => {
    const b = box({ ctl: { 'docker-exit': '137', 'docker-rm-hang': '' } });
    const began = Date.now();
    const done = spawnSync('sh', [SCRIPT], { env: b.env, encoding: 'utf8', timeout: 40_000 });
    expect(done.status).toBe(1);
    expect(Date.now() - began).toBeGreaterThan(9_000);
    expect(Date.now() - began).toBeLessThan(25_000);
    expect(logLines(b)).toHaveLength(2);
    expect(logLines(b)[1]).toMatch(/ note: this run's container could not be removed; /);
    expect(runDirs(b)).toEqual([]);
  }, 60_000);

  it.each([
    ['a flag', '--volume=/:/host'],
    ['a short id', 'ab12'.repeat(15)],
    ['a long id', 'ab12'.repeat(17)],
    ['upper-case hex', 'AB12'.repeat(16)],
    ['two lines', `${'cd34'.repeat(16)}\n--all`],
    ['nothing', ''],
  ])('asks docker to remove nothing when the cid file holds %s', (_, text) => {
    const b = box();
    mkdirSync(path.join(b.state, 'run.dead01'), { recursive: true });
    writeFileSync(path.join(b.state, 'run.dead01', 'cid'), text);
    expect(runOnce(b).status).toBe(0);
    expect(removals(b)).toEqual([`rm -f ${CID}`]);
    expect(runDirs(b)).toEqual([]);
  });

  it('removes the container a killed run left running, by the id in its leftover folder, before it starts its own', () => {
    const b = box();
    const old = 'cd34'.repeat(16);
    mkdirSync(path.join(b.state, 'run.dead01'), { recursive: true });
    writeFileSync(path.join(b.state, 'run.dead01', 'cid'), old);
    expect(runOnce(b).status).toBe(0);
    expect(removals(b)).toEqual([`rm -f ${old}`, `rm -f ${CID}`]);
    expect(dockerRuns(b)).toHaveLength(1);
    expect(runDirs(b)).toEqual([]);
  });

  /** A run that the cron token stops: exit 1, the fixed words on stderr and in one log line, no container, no secret read. */
  function refusedForToken(b: Box, run: { status: number | null; stdout: string; stderr: string }, words: string): void {
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`items-cron: ${words}\n`);
    expect(logLines(b)).toHaveLength(1);
    expect((logLines(b)[0] as string).replace(new RegExp(`^${STAMP} exit=1 `), '')).toBe(words);
    expect(baoCalls(b).some((call) => call.startsWith('kv'))).toBe(false);
    expect(dockerRuns(b)).toEqual([]);
    expect(runDirs(b)).toEqual([]);
    expect(everythingWritten(b, run)).not.toContain(CRON_TOKEN);
  }

  it('reads the token file named in the settings, when there is one', () => {
    const b = box({ token: null });
    const own = path.join(b.dir, 'elsewhere');
    mkdirSync(own, { mode: 0o700 });
    writeFileSync(path.join(own, 'cron.token'), `${CRON_TOKEN}\n`, { mode: 0o600 });
    writeFileSync(path.join(b.env['HOME'] as string, '.config', 'nwfl-linkcheck', 'items.conf'), `${CONF}LINKCHECK_BAO_TOKEN_FILE=${own}/cron.token\n`);
    const run = runOnce(b);
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(baoEnv(b)).toHaveLength(5);
    for (const line of baoEnv(b)) expect(line).toMatch(new RegExp(` BAO_TOKEN=${CRON_TOKEN} `));
  });

  it('reads a token file whose line has no newline', () => {
    const b = box({ token: CRON_TOKEN });
    expect(runOnce(b)).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(baoCalls(b)).toHaveLength(5);
  });

  it("never uses another login's token from the environment or the token helper's file, and hands docker none", () => {
    const b = box();
    const helper = path.join(b.dir, 'other-token');
    writeFileSync(helper, OTHER_TOKEN);
    writeFileSync(path.join(b.env['HOME'] as string, '.vault-token'), OTHER_TOKEN);
    b.env['BAO_TOKEN'] = OTHER_TOKEN;
    b.env['BAO_TOKEN_PATH'] = helper;
    b.env['VAULT_TOKEN'] = OTHER_TOKEN;
    b.env['VAULT_TOKEN_PATH'] = helper;
    const run = runOnce(b);
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(baoEnv(b)).toEqual(['status', 'token', 'kv', 'kv', 'kv'].map((c) => `${c} BAO_TOKEN=${CRON_TOKEN} BAO_TOKEN_PATH=(unset) VAULT_TOKEN=(unset) VAULT_TOKEN_PATH=(unset)`));
    expect(read(path.join(b.dir, 'bao-other.env'))).not.toMatch(/BAO_TOKEN|VAULT_TOKEN/);
    const env = read(path.join(b.dir, 'docker.env'));
    expect(env).not.toMatch(/BAO_TOKEN|VAULT_TOKEN/);
    for (const token of [CRON_TOKEN, OTHER_TOKEN]) expect(everythingWritten(b, run)).not.toContain(token);
  });

  it("ends the run, and does not fall back on another login's token, when there is no token file", () => {
    const b = box({ token: null });
    writeFileSync(path.join(b.env['HOME'] as string, '.vault-token'), OTHER_TOKEN);
    b.env['BAO_TOKEN'] = OTHER_TOKEN;
    b.env['VAULT_TOKEN'] = OTHER_TOKEN;
    const run = runOnce(b);
    refusedForToken(b, run, REMINT);
    expect(baoCalls(b)).toEqual([]);
    expect(everythingWritten(b, run)).not.toContain(OTHER_TOKEN);
  });

  it('shows the token nowhere: not on stdout or stderr, in the log, or in any argument', () => {
    const b = box();
    const run = runOnce(b);
    expect(run.status).toBe(0);
    expect(everythingWritten(b, run)).not.toContain(CRON_TOKEN);
    expect(read(path.join(b.dir, 'docker.env'))).not.toContain(CRON_TOKEN);
  });

  it.each([
    ['there is no token file', null],
    ['the token file is empty', ''],
    ['the token file holds only an empty line', '\n'],
  ])('ends the run with the re-mint step when %s, before it asks OpenBao for anything', (_, token) => {
    const b = box({ token });
    const run = runOnce(b);
    refusedForToken(b, run, REMINT);
    expect(baoCalls(b)).toEqual([]);
  });

  it.each([
    ['OpenBao refuses the renewal (expired or revoked: 403)', { 'bao-renew': '2' }, `${CRON_TOKEN}\n`],
    ['the renewal fails for a reason of its own', { 'bao-renew': '1' }, `${CRON_TOKEN}\n`],
    ['the token is not one OpenBao knows', {}, 'made-up-revoked-token\n'],
  ])('ends the run with the re-mint step when %s, after asking OpenBao its status and before reading the secret', (_, ctl, token) => {
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n`, ...ctl }, token });
    const run = runOnce(b);
    refusedForToken(b, run, REMINT);
    expect(baoCalls(b)).toEqual(['status', 'token renew']);
    expect(everythingWritten(b, run)).not.toContain('made-up-revoked-token');
  });

  it.each([
    ['readable by its group', 0o640],
    ['readable by anyone', 0o644],
    ['writable by anyone', 0o602],
    ['read-only (0400)', 0o400],
    ['setuid (4600)', 0o4600],
    ['setgid (2600)', 0o2600],
    ['sticky (1600)', 0o1600],
    ['runnable (0700)', 0o700],
  ])('ends the run when the token file is %s: its mode must be exactly 0600', (_, fileMode) => {
    const b = box();
    chmodSync(tokenFile(b), fileMode);
    expect(statSync(tokenFile(b)).mode & 0o7777).toBe(fileMode);
    const run = runOnce(b);
    refusedForToken(b, run, `${tokenFile(b)} must be readable and writable by you alone (chmod 600)`);
    expect(baoCalls(b)).toEqual([]);
  });

  it.each([
    ['a link to a 0600 file of yours', (file: string, b: Box) => { writeFileSync(path.join(b.dir, 'linked.token'), CRON_TOKEN, { mode: 0o600 }); symlinkSync(path.join(b.dir, 'linked.token'), file); }],
    ['a link to nothing', (file: string, b: Box) => symlinkSync(path.join(b.dir, 'nothing-here'), file)],
    ['a folder', (file: string) => mkdirSync(file, { mode: 0o700 })],
    ['a pipe (which would wait for ever to be opened)', (file: string) => expect(spawnSync('mkfifo', ['-m', '600', file]).status).toBe(0)],
  ] as const)('ends the run when the token file is %s', (_, make) => {
    const b = box({ token: null });
    make(tokenFile(b), b);
    const run = runOnce(b);
    refusedForToken(b, run, `${tokenFile(b)} must be a plain file: not a link, a folder or a pipe`);
    expect(baoCalls(b)).toEqual([]);
  });

  it('ends the run when the token file belongs to another user', () => {
    // /etc/passwd is root's, in a folder only root may write: the owner is the rule it breaks first.
    const b = box({ token: null, conf: `${CONF}LINKCHECK_BAO_TOKEN_FILE=/etc/passwd\n` });
    const run = runOnce(b);
    refusedForToken(b, run, '/etc/passwd must be a file of yours');
    expect(baoCalls(b)).toEqual([]);
  });

  it.each([
    ['its group', 0o770],
    ['anyone', 0o707],
  ])("ends the run when the token file's folder can be written by %s", (_, folderMode) => {
    const b = box({ token: null });
    const folder = path.join(b.dir, 'tokens');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'cron.token'), `${CRON_TOKEN}\n`, { mode: 0o600 });
    chmodSync(folder, folderMode);
    writeFileSync(path.join(b.env['HOME'] as string, '.config', 'nwfl-linkcheck', 'items.conf'), `${CONF}LINKCHECK_BAO_TOKEN_FILE=${folder}/cron.token\n`);
    const run = runOnce(b);
    refusedForToken(b, run, `the folder of ${folder}/cron.token must be writable by you alone (chmod go-w)`);
    expect(baoCalls(b)).toEqual([]);
  });

  it('ends the run when the settings name a token file by a path that is not a full one', () => {
    const b = box({ conf: `${CONF}LINKCHECK_BAO_TOKEN_FILE=.config/nwfl-linkcheck/bao.token\n` });
    const run = runOnce(b);
    refusedForToken(b, run, `LINKCHECK_BAO_TOKEN_FILE in ${b.env['HOME'] as string}/.config/nwfl-linkcheck/items.conf must be a full path (starting with /)`);
    expect(baoCalls(b)).toEqual([]);
  });

  /** A stand-in `date` (the wrapper's first child on every path) that notes the environment it was given. */
  function dateNotesItsEnvironment(b: Box): void {
    writeFileSync(path.join(b.dir, 'bin', 'date'), `#!/bin/sh\nenv >> '${b.dir}/date.env'\nexec /usr/bin/date "$@"\n`, { mode: 0o700 });
  }
  /** What the wrapper's children were given, other than the BAO_TOKEN of the bao calls. */
  const childEnvironments = (b: Box): string => ['docker.env', 'bao-other.env', 'date.env'].map((name) => read(path.join(b.dir, name))).join('\n');

  // A shell takes the variables it inherits as exported ones: one named like a variable of the wrapper
  // would hand what the wrapper puts in it to every child.
  it('hands the token to no child but bao, as BAO_TOKEN, when the run inherits variables named like its own', () => {
    const b = box();
    dateNotesItsEnvironment(b);
    b.env['token'] = 'inherited-x';
    b.env['more'] = 'inherited-y';
    const run = runOnce(b);
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(read(path.join(b.dir, 'docker.env'))).not.toBe('');
    expect(read(path.join(b.dir, 'date.env'))).not.toBe('');
    expect(read(path.join(b.dir, 'bao-other.env'))).not.toBe('');
    expect(childEnvironments(b)).not.toContain(CRON_TOKEN);
    expect(childEnvironments(b)).not.toMatch(/^(token|more)=/m);
  });

  it.each([
    ['a second line', `made-up-first-line\n${CRON_TOKEN}\n`],
    ['a second line that does not end', `made-up-first-line\n${CRON_TOKEN}`],
    ['a first line it refuses', `${CRON_TOKEN}\r\n`],
  ])('hands no line of a token file with %s to any child, when the run inherits variables named like its own', (_, token) => {
    const b = box({ token });
    dateNotesItsEnvironment(b);
    b.env['token'] = 'inherited-x';
    b.env['more'] = 'inherited-y';
    const run = runOnce(b);
    refusedForToken(b, run, BAD_TOKEN_FILE(tokenFile(b)));
    expect(baoCalls(b)).toEqual([]);
    expect(read(path.join(b.dir, 'date.env'))).not.toBe('');
    expect(childEnvironments(b)).not.toContain(CRON_TOKEN);
    expect(childEnvironments(b)).not.toMatch(/^(token|more)=/m);
  });

  it.each([
    ['a blank before it', ` ${CRON_TOKEN}\n`],
    ['blanks after it', `${CRON_TOKEN}  \n`],
    ['tabs and blanks around it', `\t ${CRON_TOKEN} \t\n`],
    ['blanks around it and no newline', `  ${CRON_TOKEN} `],
  ])('trims the blanks around the token: %s', (_, token) => {
    const b = box({ token });
    expect(runOnce(b)).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(baoEnv(b)).toEqual(['status', 'token', 'kv', 'kv', 'kv'].map((c) => `${c} BAO_TOKEN=${CRON_TOKEN} BAO_TOKEN_PATH=(unset) VAULT_TOKEN=(unset) VAULT_TOKEN_PATH=(unset)`));
  });

  it.each([
    ['double quotes', `"${CRON_TOKEN}"`],
    ['single quotes', `'${CRON_TOKEN}'`],
    ['a backslash at its end', `${CRON_TOKEN}\\`],
    ['an equals sign before it', `=${CRON_TOKEN}`],
  ])('trims nothing but blanks: a token with %s goes to OpenBao as it is written', (_, written) => {
    const b = box({ token: ` ${written} \n` });
    const run = runOnce(b);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`items-cron: ${REMINT}\n`);
    expect(baoEnv(b)).toEqual(['status', 'token'].map((c) => `${c} BAO_TOKEN=${written} BAO_TOKEN_PATH=(unset) VAULT_TOKEN=(unset) VAULT_TOKEN_PATH=(unset)`));
    expect(dockerRuns(b)).toEqual([]);
  });

  it.each([
    ['Windows line endings', `${CRON_TOKEN}\r\n`],
    ['a carriage return and no newline', `${CRON_TOKEN}\r`],
    ['a carriage return inside the token', `made-up\rtoken\n`],
    ['a second line', `${CRON_TOKEN}\nmade-up-second-line\n`],
    ['a second line that does not end', `${CRON_TOKEN}\nx`],
    ['a second line of one blank', `${CRON_TOKEN}\n `],
    ['an empty line after the token', `${CRON_TOKEN}\n\n`],
    ['an empty line before the token', `\n${CRON_TOKEN}\n`],
    ['three lines', `${CRON_TOKEN}\n\n${CRON_TOKEN}\n`],
    ['a blank inside the token', `made-up cron-token\n`],
    ['a tab inside the token', `made-up\tcron-token\n`],
    ['a byte order mark before the token', `\uFEFF${CRON_TOKEN}\n`],
    ['a letter outside ASCII', `made-up-t\u00F6ken\n`],
    ['a control character', `made-up\u0007token\n`],
  ])('refuses a token file with %s as a bad file, before it asks OpenBao for anything', (_, token) => {
    const b = box({ token });
    const run = runOnce(b);
    refusedForToken(b, run, BAD_TOKEN_FILE(tokenFile(b)));
    expect(baoCalls(b)).toEqual([]);
  });

  it.each([
    ['only blanks', ' \t \n'],
    ['only blanks and no newline', '  '],
  ])('ends the run with the re-mint step when the token file holds %s', (_, token) => {
    const b = box({ token });
    const run = runOnce(b);
    refusedForToken(b, run, REMINT);
    expect(baoCalls(b)).toEqual([]);
  });

  it.each([
    ['the time limit is reached (124)', '124'],
    ['the renewal ignored the stop and was killed (137)', '137'],
  ])('gives the renewal 30 seconds, and ends the run with the re-mint step when %s', (_, code) => {
    const b = box();
    // A stand-in `timeout` that records its arguments and what it was given, and reports the renewal's limit as reached.
    writeFileSync(
      path.join(b.dir, 'bin', 'timeout'),
      `#!/bin/sh\ncase "$*" in *' token renew') echo "$*" > '${b.dir}/timeout.args'; echo "BAO_TOKEN=$BAO_TOKEN" > '${b.dir}/timeout.env'; exit ${code} ;; esac\nexec /usr/bin/timeout "$@"\n`,
      { mode: 0o700 },
    );
    const run = runOnce(b);
    refusedForToken(b, run, REMINT);
    expect(read(path.join(b.dir, 'timeout.args'))).toBe('--foreground -k 5 30 bao token renew\n');
    expect(read(path.join(b.dir, 'timeout.env'))).toBe(`BAO_TOKEN=${CRON_TOKEN}\n`);
    expect(baoCalls(b)).toEqual(['status']);
  });

  it('ends a renewal that never answers: exit 1, the re-mint step, no secret read and no link check', () => {
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n`, 'bao-renew-hang': '' } });
    // The real `timeout`, with the renewal's 30 seconds made 1 so that the test does not wait for them.
    writeFileSync(
      path.join(b.dir, 'bin', 'timeout'),
      `#!/bin/sh\ncase "$*" in '--foreground -k 5 30 bao token renew') exec /usr/bin/timeout --foreground -k 1 1 bao token renew ;; esac\nexec /usr/bin/timeout "$@"\n`,
      { mode: 0o700 },
    );
    const began = Date.now();
    const run = runOnce(b);
    expect(Date.now() - began).toBeLessThan(15_000);
    refusedForToken(b, run, REMINT);
    expect(baoCalls(b)).toEqual(['status', 'token renew']);
  });

  it('runs the renewal under its time limit on a good run too, and goes on when it answers', () => {
    const b = box();
    writeFileSync(path.join(b.dir, 'bin', 'timeout'), `#!/bin/sh\necho "$*" >> '${b.dir}/timeout.args'\nexec /usr/bin/timeout "$@"\n`, { mode: 0o700 });
    expect(runOnce(b)).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(read(path.join(b.dir, 'timeout.args')).split('\n')[0]).toBe('--foreground -k 5 30 bao token renew');
    expect(baoCalls(b)).toHaveLength(5);
  });

  it('ends a renewal that never answers at once when the whole run is told to stop (a signal to its process group)', async () => {
    const b = box({ ctl: { 'docker-out': `${COUNTS}\n`, 'bao-renew-hang': '' } });
    const child = spawn('sh', [SCRIPT], { env: b.env, stdio: 'ignore', detached: true });
    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    await seen(path.join(b.dir, 'renew-started'));
    const began = Date.now();
    process.kill(-(child.pid as number), 'SIGTERM');
    expect(await exit).toBe(1);
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(logLines(b)).toHaveLength(1);
    expect(logLines(b)[0]).toMatch(new RegExp(`^${STAMP} exit=1 `));
    expect(baoCalls(b)).toEqual(['status', 'token renew']);
    expect(dockerRuns(b)).toEqual([]);
    expect(runDirs(b)).toEqual([]);
  }, 60_000);
});
