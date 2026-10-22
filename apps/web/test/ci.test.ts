import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

/** The body of one job: from its key to the next job key. */
function job(name: string): string {
  const start = ci.search(new RegExp(`^  ${name}:$`, 'm'));
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('CI workflow', () => {
  it('pins every action to a full commit SHA', () => {
    const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('reads the repository and nothing more', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(ci).not.toMatch(/write/);
  });

  it('lints and typechecks', () => {
    expect(job('lint')).toMatch(/run: npm run lint$/m);
    expect(job('typecheck')).toMatch(/run: npm run typecheck$/m);
  });

  it('runs the unit tests with the coverage gate', () => {
    expect(job('unit')).toMatch(/run: npm run test:coverage$/m);
  });

  it('runs the e2e suite on the built site, in Chromium and WebKit', () => {
    const e2e = job('e2e');
    expect(e2e).toMatch(/run: npm run build$/m);
    expect(e2e).toMatch(/playwright install --with-deps chromium webkit$/m);
    expect(e2e).toMatch(/run: npm run e2e$/m);
  });

  it('builds the image and starts it with a read-only root', () => {
    const docker = job('docker');
    expect(docker).toMatch(/docker\/build-push-action@/);
    expect(docker).toMatch(/push: false/);
    expect(docker).toMatch(/docker run .*--read-only .*--tmpfs \/tmp/);
    expect(docker).toMatch(/\/healthz/);
  });

  it('scans every commit for secrets with the pinned gitleaks', () => {
    const secrets = job('secrets');
    expect(secrets).toMatch(/fetch-depth: 0/);
    expect(secrets).toMatch(/run: sh scripts\/gitleaks\.sh git --log-opts=--all$/m);
  });

  it('installs with npm ci and never runs dependency install scripts', () => {
    for (const line of ci.match(/run: npm (ci|install).*$/gm) ?? []) expect(line).toMatch(/^run: npm ci --ignore-scripts/);
  });
});
