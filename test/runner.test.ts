import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { testIdFor } from '../src/core/ids';
import type { RoundPlan, TestState } from '../src/core/types';
import { readPlan, writeApplied, writeRecord } from '../src/session';
import { baselineStatus, runMutation, RunnerError, type RoundResult, type RunRound, type TestOutcome } from '../src/runner';

const SPEC = 'cypress/e2e/a.cy.js';
const CHECKS = testIdFor(SPEC, ['dashboard', 'checks revenue']);
const SMOKE = testIdFor(SPEC, ['dashboard', 'smoke']);
const SHAKY = testIdFor(SPEC, ['dashboard', 'shaky']);
const PAGE = 'Receita R$ 128.450,50 Pedidos 312';
const SUMMARY = { revenue: 128450.5, orders: 312 };

interface Scenario {
  record?: boolean;
  tests?: string[];
  stateFor?: (testId: string, tag: string, mutatedPath: string | null, plan: RoundPlan) => TestState;
  crashesFor?: (testId: string, tag: string, mutatedPath: string | null) => string[];
  duplicates?: string[];
  isolationOff?: boolean;
}

function fakeRunner(sessionDir: string, scenario: Scenario, calls: string[], plans: RoundPlan[] = []): RunRound {
  return async (specs, tag) => {
    calls.push(`${tag}:${specs === undefined ? 'all' : specs.join(',')}`);
    const plan = readPlan(sessionDir);
    plans.push(plan);
    const tests = new Map<string, TestOutcome>();
    for (const testId of scenario.tests ?? [CHECKS, SMOKE, SHAKY]) {
      const mutation = plan.mutations[testId];
      const mutatedPath = mutation ? String(mutation.path[0]) : null;
      const state = scenario.stateFor ? scenario.stateFor(testId, tag, mutatedPath, plan) : 'passed';
      const crashes = scenario.crashesFor ? scenario.crashesFor(testId, tag, mutatedPath) : [];
      if (plan.mode === 'record' && scenario.record !== false) {
        writeRecord(sessionDir, tag, {
          testId,
          responses: [{ method: 'GET', url: 'http://localhost/api/summary', body: SUMMARY }],
          domSnapshots: [PAGE],
          crashes,
          ...(scenario.isolationOff ? { testIsolation: false } : {})
        });
      }
      if (plan.mode === 'mutate' && mutation && state !== 'skipped') {
        writeApplied(sessionDir, tag, { testId, mutantId: mutation.id, applied: true, seen: true, crashes });
      }
      const title = testId.split(' :: ')[1]?.split(' > ') ?? [];
      const outcome: TestOutcome = { testId, spec: SPEC, title, state };
      if (state === 'failed') outcome.error = 'AssertionError: expected R$ 175.984,32 to equal R$ 128.450,50';
      tests.set(testId, outcome);
    }
    const result: RoundResult = { ok: true, tests, specErrors: new Map(), duplicates: new Set(scenario.duplicates ?? []) };
    return result;
  };
}

function baseState(testId: string, tag: string, mutatedPath: string | null): TestState {
  if (testId === SHAKY && tag === 'baseline-2') return 'failed';
  if (testId === CHECKS && mutatedPath === 'revenue') return 'failed';
  return 'passed';
}

describe('runMutation', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mutants-runner-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const options = (runRound: RunRound) => ({
    version: '0.0.0-test',
    sessionDir: dir,
    specs: undefined,
    specLabels: [],
    budget: 20,
    seed: 1,
    baselines: 2,
    browser: 'electron',
    runRound,
    specPath: (relative: string) => `/project/${relative}`,
    log: () => undefined
  });

  test('records baselines, mutates per round, confirms kills and scores per test', async () => {
    const calls: string[] = [];
    const { report, rounds } = await runMutation(options(fakeRunner(dir, { stateFor: baseState }, calls)));
    assert.deepEqual(rounds, { baselines: 2, mutate: 4, confirm: 2 });
    assert.deepEqual(calls, [
      'baseline-1:all',
      'baseline-2:all',
      `mutate-1:/project/${SPEC}`,
      `mutate-2:/project/${SPEC}`,
      `mutate-3:/project/${SPEC}`,
      `mutate-4:/project/${SPEC}`,
      `confirm-1:/project/${SPEC}`,
      `confirm-2:/project/${SPEC}`
    ]);
    assert.equal(report.summary.killed, 2);
    assert.equal(report.summary.survived, 6);
    assert.equal(report.summary.score, 0.25);
    const byTest = new Map(report.breakdown.byTest.map((group) => [group.key, group]));
    assert.equal(byTest.get(CHECKS)?.killed, 2);
    assert.equal(byTest.get(CHECKS)?.survived, 2);
    assert.equal(byTest.get(SMOKE)?.survived, 4);
    assert.deepEqual(
      report.unstableTests.map((t) => t.testId),
      [SHAKY]
    );
    assert.match(report.unstableTests[0]?.reason ?? '', /passed, failed/);
    const killed = report.results.filter((r) => r.verdict === 'killed');
    assert.ok(killed.every((r) => r.mutant.pathText === '$.revenue' && r.mutant.testId === CHECKS));
    assert.match(killed[0]?.error ?? '', /AssertionError/);
  });

  test('a kill that does not reproduce on the confirm rerun is flaky', async () => {
    const stateFor = (testId: string, tag: string, mutatedPath: string | null): TestState =>
      tag === 'confirm-1' ? 'passed' : baseState(testId, tag, mutatedPath);
    const { report } = await runMutation(options(fakeRunner(dir, { stateFor }, [])));
    assert.equal(report.summary.killed, 1);
    assert.equal(report.summary.flaky, 1);
    assert.equal(report.summary.score, 1 / 7);
  });

  test('a test skipped after an earlier test failed a hook is measured again in a later round', async () => {
    const stateFor = (testId: string, _tag: string, mutatedPath: string | null, plan: RoundPlan): TestState => {
      const checksMutation = plan.mutations[CHECKS];
      const hookFails = plan.mode === 'mutate' && checksMutation !== undefined && String(checksMutation.path[0]) === 'revenue';
      if (testId === CHECKS) return hookFails ? 'failed' : 'passed';
      if (testId === SMOKE && hookFails) return 'skipped';
      if (testId === SMOKE && mutatedPath === 'orders') return 'failed';
      return 'passed';
    };
    const { report, rounds } = await runMutation(options(fakeRunner(dir, { stateFor, tests: [CHECKS, SMOKE] }, [])));
    assert.equal(report.summary.error, 0);
    assert.equal(report.summary.total, 8);
    const smoke = report.results.filter((r) => r.mutant.testId === SMOKE);
    assert.equal(smoke.length, 4);
    assert.deepEqual(smoke.map((r) => r.verdict).sort(), ['killed', 'killed', 'survived', 'survived']);
    assert.ok(rounds.mutate > 4);
    assert.equal(report.summary.killed, 4);
  });

  test('a kill is confirmed again when its confirm run was skipped because of another test', async () => {
    const stateFor = (testId: string, tag: string, mutatedPath: string | null, plan: RoundPlan): TestState => {
      const checksMutation = plan.mutations[CHECKS];
      const checksFails = checksMutation !== undefined && String(checksMutation.path[0]) === 'revenue';
      if (testId === CHECKS) return checksFails ? 'failed' : 'passed';
      if (testId === SMOKE && tag.startsWith('confirm') && checksFails) return 'skipped';
      if (testId === SMOKE && mutatedPath === 'orders') return 'failed';
      return 'passed';
    };
    const { report } = await runMutation(options(fakeRunner(dir, { stateFor, tests: [CHECKS, SMOKE] }, [])));
    assert.equal(report.summary.error, 0);
    assert.equal(report.summary.flaky, 0);
    assert.equal(report.summary.killed, 4);
  });

  test('a test skipped in every attempt is an error after an isolated attempt', async () => {
    const plans: RoundPlan[] = [];
    const stateFor = (testId: string, tag: string): TestState => (testId === SMOKE && tag.startsWith('mutate') ? 'skipped' : 'passed');
    const { report } = await runMutation(options(fakeRunner(dir, { stateFor, tests: [CHECKS, SMOKE] }, [], plans)));
    const errors = report.results.filter((r) => r.verdict === 'error');
    assert.equal(errors.length, 4);
    assert.ok(errors.every((r) => r.mutant.testId === SMOKE));
    assert.match(errors[0]?.error ?? '', /skipped in 3 attempts/);
    const mutatePlans = plans.filter((plan) => plan.mode === 'mutate');
    assert.deepEqual(Object.keys(mutatePlans[0]?.mutations ?? {}).sort(), [CHECKS, SMOKE].sort());
    assert.deepEqual(Object.keys(mutatePlans[1]?.mutations ?? {}).sort(), [CHECKS, SMOKE].sort());
    assert.deepEqual(Object.keys(mutatePlans[2]?.mutations ?? {}), [SMOKE]);
    assert.equal(report.results.filter((r) => r.mutant.testId === CHECKS && r.verdict === 'survived').length, 4);
  });

  test('a crash the user swallowed is killed-crash, but not when the baselines crashed the same way', async () => {
    const crashesFor = (testId: string, tag: string, mutatedPath: string | null): string[] => {
      if (testId === CHECKS) return ['ResizeObserver loop completed with undelivered notifications.', 'known noise'];
      if (testId === SMOKE && tag.startsWith('baseline')) return ['known noise'];
      if (testId === SMOKE && mutatedPath === 'orders') return ['known noise', 'Cannot read properties of null'];
      return [];
    };
    const stateFor = (testId: string, tag: string, mutatedPath: string | null): TestState =>
      testId === SMOKE && mutatedPath !== null ? 'failed' : baseState(testId, tag, mutatedPath);
    const { report } = await runMutation(options(fakeRunner(dir, { stateFor, crashesFor, tests: [CHECKS, SMOKE] }, [])));
    const smoke = report.results.filter((r) => r.mutant.testId === SMOKE);
    assert.deepEqual(
      smoke.map((r) => [r.mutant.pathText, r.verdict]).sort(),
      [
        ['$.orders', 'killed-crash'],
        ['$.orders', 'killed-crash'],
        ['$.revenue', 'killed'],
        ['$.revenue', 'killed']
      ]
    );
    assert.equal(report.results.filter((r) => r.mutant.testId === CHECKS && r.verdict === 'killed').length, 2);
  });

  test('a spec with testIsolation off gets one mutant per round', async () => {
    const plans: RoundPlan[] = [];
    const { report, rounds } = await runMutation(options(fakeRunner(dir, { stateFor: baseState, tests: [CHECKS, SMOKE], isolationOff: true }, [], plans)));
    assert.ok(plans.filter((plan) => plan.mode === 'mutate').every((plan) => Object.keys(plan.mutations).length === 1));
    assert.equal(rounds.mutate, 8);
    assert.equal(report.summary.total, 8);
  });

  test('killed-crash mutants are not confirmed', async () => {
    const calls: string[] = [];
    const crashesFor = (_testId: string, _tag: string, mutatedPath: string | null): string[] => (mutatedPath === 'revenue' ? ['boom'] : []);
    await runMutation(options(fakeRunner(dir, { stateFor: baseState, crashesFor }, calls)));
    assert.ok(!calls.some((call) => call.startsWith('confirm')));
  });

  test('tests with duplicate titles and tests that always fail are not mutated', async () => {
    const stateFor = (testId: string): TestState => (testId === SHAKY ? 'failed' : 'passed');
    const logs: string[] = [];
    const { report } = await runMutation({
      ...options(fakeRunner(dir, { stateFor, duplicates: [SMOKE] }, [])),
      log: (line: string) => logs.push(line)
    });
    const status = new Map(report.tests.map((t) => [t.testId, t.baseline]));
    assert.equal(status.get(SMOKE), 'duplicate');
    assert.equal(status.get(SHAKY), 'failing');
    assert.equal(status.get(CHECKS), 'stable');
    assert.ok(report.results.every((r) => r.mutant.testId === CHECKS));
    assert.equal(logs.filter((line) => line.includes('more than one test is named')).length, 1);
  });

  test('a recording that cannot be observed is an error for that test only', async () => {
    const runner = fakeRunner(dir, { stateFor: baseState }, []);
    const broken: RunRound = async (specs, tag) => {
      const result = await runner(specs, tag);
      if (tag.startsWith('baseline')) {
        writeRecord(dir, tag, { testId: SMOKE, responses: null as never, domSnapshots: [PAGE] });
      }
      return result;
    };
    const { report } = await runMutation(options(broken));
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0] ?? '', /observing .*smoke failed/);
    assert.match(report.tests.find((t) => t.testId === SMOKE)?.note ?? '', /could not be read/);
    assert.ok(report.results.some((r) => r.mutant.testId === CHECKS));
  });

  test('stops with a setup hint when passing tests send no recordings', async () => {
    await assert.rejects(runMutation(options(fakeRunner(dir, { record: false }, []))), (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.match(error.message, /e2e-mutants\/support/);
      return true;
    });
  });

  test('stops when a baseline cannot run', async () => {
    const failing: RunRound = async () => ({ ok: false, error: 'Could not find Cypress test run results' });
    await assert.rejects(runMutation(options(failing)), /baseline 1 could not run: Could not find/);
  });

  test('stops when a baseline runs no tests', async () => {
    const empty: RunRound = async () => ({ ok: true, tests: new Map(), specErrors: new Map([[SPEC, 'Error: Webpack Compilation Error']]) });
    await assert.rejects(runMutation(options(empty)), /ran no tests[\s\S]*Webpack Compilation Error/);
  });
});

describe('baselineStatus', () => {
  test('stable, failing, unstable and not-run', () => {
    assert.equal(baselineStatus(['passed', 'passed']), 'stable');
    assert.equal(baselineStatus(['failed', 'failed']), 'failing');
    assert.equal(baselineStatus(['passed', 'failed']), 'unstable');
    assert.equal(baselineStatus(['passed', 'skipped']), 'not-run');
  });
});
