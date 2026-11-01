// ============================================================================
// Does the image name the commit it was built from? CI's read-back, after each image build
// (.github/workflows/api.yml and web.yml):
//
//   node scripts/image-labels.ts local <image> <commit-sha>                  after a pull-request build
//   node scripts/image-labels.ts registry <name>@sha256:<digest> <commit-sha>  after a publish, by the pushed digest
//
// local reads `docker image inspect`; registry reads `docker buildx imagetools inspect`, which follows
// the pushed index to its one platform manifest and that manifest's config, where the labels live.
// It prints one line, the one fc-infra's pins cite: ok or FAILED, the image (with its digest), the
// platform manifest for a registry read, and both labels. It exits 0 when org.opencontainers.image.revision
// is exactly <commit-sha> and org.opencontainers.image.source exactly this repository, 1 when not or when
// the image cannot be read, 2 on a usage error.
// test/tooling/image-labels-workflow.test.ts pins every image build to pass REVISION and run this after it.
// ============================================================================
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SOURCE = 'https://github.com/rpgoldberg/nwfl-mensa-site';
export const REVISION_LABEL = 'org.opencontainers.image.revision';
export const SOURCE_LABEL = 'org.opencontainers.image.source';

const USAGE = 'usage: node scripts/image-labels.ts local <image> <commit-sha> | registry <name>@sha256:<digest> <commit-sha>';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST_REF = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const MISSING = '<missing>';

type Map = Record<string, unknown>;
const isMap = (value: unknown): value is Map => typeof value === 'object' && value !== null && !Array.isArray(value);
const label = (labels: unknown, key: string): unknown => (isMap(labels) ? labels[key] : undefined);
const shown = (value: unknown): string => (typeof value === 'string' ? value : MISSING);

/** What keeps these labels from naming commit `revision` and this repository; empty when they do. */
export function labelProblems(labels: unknown, revision: string): string[] {
  const found: string[] = [];
  for (const [key, want] of [
    [REVISION_LABEL, revision],
    [SOURCE_LABEL, SOURCE],
  ] as const) {
    const value = label(labels, key);
    if (value !== want) found.push(`${key} is ${typeof value !== 'string' ? 'missing' : value === '' ? 'empty' : value}, not ${want}`);
  }
  return found;
}

/** An image read back: where it was read (digest, platform) and its labels. */
interface ReadBack {
  where: string;
  labels: unknown;
}

const platformOf = (image: unknown): string => {
  if (!isMap(image) || typeof image['os'] !== 'string' || typeof image['architecture'] !== 'string') return 'unknown platform';
  return [image['os'], image['architecture'], image['variant']].filter((part) => typeof part === 'string').join('/');
};

/** `docker image inspect <image>`: an array of one image. */
function fromLocal(inspect: unknown): ReadBack | string {
  if (!Array.isArray(inspect) || inspect.length !== 1 || !isMap(inspect[0])) return 'docker image inspect did not describe one image';
  const image = inspect[0];
  const config = isMap(image['Config']) ? image['Config'] : {};
  return { where: `id ${shown(image['Id'])} ${platformOf({ os: image['Os'], architecture: image['Architecture'] })}`, labels: config['Labels'] };
}

/** `docker buildx imagetools inspect <name@digest> --format '{{json .}}'`: the index (or manifest) and the image config. */
function fromRegistry(ref: string, inspect: unknown): ReadBack | string {
  const manifest = isMap(inspect) ? inspect['manifest'] : undefined;
  if (!isMap(inspect) || !isMap(manifest)) return 'the registry returned no manifest';
  let platformManifest = ref.slice(ref.indexOf('@') + 1);
  if (Array.isArray(manifest['manifests'])) {
    // An index: its platform manifests, without the attestation manifests buildx adds beside them.
    const platforms = manifest['manifests'].filter((entry): entry is Map => isMap(entry) && isMap(entry['platform']) && !(isMap(entry['annotations']) && entry['annotations']['vnd.docker.reference.type'] === 'attestation-manifest'));
    if (platforms.length !== 1) {
      const names = platforms.map((entry) => platformOf(entry['platform']));
      return `expected one platform image, found ${platforms.length} (${names.join(', ')})${platforms.length > 1 ? "; read each platform's labels" : ''}`;
    }
    platformManifest = shown(platforms[0]!['digest']);
  }
  const image = inspect['image'];
  if (!isMap(image) || !isMap(image['config'])) return 'the registry returned no image config';
  return { where: `${platformOf(image)} manifest ${platformManifest}`, labels: image['config']['Labels'] };
}

/** The command: 0 the labels name the commit and this repository, 1 not (or unreadable), 2 a usage error. */
export function main(argv: readonly string[], { docker, log }: { docker: (args: readonly string[]) => string; log: (line: string) => void }): number {
  const [mode, ref, revision] = argv;
  if (argv.length !== 3 || (mode !== 'local' && mode !== 'registry') || ref === undefined || ref === '' || revision === undefined || !SHA.test(revision) || (mode === 'registry' && !DIGEST_REF.test(ref))) {
    log(USAGE);
    return 2;
  }
  let read: ReadBack | string;
  try {
    const answer: unknown = JSON.parse(docker(mode === 'local' ? ['image', 'inspect', ref] : ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .}}']));
    read = mode === 'local' ? fromLocal(answer) : fromRegistry(ref, answer);
  } catch (error) {
    log(`::error::image-labels: cannot read ${ref}: ${(error as Error).message.trim()}`);
    return 1;
  }
  if (typeof read === 'string') {
    log(`::error::image-labels: ${ref}: ${read}`);
    return 1;
  }
  const problems = labelProblems(read.labels, revision);
  log(`image-labels: ${problems.length === 0 ? 'ok' : 'FAILED'} ${ref} ${read.where} ${REVISION_LABEL}=${shown(label(read.labels, REVISION_LABEL))} ${SOURCE_LABEL}=${shown(label(read.labels, SOURCE_LABEL))}`);
  for (const problem of problems) log(`::error::image-labels: ${ref}: ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

/** The docker CLI on PATH: its stdout, or an error carrying its stderr. */
export function runDocker(args: readonly string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// The command line itself; the test also runs it as a child process.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), { docker: runDocker, log: (line) => console.log(line) });
}
