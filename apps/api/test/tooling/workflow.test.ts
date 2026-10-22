// The API's CI: .github/workflows/api.yml at the repository root, the only
// place GitHub reads workflows from. It runs when apps/api or the workflow
// itself changes, inside apps/api. The secret scan, MT-06 and the made-up
// people guard run once for the whole repository (secrets.yml).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, encoding: 'utf8' }).trim();
const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'api.yml'), 'utf8');

/** The body of one job: from its key to the next job key. */
function job(name: string): string {
  const start = ci.search(new RegExp(`^  ${name}:$`, 'm'));
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('api workflow', () => {
  it('runs only for changes to the API or to itself', () => {
    const triggers = ci.slice(0, ci.search(/^permissions:/m));
    for (const event of ['push', 'pull_request']) {
      expect(triggers).toMatch(new RegExp(`^  ${event}:\\n(?:    .*\\n)*?    paths: \\['apps/api/\\*\\*', '\\.github/workflows/api\\.yml'\\]$`, 'm'));
    }
  });

  it('runs every step inside apps/api, with Node from its .nvmrc and npm cached by its lockfile', () => {
    expect(ci).toMatch(/^defaults:\n {2}run:\n {4}working-directory: apps\/api$/m);
    const setups = ci.match(/uses: actions\/setup-node@\S+.*\n(?: {8}.*\n)+/g) ?? [];
    expect(setups.length).toBe(2);
    for (const setup of setups) {
      expect(setup).toMatch(/node-version-file: apps\/api\/\.nvmrc$/m);
      expect(setup).toMatch(/cache-dependency-path: apps\/api\/package-lock\.json$/m);
    }
  });

  it('keeps its jobs, with the repository-wide checks moved out', () => {
    expect([...ci.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]).filter((name) => !['push', 'pull_request', 'run'].includes(name!))).toEqual(['test', 'proto', 'image', 'publish']);
    expect(ci).not.toMatch(/gitleaks|no-fc-credentials/);
  });

  it('reads the repository, and only the publishing job may write packages', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(ci.split('\n').filter((line) => /write/.test(line) && !/^\s*#/.test(line))).toEqual(['      packages: write']);
  });

  it('lints, typechecks, tests with coverage on a throwaway Postgres, and builds', () => {
    const test = job('test');
    for (const step of ['npm ci --ignore-scripts', 'npm run lint', 'npm run typecheck', 'sh scripts/test-db.sh start >> "$GITHUB_ENV"', 'npm run test:coverage', 'npm run build']) {
      expect(test).toContain(`run: ${step}`);
    }
  });

  it('checks the protos against the base commit, with the whole history at hand', () => {
    const proto = job('proto');
    expect(proto).toMatch(/fetch-depth: 0/);
    expect(proto).toContain('run: sh scripts/buf-breaking.sh "$BASE"');
    expect(proto).toMatch(/git diff --exit-code -- src\/gen$/m);
  });

  it('builds the image from apps/api and runs it read-only', () => {
    const image = job('image');
    expect(image).toMatch(/docker build .* -t nwfl-mensa-api:ci \.$/m);
    expect(image).toMatch(/docker run -d --read-only/);
  });

  it('publishes to ghcr.io/rpgoldberg/nwfl-mensa-site/api on a push to main only, once every check passed', () => {
    const publish = job('publish');
    expect(publish).toMatch(/^ {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m);
    expect(publish).toMatch(/^ {4}needs: \[test, proto, image\]$/m);
    expect(publish).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}packages: write$/m);
    expect(publish).toMatch(/uses: docker\/login-action@[0-9a-f]{40}/);
    expect(publish).toMatch(/password: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m);
    expect(publish).toMatch(/context: apps\/api$/m);
    expect(publish).toMatch(/tags: ghcr\.io\/rpgoldberg\/nwfl-mensa-site\/api:\$\{\{ steps\.sha\.outputs\.short \}\}$/m);
    expect(publish).toMatch(/echo .*ghcr\.io\/rpgoldberg\/nwfl-mensa-site\/api@\$\{\{ steps\.image\.outputs\.digest \}\}/);
  });
});
