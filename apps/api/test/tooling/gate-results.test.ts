// scripts/gate-results.ts reads the vitest JSON report of the api-gate job and fails unless every
// test file in test/gates ran at least one test and every test passed. vitest alone exits 0 when the
// catalog test skips for want of a database, and reports success, so the job checks it here.
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { gateFiles, gateProblems, main } from '../../scripts/gate-results.js';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = '/repo/apps/api';
const FILES = ['test/gates/a.test.ts', 'test/gates/b.test.ts'];

/** A vitest JSON report: each file with the statuses of its tests, every file passed unless given. */
function report(files: Record<string, string[]>, fileStatus: Record<string, string> = {}, success = true): unknown {
  return {
    success,
    testResults: Object.entries(files).map(([file, statuses]) => ({
      name: path.join(ROOT, file),
      status: fileStatus[file] ?? 'passed',
      message: fileStatus[file] === undefined ? '' : 'Failed to load the file',
      assertionResults: statuses.map((status, i) => ({ fullName: `${file} test ${i + 1}`, status })),
    })),
  };
}

const scratch = mkdtempSync(path.join(tmpdir(), 'gate-results-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('scripts/gate-results.ts', () => {
  it('passes when every gate file ran tests and every test passed', () => {
    expect(gateProblems(report({ [FILES[0]!]: ['passed', 'passed'], [FILES[1]!]: ['passed'] }), FILES, ROOT)).toEqual([]);
  });

  it('fails on a skipped, todo or failed test, the way the catalog test skips without a database', () => {
    expect(gateProblems(report({ [FILES[0]!]: ['passed'], [FILES[1]!]: ['skipped'] }), FILES, ROOT)).toEqual([`${FILES[1]} test 1 is skipped, not passed`]);
    expect(gateProblems(report({ [FILES[0]!]: ['todo', 'failed'], [FILES[1]!]: ['passed'] }), FILES, ROOT)).toEqual([`${FILES[0]} test 1 is todo, not passed`, `${FILES[0]} test 2 is failed, not passed`]);
  });

  it('fails when a gate file did not run, ran no test, or failed to load', () => {
    expect(gateProblems(report({ [FILES[0]!]: ['passed'] }), FILES, ROOT)).toEqual([`${FILES[1]} did not run`]);
    expect(gateProblems(report({ [FILES[0]!]: ['passed'], [FILES[1]!]: [] }), FILES, ROOT)).toEqual([`${FILES[1]} ran no test`]);
    expect(gateProblems(report({ [FILES[0]!]: ['passed'], [FILES[1]!]: [] }, { [FILES[1]!]: 'failed' }), FILES, ROOT)).toEqual([`${FILES[1]} is failed: Failed to load the file`, `${FILES[1]} ran no test`]);
  });

  it('fails on a failed file outside the list, an unsuccessful run, no gate files, or no report', () => {
    expect(gateProblems(report({ [FILES[0]!]: ['passed'], [FILES[1]!]: ['passed'], 'test/gates/c.test.ts': ['failed'] }), FILES, ROOT)).toEqual(['test/gates/c.test.ts test 1 is failed, not passed']);
    expect(gateProblems(report({ [FILES[0]!]: ['passed'], [FILES[1]!]: ['passed'] }, {}, false), FILES, ROOT)).toEqual(['the run did not succeed']);
    expect(gateProblems(report({}), [], ROOT)).toEqual(['no gate test file was found']);
    expect(gateProblems({ success: true }, FILES, ROOT)).toEqual(['not a vitest JSON report']);
    expect(gateProblems(null, FILES, ROOT)).toEqual(['not a vitest JSON report']);
  });

  it('reads a malformed entry as a problem, not a pass', () => {
    const odd = {
      success: true,
      testResults: [{ name: path.join(ROOT, FILES[0]!), assertionResults: [{}] }, 'junk', { name: path.join(ROOT, FILES[1]!), status: 'passed', assertionResults: 'junk' }, { status: 'failed', assertionResults: [] }],
    };
    expect(gateProblems(odd, FILES, ROOT)).toEqual([`${FILES[0]} is undefined: `, `${FILES[0]} test 1 is undefined, not passed`, `${FILES[1]} ran no test`, '(unnamed) is failed: ']);
  });

  it('lists every test file under the gate directory, nested too, relative to the API', () => {
    const root = path.join(scratch, 'api');
    mkdirSync(path.join(root, 'test/gates/deep'), { recursive: true });
    for (const file of ['test/gates/b.test.ts', 'test/gates/a.test.ts', 'test/gates/deep/c.test.ts', 'test/gates/a.requests.json', 'test/gates/helper.ts']) writeFileSync(path.join(root, file), '');
    expect(gateFiles(root, 'test/gates')).toEqual(['test/gates/a.test.ts', 'test/gates/b.test.ts', 'test/gates/deep/c.test.ts']);
  });

  it('as a command: 0 when the gate passed, 1 when it did not or the report is unreadable, 2 on bad usage', () => {
    const root = path.join(scratch, 'cmd');
    mkdirSync(path.join(root, 'test/gates'), { recursive: true });
    for (const file of FILES) writeFileSync(path.join(root, file), '');
    const good = path.join(scratch, 'good.json');
    const bad = path.join(scratch, 'bad.json');
    const passing = report({ [FILES[0]!]: ['passed'], [FILES[1]!]: ['passed'] }) as { testResults: { name: string }[] };
    for (const result of passing.testResults) result.name = result.name.replace(ROOT, root);
    writeFileSync(good, JSON.stringify(passing));
    writeFileSync(bad, '{ not json');
    const logs: string[] = [];
    const log = (line: string): void => void logs.push(line);

    expect(main([good, 'test/gates'], { root, log })).toBe(0);
    expect(logs.at(-1)).toBe('api-gate: all 2 gate test files ran and every test passed (2 tests)');
    expect(main([bad, 'test/gates'], { root, log })).toBe(1);
    expect(logs.at(-1)).toMatch(/^::error::api-gate: cannot read the report .*bad\.json: /);
    expect(main([path.join(scratch, 'missing.json'), 'test/gates'], { root, log })).toBe(1);
    expect(main([good, 'test/none'], { root, log })).toBe(1);
    expect(logs.at(-1)).toMatch(/^::error::api-gate: cannot list the gate tests in test\/none: /);
    writeFileSync(path.join(root, 'test/gates/c.test.ts'), '');
    expect(main([good, 'test/gates'], { root, log })).toBe(1);
    expect(logs.at(-1)).toBe('::error::api-gate: test/gates/c.test.ts did not run');
    expect(main([good], { root, log })).toBe(2);
    expect(logs.at(-1)).toBe('usage: node scripts/gate-results.ts <vitest-json-report> <gate-dir>');
  });

  it('runs as a command under Node itself (type stripping), and fails on an unreadable report', async () => {
    const run = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile(process.execPath, ['scripts/gate-results.ts', path.join(scratch, 'missing.json'), 'test/gates'], { cwd: API }, (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : (error.code as number), out: `${stdout}${stderr}` }),
      ),
    );
    expect(run.code, run.out).toBe(1);
    expect(run.out).toMatch(/::error::api-gate: cannot read the report/);
  });
});
