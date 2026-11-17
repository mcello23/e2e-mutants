import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mutantIdFor } from '../src/core/ids';
import type { FieldObservation } from '../src/core/observe';
import { mulberry32, mutationCandidates, planMutants, type PlannedMutant } from '../src/core/plan';

const testId = 'cypress/e2e/weak.cy.js :: orders > lists orders';

function leaf(path: (string | number)[], value: string | number, status: FieldObservation['status'] = 'observed'): FieldObservation {
  const pathText = '$' + path.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('');
  const kind = typeof value === 'number' ? 'number' : /^\d{4}-\d{2}-\d{2}/.test(value) ? 'date' : 'string';
  return {
    id: `GET /api/orders #0 ${pathText}`,
    requestKey: 'GET /api/orders',
    occurrence: 0,
    path,
    pathText,
    kind,
    status,
    value,
    ...(status === 'observed' ? { evidence: { before: '', match: String(value), after: '' } } : {})
  };
}

const fields: FieldObservation[] = [
  {
    id: 'GET /api/orders #0 $',
    requestKey: 'GET /api/orders',
    occurrence: 0,
    path: [],
    pathText: '$',
    kind: 'array',
    status: 'observed',
    length: 3
  },
  leaf([0, 'id'], 'ORD-1001'),
  leaf([0, 'customer'], 'Ana Souza'),
  leaf([0, 'total'], 1450),
  leaf([0, 'createdAt'], '2026-11-10'),
  leaf([1, 'id'], 'ORD-1002'),
  leaf([1, 'customer'], 'José Silva'),
  leaf([1, 'total'], 289.9),
  leaf([2, 'customer'], 'Carla Dias'),
  leaf([2, 'status'], 'pending', 'unobserved'),
  leaf([2, 'priority'], 3, 'trivial')
];

function keys(plan: PlannedMutant[]): string[] {
  return plan.map((m) => `${m.pathText} ${m.operator}`);
}

describe('mulberry32', () => {
  test('is deterministic and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => a());
    assert.deepEqual(values.slice(0, 5), Array.from({ length: 5 }, () => b()));
    assert.ok(values.every((v) => v >= 0 && v < 1));
    assert.notDeepEqual(values.slice(0, 5), Array.from({ length: 5 }, mulberry32(43)));
  });
});

describe('mutationCandidates', () => {
  const candidates = mutationCandidates(testId, fields);

  test('expands only observed fields into their operators, sorted by id', () => {
    assert.equal(candidates.length, 2 + 3 + 3 + 2 + 2 + 3 + 3 + 2 + 3);
    assert.ok(candidates.every((c) => !c.pathText.endsWith('status') && !c.pathText.endsWith('priority')));
    const ids = candidates.map((c) => c.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(new Set(ids).size, ids.length);
  });

  test('ids follow mutantIdFor(testId, request key, occurrence, path, operator)', () => {
    const total = candidates.find((c) => c.pathText === '$[0].total' && c.operator === 'num-shift');
    assert.equal(total?.id, mutantIdFor(testId, 'GET /api/orders', 0, '$[0].total', 'num-shift'));
  });

  test('carries before/after previews and evidence', () => {
    const total = candidates.find((c) => c.pathText === '$[0].total' && c.operator === 'num-shift');
    assert.equal(total?.before, '1450');
    assert.equal(total?.after, '1987');
    assert.equal(total?.evidence?.match, '1450');
    const list = candidates.find((c) => c.pathText === '$' && c.operator === 'array-drop-first');
    assert.equal(list?.before, '[3 items]');
    assert.equal(list?.after, '[2 items]');
  });
});

describe('planMutants', () => {
  test('same seed, same plan', () => {
    assert.deepEqual(planMutants(testId, fields, { budget: 20, seed: 1 }), planMutants(testId, fields, { budget: 20, seed: 1 }));
  });

  test('different seed, different order', () => {
    assert.notDeepEqual(keys(planMutants(testId, fields, { budget: 20, seed: 1 })), keys(planMutants(testId, fields, { budget: 20, seed: 2 })));
    const allOne = keys(planMutants(testId, fields, { budget: 100, seed: 1 }));
    const allTwo = keys(planMutants(testId, fields, { budget: 100, seed: 2 }));
    assert.notDeepEqual(allOne, allTwo);
    assert.deepEqual([...allOne].sort(), [...allTwo].sort());
  });

  test('does not depend on the input order of fields', () => {
    const shuffled = [...fields].reverse();
    assert.deepEqual(planMutants(testId, shuffled, { budget: 7, seed: 9 }), planMutants(testId, fields, { budget: 7, seed: 9 }));
  });

  test('every observed field gets one mutant before any field gets a second', () => {
    const observedCount = fields.filter((f) => f.status === 'observed').length;
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = planMutants(testId, fields, { budget: 13, seed });
      const firstStratum = plan.slice(0, observedCount).map((m) => m.fieldId);
      assert.equal(new Set(firstStratum).size, observedCount, `seed ${seed}`);
      const rest = plan.slice(observedCount).map((m) => m.fieldId);
      assert.equal(new Set(rest).size, rest.length, `seed ${seed}`);
    }
  });

  test('never repeats a (field, operator) pair and stops at the budget', () => {
    const plan = planMutants(testId, fields, { budget: 100, seed: 3 });
    assert.equal(plan.length, mutationCandidates(testId, fields).length);
    assert.equal(new Set(plan.map((m) => m.id)).size, plan.length);
    assert.equal(planMutants(testId, fields, { budget: 4, seed: 3 }).length, 4);
    assert.deepEqual(planMutants(testId, fields, { budget: 0, seed: 3 }), []);
    assert.deepEqual(planMutants(testId, [], { budget: 10, seed: 3 }), []);
  });

  test('operators rotate across fields of the same kind', () => {
    const many: FieldObservation[] = Array.from({ length: 9 }, (_, i) => leaf([i, 'customer'], `Customer Name ${i}`));
    for (const seed of [1, 2, 3]) {
      const firstPicks = planMutants(testId, many, { budget: 9, seed }).map((m) => m.operator);
      assert.deepEqual(
        [...new Set(firstPicks)].sort(),
        ['set-null', 'str-empty', 'str-reverse'],
        `seed ${seed}: ${firstPicks.join(',')}`
      );
      const counts = new Map<string, number>();
      for (const op of firstPicks) counts.set(op, (counts.get(op) ?? 0) + 1);
      assert.deepEqual([...counts.values()], [3, 3, 3]);
    }
  });
});
