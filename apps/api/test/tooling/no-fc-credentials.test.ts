// MT-06: this repository's CI never holds a FigureCollecting credential, and
// nothing here points at the FigureCollecting package registry. fc-shared stays
// vendored (vendor/README.md). MT-03 and MT-50: no default names a
// FigureCollecting host either; production issuers come from configuration.
// The patterns are assembled from parts, so this file does not match itself.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CREDENTIAL = new RegExp(['NODE_AUTH', '_TOKEN|npm\\.pkg\\.', 'github\\.com'].join(''), 'i');
const FC_HOST = new RegExp(['mindsignals', '1\\.com|figurecollecting\\.', 'com'].join(''), 'i');

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '')
    .filter((file) => !readFileSync(path.join(REPO, file)).subarray(0, 8000).includes(0));
}

const matching = (files: string[], pattern: RegExp): string[] =>
  files.flatMap((file) =>
    readFileSync(path.join(REPO, file), 'utf8')
      .split('\n')
      .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])),
  );

describe('no FigureCollecting credential or registry (MT-06)', () => {
  it('scans the workflows, package files and scripts', () => {
    expect(tracked()).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'scripts/test-db.sh']));
  });

  it('finds no registry token variable and no FigureCollecting registry anywhere tracked', () => {
    expect(matching(tracked(), CREDENTIAL)).toEqual([]);
  });

  it('keeps CI checking the same thing on every run', () => {
    expect(readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')).toMatch(/sh scripts\/no-fc-credentials\.sh/);
  });
});

describe('no FigureCollecting host as a default (MT-03, MT-50)', () => {
  it('names no FigureCollecting host in the service code', () => {
    expect(matching(tracked().filter((file) => file.startsWith('src/')), FC_HOST)).toEqual([]);
  });
});
