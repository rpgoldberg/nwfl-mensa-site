// SIGNIN-SLOW round 3: the one long browser test (a reader back from the provider after 605 s) runs in its
// own workflow, .github/workflows/web-long.yml, on a schedule and by hand: never on a pull request, never
// on the way to publishing an image. Every other sign-in e2e test stays in web.yml's e2e job.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const LONG = path.join(ROOT, '.github', 'workflows', 'web-long.yml');
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');

describe('the long e2e workflow', () => {
  it('exists', () => {
    expect(existsSync(LONG)).toBe(true);
  });

  it('runs on a schedule and by hand only: no pull_request, no push', () => {
    const ci = read('.github', 'workflows', 'web-long.yml');
    const triggers = ci.slice(ci.search(/^on:$/m), ci.search(/^permissions:/m));
    expect([...triggers.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1])).toEqual(['schedule', 'workflow_dispatch']);
    expect(triggers).toMatch(/^ {4}- cron: '[0-9*/ ,-]+'$/m);
  });

  it('reads the repository only, pins its actions, installs without scripts, and fails loudly', () => {
    const ci = read('.github', 'workflows', 'web-long.yml');
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(ci.split('\n').filter((line) => /write/.test(line) && !/^\s*#/.test(line))).toEqual([]);
    for (const ref of [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!)) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    for (const line of ci.match(/run: npm (ci|install).*$/gm) ?? []) expect(line).toMatch(/^run: npm ci --ignore-scripts/);
    expect(ci).not.toMatch(/continue-on-error|\|\| true/);
    const order = ['run: npm ci --ignore-scripts$', 'run: npx playwright install --with-deps chromium$', 'run: npm run build$', 'run: npm run e2e:long$'].map((s) => ci.search(new RegExp(s, 'm')));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(ci).toMatch(/^defaults:\n {2}run:\n {4}working-directory: apps\/web$/m);
    expect(ci).toMatch(/node-version-file: apps\/web\/\.nvmrc$/m);
  });

  it('is the only place the long test runs: tagged @long, skipped unless E2E_LONG=1, which only e2e:long sets', () => {
    const spec = read('apps', 'web', 'e2e', 'signin-slow.spec.ts');
    expect(spec).toMatch(/test\('back from the provider after 605 s[^']*', \{ tag: '@long' \}, async/);
    expect(spec).toMatch(/test\.skip\(process\.env\.E2E_LONG !== '1', /);
    expect(spec.match(/@long/g)).toHaveLength(1);
    const scripts = (JSON.parse(read('apps', 'web', 'package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['e2e:long']).toBe('E2E_LONG=1 playwright test --grep @long --project=chromium-desktop');
    expect(Object.entries(scripts).filter(([, v]) => v.includes('E2E_LONG')).map(([k]) => k)).toEqual(['e2e:long']);
    expect(read('.github', 'workflows', 'web.yml')).not.toMatch(/E2E_LONG|e2e:long/);
  });
});
