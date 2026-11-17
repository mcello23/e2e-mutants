import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMutation,
  applyMutationInPlace,
  applyOperator,
  decimalsOf,
  operatorsFor,
  reverseString,
  roundTo,
  shiftNumber,
  shiftNumericString
} from '../src/core/operators';
import { foldCase, normalizeText } from '../src/core/text';
import type { OperatorName } from '../src/core/types';

const amountFormats: Array<(v: number) => string> = [
  (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v),
  (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v),
  (v) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(v),
  (v) => new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 }).format(v),
  (v) => new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2 }).format(v)
];
const integerFormat = (v: number): string => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(v);

function formatsFor(value: number): Array<(v: number) => string> {
  return value > 0 && value <= 1 ? amountFormats : [...amountFormats, integerFormat];
}

function mutated(operator: OperatorName, value: unknown): unknown {
  const result = applyOperator(operator, value);
  assert.ok(result.ok, `${operator} should apply to ${JSON.stringify(value)}`);
  return result.value;
}

describe('decimalsOf and roundTo', () => {
  test('counts decimals including exponent notation', () => {
    assert.equal(decimalsOf(1450), 0);
    assert.equal(decimalsOf(1450.5), 1);
    assert.equal(decimalsOf(0.0425), 4);
    assert.equal(decimalsOf(1e-7), 7);
    assert.equal(decimalsOf(1.5e-7), 8);
  });

  test('roundTo', () => {
    assert.equal(roundTo(1994.315, 2), 1994.32);
    assert.equal(roundTo(0.4125, 2), 0.41);
  });
});

describe('num-shift', () => {
  test('integers move by max(7, 37%)', () => {
    assert.equal(shiftNumber(312), 312 + 115);
    assert.equal(shiftNumber(12), 19);
    assert.equal(shiftNumber(1450), 1450 + 537);
    assert.equal(shiftNumber(-40), -40 + 15);
  });

  test('floats become v*1.37 + 7.13 at the original decimals, at least two', () => {
    assert.equal(shiftNumber(128450.5), roundTo(128450.5 * 1.37 + 7.13, 2));
    assert.ok(decimalsOf(shiftNumber(128450.5)) <= 2);
    assert.equal(shiftNumber(289.9), roundTo(289.9 * 1.37 + 7.13, 2));
    assert.equal(shiftNumber(1.23456), roundTo(1.23456 * 1.37 + 7.13, 5));
  });

  test('ratios between 0 and 1 move by 0.37 and stay ratios', () => {
    assert.equal(shiftNumber(0.0425), 0.41);
    assert.equal(shiftNumber(0.75), 0.38);
    assert.equal(shiftNumber(0.5), 0.13);
  });

  test('the shift never rounds back to the original', () => {
    assert.notEqual(roundTo(shiftNumber(-19.27), 2), -19.27);
  });

  test('numeric strings keep their type and decimals', () => {
    assert.equal(shiftNumericString('1450.00'), '1993.63');
    assert.equal(shiftNumericString('1450'), '1987');
    assert.equal(shiftNumericString('0.0425'), '0.4100');
    assert.equal(shiftNumericString('289.9'), (289.9 * 1.37 + 7.13).toFixed(1));
    assert.equal(shiftNumericString('00123'), '00169');
    assert.equal(typeof mutated('num-shift', '1450.00'), 'string');
    assert.match(String(mutated('num-shift', '-12.50')), /^-?\d+\.\d{2}$/);
  });

  test('differs under common number formats (ratios skip whole-number display)', () => {
    for (const value of [128450.5, 1450, 312, 289.9, 0.0425, 0.75, 12, 99.99, 1e6]) {
      const next = mutated('num-shift', value) as number;
      for (const format of formatsFor(value)) {
        assert.notEqual(format(next), format(value), `${value} -> ${next} looks the same as ${format(value)}`);
      }
    }
  });
});

describe('string operators', () => {
  test('str-reverse reverses by code point', () => {
    assert.equal(reverseString('Ana Souza'), 'azuoS anA');
    assert.equal(reverseString('ab\u{1F600}'), '\u{1F600}ba');
    assert.equal(reverseString('ORD-1001'), '1001-DRO');
  });

  test('str-reverse appends "zq" when the reverse looks the same', () => {
    assert.equal(reverseString('Ana'), 'anAzq');
    assert.equal(reverseString('radar'), 'radarzq');
  });

  test('str-reverse output differs from the original after case folding', () => {
    for (const value of ['Ana', 'Otto', 'Ana Souza', 'paid', 'José Silva', 'ORD-1001', 'Level']) {
      const next = mutated('str-reverse', value) as string;
      assert.notEqual(foldCase(normalizeText(next)), foldCase(normalizeText(value)), value);
    }
  });

  test('str-empty and set-null', () => {
    assert.equal(mutated('str-empty', 'paid'), '');
    assert.equal(mutated('set-null', 'paid'), null);
    assert.equal(mutated('set-null', 1450), null);
    assert.equal(applyOperator('str-empty', '').ok, false);
    assert.equal(applyOperator('set-null', null).ok, false);
    assert.equal(applyOperator('str-reverse', 12).ok, false);
  });
});

describe('date-shift', () => {
  test('moves the date three days and keeps the format', () => {
    assert.equal(mutated('date-shift', '2026-11-10'), '2026-11-13');
    assert.equal(mutated('date-shift', '2026-11-12T09:30:00Z'), '2026-11-15T09:30:00Z');
    assert.equal(applyOperator('date-shift', 'soon').ok, false);
  });

  test('differs under pt-BR and en-US date formats', () => {
    for (const value of ['2026-11-10', '2026-11-12T09:30:00Z', '2026-12-30']) {
      const next = mutated('date-shift', value) as string;
      for (const locale of ['pt-BR', 'en-US', 'en-GB']) {
        const format = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' });
        assert.notEqual(format.format(new Date(next)), format.format(new Date(value)));
      }
    }
  });
});

describe('array operators', () => {
  test('drop-first and empty', () => {
    assert.deepEqual(mutated('array-drop-first', [1, 2, 3]), [2, 3]);
    assert.deepEqual(mutated('array-empty', [1, 2, 3]), []);
    assert.equal(applyOperator('array-empty', []).ok, false);
    assert.equal(applyOperator('array-drop-first', 'x').ok, false);
  });
});

describe('operatorsFor', () => {
  test('per kind', () => {
    assert.deepEqual(operatorsFor({ kind: 'number', status: 'observed', value: 1450 }), ['num-shift', 'set-null']);
    assert.deepEqual(operatorsFor({ kind: 'string', status: 'observed', value: '1450.00' }), ['num-shift', 'set-null']);
    assert.deepEqual(operatorsFor({ kind: 'string', status: 'observed', value: 'Ana' }), ['str-reverse', 'str-empty', 'set-null']);
    assert.deepEqual(operatorsFor({ kind: 'date', status: 'observed', value: '2026-11-10' }), ['date-shift', 'set-null']);
    assert.deepEqual(operatorsFor({ kind: 'array', status: 'observed', length: 5 }), ['array-drop-first', 'array-empty']);
    assert.deepEqual(operatorsFor({ kind: 'array', status: 'observed', length: 1 }), ['array-empty']);
    assert.deepEqual(operatorsFor({ kind: 'boolean', status: 'observed', value: true }), []);
  });

  test('only observed fields get operators', () => {
    for (const status of ['unobserved', 'trivial', 'sensitive'] as const) {
      assert.deepEqual(operatorsFor({ kind: 'number', status, value: 1450 }), []);
    }
  });
});

describe('applyMutation', () => {
  const orders = [
    { id: 'ORD-1001', total: 1450, items: [{ sku: 'A' }, { sku: 'B' }] },
    { id: 'ORD-1002', total: 289.9, items: [] }
  ];

  test('mutates a nested leaf without touching the original body', () => {
    const result = applyMutation(orders, { path: [0, 'total'], operator: 'num-shift' });
    assert.equal(result.applied, true);
    assert.equal((result.body as typeof orders)[0]?.total, 1987);
    assert.equal(orders[0]?.total, 1450);
    assert.equal(result.before, '1450');
    assert.equal(result.after, '1987');
  });

  test('array operators on the root array', () => {
    assert.deepEqual(
      (applyMutation(orders, { path: [], operator: 'array-drop-first' }).body as typeof orders).map((o) => o.id),
      ['ORD-1002']
    );
    const emptied = applyMutation(orders, { path: [], operator: 'array-empty' });
    assert.deepEqual(emptied.body, []);
    assert.equal(emptied.before, '[2 items]');
    assert.equal(emptied.after, '[0 items]');
  });

  test('reports a missing path or a type mismatch as not applied', () => {
    const missing = applyMutation(orders, { path: [5, 'total'], operator: 'num-shift' });
    assert.equal(missing.applied, false);
    assert.equal(missing.body, orders);
    assert.match(missing.reason ?? '', /not found/);
    const mismatch = applyMutation(orders, { path: [0, 'id'], operator: 'num-shift' });
    assert.equal(mismatch.applied, false);
    assert.match(mismatch.reason ?? '', /not numeric/);
  });

  test('works on JSON parsed from a string body', () => {
    const body = JSON.parse('{"summary":{"revenue":128450.5}}') as unknown;
    const result = applyMutation(body, { path: ['summary', 'revenue'], operator: 'set-null' });
    assert.equal(JSON.stringify(result.body), '{"summary":{"revenue":null}}');
  });
});

function mergeLikeCypress(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const from = source[key];
    const to = target[key];
    if (from === undefined) continue;
    if (typeof from === 'object' && from !== null && typeof to === 'object' && to !== null) {
      if (from !== to) mergeLikeCypress(to as Record<string, unknown>, from as Record<string, unknown>);
    } else {
      target[key] = from;
    }
  }
}

describe('applyMutationInPlace', () => {
  const fresh = () => [
    { id: 'ORD-1001', total: 1450, items: [{ sku: 'A' }, { sku: 'B' }] },
    { id: 'ORD-1002', total: 289.9, items: [] as Array<{ sku: string }> }
  ];

  test('changes the parsed body itself and returns the same reference', () => {
    const body = fresh();
    const result = applyMutationInPlace(body, { path: [0, 'total'], operator: 'num-shift' });
    assert.equal(result.applied, true);
    assert.equal(result.body, body);
    assert.equal(body[0]?.total, 1987);
    assert.equal(result.before, '1450');
    assert.equal(result.after, '1987');
  });

  test('root array operators splice the same array', () => {
    const body = fresh();
    const dropped = applyMutationInPlace(body, { path: [], operator: 'array-drop-first' });
    assert.equal(dropped.body, body);
    assert.deepEqual(body.map((o) => o.id), ['ORD-1002']);
    const emptied = applyMutationInPlace(body, { path: [], operator: 'array-empty' });
    assert.equal(emptied.body, body);
    assert.equal(body.length, 0);
    assert.equal(emptied.after, '[0 items]');
  });

  test('nested array operators replace the array on its parent', () => {
    const body = fresh();
    applyMutationInPlace(body, { path: [0, 'items'], operator: 'array-drop-first' });
    assert.deepEqual(body[0]?.items, [{ sku: 'B' }]);
  });

  test('a primitive root body comes back as the new value', () => {
    const result = applyMutationInPlace(1450, { path: [], operator: 'num-shift' });
    assert.equal(result.applied, true);
    assert.equal(result.body, 1987);
  });

  test('not applied leaves the body untouched', () => {
    const body = fresh();
    const result = applyMutationInPlace(body, { path: [0, 'id'], operator: 'num-shift' });
    assert.equal(result.applied, false);
    assert.equal(body[0]?.id, 'ORD-1001');
  });

  test('survives a lodash-style merge back into the original response, unlike a copy', () => {
    const copyRes = { body: fresh() as unknown };
    mergeLikeCypress(copyRes, { body: applyMutation(copyRes.body, { path: [], operator: 'array-empty' }).body });
    assert.equal((copyRes.body as unknown[]).length, 2);
    const inPlaceRes = { body: fresh() as unknown };
    const userRes = { ...inPlaceRes };
    userRes.body = applyMutationInPlace(userRes.body, { path: [], operator: 'array-empty' }).body;
    mergeLikeCypress(inPlaceRes, userRes);
    assert.equal((inPlaceRes.body as unknown[]).length, 0);
  });
});
