// ============================================================================
// fc-infra's pin checks bind an image digest to the commit it was built from by the image's
// org.opencontainers.image.revision label, as CI reads it back and prints it. So each of the three
// images (api, api-migrate, web), in its pull-request build and in its main publish:
//   - is built with the commit sha as the REVISION build-arg, once: --build-arg REVISION="$GITHUB_SHA"
//     in a docker build step, a build-args line REVISION=${{ github.sha }} for docker/build-push-action;
//   - then has its labels read back against that same sha by scripts/image-labels.ts, from the local
//     image after a pull-request build and from the registry, by the pushed digest, after a publish, in
//     a step that cannot be skipped or excused (no if, no continue-on-error);
// and each Dockerfile's last stage takes REVISION with no default, fails without it (${REVISION:?...}),
// and labels the source as this repository. This fails if any of that is lost.
// It reads web.yml too; apps/web/test checks the web half again, for a change that runs only web.yml.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(API, '../..');
const SCRIPT = path.join(API, 'scripts', 'image-labels.ts');
const SOURCE = 'https://github.com/rpgoldberg/nwfl-mensa-site';
const REGISTRY = 'ghcr.io/rpgoldberg/nwfl-mensa-site';

type Map = Record<string, unknown>;
const isMap = (value: unknown): value is Map => typeof value === 'object' && value !== null && !Array.isArray(value);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One image build: a pull-request build of a local tag, or a main publish of a registry name. */
type Build = { workflow: 'api.yml' | 'web.yml'; job: string } & ({ local: string; registry?: never } | { registry: string; local?: never });

const BUILDS: Build[] = [
  { workflow: 'api.yml', job: 'image', local: 'nwfl-mensa-api:ci' },
  { workflow: 'api.yml', job: 'migrate-image', local: 'nwfl-mensa-api-migrate:ci' },
  { workflow: 'api.yml', job: 'publish', registry: `${REGISTRY}/api` },
  { workflow: 'api.yml', job: 'publish', registry: `${REGISTRY}/api-migrate` },
  { workflow: 'web.yml', job: 'docker', local: 'nwfl-mensa-web:ci' },
  { workflow: 'web.yml', job: 'publish', registry: `${REGISTRY}/web` },
];
const DOCKERFILES = ['apps/api/Dockerfile', 'apps/api/Dockerfile.migrate', 'apps/web/Dockerfile'];

const RUN_ARG = '--build-arg REVISION="$GITHUB_SHA"';
const ACTION_ARG = 'REVISION=${{ github.sha }}';
const name = (build: Build): string => `${build.workflow} ${build.job} ${build.local ?? build.registry}`;
const steps = (job: unknown): Map[] => (isMap(job) && Array.isArray(job['steps']) ? job['steps'].filter(isMap) : []);
const runOf = (step: Map): string | undefined => (typeof step['run'] === 'string' ? step['run'] : undefined);
const withOf = (step: Map): Map => (isMap(step['with']) ? step['with'] : {});

/** Whether this step builds the image: a docker build tagging the local name, or build-push-action tagging it. */
function builds(step: Map, build: Build): boolean {
  const run = runOf(step);
  if (run !== undefined) return build.local !== undefined && /(^|\s)docker build\s/.test(run) && new RegExp(`(^|\\s)-t ${escape(build.local)}(\\s|$)`).test(run);
  if (typeof step['uses'] !== 'string' || !step['uses'].startsWith('docker/build-push-action@')) return false;
  const tags = withOf(step)['tags'];
  if (typeof tags !== 'string') return false;
  return build.local !== undefined ? tags.trim() === build.local : tags.trim().startsWith(`${build.registry}:`);
}

/** Whether the build passes REVISION exactly once, and as the commit sha. */
function passesRevision(step: Map): boolean {
  const run = runOf(step);
  if (run !== undefined) return (run.match(/--build-arg REVISION=/g) ?? []).length === 1 && new RegExp(`(^|\\s)${escape(RUN_ARG)}(\\s|$)`).test(run);
  const args = withOf(step)['build-args'];
  const lines = typeof args === 'string' ? args.split('\n').map((line) => line.trim()) : [];
  return lines.filter((line) => line.startsWith('REVISION=')).length === 1 && lines.includes(ACTION_ARG);
}

/** The step's working directory, as GitHub resolves it: the step's own, the job's default, the workflow's, the root. */
function workingDirectory(workflow: Map, job: Map, step: Map): string {
  const of = (holder: unknown): unknown => (isMap(holder) && isMap(holder['defaults']) && isMap(holder['defaults']['run']) ? holder['defaults']['run']['working-directory'] : undefined);
  const dir = step['working-directory'] ?? of(job) ?? of(workflow);
  return typeof dir === 'string' ? dir : '.';
}

/** The read-back command for this build, run from `dir`. */
function readBack(build: Build, dir: string): string {
  const script = path.relative(path.join(ROOT, dir), SCRIPT).split(path.sep).join('/');
  return build.local !== undefined ? `node ${script} local ${build.local} "$GITHUB_SHA"` : `node ${script} registry "${build.registry}@$DIGEST" "$GITHUB_SHA"`;
}

/** What keeps this build from being labelled with its commit and read back; empty when nothing does. */
function buildProblems(workflow: unknown, build: Build): string[] {
  const label = name(build);
  const job = isMap(workflow) && isMap(workflow['jobs']) ? workflow['jobs'][build.job] : undefined;
  if (!isMap(workflow) || !isMap(job)) return [`${label}: the job is missing`];
  const list = steps(job);
  const at = list.flatMap((step, index) => (builds(step, build) ? [index] : []));
  if (at.length !== 1) return [`${label}: ${at.length === 0 ? 'no step builds the image' : 'more than one step builds the image'}`];
  const found: string[] = [];
  const built = list[at[0]!]!;
  if (!passesRevision(built)) found.push(`${label}: the build must pass the commit sha, once, as REVISION (${runOf(built) === undefined ? ACTION_ARG : RUN_ARG})`);
  if ('continue-on-error' in job) found.push(`${label}: the job must not have continue-on-error`);
  const after = list.slice(at[0]! + 1);
  const reads = after.filter((step) => runOf(step)?.trim() === readBack(build, workingDirectory(workflow, job, step)));
  if (reads.length === 0) return [...found, `${label}: no step after the build reads its labels back: ${readBack(build, workingDirectory(workflow, job, {}))}`];
  for (const step of reads) {
    if ('if' in step || 'continue-on-error' in step) found.push(`${label}: the read-back must not have an if or continue-on-error`);
    if (build.registry === undefined) continue;
    const digest = `\${{ steps.${String(built['id'])}.outputs.digest }}`;
    if (typeof built['id'] !== 'string' || !isMap(step['env']) || step['env']['DIGEST'] !== digest) found.push(`${label}: the read-back must read the digest the build pushed (env DIGEST: ${digest}, and an id on the build)`);
  }
  return found;
}

/** What keeps a Dockerfile's last stage from requiring REVISION and labelling the commit and the source. */
function dockerfileProblems(text: string): string[] {
  const lines = text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const last = lines.slice(Math.max(0, lines.findLastIndex((line) => /^FROM\s/i.test(line))));
  const arg = last.findIndex((line) => /^ARG\s+REVISION(=|\s|$)/.test(line));
  if (arg === -1) return ['the last stage must declare ARG REVISION'];
  const found: string[] = [];
  if (last[arg] !== 'ARG REVISION') found.push('ARG REVISION must have no default: a build without the commit sha must fail');
  const rest = last.slice(arg + 1);
  if (!rest.some((line) => /^LABEL org\.opencontainers\.image\.revision="\$\{REVISION:\?[^}"]+\}"$/.test(line))) {
    found.push('after ARG REVISION, LABEL org.opencontainers.image.revision="${REVISION:?...}" must fail a build without it');
  }
  if (lines.filter((line) => line.includes('org.opencontainers.image.revision')).length !== 1) found.push('org.opencontainers.image.revision must be set once');
  if (!last.includes(`LABEL org.opencontainers.image.source="${SOURCE}"`)) found.push(`the last stage must label org.opencontainers.image.source="${SOURCE}"`);
  if (rest.some((line) => /^RUN\s/i.test(line))) found.push('no RUN may follow ARG REVISION: each commit would rebuild that layer');
  return found;
}

const workflows: Record<Build['workflow'], Map> = {
  'api.yml': parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'api.yml'), 'utf8')) as Map,
  'web.yml': parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'web.yml'), 'utf8')) as Map,
};

/** A deep copy of the build's workflow with its job changed, given the steps and where the build step is. */
function changed(build: Build, edit: (list: Map[], at: number, job: Map) => void): Map {
  const copy = structuredClone(workflows[build.workflow]);
  const job = (copy['jobs'] as Map)[build.job] as Map;
  const list = job['steps'] as Map[];
  edit(list, list.findIndex((step) => builds(step, build)), job);
  return copy;
}
/** Where the build's read-back step is, after `at`. */
const readAt = (list: Map[], at: number, build: Build): number => list.findIndex((step, index) => index > at && (runOf(step) ?? '').includes(`image-labels.ts ${build.local === undefined ? 'registry' : 'local'} `) && (runOf(step) ?? '').includes(build.local ?? `${build.registry}@`));

describe('the image builds: each passes its commit as REVISION and reads the labels back', () => {
  it('builds every image with the commit sha as REVISION, then reads its labels back against it', () => {
    for (const build of BUILDS) expect(buildProblems(workflows[build.workflow], build), name(build)).toEqual([]);
  });

  it('runs a read-back script that is where the steps run it', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('fails if any image build loses its REVISION build-arg, passes it twice or passes something else', () => {
    for (const build of BUILDS) {
      const expected = [expect.stringMatching(new RegExp(`^${escape(name(build))}: the build must pass the commit sha, once, as REVISION`))];
      const edit = (to: (arg: string) => string) =>
        changed(build, (list, at) => {
          const step = list[at]!;
          if (typeof step['run'] === 'string') step['run'] = step['run'].replace(RUN_ARG, to(RUN_ARG)).replace(/ {2,}/g, ' ');
          else withOf(step)['build-args'] = String(withOf(step)['build-args']).replace(ACTION_ARG, to(ACTION_ARG));
        });
      expect(buildProblems(edit(() => ''), build), `${name(build)} lost`).toEqual(expected);
      expect(buildProblems(edit((arg) => arg.replace(/GITHUB_SHA|github\.sha/, (sha) => (sha === 'GITHUB_SHA' ? 'GITHUB_REF' : 'github.ref'))), build), `${name(build)} other`).toEqual(expected);
      expect(buildProblems(edit((arg) => `${arg}${arg.startsWith('--') ? ' --build-arg REVISION=0' : '\nREVISION=0'}`), build), `${name(build)} twice`).toEqual(expected);
    }
  });

  it('fails if any image build loses its read-back, or reads back before the build, another image, or against another sha', () => {
    for (const build of BUILDS) {
      const expected = [expect.stringMatching(new RegExp(`^${escape(name(build))}: no step after the build reads its labels back: `))];
      expect(buildProblems(changed(build, (list, at) => list.splice(readAt(list, at, build), 1)), build), `${name(build)} lost`).toEqual(expected);
      expect(buildProblems(changed(build, (list, at) => list.splice(at, 0, ...list.splice(readAt(list, at, build), 1))), build), `${name(build)} before`).toEqual(expected);
      expect(buildProblems(changed(build, (list, at) => (list[readAt(list, at, build)]!['run'] = String(list[readAt(list, at, build)]!['run']).replace(':ci', ':canary').replace('@$DIGEST', ':latest'))), build), `${name(build)} other image`).toEqual(expected);
      expect(buildProblems(changed(build, (list, at) => (list[readAt(list, at, build)]!['run'] = String(list[readAt(list, at, build)]!['run']).replace('"$GITHUB_SHA"', '"$GITHUB_REF"'))), build), `${name(build)} other sha`).toEqual(expected);
    }
  });

  it('fails if a read-back may be skipped or excused, or the job excused', () => {
    for (const build of BUILDS) {
      const onRead = (key: string) => changed(build, (list, at) => (list[readAt(list, at, build)]![key] = key === 'if' ? 'success()' : true));
      expect(buildProblems(onRead('if'), build)).toEqual([`${name(build)}: the read-back must not have an if or continue-on-error`]);
      expect(buildProblems(onRead('continue-on-error'), build)).toEqual([`${name(build)}: the read-back must not have an if or continue-on-error`]);
      expect(buildProblems(changed(build, (_list, _at, job) => (job['continue-on-error'] = true)), build)).toEqual([`${name(build)}: the job must not have continue-on-error`]);
    }
  });

  it('fails if a publish reads back a digest other than the one its build pushed', () => {
    for (const build of BUILDS.filter((each) => each.registry !== undefined)) {
      const expected = [expect.stringMatching(new RegExp(`^${escape(name(build))}: the read-back must read the digest the build pushed`))];
      expect(buildProblems(changed(build, (list, at) => ((list[readAt(list, at, build)]!['env'] as Map)['DIGEST'] = '${{ steps.other.outputs.digest }}')), build)).toEqual(expected);
      expect(buildProblems(changed(build, (list, at) => delete list[readAt(list, at, build)]!['env']), build)).toEqual(expected);
      expect(buildProblems(changed(build, (list, at) => delete list[at]!['id']), build)).toEqual(expected);
    }
  });

  it('fails if the build is gone, doubled, or its job is', () => {
    const [local, registry] = [BUILDS[0]!, BUILDS[2]!];
    expect(buildProblems(changed(local, (list, at) => list.splice(at, 1)), local)).toEqual([`${name(local)}: no step builds the image`]);
    expect(buildProblems(changed(registry, (list, at) => list.splice(at, 0, structuredClone(list[at]!))), registry)).toEqual([`${name(registry)}: more than one step builds the image`]);
    expect(buildProblems({ jobs: {} }, local)).toEqual([`${name(local)}: the job is missing`]);
    expect(buildProblems('not a workflow', local)).toEqual([`${name(local)}: the job is missing`]);
    expect(buildProblems({ jobs: { image: { steps: [{ uses: 'docker/build-push-action@0', with: { tags: ['x'] } }, { uses: 'actions/checkout@0' }] } } }, local)).toEqual([`${name(local)}: no step builds the image`]);
  });

  it('resolves the read-back script from the working directory the step runs in', () => {
    const build = BUILDS[4]!;
    const moved = changed(build, (list, at) => {
      const step = list[readAt(list, at, build)]!;
      step['working-directory'] = 'apps/api';
      step['run'] = String(step['run']).replace('../api/scripts/', 'scripts/');
    });
    expect(buildProblems(moved, build)).toEqual([]);
    expect(workingDirectory({}, {}, {})).toBe('.');
  });
});

describe('the Dockerfiles: REVISION required, the commit and the source labelled', () => {
  const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

  it('takes REVISION with no default in the last stage, fails without it, and labels the commit and this repository', () => {
    for (const file of DOCKERFILES) expect(dockerfileProblems(read(file)), file).toEqual([]);
  });

  it('fails when REVISION is missing, defaulted, unchecked, set twice, or followed by a RUN, or the source is wrong', () => {
    const text = read(DOCKERFILES[0]!);
    expect(dockerfileProblems(text.replace(/^ARG REVISION$/m, ''))).toEqual(['the last stage must declare ARG REVISION']);
    expect(dockerfileProblems(text.replace(/^ARG REVISION$/m, 'ARG REVISION=unknown'))).toEqual(['ARG REVISION must have no default: a build without the commit sha must fail']);
    expect(dockerfileProblems(text.replace(/\$\{REVISION:\?[^}]+\}/, '${REVISION}'))).toEqual(['after ARG REVISION, LABEL org.opencontainers.image.revision="${REVISION:?...}" must fail a build without it']);
    expect(dockerfileProblems(`${text}\nLABEL org.opencontainers.image.revision="unknown"\n`)).toEqual(['org.opencontainers.image.revision must be set once']);
    expect(dockerfileProblems(text.replace(SOURCE, `${SOURCE}.git`))).toEqual([`the last stage must label org.opencontainers.image.source="${SOURCE}"`]);
    expect(dockerfileProblems(`${text}\nRUN true\n`)).toEqual(['no RUN may follow ARG REVISION: each commit would rebuild that layer']);
    expect(dockerfileProblems(`${text}\nFROM scratch\n`)).toEqual(['the last stage must declare ARG REVISION']);
  });
});
