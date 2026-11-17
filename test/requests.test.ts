import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { fieldIdFor, mutantIdFor, specOfTestId, testIdFor, titleOfTestId } from '../src/core/ids';
import { isJsonContentType, keyResponses, OccurrenceCounter, parseJsonBody, requestKey, urlTemplate } from '../src/core/requests';

describe('urlTemplate', () => {
  test('all-digit segments become :n', () => {
    assert.equal(urlTemplate('/api/orders/1001'), '/api/orders/:n');
  });

  test('UUID segments become :uuid', () => {
    assert.equal(urlTemplate('/api/users/3F2504E0-4F89-11D3-9A0C-0305E82C3301/cart'), '/api/users/:uuid/cart');
  });

  test('24-hex segments become :oid', () => {
    assert.equal(urlTemplate('/api/items/507f1f77bcf86cd799439011'), '/api/items/:oid');
  });

  test('query string, hash and origin are dropped', () => {
    assert.equal(urlTemplate('http://localhost:4517/api/orders?page=2&sort=desc#top'), '/api/orders');
    assert.equal(urlTemplate('https://api.example.com/v2/summary'), '/v2/summary');
  });

  test('mixed segments stay literal', () => {
    assert.equal(urlTemplate('/api/orders/ORD-1001'), '/api/orders/ORD-1001');
    assert.equal(urlTemplate('/api/v2/orders'), '/api/v2/orders');
  });
});

describe('requestKey', () => {
  test('uppercases the method and templates the URL', () => {
    assert.equal(requestKey('get', 'http://localhost:4517/api/orders/12?x=1'), 'GET /api/orders/:n');
  });
});

describe('occurrences', () => {
  test('keyResponses counts each key separately in arrival order', () => {
    const keyed = keyResponses([
      { method: 'GET', url: '/api/orders/1' },
      { method: 'GET', url: '/api/summary' },
      { method: 'GET', url: '/api/orders/2?fresh=1' },
      { method: 'POST', url: '/api/orders/3' },
      { method: 'GET', url: '/api/orders/4' }
    ]);
    assert.deepEqual(
      keyed.map((r) => [r.key, r.occurrence]),
      [
        ['GET /api/orders/:n', 0],
        ['GET /api/summary', 0],
        ['GET /api/orders/:n', 1],
        ['POST /api/orders/:n', 0],
        ['GET /api/orders/:n', 2]
      ]
    );
  });

  test('OccurrenceCounter increments per key and resets', () => {
    const counter = new OccurrenceCounter();
    assert.equal(counter.next('a'), 0);
    assert.equal(counter.next('a'), 1);
    assert.equal(counter.next('b'), 0);
    counter.reset();
    assert.equal(counter.next('a'), 0);
  });
});

describe('JSON bodies', () => {
  test('isJsonContentType', () => {
    assert.ok(isJsonContentType('application/json; charset=utf-8'));
    assert.ok(isJsonContentType('application/problem+json'));
    assert.ok(isJsonContentType(['text/json']));
    assert.ok(!isJsonContentType('application/x-ndjson'));
    assert.ok(!isJsonContentType('text/html'));
    assert.ok(!isJsonContentType(undefined));
  });

  test('parseJsonBody accepts objects, arrays and JSON strings', () => {
    assert.deepEqual(parseJsonBody({ a: 1 }), { ok: true, value: { a: 1 }, wasString: false });
    assert.deepEqual(parseJsonBody('[1,2]'), { ok: true, value: [1, 2], wasString: true });
    assert.deepEqual(parseJsonBody(' {"a":1} ', 'application/json'), { ok: true, value: { a: 1 }, wasString: true });
    assert.deepEqual(parseJsonBody('42', 'application/json'), { ok: true, value: 42, wasString: true });
    assert.deepEqual(parseJsonBody(42, 'application/json'), { ok: true, value: 42, wasString: false });
  });

  test('parseJsonBody accepts plain objects created in another realm', () => {
    const foreign = runInNewContext('({ revenue: 128450.5, nested: { a: 1 } })') as unknown;
    assert.notEqual(Object.getPrototypeOf(foreign), Object.prototype);
    const parsed = parseJsonBody(foreign, 'application/json');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.value, foreign);
    assert.equal(parseJsonBody(Object.create(null), 'application/json').ok, true);
  });

  test('parseJsonBody rejects class instances from any realm', () => {
    assert.deepEqual(parseJsonBody(new Date(0)), { ok: false });
    assert.deepEqual(parseJsonBody(runInNewContext('new Map()')), { ok: false });
    class Box {}
    assert.deepEqual(parseJsonBody(new Box()), { ok: false });
  });

  test('parseJsonBody rejects non-JSON', () => {
    assert.deepEqual(parseJsonBody('<html></html>', 'text/html'), { ok: false });
    assert.deepEqual(parseJsonBody('{broken', 'application/json'), { ok: false });
    assert.deepEqual(parseJsonBody('42'), { ok: false });
    assert.deepEqual(parseJsonBody(new Uint8Array([1, 2])), { ok: false });
    assert.deepEqual(parseJsonBody(undefined, 'application/json'), { ok: false });
  });
});

describe('ids', () => {
  test('testIdFor joins spec and title path', () => {
    const id = testIdFor('cypress/e2e/weak.cy.js', ['dashboard', 'shows revenue']);
    assert.equal(id, 'cypress/e2e/weak.cy.js :: dashboard > shows revenue');
    assert.equal(specOfTestId(id), 'cypress/e2e/weak.cy.js');
    assert.equal(titleOfTestId(id), 'dashboard > shows revenue');
  });

  test('fieldIdFor and mutantIdFor are stable and distinct', () => {
    assert.equal(fieldIdFor('GET /api/summary', 0, '$.revenue'), 'GET /api/summary #0 $.revenue');
    const a = mutantIdFor('t', 'GET /api/summary', 0, '$.revenue', 'num-shift');
    assert.equal(a, mutantIdFor('t', 'GET /api/summary', 0, '$.revenue', 'num-shift'));
    assert.notEqual(a, mutantIdFor('t', 'GET /api/summary', 1, '$.revenue', 'num-shift'));
    assert.notEqual(a, mutantIdFor('t', 'GET /api/summary', 0, '$.revenue', 'set-null'));
    assert.match(a, /^[0-9a-z]{11}$/);
  });
});
