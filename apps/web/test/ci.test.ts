// The web app's CI: .github/workflows/web.yml at the repository root, the only
// place GitHub reads workflows from. It runs when apps/web or the workflow
// itself changes, inside apps/web.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'web.yml'), 'utf8');

/** The body of one job: from its key to the next job key. */
function job(name: string): string {
  const start = ci.search(new RegExp(`^  ${name}:$`, 'm'));
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

const JOBS = ['lint', 'typecheck', 'unit', 'e2e', 'docker', 'publish'];

describe('web workflow', () => {
  it('runs only for changes to the web app, the API protos its client is generated from, the API the leak test runs, or itself, on pushes and pull requests', () => {
    const triggers = ci.slice(0, ci.search(/^permissions:/m));
    const paths = String.raw`    paths: \['apps/web/\*\*', 'apps/api/proto/\*\*', 'apps/api/src/\*\*', 'apps/api/migrations/\*\*', 'apps/api/scripts/\*\*', '\.github/workflows/web\.yml'\]$`;
    for (const event of ['push', 'pull_request']) expect(triggers).toMatch(new RegExp(`^  ${event}:\\n(?:    .*\\n)*?${paths}`, 'm'));
  });

  it('runs every step inside apps/web', () => {
    expect(ci).toMatch(/^defaults:\n {2}run:\n {4}working-directory: apps\/web$/m);
  });

  it('has these jobs and no other', () => {
    expect([...ci.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]).filter((name) => !['push', 'pull_request', 'run'].includes(name!))).toEqual(JOBS);
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('takes Node from apps/web/.nvmrc and caches by the app lockfile', () => {
    const setups = ci.match(/uses: actions\/setup-node@\S+.*\n(?: {8}.*\n)+/g) ?? [];
    expect(setups.length).toBe(4);
    for (const setup of setups) {
      expect(setup).toMatch(/node-version-file: apps\/web\/\.nvmrc$/m);
      expect(setup).toMatch(/cache-dependency-path: apps\/web\/package-lock\.json$/m);
    }
    expect(readFileSync(path.join(ROOT, 'apps', 'web', '.nvmrc'), 'utf8').trim()).toMatch(/^24\.\d+\.\d+$/);
  });

  it('reads the repository, and only the publishing job may write packages', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    const writes = ci.split('\n').filter((line) => /write/.test(line) && !/^\s*#/.test(line));
    expect(writes).toEqual(['      packages: write']);
    expect(job('publish')).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}packages: write$/m);
  });

  it('lints and typechecks', () => {
    expect(job('lint')).toMatch(/run: npm run lint$/m);
    expect(job('typecheck')).toMatch(/run: npm run typecheck$/m);
  });

  it('runs the unit tests with the coverage gate, and keeps the report', () => {
    expect(job('unit')).toMatch(/run: npm run test:coverage$/m);
    expect(job('unit')).toMatch(/path: apps\/web\/coverage\/$/m);
  });

  it('runs one e2e job: the built site, then the public-only canary, with one browser install', () => {
    const e2e = job('e2e');
    expect(e2e.match(/playwright install/g)).toHaveLength(1);
    expect(e2e).toMatch(/run: npx playwright install --with-deps chromium webkit$/m);
    const order = ['run: npm run build$', 'run: npm run e2e$', 'run: npm run build:public-only$', 'run: npm run e2e:public-only$'].map((step) => e2e.search(new RegExp(step, 'm')));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(e2e).toMatch(/apps\/web\/playwright-report\//);
  });

  it('runs the redaction leak test against the real API, on the full build, before the canary build replaces it (REDACT R2b)', () => {
    const e2e = job('e2e');
    const order = [
      'run: npm run e2e$',
      'run: npm ci --ignore-scripts && npm run build\\n {8}working-directory: apps/api$',
      'run: sh \\.\\./api/scripts/test-db\\.sh start >> "\\$GITHUB_ENV"$',
      'run: npm run e2e:redaction$',
      'run: npm run build:public-only$',
    ].map((step) => e2e.search(new RegExp(step, 'm')));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The throwaway database goes, by the id it was started with, whatever happened.
    expect(e2e).toMatch(/^ {6}- if: always\(\) && env\.NWFL_TEST_PG_CONTAINER != ''\n {8}run: sh \.\.\/api\/scripts\/test-db\.sh stop "\$NWFL_TEST_PG_CONTAINER"$/m);
  });

  it('builds the image from apps/web and starts it with a read-only root, the canary image too', () => {
    const docker = job('docker');
    expect(docker).toMatch(/docker\/build-push-action@/);
    expect(docker).toMatch(/context: apps\/web$/m);
    expect(docker).toMatch(/push: false/);
    expect(docker).toMatch(/docker run .*--read-only .*--tmpfs \/tmp/);
    expect(docker).toMatch(/\/healthz/);
    expect(docker).toMatch(/--build-arg PUBLIC_ONLY=true/);
    expect(docker).toMatch(/\/auth\/callback/);
  });

  it('publishes to ghcr.io/rpgoldberg/nwfl-mensa-site/web on a push to main only, once every check passed', () => {
    const publish = job('publish');
    expect(publish).toMatch(/^ {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m);
    expect(publish).toMatch(/^ {4}needs: \[lint, typecheck, unit, e2e, docker\]$/m);
    expect(publish).toMatch(/uses: docker\/login-action@/);
    expect(publish).toMatch(/registry: ghcr\.io$/m);
    expect(publish).toMatch(/password: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m);
    expect(publish).toMatch(/context: apps\/web$/m);
    expect(publish).toMatch(/push: true$/m);
    expect(publish).toMatch(/tags: ghcr\.io\/rpgoldberg\/nwfl-mensa-site\/web:\$\{\{ steps\.sha\.outputs\.short \}\}$/m);
    expect(publish).toMatch(/steps\.image\.outputs\.digest/);
    expect(publish).toMatch(/echo .*ghcr\.io\/rpgoldberg\/nwfl-mensa-site\/web@\$\{\{ steps\.image\.outputs\.digest \}\}/);
  });

  it('installs with npm ci and never runs dependency install scripts', () => {
    for (const line of ci.match(/run: npm (ci|install).*$/gm) ?? []) expect(line).toMatch(/^run: npm ci --ignore-scripts/);
  });
});
