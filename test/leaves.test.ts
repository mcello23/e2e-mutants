import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeValue,
  formatPath,
  generalizePath,
  getAtPath,
  isNumericString,
  setAtPath,
  walkJson
} from '../src/core/leaves';

describe('walkJson', () => {
  const body = {
    revenue: 128450.5,
    orders: 312,
    updatedAt: '2026-11-12T09:30:00Z',
    total: '1450.00',
    plan: 'Pro',
    active: true,
    coupon: null,
    items: [
      { sku: 'SKU-1', qty: 2 },
      { sku: 'SKU-2', qty: 1 }
    ],
    tags: []
  };
  const walk = walkJson(body);
  const byPath = new Map(walk.leaves.map((leaf) => [formatPath(leaf.path), leaf]));

  test('collects every leaf with its kind', () => {
    assert.equal(byPath.get('$.revenue')?.kind, 'number');
    assert.equal(byPath.get('$.updatedAt')?.kind, 'date');
    assert.equal(byPath.get('$.plan')?.kind, 'string');
    assert.equal(byPath.get('$.active')?.kind, 'boolean');
    assert.equal(byPath.get('$.coupon')?.kind, 'null');
    assert.equal(byPath.get('$.items[1].sku')?.value, 'SKU-2');
  });

  test('numeric strings stay strings but carry a numeric value', () => {
    const total = byPath.get('$.total');
    assert.equal(total?.kind, 'string');
    assert.equal(total?.numeric, 1450);
    assert.equal(byPath.get('$.plan')?.numeric, null);
  });

  test('collects arrays with their length, including the empty one', () => {
    assert.deepEqual(
      walk.arrays.map((a) => [formatPath(a.path), a.length]),
      [
        ['$.items', 2],
        ['$.tags', 0]
      ]
    );
  });

  test('a root array and a root primitive', () => {
    assert.deepEqual(walkJson([1, 2]).arrays, [{ path: [], length: 2 }]);
    assert.deepEqual(walkJson('hello').leaves.map((l) => l.path), [[]]);
  });
});

describe('isNumericString', () => {
  test('accepts JSON-style decimals and rejects everything else', () => {
    assert.ok(isNumericString('1450.00'));
    assert.ok(isNumericString('-12'));
    assert.ok(isNumericString('00123'));
    assert.ok(!isNumericString('1,450.00'));
    assert.ok(!isNumericString('1e5'));
    assert.ok(!isNumericString('12.'));
    assert.ok(!isNumericString(''));
    assert.ok(!isNumericString('1234567890123456'));
  });
});

describe('paths', () => {
  test('formatPath quotes keys that are not identifiers', () => {
    assert.equal(formatPath([]), '$');
    assert.equal(formatPath(['orders', 0, 'total']), '$.orders[0].total');
    assert.equal(formatPath(['a b', 'x"y', '1st']), '$["a b"]["x\\"y"]["1st"]');
  });

  test('generalizePath replaces indexes', () => {
    assert.equal(generalizePath([0, 'items', 3, 'price']), '$[*].items[*].price');
  });

  test('getAtPath finds values and reports missing ones', () => {
    const body = { a: [{ b: 1 }], c: null };
    assert.deepEqual(getAtPath(body, ['a', 0, 'b']), { found: true, value: 1 });
    assert.deepEqual(getAtPath(body, ['c']), { found: true, value: null });
    assert.equal(getAtPath(body, ['a', 1, 'b']).found, false);
    assert.equal(getAtPath(body, ['a', 'b']).found, false);
    assert.equal(getAtPath(body, ['toString']).found, false);
  });

  test('setAtPath copies the spine and leaves the original untouched', () => {
    const body = { a: [{ b: 1, keep: { deep: true } }], other: { x: 1 } };
    const next = setAtPath(body, ['a', 0, 'b'], 99) as typeof body;
    assert.equal(next.a[0]?.b, 99);
    assert.equal(body.a[0]?.b, 1);
    assert.equal(next.other, body.other);
    assert.equal(next.a[0]?.keep, body.a[0]?.keep);
    assert.deepEqual(setAtPath([1, 2, 3], [], []), []);
  });
});

describe('describeValue', () => {
  test('renders values for the report', () => {
    assert.equal(describeValue('Ana'), '"Ana"');
    assert.equal(describeValue(1450), '1450');
    assert.equal(describeValue(null), 'null');
    assert.equal(describeValue([1, 2, 3]), '[3 items]');
    assert.equal(describeValue([1]), '[1 item]');
    assert.equal(describeValue({ a: 1 }), '{…}');
    assert.equal(describeValue('x'.repeat(500)).length, 120);
  });
});
