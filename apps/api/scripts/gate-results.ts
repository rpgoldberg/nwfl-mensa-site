// ============================================================================
// The api-gate job's last word (.github/workflows/api-gate.yml): did every gate test run and pass?
//
//   node scripts/gate-results.ts <vitest-json-report> <gate-dir>
//
// vitest alone exits 0, and reports success, when a test is skipped: the catalog test skips without a
// database, so a job that lost its Postgres would pass with the backstop never run. This reads the
// JSON report and exits 1 unless every *.test.ts under <gate-dir> (relative to apps/api) ran at least
// one test, and every test in the report passed: none skipped, todo or failed. 2 is a usage error.
// test/gates/api-gate-workflow.test.ts pins the job to run this after the gate tests.
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node scripts/gate-results.ts <vitest-json-report> <gate-dir>';

type Map = Record<string, unknown>;
const isMap = (value: unknown): value is Map => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every test file under `dir`, nested too, as paths relative to `root` with forward slashes, sorted. */
export function gateFiles(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => path.posix.join(dir, file.split(path.sep).join('/')))
    .sort();
}

interface Result {
  file: string;
  status: unknown;
  message: unknown;
  tests: { label: string; status: unknown }[];
}

/** The report's file results, read defensively (a malformed entry reads as not passed); undefined if it is no report. */
function results(report: unknown, root: string): Result[] | undefined {
  if (!isMap(report) || !Array.isArray(report['testResults'])) return undefined;
  return report['testResults'].filter(isMap).map((result) => {
    const name = result['name'];
    const file = typeof name === 'string' ? path.relative(root, name).split(path.sep).join('/') : '(unnamed)';
    const tests: unknown[] = Array.isArray(result['assertionResults']) ? result['assertionResults'] : [];
    return {
      file,
      status: result['status'],
      message: result['message'],
      tests: tests.map((test, i) => ({
        label: isMap(test) && typeof test['fullName'] === 'string' ? test['fullName'] : `${file} test ${i + 1}`,
        status: isMap(test) ? test['status'] : undefined,
      })),
    };
  });
}

/** What keeps the report from proving that every one of `files` ran and passed; empty when it does. */
export function gateProblems(report: unknown, files: readonly string[], root: string): string[] {
  const read = results(report, root);
  if (read === undefined) return ['not a vitest JSON report'];
  const found: string[] = [];
  if (files.length === 0) found.push('no gate test file was found');
  for (const { file, status, message, tests } of read) {
    if (status !== 'passed') found.push(`${file} is ${String(status)}: ${typeof message === 'string' ? message : ''}`);
    for (const test of tests) if (test.status !== 'passed') found.push(`${test.label} is ${String(test.status)}, not passed`);
    if (tests.length === 0 && files.includes(file)) found.push(`${file} ran no test`);
  }
  const ran = new Set(read.map((result) => result.file));
  for (const file of files) if (!ran.has(file)) found.push(`${file} did not run`);
  if ((report as Map)['success'] !== true) found.push('the run did not succeed');
  return found;
}

/** The command: 0 every gate test ran and passed, 1 not (or no readable report), 2 a usage error. */
export function main(argv: readonly string[], { root, log }: { root: string; log: (line: string) => void }): number {
  const [reportPath, dir] = argv;
  if (argv.length !== 2 || reportPath === undefined || dir === undefined) {
    log(USAGE);
    return 2;
  }
  let report: unknown;
  let files: string[];
  try {
    report = JSON.parse(readFileSync(path.resolve(reportPath), 'utf8'));
  } catch (error) {
    log(`::error::api-gate: cannot read the report ${reportPath}: ${(error as Error).message}`);
    return 1;
  }
  try {
    files = gateFiles(root, dir);
  } catch (error) {
    log(`::error::api-gate: cannot list the gate tests in ${dir}: ${(error as Error).message}`);
    return 1;
  }
  const problems = gateProblems(report, files, root);
  for (const problem of problems) log(`::error::api-gate: ${problem}`);
  if (problems.length > 0) return 1;
  const tests = (results(report, root) as Result[]).reduce((sum, result) => sum + result.tests.length, 0);
  log(`api-gate: all ${files.length} gate test files ran and every test passed (${tests} tests)`);
  return 0;
}

// The command line itself; the test also runs it as a child process.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), { root: path.resolve(import.meta.dirname, '..'), log: (line) => console.log(line) });
}
