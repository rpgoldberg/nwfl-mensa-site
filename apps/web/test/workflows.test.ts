// Repository-wide CI policy (REPOPARITY): every workflow under .github/workflows, plus the
// Dependabot file, read from the repository root. web.yml's own details stay in ci.test.ts.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const DIR = path.join(ROOT, '.github', 'workflows');
const read = (name: string): string => readFileSync(path.join(DIR, name), 'utf8');
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml')).sort();

/** The body of one job: from its key to the next job key. */
function job(text: string, name: string): string {
  const start = text.search(new RegExp(`^  ${name}:$`, 'm'));
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('every workflow', () => {
  it('has the expected set of workflows', () => {
    expect(files).toEqual(['api-gate.yml', 'api.yml', 'codeql.yml', 'linkcheck.yml', 'secrets.yml', 'security-scan.yml', 'web-long.yml', 'web.yml']);
  });

  it('pins every action to a full commit SHA with a version comment', () => {
    for (const f of files) {
      const uses = [...read(f).matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
      expect(uses.length, f).toBeGreaterThan(0);
      for (const [, ref, rest] of uses) {
        expect(ref, f).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(rest, `${f} ${ref}`).toMatch(/^\s+# v\d+\.\d+\.\d+/);
      }
    }
  });

  it('declares least-privilege permissions: contents read at the top, writes only where a job names them', () => {
    for (const f of files) expect(read(f), f).toMatch(/^permissions:\n {2}contents: read$/m);
    for (const f of files) {
      const writes = read(f).split('\n').filter((l) => /: write$/.test(l.trim()));
      for (const w of writes) expect(['packages: write', 'security-events: write'], f).toContain(w.trim());
    }
  });

  it('runs on pushes and pull requests to develop and main (api-gate stays unfiltered, web adds release/web-*)', () => {
    for (const f of ['api.yml', 'linkcheck.yml', 'secrets.yml', 'codeql.yml', 'security-scan.yml']) {
      const t = read(f);
      expect(t, f).toMatch(/^ {2}push:\n {4}branches: \[develop, main\]$/m);
      expect(t, f).toMatch(/^ {2}pull_request:\n(?: {4}types: .*\n)? {4}branches: \[develop, main\]$/m);
    }
    expect(read('api-gate.yml')).toMatch(/^ {2}push:\n {4}branches: \['\*\*'\]\n {2}pull_request:$/m);
    expect(read('web.yml')).toMatch(/^ {2}pull_request:\n {4}branches: \[develop, main\]$/m);
  });

  it('publishes only from a push to develop or main (web also release/web-*), never a pull request, once its checks passed', () => {
    for (const [f, name] of [['api.yml', 'publish'], ['linkcheck.yml', 'publish'], ['web.yml', 'publish']] as const) {
      const text = read(f);
      const publish = job(text, name);
      expect(publish, f).toMatch(/^ {4}if: github\.event_name == 'push' && \(github\.ref == 'refs\/heads\/develop' \|\| github\.ref == 'refs\/heads\/main'/m);
      expect(publish, f).toMatch(/^ {4}needs: \[/m);
      expect(publish, f).not.toMatch(/pull_request/);
      expect(publish, f).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}packages: write$/m);
    }
    expect(job(read('api.yml'), 'publish')).toMatch(/name: Publish the image \(develop and main\)/);
    expect(job(read('linkcheck.yml'), 'publish')).toMatch(/name: Publish the image \(develop and main\)/);
  });
});

describe('codeql.yml', () => {
  const t = read('codeql.yml');
  it('analyzes javascript-typescript weekly and on every develop/main push and pull request', () => {
    expect(t).toMatch(/^ {2}schedule:\n {4}- cron: '[^']+'$/m);
    expect(t).toMatch(/languages: javascript-typescript$/m);
    expect(t).toMatch(/^ {4}name: Analyze$/m);
    expect(t).toMatch(/^ {6}security-events: write$/m);
  });
});

describe('security-scan.yml', () => {
  const t = read('security-scan.yml');
  it('runs a Trivy filesystem scan and npm audit at high for each of the three packages', () => {
    expect(t).toMatch(/^ {4}name: Trivy filesystem scan$/m);
    expect(t).toMatch(/scan-type: 'fs'$/m);
    expect(t).toMatch(/^ {4}name: npm audit \(\$\{\{ matrix\.app \}\}\)$/m);
    expect(t).toMatch(/app: \[api, linkcheck, web\]$/m);
    expect(t).toMatch(/npm audit --audit-level=high/);
    expect(t).toMatch(/working-directory: apps\/\$\{\{ matrix\.app \}\}$/m);
    expect(t).toMatch(/npm ci --ignore-scripts/);
  });
  it('never writes anything but security events', () => {
    expect(t.split('\n').filter((l) => /: write$/.test(l.trim())).map((l) => l.trim())).toEqual(['security-events: write']);
  });
});

describe('dependabot.yml', () => {
  const t = readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8');
  it('updates npm (each package), github-actions and docker weekly against develop, grouped', () => {
    expect(t).toMatch(/^version: 2$/m);
    const blocks = t.split(/^ {2}- package-ecosystem: /m).slice(1);
    const kinds = blocks.map((b) => b.split('\n')[0]);
    expect(kinds.sort()).toEqual(['"docker"', '"github-actions"', '"npm"']);
    for (const b of blocks) {
      expect(b).toMatch(/^ {4}target-branch: develop$/m);
      expect(b).toMatch(/^ {6}interval: weekly$/m);
      expect(b).toMatch(/update-types:\n {10}- minor\n {10}- patch$/m);
    }
    for (const b of blocks.filter((x) => !x.startsWith('"github-actions"'))) for (const dir of ['apps/api', 'apps/linkcheck', 'apps/web']) expect(b).toContain(`      - "/${dir}"`);
    expect(blocks.find((x) => x.startsWith('"github-actions"'))).toMatch(/^ {4}directory: "\/"$/m);
  });
});
