import { specOfTestId } from './ids';
import { generalizePath } from './leaves';
import type { FieldObservation } from './observe';
import type { PlannedMutant } from './plan';
import type { FieldStatus, TestState, Verdict } from './types';

export const VERDICTS: readonly Verdict[] = ['survived', 'killed', 'killed-crash', 'flaky', 'not-applied', 'error'];
export const REPORT_SCHEMA_VERSION = 1;

const CRASH_PATTERN = /The following error originated from your application code|uncaught exception/i;
export const BENIGN_CRASH = /ResizeObserver loop/i;

export interface RunOutcome {
  state: TestState;
  applied: boolean;
  crashed?: boolean;
  error?: string;
  infraError?: string;
}

export interface MutantResult {
  mutant: PlannedMutant;
  spec: string;
  verdict: Verdict;
  round?: number;
  error?: string;
}

export interface ScoreSummary {
  total: number;
  killed: number;
  killedCrash: number;
  survived: number;
  notApplied: number;
  flaky: number;
  error: number;
  score: number | null;
}

export interface GroupScore extends ScoreSummary {
  key: string;
}

export interface FieldGroupScore extends GroupScore {
  shownIn: number;
  mutatedIn: number;
  killedIn: number;
}

export interface ScoreBreakdown {
  bySpec: GroupScore[];
  byTest: GroupScore[];
  byEndpoint: GroupScore[];
  byField: FieldGroupScore[];
}

export type BaselineStatus = 'stable' | 'unstable' | 'failing' | 'not-run' | 'duplicate';

export interface ReportTest {
  testId: string;
  spec: string;
  title: string;
  baseline: BaselineStatus;
  fields: FieldObservation[];
  planned: number;
  note?: string;
  fieldCounts?: Partial<Record<FieldStatus, number>>;
  omittedFields?: number;
}

export interface ReportOptions {
  specs: string[];
  budget: number;
  seed: number;
  baselines: number;
  browser: string;
  minScore?: number | null;
}

export interface ReportInput {
  version: string;
  startedAt: string;
  finishedAt: string;
  options: ReportOptions;
  tests: ReportTest[];
  results: MutantResult[];
  errors?: string[];
}

export interface UnstableTest {
  testId: string;
  spec: string;
  baseline: BaselineStatus;
  reason: string;
}

export interface E2eMutantsReport extends ReportInput {
  tool: 'e2e-mutants';
  schemaVersion: number;
  summary: ScoreSummary;
  breakdown: ScoreBreakdown;
  unstableTests: UnstableTest[];
  noObservedData: string[];
  errors: string[];
}

export function isCrashMessage(message: string | undefined | null): boolean {
  return typeof message === 'string' && CRASH_PATTERN.test(message);
}

export function hasNewCrash(crashes: readonly string[] | undefined, baseline: ReadonlySet<string> = new Set()): boolean {
  return (crashes ?? []).some((crash) => !baseline.has(crash) && !BENIGN_CRASH.test(crash));
}

export function classifyMutantRun(outcome: RunOutcome): Verdict {
  if (outcome.infraError !== undefined) return 'error';
  if (outcome.state !== 'passed' && outcome.state !== 'failed') return 'error';
  if (!outcome.applied) return 'not-applied';
  if (outcome.state === 'passed') return 'survived';
  return outcome.crashed === true || isCrashMessage(outcome.error) ? 'killed-crash' : 'killed';
}

export function confirmVerdict(first: Verdict, confirm: RunOutcome): Verdict {
  if (first !== 'killed') return first;
  const second = classifyMutantRun(confirm);
  if (second === 'killed') return 'killed';
  if (second === 'killed-crash') return 'killed-crash';
  if (second === 'survived' || second === 'not-applied') return 'flaky';
  return 'error';
}

export function computeScore(killed: number, survived: number): number | null {
  const scored = killed + survived;
  return scored === 0 ? null : killed / scored;
}

export function summarize(results: readonly Pick<MutantResult, 'verdict'>[]): ScoreSummary {
  const summary: ScoreSummary = { total: 0, killed: 0, killedCrash: 0, survived: 0, notApplied: 0, flaky: 0, error: 0, score: null };
  for (const { verdict } of results) {
    summary.total += 1;
    if (verdict === 'killed') summary.killed += 1;
    else if (verdict === 'killed-crash') summary.killedCrash += 1;
    else if (verdict === 'survived') summary.survived += 1;
    else if (verdict === 'not-applied') summary.notApplied += 1;
    else if (verdict === 'flaky') summary.flaky += 1;
    else summary.error += 1;
  }
  summary.score = computeScore(summary.killed, summary.survived);
  return summary;
}

function compareGroups(a: GroupScore, b: GroupScore): number {
  if (a.score !== b.score) {
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return a.score - b.score;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function groupScores(results: readonly MutantResult[], keyOf: (result: MutantResult) => string): GroupScore[] {
  const groups = new Map<string, MutantResult[]>();
  for (const result of results) {
    const key = keyOf(result);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [result]);
    else list.push(result);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, ...summarize(list) })).sort(compareGroups);
}

export function fieldKeyOf(mutant: Pick<PlannedMutant, 'requestKey' | 'path'>): string {
  return `${mutant.requestKey} ${generalizePath(mutant.path)}`;
}

function addTo(map: Map<string, Set<string>>, key: string, testId: string): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([testId]));
  else set.add(testId);
}

export function fieldScores(results: readonly MutantResult[], tests: readonly ReportTest[] = []): FieldGroupScore[] {
  const shown = new Map<string, Set<string>>();
  const mutated = new Map<string, Set<string>>();
  const killed = new Map<string, Set<string>>();
  for (const test of tests) {
    if (test.baseline !== 'stable') continue;
    for (const field of test.fields) if (field.status === 'observed') addTo(shown, fieldKeyOf(field), test.testId);
  }
  for (const result of results) {
    const key = fieldKeyOf(result.mutant);
    addTo(mutated, key, result.mutant.testId);
    if (result.verdict === 'killed') addTo(killed, key, result.mutant.testId);
  }
  const groups: GroupScore[] = groupScores(results, (r) => fieldKeyOf(r.mutant));
  const known = new Set(groups.map((g) => g.key));
  const unmutated = [...shown.keys()].filter((key) => !known.has(key)).sort();
  for (const key of unmutated) groups.push({ key, ...summarize([]) });
  return groups.map((g) => ({
    ...g,
    shownIn: shown.get(g.key)?.size ?? 0,
    mutatedIn: mutated.get(g.key)?.size ?? 0,
    killedIn: killed.get(g.key)?.size ?? 0
  }));
}

export function scoreBreakdown(results: readonly MutantResult[], tests: readonly ReportTest[] = []): ScoreBreakdown {
  return {
    bySpec: groupScores(results, (r) => r.spec),
    byTest: groupScores(results, (r) => r.mutant.testId),
    byEndpoint: groupScores(results, (r) => r.mutant.requestKey),
    byField: fieldScores(results, tests)
  };
}

function verdictRank(verdict: Verdict): number {
  return VERDICTS.indexOf(verdict);
}

export function sortResults(results: readonly MutantResult[]): MutantResult[] {
  return [...results].sort(
    (a, b) =>
      verdictRank(a.verdict) - verdictRank(b.verdict) ||
      (a.mutant.testId < b.mutant.testId ? -1 : a.mutant.testId > b.mutant.testId ? 1 : 0) ||
      (a.mutant.id < b.mutant.id ? -1 : a.mutant.id > b.mutant.id ? 1 : 0)
  );
}

function unstableReason(test: ReportTest): string {
  if (test.note !== undefined && test.note !== '') return test.note;
  if (test.baseline === 'not-run') return 'did not run in every baseline';
  if (test.baseline === 'failing') return 'failed in every baseline';
  if (test.baseline === 'duplicate') return 'another test in the same spec has the same title path';
  return 'did not pass in every baseline';
}

export const MAX_LISTED_FIELDS = 1000;

export function listedFields(test: ReportTest, max = MAX_LISTED_FIELDS): ReportTest {
  const others = test.fields.filter((field) => field.status !== 'observed');
  if (others.length <= max) return test;
  const counts: Partial<Record<FieldStatus, number>> = {};
  for (const field of test.fields) counts[field.status] = (counts[field.status] ?? 0) + 1;
  const kept = new Set(others.slice(0, max));
  return {
    ...test,
    fields: test.fields.filter((field) => field.status === 'observed' || kept.has(field)),
    fieldCounts: counts,
    omittedFields: others.length - max
  };
}

export function buildReport(input: ReportInput): E2eMutantsReport {
  const results = sortResults(input.results);
  return {
    tool: 'e2e-mutants',
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...input,
    tests: input.tests.map((test) => listedFields(test)),
    errors: input.errors ?? [],
    results,
    summary: summarize(results),
    breakdown: scoreBreakdown(results, input.tests),
    unstableTests: input.tests
      .filter((test) => test.baseline !== 'stable')
      .map((test) => ({ testId: test.testId, spec: test.spec || specOfTestId(test.testId), baseline: test.baseline, reason: unstableReason(test) })),
    noObservedData: input.tests
      .filter((test) => test.baseline === 'stable' && !test.fields.some((field) => field.status === 'observed'))
      .map((test) => test.testId)
  };
}

export function formatScore(score: number | null): string {
  return score === null ? 'n/a' : `${(Math.round(score * 1000) / 10).toFixed(1)}%`;
}

export function meetsMinScore(score: number | null, minScore: number): boolean {
  return score !== null && score + 1e-9 >= minScore;
}

const BASELINE_ORDER: readonly BaselineStatus[] = ['stable', 'unstable', 'failing', 'not-run', 'duplicate'];

export function formatTextSummary(report: E2eMutantsReport, maxSurvivors = 10): string {
  const s = report.summary;
  const statuses = BASELINE_ORDER.map((status) => [status, report.tests.filter((test) => test.baseline === status).length] as const)
    .filter(([status, n]) => n > 0 || status === 'stable' || status === 'unstable')
    .map(([status, n]) => `${n} ${status}`);
  const lines = [
    `e2e-mutants ${report.version}  score ${formatScore(s.score)}  (${s.killed} killed / ${s.killed + s.survived} scored)`,
    `  killed ${s.killed}  survived ${s.survived}  killed-crash ${s.killedCrash}  flaky ${s.flaky}  not-applied ${s.notApplied}  error ${s.error}`,
    `  tests ${report.tests.length}: ${statuses.join(', ')}, ${report.noObservedData.length} without observed data`
  ];
  const survivors = report.results.filter((result) => result.verdict === 'survived');
  if (survivors.length > 0) {
    lines.push('  survived:');
    for (const result of survivors.slice(0, maxSurvivors)) {
      const m = result.mutant;
      lines.push(`    ${m.testId}`);
      lines.push(`      ${m.requestKey} ${m.pathText}  ${m.operator}  ${m.before} -> ${m.after}`);
    }
    if (survivors.length > maxSurvivors) lines.push(`    … ${survivors.length - maxSurvivors} more in the report`);
  }
  for (const error of report.errors) lines.push(`  error: ${error}`);
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const counts = ['total', 'killed', 'killedCrash', 'survived', 'notApplied', 'flaky', 'error'];
  return counts.every((key) => isCount(value[key])) && (value.score === null || isCount(value.score));
}

function isMutant(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const strings = ['id', 'testId', 'requestKey', 'pathText', 'operator', 'before', 'after'];
  return strings.every((key) => typeof value[key] === 'string') && isCount(value.occurrence);
}

function isField(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.requestKey === 'string' &&
    typeof value.pathText === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.status === 'string' &&
    isCount(value.occurrence)
  );
}

function isGroup(value: unknown): boolean {
  return isRecord(value) && typeof value.key === 'string' && isSummary(value);
}

export function isE2eMutantsReport(value: unknown): value is E2eMutantsReport {
  if (!isRecord(value)) return false;
  const options = value.options;
  const breakdown = value.breakdown;
  return (
    value.tool === 'e2e-mutants' &&
    value.schemaVersion === REPORT_SCHEMA_VERSION &&
    typeof value.version === 'string' &&
    typeof value.startedAt === 'string' &&
    typeof value.finishedAt === 'string' &&
    isRecord(options) &&
    isStringArray(options.specs) &&
    Array.isArray(value.tests) &&
    value.tests.every(
      (test) =>
        isRecord(test) &&
        typeof test.testId === 'string' &&
        typeof test.baseline === 'string' &&
        Array.isArray(test.fields) &&
        test.fields.every(isField)
    ) &&
    Array.isArray(value.results) &&
    value.results.every((result) => isRecord(result) && typeof result.verdict === 'string' && isMutant(result.mutant)) &&
    isSummary(value.summary) &&
    isRecord(breakdown) &&
    ['bySpec', 'byTest', 'byEndpoint', 'byField'].every((key) => Array.isArray(breakdown[key]) && (breakdown[key] as unknown[]).every(isGroup)) &&
    Array.isArray(value.unstableTests) &&
    value.unstableTests.every((test) => isRecord(test) && typeof test.testId === 'string' && typeof test.reason === 'string') &&
    isStringArray(value.noObservedData) &&
    isStringArray(value.errors)
  );
}
