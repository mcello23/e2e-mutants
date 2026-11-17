import { specOfTestId, titleOfTestId } from './core/ids';
import { mergeBaselineObservations, observeTest, type FieldObservation } from './core/observe';
import { planMutants, type PlannedMutant } from './core/plan';
import {
  buildReport,
  classifyMutantRun,
  confirmVerdict,
  hasNewCrash,
  type BaselineStatus,
  type E2eMutantsReport,
  type MutantResult,
  type ReportTest,
  type RunOutcome
} from './core/score';
import type { Mutation, RoundPlan, TestState } from './core/types';
import { readRound, writePlan, type RoundData } from './session';

export interface TestOutcome {
  testId: string;
  spec: string;
  title: string[];
  state: TestState;
  error?: string;
}

export type RoundResult =
  | { ok: true; tests: Map<string, TestOutcome>; specErrors: Map<string, string>; duplicates?: Set<string> }
  | { ok: false; error: string };

export type RunRound = (specs: string[] | undefined, tag: string) => Promise<RoundResult>;

export interface MutationRunOptions {
  version: string;
  sessionDir: string;
  specs: string[] | undefined;
  specLabels: string[];
  budget: number;
  seed: number;
  baselines: number;
  browser: string;
  timeZones?: string[];
  minScore?: number | null;
  runRound: RunRound;
  specPath: (specRelative: string) => string;
  log: (line: string) => void;
  now?: () => number;
}

export interface MutationRunResult {
  report: E2eMutantsReport;
  rounds: { baselines: number; mutate: number; confirm: number };
}

export class RunnerError extends Error {}

export const MAX_ATTEMPTS = 3;
export const ISOLATE_AFTER = 2;

const ERROR_LIMIT = 600;

type Outcome = RunOutcome & { reason?: string };

interface Job<T> {
  item: T;
  mutant: PlannedMutant;
  attempts: number;
}

export function trimError(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const text = message.trim();
  return text.length > ERROR_LIMIT ? text.slice(0, ERROR_LIMIT - 1) + '…' : text;
}

export function toMutation(mutant: PlannedMutant): Mutation {
  return {
    id: mutant.id,
    testId: mutant.testId,
    requestKey: mutant.requestKey,
    occurrence: mutant.occurrence,
    path: mutant.path,
    pathText: mutant.pathText,
    operator: mutant.operator
  };
}

export function outcomeFor(result: RoundResult, data: RoundData, mutant: PlannedMutant, baselineCrashes?: ReadonlySet<string>): Outcome {
  if (!result.ok) return { state: 'missing', applied: false, infraError: result.error };
  const test = result.tests.get(mutant.testId);
  if (test === undefined) {
    const specError = result.specErrors.get(specOfTestId(mutant.testId));
    if (specError !== undefined) return { state: 'missing', applied: false, infraError: specError };
    return { state: 'missing', applied: false, reason: 'the test did not run in this round' };
  }
  const applied = data.applied.get(mutant.testId);
  const isApplied = applied !== undefined && applied.mutantId === mutant.id && applied.applied;
  const outcome: Outcome = { state: test.state, applied: isApplied };
  if (isApplied && hasNewCrash(applied.crashes, baselineCrashes)) outcome.crashed = true;
  if (test.error !== undefined) outcome.error = test.error;
  if (test.state !== 'passed' && test.state !== 'failed') outcome.reason = `the test was ${test.state}`;
  else if (!isApplied) outcome.reason = applied?.reason ?? 'no mutation report arrived from the test';
  return outcome;
}

export function isNotRun(result: RoundResult, outcome: Outcome): boolean {
  return result.ok && outcome.infraError === undefined && (outcome.state === 'skipped' || outcome.state === 'missing');
}

function notRunReason(outcome: Outcome, attempts: number): string {
  const what = outcome.state === 'skipped' ? 'was skipped' : 'did not run';
  return `the test ${what} in ${attempts} attempts, the last one with no other mutation in its spec (a failure in an earlier test or hook stops Cypress from running it)`;
}

function errorText(outcome: Outcome, verdict: MutantResult['verdict']): string | undefined {
  if (verdict === 'error') return trimError(outcome.infraError ?? outcome.reason ?? outcome.error);
  if (verdict === 'not-applied') return trimError(outcome.reason);
  if (verdict === 'killed' || verdict === 'killed-crash' || verdict === 'flaky') return trimError(outcome.error);
  return undefined;
}

function firstLine(text: string): string {
  return trimError(text.trim().split('\n', 1)[0]) ?? '';
}

function count(tests: Iterable<TestOutcome>, state: TestState): number {
  let n = 0;
  for (const test of tests) if (test.state === state) n += 1;
  return n;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function baselineStatus(states: TestState[]): BaselineStatus {
  if (states.every((state) => state === 'passed')) return 'stable';
  if (states.every((state) => state === 'failed')) return 'failing';
  if (states.some((state) => state === 'failed')) return 'unstable';
  return 'not-run';
}

export function pickJobs<T>(queues: ReadonlyMap<string, Job<T>[]>, serialSpecs: ReadonlySet<string> = new Set()): Job<T>[] {
  const bySpec = new Map<string, Job<T>[]>();
  for (const [testId, queue] of queues) {
    const head = queue[0];
    if (head === undefined) continue;
    const spec = specOfTestId(testId);
    const heads = bySpec.get(spec);
    if (heads === undefined) bySpec.set(spec, [head]);
    else heads.push(head);
  }
  const picked: Job<T>[] = [];
  for (const [spec, heads] of bySpec) {
    const isolated = heads.find((job) => job.attempts >= ISOLATE_AFTER) ?? (serialSpecs.has(spec) ? heads[0] : undefined);
    if (isolated !== undefined) picked.push(isolated);
    else picked.push(...heads);
  }
  return picked;
}

function tallyText(tally: Map<string, number>): string {
  return [...tally.entries()].map(([label, n]) => `${n} ${label}`).join(', ') || 'nothing settled';
}

export async function runMutation(options: MutationRunOptions): Promise<MutationRunResult> {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const errors: string[] = [];
  const baselines: Array<{ tests: Map<string, TestOutcome>; data: RoundData }> = [];
  const duplicates = new Set<string>();

  const runTagged = async (plan: RoundPlan, specs: string[] | undefined): Promise<{ result: RoundResult; data: RoundData; ms: number }> => {
    writePlan(options.sessionDir, plan);
    const started = now();
    const result = await options.runRound(specs, plan.tag);
    return { result, data: readRound(options.sessionDir, plan.tag), ms: now() - started };
  };

  for (let b = 1; b <= options.baselines; b++) {
    const tag = `baseline-${b}`;
    const { result, data, ms } = await runTagged({ mode: 'record', round: b, tag, mutations: {} }, options.specs);
    if (!result.ok) throw new RunnerError(`baseline ${b} could not run: ${result.error}`);
    if (result.tests.size === 0) {
      const specErrors = [...result.specErrors.entries()].map(([spec, error]) => `${spec}: ${trimError(error)}`);
      throw new RunnerError(['baseline ' + b + ' ran no tests.', ...specErrors].join('\n'));
    }
    const tests = [...result.tests.values()];
    options.log(
      `baseline ${b}/${options.baselines}: ${count(tests, 'passed')} passed, ${count(tests, 'failed')} failed, ${data.records.size} recorded (${seconds(ms)})`
    );
    if (count(tests, 'passed') > 0 && data.records.size === 0) {
      throw new RunnerError(
        'no recordings arrived from the passing tests. Check that the support file imports "e2e-mutants/support" and that setupNodeEvents returns the config from setupE2eMutants(on, config) (awaited, when setupNodeEvents is async).'
      );
    }
    for (const [spec, error] of result.specErrors) errors.push(`baseline ${b}, ${spec}: ${trimError(error)}`);
    for (const testId of result.duplicates ?? []) {
      if (!duplicates.has(testId)) options.log(`warning: more than one test is named "${testId}"; these tests are not mutated`);
      duplicates.add(testId);
    }
    baselines.push({ tests: result.tests, data });
  }

  const testIds: string[] = [];
  const seen = new Set<string>();
  for (const { tests } of baselines) {
    for (const testId of tests.keys()) {
      if (!seen.has(testId)) {
        seen.add(testId);
        testIds.push(testId);
      }
    }
  }

  const reportTests: ReportTest[] = [];
  const plans = new Map<string, PlannedMutant[]>();
  const baselineCrashes = new Map<string, Set<string>>();
  const serialSpecs = new Set<string>();
  for (const { data } of baselines) {
    for (const recording of data.records.values()) if (recording.testIsolation === false) serialSpecs.add(specOfTestId(recording.testId));
  }
  for (const spec of serialSpecs) options.log(`${spec} turns testIsolation off: its mutants run one at a time`);
  for (const testId of testIds) {
    const outcomes = baselines.map(({ tests }) => tests.get(testId));
    const states = outcomes.map((outcome) => outcome?.state ?? 'missing');
    const spec = outcomes.find((outcome) => outcome !== undefined)?.spec ?? specOfTestId(testId);
    const recordings = baselines.map(({ data }) => data.records.get(testId));
    let status: BaselineStatus = duplicates.has(testId) ? 'duplicate' : baselineStatus(states);
    let note: string | undefined;
    let fields: FieldObservation[] = [];
    if (status === 'stable') {
      if (recordings.some((recording) => recording === undefined)) {
        status = 'unstable';
        note = 'passed, but no recording arrived in every baseline';
      } else {
        baselineCrashes.set(testId, new Set(recordings.flatMap((recording) => recording?.crashes ?? [])));
        try {
          const observations = recordings.map((recording) => observeTest(recording!, { timeZones: options.timeZones ?? [] }));
          fields = mergeBaselineObservations(observations).fields;
        } catch (error) {
          note = `its recordings could not be read: ${firstLine(String((error as Error)?.message ?? error))}`;
          errors.push(`observing ${testId} failed: ${trimError((error as Error)?.stack ?? String(error))}`);
        }
      }
    } else if (status !== 'duplicate') {
      const error = outcomes.find((outcome) => outcome?.error !== undefined)?.error;
      note = `baseline results: ${states.join(', ')}` + (error === undefined ? '' : `; ${firstLine(error)}`);
    }
    const planned = status === 'stable' ? planMutants(testId, fields, { budget: options.budget, seed: options.seed }) : [];
    if (planned.length > 0) plans.set(testId, planned);
    const test: ReportTest = { testId, spec, title: titleOfTestId(testId), baseline: status, fields, planned: planned.length };
    if (note !== undefined) test.note = note;
    reportTests.push(test);
  }

  const totalPlanned = [...plans.values()].reduce((sum, list) => sum + list.length, 0);
  options.log(`planned ${totalPlanned} mutants for ${plans.size} of ${testIds.length} tests`);

  const runPhase = async <T>(
    phase: 'mutate' | 'confirm',
    queues: Map<string, Job<T>[]>,
    settle: (job: Job<T>, outcome: Outcome, round: number) => string,
    describe: (round: number, picked: number, specs: number, tally: string, left: number) => string
  ): Promise<number> => {
    let round = 0;
    for (;;) {
      const jobs = pickJobs(queues, serialSpecs);
      if (jobs.length === 0) return round;
      round += 1;
      const mutations = Object.fromEntries(jobs.map((job) => [job.mutant.testId, toMutation(job.mutant)]));
      const specs = [...new Set(jobs.map((job) => specOfTestId(job.mutant.testId)))];
      const { result, data, ms } = await runTagged({ mode: 'mutate', round, tag: `${phase}-${round}`, mutations }, specs.map(options.specPath));
      if (!result.ok) errors.push(`${phase === 'mutate' ? 'mutation' : 'confirm'} round ${round} could not run: ${trimError(result.error)}`);
      const tally = new Map<string, number>();
      for (const job of jobs) {
        const outcome = outcomeFor(result, data, job.mutant, baselineCrashes.get(job.mutant.testId));
        const queue = queues.get(job.mutant.testId);
        if (isNotRun(result, outcome)) {
          job.attempts += 1;
          if (job.attempts < MAX_ATTEMPTS) {
            tally.set('rescheduled', (tally.get('rescheduled') ?? 0) + 1);
            continue;
          }
          outcome.reason = notRunReason(outcome, job.attempts);
        }
        queue?.shift();
        const label = settle(job, outcome, round);
        tally.set(label, (tally.get(label) ?? 0) + 1);
      }
      const left = [...queues.values()].reduce((sum, queue) => sum + queue.length, 0);
      options.log(describe(round, jobs.length, specs.length, tallyText(tally), left) + ` (${seconds(ms)})`);
    }
  };

  const results: MutantResult[] = [];
  const killedByTest = new Map<string, Job<MutantResult>[]>();
  const mutateQueues = new Map([...plans.entries()].map(([testId, list]) => [testId, list.map((mutant) => ({ item: mutant, mutant, attempts: 0 }))]));
  const mutateRounds = await runPhase(
    'mutate',
    mutateQueues,
    (job, outcome, round) => {
      const verdict = classifyMutantRun(outcome);
      const entry: MutantResult = { mutant: job.mutant, spec: specOfTestId(job.mutant.testId), verdict, round };
      const error = errorText(outcome, verdict);
      if (error !== undefined) entry.error = error;
      results.push(entry);
      if (verdict === 'killed') {
        const list = killedByTest.get(job.mutant.testId);
        const confirmJob = { item: entry, mutant: job.mutant, attempts: 0 };
        if (list === undefined) killedByTest.set(job.mutant.testId, [confirmJob]);
        else list.push(confirmJob);
      }
      return verdict;
    },
    (round, picked, specs, tally, left) => `round ${round}: ${picked} mutants in ${specs} spec(s): ${tally}; ${left} left`
  );

  const confirmRounds = await runPhase(
    'confirm',
    killedByTest,
    (job, outcome) => {
      const entry = job.item;
      const verdict = confirmVerdict(entry.verdict, outcome);
      if (verdict === entry.verdict) return 'reproduced';
      entry.verdict = verdict;
      const error = verdict === 'error' ? trimError(outcome.infraError ?? outcome.reason) : verdict === 'killed-crash' ? trimError(outcome.error) : entry.error;
      if (error !== undefined) entry.error = error;
      return verdict === 'flaky' ? 'not reproduced (flaky)' : verdict;
    },
    (round, picked, specs, tally, left) => `confirm ${round}: ${picked} kills in ${specs} spec(s): ${tally}; ${left} left`
  );

  const report = buildReport({
    version: options.version,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    options: {
      specs: options.specLabels,
      budget: options.budget,
      seed: options.seed,
      baselines: options.baselines,
      browser: options.browser,
      minScore: options.minScore ?? null
    },
    tests: reportTests,
    results,
    errors
  });
  return { report, rounds: { baselines: options.baselines, mutate: mutateRounds, confirm: confirmRounds } };
}
