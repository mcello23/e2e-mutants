import type { FieldObservation } from '../src/core/observe';
import type { PlannedMutant } from '../src/core/plan';
import type { MutantResult, ReportInput, ReportTest } from '../src/core/score';
import type { OperatorName, Verdict } from '../src/core/types';

export const HOSTILE = '<img src=x onerror=alert(1)>';

let sequence = 0;

export function mutant(overrides: Partial<PlannedMutant> = {}): PlannedMutant {
  sequence += 1;
  return {
    id: 'm' + String(sequence).padStart(5, '0'),
    testId: 'cypress/e2e/weak.cy.js :: dashboard > shows revenue',
    requestKey: 'GET /api/summary',
    occurrence: 0,
    path: ['revenue'],
    pathText: '$.revenue',
    operator: 'num-shift' as OperatorName,
    fieldId: 'GET /api/summary #0 $.revenue',
    kind: 'number',
    before: '128450.5',
    after: '175984.32',
    evidence: { before: 'Receita ', match: 'R$ 128.450,50', after: ' hoje' },
    ...overrides
  };
}

export function result(verdict: Verdict, overrides: Partial<PlannedMutant> = {}, extra: Partial<MutantResult> = {}): MutantResult {
  const m = mutant(overrides);
  return { mutant: m, spec: m.testId.split(' :: ')[0] ?? '', verdict, ...extra };
}

export function observed(pathText: string, value: string | number): FieldObservation {
  return {
    id: `GET /api/orders #0 ${pathText}`,
    requestKey: 'GET /api/orders',
    occurrence: 0,
    path: [0, 'customer'],
    pathText,
    kind: typeof value === 'number' ? 'number' : 'string',
    status: 'observed',
    value,
    evidence: { before: '', match: String(value), after: '' }
  };
}

export function reportTest(testId: string, overrides: Partial<ReportTest> = {}): ReportTest {
  return {
    testId,
    spec: testId.split(' :: ')[0] ?? '',
    title: testId.split(' :: ')[1] ?? testId,
    baseline: 'stable',
    fields: [observed('$[0].customer', 'Ana Souza')],
    planned: 1,
    ...overrides
  };
}

export function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    version: '0.1.0',
    startedAt: '2026-11-17T21:00:00.000Z',
    finishedAt: '2026-11-17T21:04:00.000Z',
    options: { specs: ['cypress/e2e/weak.cy.js'], budget: 20, seed: 1, baselines: 2, browser: 'electron' },
    tests: [],
    results: [],
    ...overrides
  };
}
