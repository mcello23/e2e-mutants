import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setupE2eMutants, type E2eMutantsTasks } from '../src/cypress/plugin';
import { APPLIED_TASK, FLAG, PLAN_TASK, RECORD_TASK, SESSION_ENV } from '../src/cypress/shared';
import { readRound, writePlan } from '../src/session';
import type { Mutation } from '../src/core/types';

const TEST_ID = 'cypress/e2e/a.cy.js :: suite > shows revenue';

const mutation: Mutation = {
  id: 'abc',
  testId: TEST_ID,
  requestKey: 'GET /api/summary',
  occurrence: 0,
  path: ['revenue'],
  pathText: '$.revenue',
  operator: 'num-shift'
};

function register(config: { env?: Record<string, unknown>; expose?: Record<string, unknown> }): {
  tasks: E2eMutantsTasks;
  result: typeof config;
} {
  let tasks: E2eMutantsTasks = {};
  const result = setupE2eMutants((action, handlers) => {
    assert.equal(action, 'task');
    tasks = { ...tasks, ...handlers };
  }, config);
  return { tasks, result };
}

describe('setupE2eMutants', () => {
  let dir = '';
  const saved = process.env[SESSION_ENV];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mutants-test-'));
    delete process.env[SESSION_ENV];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env[SESSION_ENV];
    else process.env[SESSION_ENV] = saved;
  });

  test('without a session it registers tasks that answer off and leaves the config alone', () => {
    const config = { env: {}, expose: {} };
    const { tasks, result } = register(config);
    assert.equal(result, config);
    assert.deepEqual(config, { env: {}, expose: {} });
    assert.deepEqual(tasks[PLAN_TASK]?.({ testId: TEST_ID }), { mode: 'off', mutation: null });
    assert.equal(tasks[RECORD_TASK]?.({ testId: TEST_ID, responses: [], domSnapshots: [] }), null);
    assert.equal(tasks[APPLIED_TASK]?.({ testId: TEST_ID, mutantId: 'x', applied: true, seen: true }), null);
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  test('a record session sets the expose flag and writes recordings', () => {
    writePlan(dir, { mode: 'record', round: 1, tag: 'baseline-1', mutations: {} });
    process.env[SESSION_ENV] = dir;
    const config = { env: {}, expose: { other: 1 } as Record<string, unknown> };
    const { tasks } = register(config);
    assert.equal(config.expose[FLAG], true);
    assert.equal((config.env as Record<string, unknown>)[FLAG], undefined);
    assert.deepEqual(tasks[PLAN_TASK]?.({ testId: TEST_ID }), { mode: 'record', mutation: null });
    tasks[RECORD_TASK]?.({ testId: TEST_ID, responses: [], domSnapshots: ['R$ 1,00'] });
    const round = readRound(dir, 'baseline-1');
    assert.deepEqual(round.records.get(TEST_ID)?.domSnapshots, ['R$ 1,00']);
  });

  test('falls back to config.env when the Cypress version has no expose', () => {
    writePlan(dir, { mode: 'record', round: 1, tag: 'baseline-1', mutations: {} });
    process.env[SESSION_ENV] = dir;
    const config: { env?: Record<string, unknown> } = {};
    register(config);
    assert.equal(config.env?.[FLAG], true);
  });

  test('a mutate session hands out the planned mutation and records the applied state', () => {
    writePlan(dir, { mode: 'mutate', round: 3, tag: 'mutate-3', mutations: { [TEST_ID]: mutation } });
    process.env[SESSION_ENV] = dir;
    const { tasks } = register({ expose: {} });
    assert.deepEqual(tasks[PLAN_TASK]?.({ testId: TEST_ID }), { mode: 'mutate', mutation });
    assert.deepEqual(tasks[PLAN_TASK]?.({ testId: 'other' }), { mode: 'off', mutation: null });
    assert.deepEqual(tasks[PLAN_TASK]?.({ testId: 'toString' }), { mode: 'off', mutation: null });
    assert.deepEqual(tasks[PLAN_TASK]?.(null), { mode: 'off', mutation: null });
    tasks[RECORD_TASK]?.({ testId: TEST_ID, responses: [], domSnapshots: [] });
    tasks[APPLIED_TASK]?.({ testId: TEST_ID, mutantId: 'abc', applied: true, seen: true, before: '1', after: '8' });
    const round = readRound(dir, 'mutate-3');
    assert.equal(round.records.size, 0);
    assert.equal(round.applied.get(TEST_ID)?.applied, true);
  });

  test('an async plugin chain gets the flag on the resolved config', async () => {
    writePlan(dir, { mode: 'record', round: 1, tag: 'baseline-1', mutations: {} });
    process.env[SESSION_ENV] = dir;
    let tasks: E2eMutantsTasks = {};
    const config = { expose: {} as Record<string, unknown> };
    const result = setupE2eMutants(
      (_action, handlers) => {
        tasks = { ...tasks, ...handlers };
      },
      Promise.resolve(config)
    );
    assert.equal(typeof tasks[PLAN_TASK], 'function');
    assert.equal(await result, config);
    assert.equal(config.expose[FLAG], true);
  });

  test('an async plugin chain without a session resolves to the config untouched', async () => {
    const config = { expose: {} as Record<string, unknown> };
    const resolved = await setupE2eMutants(() => undefined, Promise.resolve(config));
    assert.deepEqual(resolved, { expose: {} });
  });

  test('writes after the CLI deleted the session directory are dropped, not recreated', () => {
    writePlan(dir, { mode: 'record', round: 1, tag: 'baseline-1', mutations: {} });
    process.env[SESSION_ENV] = dir;
    const { tasks } = register({ expose: {} });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(tasks[RECORD_TASK]?.({ testId: TEST_ID, responses: [], domSnapshots: ['secret page'] }), null);
    assert.equal(fs.existsSync(dir), false);
  });

  test('round directories and files are private to the user', () => {
    writePlan(dir, { mode: 'record', round: 1, tag: 'baseline-1', mutations: {} });
    process.env[SESSION_ENV] = dir;
    const { tasks } = register({ expose: {} });
    tasks[RECORD_TASK]?.({ testId: TEST_ID, responses: [], domSnapshots: [] });
    const roundsDir = path.join(dir, 'rounds');
    const tagDir = path.join(roundsDir, 'baseline-1');
    assert.equal(fs.statSync(roundsDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(tagDir).mode & 0o777, 0o700);
    const [file] = fs.readdirSync(tagDir);
    assert.equal(fs.statSync(path.join(tagDir, file as string)).mode & 0o777, 0o600);
  });

  test('a session without a readable plan fails loudly', () => {
    process.env[SESSION_ENV] = dir;
    assert.throws(() => register({ expose: {} }), /cannot read the session plan/);
  });
});
