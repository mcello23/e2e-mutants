import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  classifyMutantRun,
  computeScore,
  confirmVerdict,
  fieldKeyOf,
  fieldScores,
  formatScore,
  formatTextSummary,
  groupScores,
  hasNewCrash,
  isCrashMessage,
  isE2eMutantsReport,
  meetsMinScore,
  scoreBreakdown,
  summarize
} from '../src/core/score';
import { observed, reportInput, reportTest, result } from './fixtures';

const CRASH = 'TypeError: Cannot read properties of null\n\nThe following error originated from your application code, not from Cypress.';

describe('classifyMutantRun', () => {
  test('passed with the mutation applied is survived', () => {
    assert.equal(classifyMutantRun({ state: 'passed', applied: true }), 'survived');
  });

  test('failed with the mutation applied is killed', () => {
    assert.equal(classifyMutantRun({ state: 'failed', applied: true, error: 'expected 1 to equal 2' }), 'killed');
  });

  test('an uncaught application exception is killed-crash', () => {
    assert.equal(classifyMutantRun({ state: 'failed', applied: true, error: CRASH }), 'killed-crash');
    assert.equal(classifyMutantRun({ state: 'failed', applied: true, error: 'Uncaught exception: boom' }), 'killed-crash');
  });

  test('the target response never arrived: not-applied, whatever the outcome', () => {
    assert.equal(classifyMutantRun({ state: 'passed', applied: false }), 'not-applied');
    assert.equal(classifyMutantRun({ state: 'failed', applied: false, error: 'x' }), 'not-applied');
  });

  test('runner problems are errors', () => {
    assert.equal(classifyMutantRun({ state: 'missing', applied: false }), 'error');
    assert.equal(classifyMutantRun({ state: 'skipped', applied: true }), 'error');
    assert.equal(classifyMutantRun({ state: 'passed', applied: true, infraError: 'Cypress crashed' }), 'error');
  });

  test('a crash recorded by the support file is killed-crash even when the user swallowed it', () => {
    const timeout = 'AssertionError: Timed out retrying after 4000ms: Expected to find element: `[data-cy=order-row]`, but never found it.';
    assert.equal(classifyMutantRun({ state: 'failed', applied: true, crashed: true, error: timeout }), 'killed-crash');
    assert.equal(classifyMutantRun({ state: 'passed', applied: true, crashed: true }), 'survived');
  });

  test('hasNewCrash ignores crashes the baselines already had and ResizeObserver noise', () => {
    assert.equal(hasNewCrash(['Cannot read properties of null'], new Set()), true);
    assert.equal(hasNewCrash(['Cannot read properties of null'], new Set(['Cannot read properties of null'])), false);
    assert.equal(hasNewCrash(['ResizeObserver loop completed with undelivered notifications.'], new Set()), false);
    assert.equal(hasNewCrash(undefined), false);
  });

  test('isCrashMessage', () => {
    assert.equal(isCrashMessage(CRASH), true);
    assert.equal(isCrashMessage('AssertionError: expected'), false);
    assert.equal(isCrashMessage(undefined), false);
  });
});

describe('confirmVerdict', () => {
  test('a kill reproduced on the confirm rerun stays killed', () => {
    assert.equal(confirmVerdict('killed', { state: 'failed', applied: true, error: 'x' }), 'killed');
    assert.equal(confirmVerdict('killed-crash', { state: 'failed', applied: true, error: CRASH }), 'killed-crash');
  });

  test('a kill that passes on the confirm rerun is flaky', () => {
    assert.equal(confirmVerdict('killed', { state: 'passed', applied: true }), 'flaky');
    assert.equal(confirmVerdict('killed', { state: 'failed', applied: false }), 'flaky');
  });

  test('a confirm rerun that breaks is an error', () => {
    assert.equal(confirmVerdict('killed', { state: 'missing', applied: false }), 'error');
  });

  test('a kill that crashes the app on the confirm rerun leaves the score', () => {
    assert.equal(confirmVerdict('killed', { state: 'failed', applied: true, crashed: true, error: 'x' }), 'killed-crash');
  });

  test('killed-crash is final and is not confirmed', () => {
    assert.equal(confirmVerdict('killed-crash', { state: 'passed', applied: true }), 'killed-crash');
  });

  test('verdicts other than killed are not changed', () => {
    assert.equal(confirmVerdict('survived', { state: 'failed', applied: true }), 'survived');
    assert.equal(confirmVerdict('not-applied', { state: 'failed', applied: true }), 'not-applied');
  });
});

describe('score', () => {
  test('killed / (killed + survived); crash, flaky, not-applied and error are excluded', () => {
    const results = [
      result('killed'),
      result('killed'),
      result('killed'),
      result('survived'),
      result('killed-crash'),
      result('killed-crash'),
      result('flaky'),
      result('not-applied'),
      result('error')
    ];
    const summary = summarize(results);
    assert.deepEqual(summary, {
      total: 9,
      killed: 3,
      killedCrash: 2,
      survived: 1,
      notApplied: 1,
      flaky: 1,
      error: 1,
      score: 0.75
    });
  });

  test('no scored mutants means no score', () => {
    assert.equal(summarize([result('killed-crash'), result('not-applied')]).score, null);
    assert.equal(computeScore(0, 0), null);
    assert.equal(formatScore(null), 'n/a');
    assert.equal(formatScore(2 / 3), '66.7%');
    assert.equal(formatScore(1), '100.0%');
  });

  test('meetsMinScore', () => {
    assert.equal(meetsMinScore(0.75, 0.75), true);
    assert.equal(meetsMinScore(0.7, 0.75), false);
    assert.equal(meetsMinScore(null, 0), false);
  });
});

describe('aggregation', () => {
  const weak = 'cypress/e2e/weak.cy.js :: orders > lists orders';
  const strong = 'cypress/e2e/strong.cy.js :: orders > lists orders';
  const results = [
    result('survived', { testId: weak, requestKey: 'GET /api/orders', path: [0, 'total'], pathText: '$[0].total' }),
    result('survived', { testId: weak, requestKey: 'GET /api/orders', path: [3, 'total'], pathText: '$[3].total' }),
    result('killed', { testId: strong, requestKey: 'GET /api/orders', path: [1, 'total'], pathText: '$[1].total' }),
    result('killed', { testId: strong, requestKey: 'GET /api/summary', path: ['revenue'], pathText: '$.revenue' }),
    result('killed-crash', { testId: strong, requestKey: 'GET /api/summary', path: ['revenue'], pathText: '$.revenue' })
  ];

  test('per spec, test, endpoint and field (array indexes generalized)', () => {
    const breakdown = scoreBreakdown(results);
    assert.deepEqual(
      breakdown.bySpec.map((g) => [g.key, g.score]),
      [
        ['cypress/e2e/weak.cy.js', 0],
        ['cypress/e2e/strong.cy.js', 1]
      ]
    );
    assert.deepEqual(
      breakdown.byTest.map((g) => g.key),
      [weak, strong]
    );
    const orders = breakdown.byEndpoint.find((g) => g.key === 'GET /api/orders');
    assert.equal(orders?.score, 1 / 3);
    const summaryEndpoint = breakdown.byEndpoint.find((g) => g.key === 'GET /api/summary');
    assert.equal(summaryEndpoint?.killedCrash, 1);
    assert.equal(summaryEndpoint?.score, 1);
    assert.deepEqual(
      breakdown.byField.map((g) => [g.key, g.total]),
      [
        ['GET /api/orders $[*].total', 3],
        ['GET /api/summary $.revenue', 2]
      ]
    );
  });

  test('groups are sorted worst score first, then by key, unscored last', () => {
    const groups = groupScores([result('killed', { testId: 'b :: x' }), result('not-applied', { testId: 'a :: x' }), result('survived', { testId: 'c :: x' })], (r) => r.mutant.testId);
    assert.deepEqual(
      groups.map((g) => g.key),
      ['c :: x', 'b :: x', 'a :: x']
    );
  });

  test('fieldScores counts the tests that showed, mutated and killed each field', () => {
    const a = 'cypress/e2e/s.cy.js :: a';
    const b = 'cypress/e2e/s.cy.js :: b';
    const c = 'cypress/e2e/s.cy.js :: c';
    const revenue = { ...observed('$.revenue', 128450.5), requestKey: 'GET /api/summary', path: ['revenue'], id: 'GET /api/summary #0 $.revenue' };
    const orders = { ...observed('$.orders', 312), requestKey: 'GET /api/summary', path: ['orders'], id: 'GET /api/summary #0 $.orders' };
    const tests = [
      reportTest(a, { fields: [revenue, orders] }),
      reportTest(b, { fields: [revenue, orders] }),
      reportTest(c, { fields: [revenue], baseline: 'unstable' })
    ];
    const groups = fieldScores(
      [
        result('survived', { testId: a, requestKey: 'GET /api/summary', path: ['revenue'] }),
        result('killed', { testId: b, requestKey: 'GET /api/summary', path: ['revenue'] }),
        result('survived', { testId: b, requestKey: 'GET /api/summary', path: ['revenue'] })
      ],
      tests
    );
    const byKey = new Map(groups.map((g) => [g.key, g]));
    assert.deepEqual(
      [byKey.get('GET /api/summary $.revenue')?.shownIn, byKey.get('GET /api/summary $.revenue')?.mutatedIn, byKey.get('GET /api/summary $.revenue')?.killedIn],
      [2, 2, 1]
    );
    const unmutated = byKey.get('GET /api/summary $.orders');
    assert.deepEqual([unmutated?.shownIn, unmutated?.mutatedIn, unmutated?.total, unmutated?.score], [2, 0, 0, null]);
    assert.equal(groups[groups.length - 1]?.key, 'GET /api/summary $.orders');
  });

  test('fieldKeyOf', () => {
    assert.equal(fieldKeyOf({ requestKey: 'GET /api/orders', path: [2, 'items', 0, 'price'] }), 'GET /api/orders $[*].items[*].price');
  });
});

describe('buildReport', () => {
  const stable = 'cypress/e2e/weak.cy.js :: dashboard > shows revenue';
  const unstable = 'cypress/e2e/weak.cy.js :: dashboard > flaky widget';
  const empty = 'cypress/e2e/weak.cy.js :: dashboard > static page';
  const report = buildReport(
    reportInput({
      tests: [
        reportTest(stable),
        reportTest(unstable, { baseline: 'unstable', note: 'failed in baseline 2 of 2' }),
        reportTest(empty, { fields: [] }),
        reportTest('cypress/e2e/weak.cy.js :: x > y', { baseline: 'not-run' })
      ],
      results: [result('killed', { testId: stable }), result('survived', { testId: stable }), result('flaky', { testId: stable })]
    })
  );

  test('has the tool marker, summary and breakdown', () => {
    assert.equal(report.tool, 'e2e-mutants');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.summary.score, 0.5);
    assert.equal(report.breakdown.byTest.length, 1);
    assert.deepEqual(report.errors, []);
    assert.equal(isE2eMutantsReport(report), true);
    assert.equal(isE2eMutantsReport(JSON.parse(JSON.stringify(report))), true);
    assert.equal(isE2eMutantsReport({ tool: 'other' }), false);
    assert.equal(isE2eMutantsReport(null), false);
  });

  test('isE2eMutantsReport rejects partial or crafted files', () => {
    const copy = (): Record<string, any> => JSON.parse(JSON.stringify(report));
    assert.equal(isE2eMutantsReport({ tool: 'e2e-mutants', schemaVersion: 1, tests: [{}], results: [], summary: {} }), false);
    const badCount = copy();
    badCount.summary.survived = '<h1>INJECTED</h1>';
    assert.equal(isE2eMutantsReport(badCount), false);
    const badField = copy();
    badField.tests[0].fields[0].occurrence = '0"><script>';
    assert.equal(isE2eMutantsReport(badField), false);
    const noBreakdown = copy();
    delete noBreakdown.breakdown;
    assert.equal(isE2eMutantsReport(noBreakdown), false);
  });

  test('lists survived results first', () => {
    assert.deepEqual(
      report.results.map((r) => r.verdict),
      ['survived', 'killed', 'flaky']
    );
  });

  test('a test with a huge response lists its observed fields and the first 1000 others', () => {
    const fields = [observed('$[0].customer', 'Ana Souza')];
    for (let i = 0; i < 1500; i++) fields.push({ ...observed(`$[${i}].note`, 'n'), id: `n${i}`, status: 'unobserved' });
    const big = buildReport(reportInput({ tests: [reportTest('cypress/e2e/a.cy.js :: big', { fields })] }));
    const test = big.tests[0];
    assert.equal(test?.fields.length, 1001);
    assert.equal(test?.omittedFields, 500);
    assert.deepEqual(test?.fieldCounts, { observed: 1, unobserved: 1500 });
    assert.equal(test?.fields.filter((f) => f.status === 'observed').length, 1);
  });

  test('failing and duplicate tests get their own reasons', () => {
    const other = buildReport(
      reportInput({
        tests: [
          reportTest('cypress/e2e/a.cy.js :: always red', { baseline: 'failing' }),
          reportTest('cypress/e2e/a.cy.js :: twin', { baseline: 'duplicate' })
        ]
      })
    );
    assert.deepEqual(
      other.unstableTests.map((t) => t.reason),
      ['failed in every baseline', 'another test in the same spec has the same title path']
    );
    assert.match(formatTextSummary(other), /tests 2: 0 stable, 0 unstable, 1 failing, 1 duplicate/);
  });

  test('lists unstable tests and tests with no observed data', () => {
    assert.deepEqual(
      report.unstableTests.map((t) => [t.testId, t.reason]),
      [
        [unstable, 'failed in baseline 2 of 2'],
        ['cypress/e2e/weak.cy.js :: x > y', 'did not run in every baseline']
      ]
    );
    assert.deepEqual(report.noObservedData, [empty]);
  });

  test('formatTextSummary is compact and names survivors', () => {
    const text = formatTextSummary(report);
    assert.match(text, /score 50\.0%/);
    assert.match(text, /survived 1/);
    assert.match(text, /GET \/api\/summary \$\.revenue {2}num-shift {2}128450\.5 -> 175984\.32/);
    assert.match(text, /tests 4: 2 stable, 1 unstable, 1 not-run, 1 without observed data/);
    assert.ok(text.split('\n').length < 12);
  });
});
