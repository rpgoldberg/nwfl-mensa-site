// ============================================================================
// The gate for the gates: .github/workflows/api-gate.yml runs every test in test/gates (the
// UNTRUSTED-PDF-GATE tests and this one) on EVERY push and pull request, whatever it touches, as the
// check run `api-gate`, which the branch ruleset requires. A required check that does not report
// hangs on pending, and one reported as skipped counts as passed, so this fails if the workflow:
//   - gains a filter on push or pull_request (paths, paths-ignore, a branch or tag filter), or a
//     job-level if, needs or matrix that could leave it unreported or skipped;
//   - renames the job or its check run, or another workflow reports a check run of the same name;
//   - stops running the gate tests on a throwaway Postgres, or stops checking that every one ran and
//     passed (scripts/gate-results.ts), or lets a gate step fail quietly (if, continue-on-error);
//   - takes an action by tag instead of by commit.
// It runs in the normal suite (api.yml) and in the gate job itself, since it lives in test/gates.
// ============================================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseDocument } from 'yaml';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(API, '../..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const GATE_FILE = path.join(WORKFLOWS, 'api-gate.yml');

/** The check run's name, which the ruleset requires: the job's key and its name. */
export const GATE_CHECK = 'api-gate';
/** The gate tests the job must run, with what they read; a move or rename fails here. */
const PINNED = ['test/gates/untrusted-pdf.test.ts', 'test/gates/untrusted-pdf-catalog.test.ts', 'test/gates/untrusted-pdf.requests.json', 'src/pdf/untrusted.ts'];

const DB_START = 'sh scripts/test-db.sh start >> "$GITHUB_ENV"';
const GATE_RUN = 'node_modules/.bin/vitest run test/gates/ --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/api-gate.json"';
const RESULTS_RUN = 'node scripts/gate-results.ts "$RUNNER_TEMP/api-gate.json" test/gates';
const DB_STOP = 'sh scripts/test-db.sh stop "$NWFL_TEST_PG_CONTAINER"';
const PR_TYPES = ['opened', 'synchronize', 'reopened'];

type Map = Record<string, unknown>;
const isMap = (value: unknown): value is Map => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Why this workflow could fail to report `api-gate`, report it without running the gate tests, or pass them quietly. */
export function workflowProblems(workflow: unknown): string[] {
  const found: string[] = [];
  if (!isMap(workflow)) return ['the workflow is not a mapping'];
  if (workflow['name'] !== GATE_CHECK) found.push(`the workflow must be named ${GATE_CHECK}`);

  const on = workflow['on'];
  if (!isMap(on)) found.push('on must be a mapping that names push and pull_request');
  else {
    for (const event of ['push', 'pull_request']) if (!(event in on)) found.push(`it must run on every ${event}`);
    for (const event of ['push', 'pull_request']) {
      const spec = on[event];
      if (spec === null || spec === undefined) continue;
      if (!isMap(spec)) {
        found.push(`on.${event} must be empty or a mapping`);
        continue;
      }
      for (const [key, value] of Object.entries(spec)) {
        if (event === 'push' && key === 'branches') {
          if (!same(value, ['**'])) found.push(`on.push.branches must be ['**'], every branch`);
        } else if (event === 'pull_request' && key === 'types') {
          if (!Array.isArray(value) || PR_TYPES.some((type) => !value.includes(type))) found.push(`on.pull_request.types must include ${PR_TYPES.join(', ')}`);
        } else {
          found.push(`on.${event}.${key} is a filter: a change it leaves out would never report ${GATE_CHECK}`);
        }
      }
    }
  }

  if (!same(workflow['permissions'], { contents: 'read' })) found.push('permissions must be contents: read, nothing else');
  if (!same(workflow['defaults'], { run: { 'working-directory': 'apps/api' } })) found.push('every step must run in apps/api (defaults.run.working-directory)');

  const jobs = workflow['jobs'];
  const job = isMap(jobs) ? jobs[GATE_CHECK] : undefined;
  if (!isMap(job)) return [...found, `the job ${GATE_CHECK} is missing; the ruleset requires that check run`];
  if (job['name'] !== GATE_CHECK) found.push(`the job's name must be ${GATE_CHECK}, the check run the ruleset requires`);
  for (const key of ['if', 'needs', 'strategy', 'continue-on-error']) {
    if (key in job) found.push(`the job must not have ${key}: it could skip, rename or excuse the check`);
  }

  const steps = Array.isArray(job['steps']) ? job['steps'].filter(isMap) : [];
  const at = (run: string): number => steps.findIndex((step) => typeof step['run'] === 'string' && step['run'].trim() === run);
  const [start, gate, results] = [at(DB_START), at(GATE_RUN), at(RESULTS_RUN)];
  if (start === -1) found.push(`a step must start the throwaway Postgres: ${DB_START}`);
  if (gate === -1) found.push(`a step must run the gate tests: ${GATE_RUN}`);
  if (results === -1) found.push(`a step must check every gate test ran and passed: ${RESULTS_RUN}`);
  if (start !== -1 && gate !== -1 && results !== -1 && !(start < gate && gate < results)) found.push('the steps must start Postgres, run the gate tests, then check the results, in that order');
  steps.forEach((step, index) => {
    const label = typeof step['name'] === 'string' ? step['name'] : `step ${index + 1}`;
    if ('continue-on-error' in step) found.push(`${label} must not have continue-on-error`);
    if ('if' in step && !(step['run'] === DB_STOP && typeof step['if'] === 'string' && step['if'].includes('always()'))) found.push(`${label} must not have an if (only the Postgres removal, with always())`);
    if (typeof step['uses'] === 'string' && !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(step['uses'])) found.push(`${label} must take its action by commit sha: ${step['uses']}`);
  });
  return found;
}

const text = readFileSync(GATE_FILE, 'utf8');
const gate = parse(text) as Map;
/** A deep copy of the real workflow with one change made, to prove the check catches it. */
function changed(edit: (workflow: Map & { on: Map; jobs: Map & { 'api-gate': Map & { steps: Map[] } } }) => void): Map {
  const copy = structuredClone(gate) as Parameters<typeof edit>[0];
  edit(copy);
  return copy;
}

describe(`the ${GATE_CHECK} workflow, the required check that runs the gate tests`, () => {
  it('parses as plain YAML 1.2, with no error or warning', () => {
    const doc = parseDocument(text);
    expect(doc.errors).toEqual([]);
    expect(doc.warnings).toEqual([]);
  });

  it('runs on every push and pull request, unfiltered, and runs and checks every gate test', () => {
    expect(workflowProblems(gate)).toEqual([]);
  });

  it('fails on a paths, branch or tag filter', () => {
    expect(workflowProblems(changed((w) => ((w.on['push'] as Map)['paths'] = ['apps/api/**'])))).toEqual([`on.push.paths is a filter: a change it leaves out would never report ${GATE_CHECK}`]);
    expect(workflowProblems(changed((w) => (w.on['pull_request'] = { 'paths-ignore': ['**/*.md'] })))).toEqual([`on.pull_request.paths-ignore is a filter: a change it leaves out would never report ${GATE_CHECK}`]);
    expect(workflowProblems(changed((w) => (w.on['pull_request'] = { branches: ['main'] })))).toHaveLength(1);
    expect(workflowProblems(changed((w) => ((w.on['push'] as Map)['branches'] = ['main'])))).toEqual([`on.push.branches must be ['**'], every branch`]);
    expect(workflowProblems(changed((w) => ((w.on['push'] as Map)['tags-ignore'] = ['v*'])))).toHaveLength(1);
    expect(workflowProblems(changed((w) => (w.on['pull_request'] = { types: ['opened'] })))).toEqual([`on.pull_request.types must include ${PR_TYPES.join(', ')}`]);
    expect(workflowProblems(changed((w) => (w.on['pull_request'] = 'yes')))).toEqual(['on.pull_request must be empty or a mapping']);
    expect(workflowProblems(changed((w) => delete w.on['push']))).toEqual(['it must run on every push']);
    expect(workflowProblems(changed((w) => ((w as Map)['on'] = ['push', 'pull_request'])))).toEqual(['on must be a mapping that names push and pull_request']);
  });

  it('fails when the job or its check run is renamed, or the workflow is', () => {
    expect(workflowProblems(changed((w) => (w.jobs['api-gate']['name'] = 'API gate')))).toEqual([`the job's name must be ${GATE_CHECK}, the check run the ruleset requires`]);
    expect(workflowProblems(changed((w) => ((w.jobs['gate'] = w.jobs['api-gate']), delete (w.jobs as Map)['api-gate'])))).toEqual([`the job ${GATE_CHECK} is missing; the ruleset requires that check run`]);
    expect(workflowProblems(changed((w) => (w['name'] = 'gate')))).toEqual([`the workflow must be named ${GATE_CHECK}`]);
    expect(workflowProblems([])).toEqual(['the workflow is not a mapping']);
  });

  it('fails when the job could be skipped, renamed by a matrix, or excused', () => {
    expect(workflowProblems(changed((w) => (w.jobs['api-gate']['if'] = "github.event_name == 'push'")))).toHaveLength(1);
    expect(workflowProblems(changed((w) => (w.jobs['api-gate']['needs'] = ['lint'])))).toHaveLength(1);
    expect(workflowProblems(changed((w) => (w.jobs['api-gate']['strategy'] = { matrix: { node: [24] } })))).toHaveLength(1);
    expect(workflowProblems(changed((w) => (w.jobs['api-gate']['continue-on-error'] = true)))).toHaveLength(1);
  });

  it('fails when it stops running the gate tests, or checking that each ran and passed', () => {
    const without = (run: string) => changed((w) => (w.jobs['api-gate'].steps = w.jobs['api-gate'].steps.filter((step) => step['run'] !== run)));
    expect(workflowProblems(without(GATE_RUN))).toEqual([`a step must run the gate tests: ${GATE_RUN}`]);
    expect(workflowProblems(without(RESULTS_RUN))).toEqual([`a step must check every gate test ran and passed: ${RESULTS_RUN}`]);
    expect(workflowProblems(without(DB_START))).toEqual([`a step must start the throwaway Postgres: ${DB_START}`]);
    const edited = (from: string, to: string) => changed((w) => w.jobs['api-gate'].steps.forEach((step) => step['run'] === from && (step['run'] = to)));
    expect(workflowProblems(edited(GATE_RUN, `${GATE_RUN} || true`))).toHaveLength(1);
    expect(workflowProblems(edited(GATE_RUN, GATE_RUN.replace('test/gates/', 'test/gates/untrusted-pdf.test.ts')))).toHaveLength(1);
    expect(workflowProblems(changed((w) => w.jobs['api-gate'].steps.reverse()))).toEqual(['the steps must start Postgres, run the gate tests, then check the results, in that order']);
    expect(workflowProblems(changed((w) => (w.jobs['api-gate'].steps = 'none' as unknown as Map[])))).toHaveLength(3);
  });

  it('fails when a gate step may fail quietly, an action is taken by tag, or the scope widens', () => {
    const onStep = (run: string, key: string, value: unknown) => changed((w) => w.jobs['api-gate'].steps.forEach((step) => step['run'] === run && (step[key] = value)));
    expect(workflowProblems(onStep(GATE_RUN, 'continue-on-error', true))).toHaveLength(1);
    expect(workflowProblems(onStep(RESULTS_RUN, 'if', 'success()'))).toEqual([expect.stringMatching(/must not have an if/)]);
    expect(workflowProblems(onStep(DB_STOP, 'if', 'failure()'))).toEqual([expect.stringMatching(/must not have an if/)]);
    expect(workflowProblems(changed((w) => (w.jobs['api-gate'].steps[0]!['uses'] = 'actions/checkout@v7')))).toEqual([expect.stringMatching(/must take its action by commit sha: actions\/checkout@v7$/)]);
    expect(workflowProblems(changed((w) => (w['permissions'] = { contents: 'write' })))).toEqual(['permissions must be contents: read, nothing else']);
    expect(workflowProblems(changed((w) => delete w['defaults']))).toEqual(['every step must run in apps/api (defaults.run.working-directory)']);
  });

  it('is the only check run of that name in any workflow', () => {
    const reporters = readdirSync(WORKFLOWS)
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) => {
        const jobs = (parse(readFileSync(path.join(WORKFLOWS, file), 'utf8')) as Map)['jobs'];
        return Object.entries(isMap(jobs) ? jobs : {})
          .filter(([key, job]) => (isMap(job) && typeof job['name'] === 'string' ? job['name'] : key) === GATE_CHECK)
          .map(([key]) => `${file}:${key}`);
      });
    expect(reporters).toEqual([`api-gate.yml:${GATE_CHECK}`]);
  });

  it('runs gate tests that are where it looks for them', () => {
    for (const file of PINNED) expect(existsSync(path.join(API, file)), file).toBe(true);
  });
});
