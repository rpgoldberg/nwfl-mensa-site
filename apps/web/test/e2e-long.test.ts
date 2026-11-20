// SIGNIN-SLOW round 4: the nightly long run (npm run e2e:long, in web-long.yml) must not pass while testing
// nothing. Playwright exits 0 when a test is skipped, so e2e:long reads Playwright's JSON report and fails
// unless exactly the long test(s) it names ran, once each, and passed.
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LONG_TESTS, longRunProblems, runLong } from '../scripts/e2e-long.mjs';

const TITLE = LONG_TESTS[0]!;
type Test = { projectName: string; status: string };
const spec = (title: string, ...tests: Test[]) => ({ title, tests });
const report = (specs: ReturnType<typeof spec>[], errors: unknown[] = []) => ({
  suites: [{ title: 'signin-slow.spec.ts', specs: [], suites: [{ title: 'nested', specs }] }],
  errors,
});
const passed = { projectName: 'chromium-desktop', status: 'expected' };

describe('the long run’s check', () => {
  it('names the one long test, the 605 s sign-in test', () => {
    expect(LONG_TESTS).toEqual(['back from the provider after 605 s, with a code or a cancel: the expired page, no round, as main']);
    const specFile = readFileSync(path.join(import.meta.dirname, '..', 'e2e', 'signin-slow.spec.ts'), 'utf8');
    expect(specFile).toContain(`test('${TITLE}', { tag: '@long' }`);
  });

  it('passes a run in which the long test ran once and passed', () => {
    expect(longRunProblems(report([spec(TITLE, passed)]))).toEqual([]);
  });

  it('fails a run in which the long test was skipped, failed or flaky', () => {
    for (const status of ['skipped', 'unexpected', 'flaky']) {
      expect(longRunProblems(report([spec(TITLE, { projectName: 'chromium-desktop', status })]))).toEqual([`${TITLE} [chromium-desktop]: ${status}, not passed`]);
    }
  });

  it('fails a run in which the long test was not found, ran twice, or another test ran', () => {
    expect(longRunProblems(report([]))).toEqual([`${TITLE}: ran 0 times, not once`]);
    expect(longRunProblems({})).toEqual([`${TITLE}: ran 0 times, not once`]);
    expect(longRunProblems(report([spec(TITLE, passed, { projectName: 'webkit-phone', status: 'expected' })]))).toEqual([`${TITLE}: ran 2 times, not once`]);
    expect(longRunProblems(report([spec(TITLE, passed), spec('another', passed)]))).toEqual(['another [chromium-desktop]: not a long test']);
  });

  it('fails a run with an error outside any test', () => {
    expect(longRunProblems(report([spec(TITLE, passed)], [{ message: 'webServer failed' }]))).toEqual(['1 error outside the tests']);
  });
});

describe('npm run e2e:long', () => {
  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-long-'));
    const file = path.join(dir, 'e2e-long.json');
    const out: string[] = [];
    const say = (line: string) => out.push(line);
    return { file, out, say };
  };

  it('runs only the long test, in Chromium, with E2E_LONG=1 and a JSON report, passing on the arguments', () => {
    const { file, say } = setup();
    const calls: [string, string[], { env: Record<string, string | undefined> }][] = [];
    const spawn = (...call: [string, string[], { env: Record<string, string | undefined> }]) => {
      calls.push(call);
      writeFileSync(file, JSON.stringify(report([spec(TITLE, passed)])));
      return { status: 0 };
    };
    expect(runLong(['--workers=1'], { spawn, env: { KEEP: 'x', E2E_LONG: '0' }, report: file, say })).toBe(0);
    expect(calls).toHaveLength(1);
    const [cmd, args, opts] = calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['test', '--grep', '@long', '--project=chromium-desktop', '--reporter=line,json', '--workers=1']);
    expect(args[0]).toMatch(/@playwright[\\/]test[\\/]cli\.js$/);
    expect(opts.env).toMatchObject({ KEEP: 'x', E2E_LONG: '1', PLAYWRIGHT_JSON_OUTPUT_FILE: file });
  });

  it('exits non-zero when the long test was skipped, and says why', () => {
    const { file, out, say } = setup();
    const spawn = () => {
      writeFileSync(file, JSON.stringify(report([spec(TITLE, { projectName: 'chromium-desktop', status: 'skipped' })])));
      return { status: 0 };
    };
    expect(runLong([], { spawn, env: {}, report: file, say })).toBe(1);
    expect(out).toEqual([`e2e:long: ${TITLE} [chromium-desktop]: skipped, not passed`]);
  });

  it('keeps Playwright’s own failure, and fails on a signal', () => {
    const { file, say } = setup();
    expect(runLong([], { spawn: () => ({ status: 3 }), env: {}, report: file, say })).toBe(3);
    expect(runLong([], { spawn: () => ({ status: null }), env: {}, report: file, say })).toBe(1);
  });

  it('fails when Playwright wrote no report, and never reads one left from an earlier run', () => {
    const { file, out, say } = setup();
    writeFileSync(file, JSON.stringify(report([spec(TITLE, passed)])));
    expect(runLong([], { spawn: () => ({ status: 0 }), env: {}, report: file, say })).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(out).toEqual([`e2e:long: no JSON report at ${file}`]);
  });
});
