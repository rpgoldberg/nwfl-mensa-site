// e2e-long.mjs (SIGNIN-SLOW): `npm run e2e:long`, the long browser test(s) tagged @long, run nightly by
// .github/workflows/web-long.yml. Playwright exits 0 when a test is skipped, so a nightly run could pass
// while testing nothing. This runs Playwright with a JSON report beside the line reporter, then exits
// non-zero unless exactly the tests named in LONG_TESTS ran, once each, and passed. Arguments are passed
// on to Playwright. Locally, from apps/web: npm run build && npm run e2e:long
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The long tests, by title: each must run once, in Chromium, and pass. */
export const LONG_TESTS = ['back from the provider after 605 s, with a code or a cancel: the expired page, no round, as main'];

/**
 * @typedef {{ title?: string, specs?: { title: string, tests?: { projectName: string, status: string }[] }[], suites?: Suite[] }} Suite
 * @typedef {{ suites?: Suite[], errors?: unknown[] }} Report
 */

/**
 * What is wrong with a long run, from Playwright's JSON report: nothing when each long test ran once and
 * passed and nothing else ran.
 *
 * @param {Report} report
 * @param {string[]} [expected]
 * @returns {string[]}
 */
export function longRunProblems(report, expected = LONG_TESTS) {
  /** @type {{ title: string, project: string, status: string }[]} */
  const ran = [];
  /** @param {Suite[]} suites */
  const walk = (suites) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) ran.push({ title: spec.title, project: test.projectName, status: test.status });
      walk(suite.suites ?? []);
    }
  };
  walk(report.suites ?? []);
  const problems = [];
  for (const title of expected) {
    const times = ran.filter((r) => r.title === title).length;
    if (times !== 1) problems.push(`${title}: ran ${times} times, not once`);
  }
  for (const r of ran) {
    if (!expected.includes(r.title)) problems.push(`${r.title} [${r.project}]: not a long test`);
    else if (r.status !== 'expected') problems.push(`${r.title} [${r.project}]: ${r.status}, not passed`);
  }
  const errors = report.errors?.length ?? 0;
  if (errors > 0) problems.push(`${errors} error${errors === 1 ? '' : 's'} outside the tests`);
  return problems;
}

/**
 * @typedef {(cmd: string, args: string[], opts: { stdio: 'inherit', env: Record<string, string | undefined> }) => { status: number | null }} Spawn
 */

/**
 * Run the long tests and check the run: Playwright's own exit code when it failed, 1 when the report
 * shows a test skipped, missing, repeated or extra (or there is no report), 0 otherwise.
 *
 * @param {string[]} args passed on to Playwright
 * @param {{ spawn?: Spawn, env?: Record<string, string | undefined>, report?: string, say?: (line: string) => void }} [deps]
 * @returns {number}
 */
export function runLong(args, { spawn = spawnSync, env = process.env, report = path.resolve('playwright-report', 'e2e-long.json'), say = console.error } = {}) {
  // A report left from an earlier run must never stand in for this one.
  rmSync(report, { force: true });
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const { status } = spawn(process.execPath, [cli, 'test', '--grep', '@long', '--project=chromium-desktop', '--reporter=line,json', ...args], {
    stdio: 'inherit',
    env: { ...env, E2E_LONG: '1', PLAYWRIGHT_JSON_OUTPUT_FILE: report },
  });
  if (status !== 0) return status ?? 1;
  if (!existsSync(report)) {
    say(`e2e:long: no JSON report at ${report}`);
    return 1;
  }
  const problems = longRunProblems(JSON.parse(readFileSync(report, 'utf8')));
  for (const problem of problems) say(`e2e:long: ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(runLong(process.argv.slice(2)));
