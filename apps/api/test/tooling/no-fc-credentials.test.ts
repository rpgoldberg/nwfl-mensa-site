// MT-06: CI never holds a FigureCollecting credential, and nothing in the
// repository points at the FigureCollecting package registry. fc-shared stays
// vendored (vendor/README.md). One script checks the whole repository
// (scripts/no-fc-credentials.sh at the root), in CI and here. MT-03 and MT-50:
// no default names a FigureCollecting host either; production issuers come
// from configuration. The patterns are assembled from parts, so this file does
// not match itself.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, encoding: 'utf8' }).trim();

const CREDENTIAL = new RegExp(['NODE_AUTH', '_TOKEN|npm\\.pkg\\.', 'github\\.com'].join(''), 'i');
const FC_HOST = new RegExp(['mindsignals', '1\\.com|figurecollecting\\.', 'com'].join(''), 'i');

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '')
    .filter((file) => !readFileSync(path.join(ROOT, file)).subarray(0, 8000).includes(0));
}

const matching = (files: string[], pattern: RegExp): string[] =>
  files.flatMap((file) =>
    readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])),
  );

describe('no FigureCollecting credential or registry (MT-06)', () => {
  it('scans the whole repository: both apps, the workflows and the scripts', () => {
    expect(tracked()).toEqual(
      expect.arrayContaining(['.github/workflows/api.yml', '.github/workflows/secrets.yml', 'apps/api/package.json', 'apps/api/package-lock.json', 'apps/web/package-lock.json', 'apps/api/scripts/test-db.sh']),
    );
  });

  it('finds no registry token variable and no FigureCollecting registry anywhere tracked', () => {
    expect(matching(tracked(), CREDENTIAL)).toEqual([]);
  });

  it('keeps CI checking the same thing on every run, with the root script, which passes here', async () => {
    expect(readFileSync(path.join(ROOT, '.github', 'workflows', 'secrets.yml'), 'utf8')).toMatch(/run: sh scripts\/no-fc-credentials\.sh$/m);
    const code = await new Promise<number>((resolve) => execFile('sh', [path.join(ROOT, 'scripts', 'no-fc-credentials.sh')], { cwd: REPO }, (error) => resolve(error === null ? 0 : 1)));
    expect(code).toBe(0);
  });
});

describe('no FigureCollecting host as a default (MT-03, MT-50)', () => {
  it('names no FigureCollecting host in the service code', () => {
    expect(matching(tracked().filter((file) => file.startsWith('apps/api/src/')), FC_HOST)).toEqual([]);
  });
});
