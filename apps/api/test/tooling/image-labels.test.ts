// scripts/image-labels.ts reads an image's labels back, from the local image after a pull-request build
// or from the registry by the pushed digest after a publish, and fails unless
// org.opencontainers.image.revision is exactly the commit sha and org.opencontainers.image.source exactly
// this repository. The line it prints (the image, its digest, the labels) is what fc-infra's pins cite.
// The shapes below are the real ones: docker image inspect of a local build, and docker buildx imagetools
// inspect --format '{{json .}}' of the published api index (one linux/amd64 manifest and its attestation).
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { REVISION_LABEL, SOURCE, SOURCE_LABEL, labelProblems, main, runDocker } from '../../scripts/image-labels.js';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = 'a50b7750d5f49bb0c951e301dfc012a35311de19';
const OTHER = '7a94884ac99c71c2b89b1a86e2ad114285194acb';
const INDEX = 'sha256:feb522a651e6ca7875a2bee7b97a39c3bdac3713251d4c8a30ba6eda96de27d1';
const MANIFEST = 'sha256:20dec9b29ddf2317b038066f67104c3c4759f612e42e47979d1bd3b173eddd83';
const ID = 'sha256:689b399864ecff480622d0bdbbdd90b551e6b0ca78a8e1759c55bf77c6a50a69';
const REF = `ghcr.io/rpgoldberg/nwfl-mensa-site/api@${INDEX}`;
const LOCAL = 'nwfl-mensa-api:ci';

const good = (revision = SHA, source: string = SOURCE): Record<string, string> => ({ 'org.opencontainers.image.title': 'nwfl-mensa-api', [REVISION_LABEL]: revision, [SOURCE_LABEL]: source });

/** docker image inspect <image>: an array of one image. */
const local = (labels: unknown, extra: Record<string, unknown> = {}): unknown => [{ Id: ID, RepoDigests: [], Os: 'linux', Architecture: 'amd64', Config: { User: '10001:10001', Labels: labels }, ...extra }];

const AMD64 = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: MANIFEST, size: 2541, platform: { architecture: 'amd64', os: 'linux' } };
const ATTESTATION = {
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  digest: 'sha256:88dd012151fec0790c259c8d3aa05982777bc0cb66b738188574b59458491922',
  size: 840,
  annotations: { 'vnd.docker.reference.digest': MANIFEST, 'vnd.docker.reference.type': 'attestation-manifest' },
  platform: { architecture: 'unknown', os: 'unknown' },
};
/** docker buildx imagetools inspect <name@digest> --format '{{json .}}': the index and the one platform's config. */
const registry = (labels: unknown, manifests: unknown[] = [AMD64, ATTESTATION], image: unknown = { os: 'linux', architecture: 'amd64', config: { Labels: labels } }): unknown => ({
  name: REF,
  manifest: { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', digest: INDEX, size: 856, manifests },
  image,
});

/** Runs main with a docker that answers `answer` (JSON-encoded unless a string, thrown if an Error). */
function run(argv: string[], answer: unknown): { code: number; lines: string[]; calls: string[][] } {
  const lines: string[] = [];
  const calls: string[][] = [];
  const docker = (args: readonly string[]): string => {
    calls.push([...args]);
    if (answer instanceof Error) throw answer;
    return typeof answer === 'string' ? answer : JSON.stringify(answer);
  };
  const code = main(argv, { docker, log: (line) => lines.push(line) });
  return { code, lines, calls };
}

describe('labelProblems', () => {
  it('passes labels that name the commit exactly and this repository', () => {
    expect(SOURCE).toBe('https://github.com/rpgoldberg/nwfl-mensa-site');
    expect(labelProblems(good(), SHA)).toEqual([]);
  });

  it('fails a revision that is another commit, a prefix, upper case, empty or missing', () => {
    expect(labelProblems(good(OTHER), SHA)).toEqual([`${REVISION_LABEL} is ${OTHER}, not ${SHA}`]);
    expect(labelProblems(good(SHA.slice(0, 7)), SHA)).toEqual([`${REVISION_LABEL} is ${SHA.slice(0, 7)}, not ${SHA}`]);
    expect(labelProblems(good(SHA.toUpperCase()), SHA)).toHaveLength(1);
    expect(labelProblems(good(''), SHA)).toEqual([`${REVISION_LABEL} is empty, not ${SHA}`]);
    expect(labelProblems({ [SOURCE_LABEL]: SOURCE }, SHA)).toEqual([`${REVISION_LABEL} is missing, not ${SHA}`]);
  });

  it('fails a source that is not exactly this repository', () => {
    expect(labelProblems(good(SHA, `${SOURCE}.git`), SHA)).toEqual([`${SOURCE_LABEL} is ${SOURCE}.git, not ${SOURCE}`]);
    expect(labelProblems(good(SHA, 'https://github.com/someone/nwfl-mensa-site'), SHA)).toHaveLength(1);
  });

  it('fails an image with no labels, or labels that are not strings', () => {
    expect(labelProblems(null, SHA)).toEqual([`${REVISION_LABEL} is missing, not ${SHA}`, `${SOURCE_LABEL} is missing, not ${SOURCE}`]);
    expect(labelProblems({ [REVISION_LABEL]: 1, [SOURCE_LABEL]: [SOURCE] }, SHA)).toHaveLength(2);
  });
});

describe('scripts/image-labels.ts local', () => {
  it('reads the local image, prints its id and labels, and passes when they name the commit', () => {
    const result = run(['local', LOCAL, SHA], local(good()));
    expect(result.calls).toEqual([['image', 'inspect', LOCAL]]);
    expect(result.lines).toEqual([`image-labels: ok ${LOCAL} id ${ID} linux/amd64 ${REVISION_LABEL}=${SHA} ${SOURCE_LABEL}=${SOURCE}`]);
    expect(result.code).toBe(0);
  });

  it('fails, printing what it found, when the revision is another commit or a label is missing', () => {
    const wrong = run(['local', LOCAL, SHA], local(good(OTHER)));
    expect(wrong.code).toBe(1);
    expect(wrong.lines).toEqual([`image-labels: FAILED ${LOCAL} id ${ID} linux/amd64 ${REVISION_LABEL}=${OTHER} ${SOURCE_LABEL}=${SOURCE}`, `::error::image-labels: ${LOCAL}: ${REVISION_LABEL} is ${OTHER}, not ${SHA}`]);
    const bare = run(['local', LOCAL, SHA], local(undefined, { Config: {}, Os: undefined }));
    expect(bare.code).toBe(1);
    expect(bare.lines[0]).toBe(`image-labels: FAILED ${LOCAL} id ${ID} unknown platform ${REVISION_LABEL}=<missing> ${SOURCE_LABEL}=<missing>`);
    expect(bare.lines).toHaveLength(3);
  });

  it('fails when docker cannot read the image, or answers with something that is not one image', () => {
    expect(run(['local', LOCAL, SHA], new Error('No such image: nwfl-mensa-api:ci'))).toMatchObject({ code: 1, lines: [`::error::image-labels: cannot read ${LOCAL}: No such image: nwfl-mensa-api:ci`] });
    expect(run(['local', LOCAL, SHA], 'not json')).toMatchObject({ code: 1, lines: [expect.stringMatching(/^::error::image-labels: cannot read nwfl-mensa-api:ci: .*JSON/)] });
    expect(run(['local', LOCAL, SHA], [])).toMatchObject({ code: 1, lines: [`::error::image-labels: ${LOCAL}: docker image inspect did not describe one image`] });
    expect(run(['local', LOCAL, SHA], [{ Config: { Labels: good() } }, { Id: ID }])).toMatchObject({ code: 1 });
    expect(run(['local', LOCAL, SHA], [{ Config: { Labels: good() } }]).lines[0]).toMatch(/^image-labels: ok nwfl-mensa-api:ci id <missing> /);
  });
});

describe('scripts/image-labels.ts registry', () => {
  it('reads the pushed digest from the registry, prints the index, the platform manifest and the labels, and passes', () => {
    const result = run(['registry', REF, SHA], registry(good()));
    expect(result.calls).toEqual([['buildx', 'imagetools', 'inspect', REF, '--format', '{{json .}}']]);
    expect(result.lines).toEqual([`image-labels: ok ${REF} linux/amd64 manifest ${MANIFEST} ${REVISION_LABEL}=${SHA} ${SOURCE_LABEL}=${SOURCE}`]);
    expect(result.code).toBe(0);
  });

  it('reads a single-platform manifest pushed without an index as its own platform manifest', () => {
    const single = { name: REF, manifest: { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: {}, layers: [] }, image: { os: 'linux', architecture: 'arm64', variant: 'v8', config: { Labels: good() } } };
    expect(run(['registry', REF, SHA], single)).toMatchObject({ code: 0, lines: [`image-labels: ok ${REF} linux/arm64/v8 manifest ${INDEX} ${REVISION_LABEL}=${SHA} ${SOURCE_LABEL}=${SOURCE}`] });
  });

  it('fails when the pushed image names another commit or another source', () => {
    const wrong = run(['registry', REF, SHA], registry(good(OTHER, `${SOURCE}.git`)));
    expect(wrong.code).toBe(1);
    expect(wrong.lines.slice(1)).toEqual([`::error::image-labels: ${REF}: ${REVISION_LABEL} is ${OTHER}, not ${SHA}`, `::error::image-labels: ${REF}: ${SOURCE_LABEL} is ${SOURCE}.git, not ${SOURCE}`]);
    expect(wrong.lines[0]).toMatch(/^image-labels: FAILED /);
  });

  it('fails on anything but one platform: several platforms, none, or no image config', () => {
    const arm = { ...AMD64, digest: 'sha256:' + '1'.repeat(64), platform: { architecture: 'arm64', os: 'linux' } };
    const several = run(['registry', REF, SHA], registry(good(), [AMD64, arm, ATTESTATION], { 'linux/amd64': {}, 'linux/arm64': {} }));
    expect(several).toMatchObject({ code: 1, lines: [`::error::image-labels: ${REF}: expected one platform image, found 2 (linux/amd64, linux/arm64); read each platform's labels`] });
    expect(run(['registry', REF, SHA], registry(good(), [ATTESTATION]))).toMatchObject({ code: 1, lines: [`::error::image-labels: ${REF}: expected one platform image, found 0 ()`] });
    expect(run(['registry', REF, SHA], registry(good(), [AMD64], { 'linux/amd64': { config: { Labels: good() } } }))).toMatchObject({ code: 1, lines: [`::error::image-labels: ${REF}: the registry returned no image config`] });
    expect(run(['registry', REF, SHA], { name: REF })).toMatchObject({ code: 1, lines: [`::error::image-labels: ${REF}: the registry returned no manifest`] });
    expect(run(['registry', REF, SHA], registry(good(), ['junk', { platform: 'x' }, AMD64]))).toMatchObject({ code: 0 });
  });

  it('fails when the registry cannot be read', () => {
    expect(run(['registry', REF, SHA], new Error('ERROR: not found'))).toMatchObject({ code: 1, lines: [`::error::image-labels: cannot read ${REF}: ERROR: not found`] });
  });
});

describe('scripts/image-labels.ts usage', () => {
  it('refuses, without asking docker, a missing or extra argument, an unknown mode, a sha that is not 40 lower-case hex, or a registry tag', () => {
    const usage = (argv: string[]) => {
      const result = run(argv, local(good()));
      expect(result.calls, argv.join(' ')).toEqual([]);
      expect(result.lines[0], argv.join(' ')).toMatch(/^usage: node scripts\/image-labels\.ts (local|registry)/);
      return result.code;
    };
    expect(usage([])).toBe(2);
    expect(usage(['local', LOCAL])).toBe(2);
    expect(usage(['local', LOCAL, SHA, 'extra'])).toBe(2);
    expect(usage(['remote', LOCAL, SHA])).toBe(2);
    expect(usage(['local', LOCAL, SHA.slice(0, 7)])).toBe(2);
    expect(usage(['local', LOCAL, SHA.toUpperCase()])).toBe(2);
    expect(usage(['local', LOCAL, ''])).toBe(2);
    expect(usage(['local', '', SHA])).toBe(2);
    expect(usage(['registry', 'ghcr.io/rpgoldberg/nwfl-mensa-site/api:a50b775', SHA])).toBe(2);
    expect(usage(['registry', 'ghcr.io/rpgoldberg/nwfl-mensa-site/api@', SHA])).toBe(2);
  });
});

const scratch = mkdtempSync(path.join(tmpdir(), 'image-labels-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('scripts/image-labels.ts as a command', () => {
  /** A folder with a docker that prints `answer` for any arguments, or prints its arguments to stderr and fails. */
  function fakeDocker(answer: string | undefined): string {
    const bin = mkdtempSync(path.join(scratch, 'bin-'));
    writeFileSync(path.join(bin, 'answer.json'), answer ?? '');
    writeFileSync(path.join(bin, 'docker'), answer === undefined ? '#!/bin/sh\necho "docker said no to: $*" >&2\nexit 1\n' : `#!/bin/sh\ncat "${path.join(bin, 'answer.json')}"\n`);
    chmodSync(path.join(bin, 'docker'), 0o755);
    return bin;
  }

  function command(argv: string[], answer: string): Promise<{ code: number | null; out: string }> {
    const bin = fakeDocker(answer);
    return new Promise((resolve) => {
      const child = execFile(process.execPath, ['scripts/image-labels.ts', ...argv], { cwd: API, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` } }, (_error, stdout, stderr) => resolve({ code: child.exitCode, out: `${stdout}${stderr}` }));
    });
  }

  it('exits 0 and prints the line when the labels match, 1 when they do not, 2 on a usage error', async () => {
    const ok = await command(['local', LOCAL, SHA], JSON.stringify(local(good())));
    expect(ok.out).toContain(`image-labels: ok ${LOCAL} id ${ID}`);
    expect(ok.code).toBe(0);
    const wrong = await command(['registry', REF, SHA], JSON.stringify(registry(good(OTHER))));
    expect(wrong.out).toContain(`::error::image-labels: ${REF}: ${REVISION_LABEL} is ${OTHER}, not ${SHA}`);
    expect(wrong.code).toBe(1);
    expect((await command(['local', LOCAL], '')).code).toBe(2);
  });

  it('asks the docker on PATH, and passes on what it prints or the error it gives', () => {
    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = `${fakeDocker('{"ok":true}')}${path.delimiter}${saved ?? ''}`;
      expect(runDocker(['image', 'inspect', LOCAL])).toBe('{"ok":true}');
      process.env['PATH'] = `${fakeDocker(undefined)}${path.delimiter}${saved ?? ''}`;
      expect(() => runDocker(['image', 'inspect', LOCAL])).toThrow(/docker said no to: image inspect nwfl-mensa-api:ci/);
    } finally {
      process.env['PATH'] = saved;
    }
  });
});
