import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTextIndex,
  collectSensitiveValues,
  isSensitiveKey,
  isTrivialLeaf,
  mergeBaselineObservations,
  observedFields,
  observeTest,
  REDACTED,
  redactSensitive,
  scrubText,
  type FieldObservation,
  type TestObservation
} from '../src/core/observe';
import { toLeaf } from '../src/core/leaves';
import { evidenceText } from '../src/core/text';
import type { TestRecording } from '../src/core/types';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2 });
const day = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' });

const summary = { revenue: 128450.5, orders: 312, conversionRate: 0.0425, updatedAt: '2026-11-12T09:30:00Z', currency: 'BRL', hidden: 98765 };
const orders = [
  { id: 'ORD-1001', customer: 'Ana Souza', total: 1450, status: 'paid', createdAt: '2026-11-10', priority: 3, gift: false },
  { id: 'ORD-1002', customer: 'José Silva', total: 289.9, status: 'pending', createdAt: '2026-11-11', priority: 1, gift: true }
];
const me = { name: 'Marta Lima', locale: 'pt-BR', plan: 'Enterprise', accessToken: 'eyJhbGciOi.secret', session: { id: 'abc123def', user: 'Marta Lima' } };

const page = [
  'Olá, Marta Lima',
  `Receita ${brl.format(summary.revenue)}`,
  `Pedidos ${summary.orders}`,
  `Conversão ${pct.format(summary.conversionRate)}`,
  `Atualizado em ${day.format(new Date(summary.updatedAt))}`,
  ...orders.map((o) => `${o.id} ${o.customer} ${brl.format(o.total)} ${o.status === 'paid' ? 'Pago' : 'Pendente'} ${day.format(new Date(o.createdAt))}`)
].join('\n');

const recording: TestRecording = {
  testId: 'cypress/e2e/weak.cy.js :: dashboard > renders',
  responses: [
    { method: 'GET', url: 'http://localhost:4517/api/me', body: me },
    { method: 'GET', url: 'http://localhost:4517/api/summary', body: summary },
    { method: 'GET', url: 'http://localhost:4517/api/orders?page=1', body: orders }
  ],
  domSnapshots: [page, page]
};

function field(observation: TestObservation, requestKey: string, pathText: string): FieldObservation {
  const found = observation.fields.find((f) => f.requestKey === requestKey && f.pathText === pathText);
  assert.ok(found, `missing field ${requestKey} ${pathText}`);
  return found;
}

describe('observeTest on a pt-BR dashboard', () => {
  const observation = observeTest(recording);

  test('locale-formatted numbers, percent and dates are observed with evidence', () => {
    const revenue = field(observation, 'GET /api/summary', '$.revenue');
    assert.equal(revenue.status, 'observed');
    assert.ok(revenue.evidence && evidenceText(revenue.evidence).includes('128.450,50'));
    assert.equal(revenue.evidence?.match, 'R$ 128.450,50');
    assert.equal(field(observation, 'GET /api/summary', '$.orders').status, 'observed');
    const rate = field(observation, 'GET /api/summary', '$.conversionRate');
    assert.equal(rate.status, 'observed');
    assert.equal(rate.evidence?.match, '4,25%');
    const updated = field(observation, 'GET /api/summary', '$.updatedAt');
    assert.equal(updated.status, 'observed');
    assert.equal(updated.evidence?.match, '12/11/2026');
  });

  test('strings are observed case-insensitively and by whole word', () => {
    assert.equal(field(observation, 'GET /api/orders', '$[0].customer').status, 'observed');
    assert.equal(field(observation, 'GET /api/orders', '$[1].customer').status, 'observed');
    assert.equal(field(observation, 'GET /api/orders', '$[0].id').status, 'observed');
    assert.equal(field(observation, 'GET /api/orders', '$[0].createdAt').evidence?.match, '10/11/2026');
    assert.equal(field(observation, 'GET /api/orders', '$[1].total').evidence?.match, 'R$ 289,90');
  });

  test('values not on the page are unobserved', () => {
    assert.equal(field(observation, 'GET /api/summary', '$.hidden').status, 'unobserved');
    assert.equal(field(observation, 'GET /api/me', '$.plan').status, 'unobserved');
    assert.equal(field(observation, 'GET /api/orders', '$[0].status').status, 'unobserved');
    assert.equal(field(observation, 'GET /api/me', '$.locale').status, 'unobserved');
  });

  test('booleans, small integers and short strings are trivial', () => {
    assert.equal(field(observation, 'GET /api/orders', '$[0].gift').status, 'trivial');
    assert.equal(field(observation, 'GET /api/orders', '$[0].priority').status, 'trivial');
  });

  test('sensitive keys are never observed and never carry values', () => {
    const token = field(observation, 'GET /api/me', '$.accessToken');
    assert.equal(token.status, 'sensitive');
    assert.equal('value' in token, false);
    const nested = field(observation, 'GET /api/me', '$.session.user');
    assert.equal(nested.status, 'sensitive');
    assert.equal('value' in nested, false);
  });

  test('arrays are observed when one of their items has an observed leaf', () => {
    const list = field(observation, 'GET /api/orders', '$');
    assert.equal(list.kind, 'array');
    assert.equal(list.status, 'observed');
    assert.equal(list.length, 2);
  });

  test('request keys drop the query string and carry occurrences', () => {
    const keys = new Set(observation.fields.map((f) => `${f.requestKey}#${f.occurrence}`));
    assert.deepEqual([...keys].sort(), ['GET /api/me#0', 'GET /api/orders#0', 'GET /api/summary#0']);
    assert.equal(field(observation, 'GET /api/summary', '$.revenue').id, 'GET /api/summary #0 $.revenue');
  });

  test('observedFields returns only observed ones', () => {
    assert.ok(observedFields(observation).every((f) => f.status === 'observed'));
    assert.ok(observedFields(observation).length >= 10);
  });
});

describe('observation edge cases', () => {
  function observeOne(body: unknown, text: string, timeZone?: string): TestObservation {
    const rec: TestRecording = { testId: 't', responses: [{ method: 'GET', url: '/x', body }], domSnapshots: [text] };
    if (timeZone !== undefined) rec.timeZone = timeZone;
    return observeTest(rec);
  }

  test('"Ana" is not observed in "Banana" but is in "Ana Souza"', () => {
    assert.equal(observeOne({ name: 'Ana' }, 'Banana split').fields[0]?.status, 'unobserved');
    assert.equal(observeOne({ name: 'Ana' }, 'Cliente Ana Souza').fields[0]?.status, 'observed');
  });

  test('"José" is observed in "José Silva" but not in "Josélia"', () => {
    assert.equal(observeOne({ name: 'José' }, 'José Silva').fields[0]?.status, 'observed');
    assert.equal(observeOne({ name: 'José' }, 'Josélia Lima').fields[0]?.status, 'unobserved');
  });

  test('numbers inside dates and times are not observed as numbers', () => {
    const obs = observeOne({ year: 2026, minute: 30 }, 'Atualizado 10/11/2026 às 09:30');
    assert.deepEqual(
      obs.fields.map((f) => f.status),
      ['unobserved', 'unobserved']
    );
  });

  test('1450 is not observed when the page shows 14500 or 1.450,90', () => {
    assert.equal(observeOne({ total: 1450 }, 'Total R$ 14.500,00').fields[0]?.status, 'unobserved');
    assert.equal(observeOne({ total: 1450 }, 'Total R$ 1.450,90').fields[0]?.status, 'unobserved');
  });

  test('numeric strings match their formatted value', () => {
    assert.equal(observeOne({ total: '1450.00' }, 'Total R$ 1.450,00').fields[0]?.status, 'observed');
  });

  test('strings over 200 characters match on their first 60 characters', () => {
    const notes = 'Cliente pediu entrega no período da manhã e embalagem para presente com cartão escrito à mão. '.repeat(3);
    const obs = observeOne({ notes }, `Observações: ${notes.slice(0, 80)}… mostrar mais`);
    assert.equal(obs.fields[0]?.status, 'observed');
  });

  test('the recording time zone adds the local calendar date of datetimes', () => {
    const body = { at: '2026-11-10T23:45:00Z' };
    assert.equal(observeOne(body, 'Enviado 11/11/2026').fields[0]?.status, 'unobserved');
    assert.equal(observeOne(body, 'Enviado 11/11/2026', 'Asia/Tokyo').fields[0]?.status, 'observed');
  });

  test('an extra time zone matches date-times the app formats in a fixed business zone', () => {
    const rec: TestRecording = {
      testId: 't',
      responses: [{ method: 'GET', url: '/x', body: { updatedAt: '2026-11-12T01:30:00Z' } }],
      domSnapshots: ['Atualizado em 11/11/2026 às 22:30'],
      timeZone: 'Europe/Madrid'
    };
    assert.equal(observeTest(rec).fields[0]?.status, 'unobserved');
    assert.equal(observeTest(rec, { timeZones: ['America/Sao_Paulo'] }).fields[0]?.status, 'observed');
  });

  test('empty arrays are trivial; arrays with no observed item are unobserved', () => {
    const obs = observeOne({ empty: [], hidden: [{ sku: 'SKU-XYZ-1' }] }, 'nothing here');
    assert.equal(obs.fields.find((f) => f.pathText === '$.empty')?.status, 'trivial');
    assert.equal(obs.fields.find((f) => f.pathText === '$.hidden')?.status, 'unobserved');
  });

  test('a value shown in several places carries the number of places', () => {
    const obs = observeOne({ shipped: '2026-11-12', name: 'Ana Souza', total: 1450 }, 'Atualizado em 12/11/2026 · ORD-1005 12/11/2026 · Ana Souza · R$ 1.450,00 e R$ 1.450,00');
    const byPath = new Map(obs.fields.map((f) => [f.pathText, f]));
    assert.equal(byPath.get('$.shipped')?.evidence?.matches, 2);
    assert.equal(byPath.get('$.total')?.evidence?.matches, 2);
    assert.equal(byPath.get('$.name')?.evidence?.matches, undefined);
  });

  test('a body with more than 200k leaves is observed without overflowing the stack', () => {
    const rows = Array.from({ length: 70_000 }, (_, i) => ({ id: i, name: `Item ${String(i).padStart(6, '0')}`, value: 1000 + i }));
    const started = Date.now();
    const obs = observeOne(rows, 'big 70000 first Item 000000');
    assert.equal(obs.fields.length, 70_000 * 3 + 1);
    assert.equal(obs.fields.find((f) => f.pathText === '$')?.status, 'observed');
    assert.equal(obs.fields.find((f) => f.pathText === '$[0].name')?.status, 'observed');
    assert.ok(Date.now() - started < 20_000);
  });

  test('nested arrays get their witness in one pass', () => {
    const body = { orders: [{ items: [{ sku: 'SKU-AAA-1' }, { sku: 'SKU-BBB-2' }] }, { items: [{ sku: 'SKU-CCC-3' }] }] };
    const obs = observeOne(body, 'SKU-CCC-3');
    const status = new Map(obs.fields.map((f) => [f.pathText, f.status]));
    assert.equal(status.get('$.orders'), 'observed');
    assert.equal(status.get('$.orders[0].items'), 'unobserved');
    assert.equal(status.get('$.orders[1].items'), 'observed');
  });

  test('unobserved string values are cut at 60 characters, observed ones are kept whole', () => {
    const note = 'x'.repeat(5000);
    const obs = observeOne({ note, internal: 'never shown on the page', name: 'Ana Souza' }, 'hello Ana Souza');
    const byPath = new Map(obs.fields.map((f) => [f.pathText, f]));
    assert.equal(Array.from(String(byPath.get('$.note')?.value)).length, 60);
    assert.equal(byPath.get('$.internal')?.value, 'never shown on the page');
    assert.equal(byPath.get('$.name')?.value, 'Ana Souza');
  });

  test('blank snapshots are ignored', () => {
    assert.equal(observeOne({ name: 'Ana Souza' }, '   ').fields[0]?.status, 'unobserved');
  });

  test('buildTextIndex excludes date and time spans from numbers', () => {
    const index = buildTextIndex('10/11/2026 09:30 total 312');
    assert.deepEqual(
      index.numbers.tokens.map((t) => t.raw),
      ['312']
    );
    assert.ok(index.dates.has('2026-11-10'));
  });
});

describe('repeated responses', () => {
  const twice = (second: unknown): TestRecording => ({
    testId: 't',
    responses: [
      { method: 'GET', url: '/api/summary', body: { revenue: 128450.5, orders: 312 } },
      { method: 'GET', url: '/api/summary', body: second }
    ],
    domSnapshots: ['Receita R$ 128.450,50 Pedidos 312 427']
  });

  test('a value that is the same in every occurrence of an endpoint becomes one field for all occurrences', () => {
    const obs = observeTest(twice({ revenue: 128450.5, orders: 312 }));
    const revenue = obs.fields.filter((f) => f.pathText === '$.revenue');
    assert.equal(revenue.length, 1);
    assert.equal(revenue[0]?.occurrence, -1);
    assert.equal(revenue[0]?.id, 'GET /api/summary #* $.revenue');
    assert.equal(revenue[0]?.status, 'observed');
  });

  test('values that differ between occurrences stay separate', () => {
    const obs = observeTest(twice({ revenue: 128450.5, orders: 427 }));
    assert.deepEqual(
      obs.fields.filter((f) => f.pathText === '$.orders').map((f) => f.occurrence),
      [0, 1]
    );
    assert.equal(obs.fields.filter((f) => f.pathText === '$.revenue').length, 1);
  });
});

describe('sensitive values in page text', () => {
  test('collectSensitiveValues finds values under sensitive keys at any depth, longest first', () => {
    const body = {
      name: 'Production key',
      apiKey: 'sk-live-9f8e7d6c5b4a3210',
      auth: { accessToken: 'ACCESS_TOKEN_XYZ', expiresIn: 3600 },
      session: { id: 'sess_ABCDEF123456', otp: 123456, short: 'abc' }
    };
    assert.deepEqual(collectSensitiveValues(body), ['sk-live-9f8e7d6c5b4a3210', 'sess_ABCDEF123456', 'ACCESS_TOKEN_XYZ', '123456']);
  });

  test('scrubText replaces every occurrence, in any case', () => {
    const page = 'API keys Production key sk-live-9f8e7d6c5b4a3210 Owner Ana Souza SK-LIVE-9F8E7D6C5B4A3210';
    assert.equal(scrubText(page, ['sk-live-9f8e7d6c5b4a3210']), 'API keys Production key [redacted] Owner Ana Souza [redacted]');
  });

  test('evidence from a scrubbed page does not carry the secret', () => {
    const body = { name: 'Production key', apiKey: 'sk-live-9f8e7d6c5b4a3210' };
    const page = scrubText('API keys Production key sk-live-9f8e7d6c5b4a3210 Owner Ana Souza', collectSensitiveValues(body));
    const obs = observeTest({ testId: 't', responses: [{ method: 'GET', url: '/k', body: redactSensitive(body) }], domSnapshots: [page] });
    const name = obs.fields.find((f) => f.pathText === '$.name');
    assert.equal(name?.status, 'observed');
    assert.ok(!JSON.stringify(obs).includes('sk-live'));
  });
});

describe('classification', () => {
  test('trivial leaves', () => {
    const trivial = [true, false, null, 0, 7, -9, 'ab', ' x ', '--', '…', '5'];
    for (const value of trivial) assert.equal(isTrivialLeaf(toLeaf(['k'], value)), true, `expected trivial: ${JSON.stringify(value)}`);
    const meaningful = [10, -10, 7.5, 0.0425, 'abc', 'Ana', '7.5', '2026-11-10', 'R$1'];
    for (const value of meaningful) assert.equal(isTrivialLeaf(toLeaf(['k'], value)), false, `expected meaningful: ${JSON.stringify(value)}`);
  });

  test('sensitive keys', () => {
    for (const key of [
      'password',
      'passwd',
      'clientSecret',
      'accessToken',
      'refresh_token',
      'Authorization',
      'set-cookie',
      'apiKey',
      'api_key',
      'api-key',
      'sessionId',
      'SESSION',
      'jwt',
      'privateKey',
      'private_key',
      'accessKey',
      'credentials',
      'bearer',
      'cardNumber',
      'card_number',
      'ssn',
      'userSSN',
      'otp',
      'otpCode',
      'cvv',
      'pin'
    ]) {
      assert.equal(isSensitiveKey(key), true, key);
    }
    for (const key of ['name', 'total', 'customer', 'keyboard', 'capitalCity', 'classname', 'footprint', 'pinned', 'spinner', 'shipping']) {
      assert.equal(isSensitiveKey(key), false, key);
    }
  });

  test('redactSensitive replaces sensitive values at any depth', () => {
    const body = { user: { name: 'Ana', password: 'hunter2', tokens: ['a', 'b'] }, list: [{ apiKey: 'k', id: 1 }] };
    assert.deepEqual(redactSensitive(body), {
      user: { name: 'Ana', password: REDACTED, tokens: REDACTED },
      list: [{ apiKey: REDACTED, id: 1 }]
    });
    assert.equal(body.user.password, 'hunter2');
  });

  test('redactSensitive keeps a __proto__ key as data', () => {
    const body = JSON.parse('{"__proto__": {"token": "x"}, "a": 1}') as unknown;
    const out = redactSensitive(body) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.deepEqual(Object.keys(out), ['__proto__', 'a']);
  });
});

describe('mergeBaselineObservations', () => {
  test('a field is observed only when every baseline observed it', () => {
    const base = (status: FieldObservation['status']): FieldObservation => ({
      id: 'GET /x #0 $.a',
      requestKey: 'GET /x',
      occurrence: 0,
      path: ['a'],
      pathText: '$.a',
      kind: 'string',
      status,
      value: 'Ana Souza',
      ...(status === 'observed' ? { evidence: { before: '', match: 'Ana Souza', after: '' } } : {})
    });
    const other: FieldObservation = { ...base('observed'), id: 'GET /x #0 $.b', path: ['b'], pathText: '$.b' };
    const merged = mergeBaselineObservations([
      { testId: 't', fields: [base('observed'), other] },
      { testId: 't', fields: [base('unobserved'), other] }
    ]);
    const a = merged.fields.find((f) => f.pathText === '$.a');
    assert.equal(a?.status, 'unobserved');
    assert.equal(a?.evidence, undefined);
    assert.equal(merged.fields.find((f) => f.pathText === '$.b')?.status, 'observed');
  });

  test('a field missing from one baseline is not observed', () => {
    const f: FieldObservation = {
      id: 'GET /x #1 $.a',
      requestKey: 'GET /x',
      occurrence: 1,
      path: ['a'],
      pathText: '$.a',
      kind: 'number',
      status: 'observed',
      value: 1450
    };
    const merged = mergeBaselineObservations([
      { testId: 't', fields: [f] },
      { testId: 't', fields: [] }
    ]);
    assert.equal(merged.fields[0]?.status, 'unobserved');
  });

  test('needs at least one observation', () => {
    assert.throws(() => mergeBaselineObservations([]));
  });

  test('two real baselines of the same page agree', () => {
    const merged = mergeBaselineObservations([observeTest(recording), observeTest(recording)]);
    assert.deepEqual(
      observedFields(merged).map((f) => f.id),
      observedFields(observeTest(recording)).map((f) => f.id)
    );
  });
});
