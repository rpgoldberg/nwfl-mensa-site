// MT-06: this tenant installs only from the public npm registry. A private
// registry address or its token variable in any tracked file would tie the
// build to an fc credential, so neither may appear anywhere. The patterns are
// assembled at run time so this file does not match itself; the CI step uses
// a bracket class for the same reason.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const BANNED = [['NODE', 'AUTH', 'TOKEN'].join('_'), ['npm', 'pkg', 'github', 'com'].join('.')];

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '');
}

describe('no private registry (MT-06)', () => {
  it('scans every tracked file, the lockfile and npm config included', () => {
    expect(tracked()).toEqual(expect.arrayContaining(['package-lock.json', '.npmrc', '.github/workflows/ci.yml', 'Dockerfile']));
  });

  it('names neither the private registry nor its token variable in any tracked file', () => {
    const hits = tracked().flatMap((file) => {
      const text = readFileSync(file).toString('latin1');
      return BANNED.filter((word) => text.includes(word)).map((word) => `${file}: ${word}`);
    });
    expect(hits).toEqual([]);
  });

  it('is checked in CI with a pattern that cannot match itself', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    // YAML single quotes double the shell's: the shell runs ! git grep -nE '<pattern>'.
    expect(ci).toContain("run: '! git grep -nE ''NODE_AUTH_TOKE[N]|npm\\.pkg\\.github\\.co[m]'''");
  });
});
