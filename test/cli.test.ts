import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { HELP, main, parseCliArgs, signalExitCode, splitSpecs, toRoundResult, type RunArgs } from '../src/cli';
import { buildReport } from '../src/core/score';

function sink(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    }
  });
  return { stream, text: () => text };
}

describe('parseCliArgs', () => {
  test('run defaults', () => {
    const args = parseCliArgs(['run'], '/work') as RunArgs;
    assert.deepEqual(args, {
      command: 'run',
      specs: [],
      project: '/work',
      budget: 20,
      seed: 1,
      baselines: 2,
      browser: 'electron',
      out: '/work/e2e-mutants-report',
      timeZones: [],
      keepSession: false
    });
  });

  test('comma-separated specs are split like the Cypress CLI does, keeping brace globs whole', () => {
    const args = parseCliArgs(['run', '--spec', 'cypress/e2e/a.cy.js,cypress/e2e/b.cy.js', '--spec', 'cypress/e2e/{c,d}.cy.js'], '/w') as RunArgs;
    assert.deepEqual(args.specs, ['/w/cypress/e2e/a.cy.js', '/w/cypress/e2e/b.cy.js', '/w/cypress/e2e/{c,d}.cy.js']);
    assert.deepEqual(splitSpecs([' a.cy.js , ,b.cy.js', '{x,{y,z}}.cy.js']), ['a.cy.js', 'b.cy.js', '{x,{y,z}}.cy.js']);
  });

  test('time zones are validated', () => {
    const args = parseCliArgs(['run', '--time-zone', 'America/Sao_Paulo', '--time-zone', 'UTC'], '/w') as RunArgs;
    assert.deepEqual(args.timeZones, ['America/Sao_Paulo', 'UTC']);
    assert.throws(() => parseCliArgs(['run', '--time-zone', 'Mars/Olympus'], '/w'), /--time-zone "Mars\/Olympus" is not a time zone/);
  });

  test('specs and the config file resolve against the project, out against the cwd', () => {
    const args = parseCliArgs(
      ['run', '--project', 'app', '--spec', 'cypress/e2e/a.cy.js', '--spec', 'cypress/e2e/**/b*.cy.js', '--config-file', 'cy.config.ts', '--out', 'r'],
      '/work'
    ) as RunArgs;
    assert.equal(args.project, '/work/app');
    assert.deepEqual(args.specs, ['/work/app/cypress/e2e/a.cy.js', '/work/app/cypress/e2e/**/b*.cy.js']);
    assert.equal(args.configFile, '/work/app/cy.config.ts');
    assert.equal(args.out, '/work/r');
  });

  test('numeric options are validated', () => {
    const args = parseCliArgs(['run', '--budget', '5', '--seed', '0', '--baselines', '1', '--min-score', '0.8', '--keep-session'], '/w') as RunArgs;
    assert.equal(args.budget, 5);
    assert.equal(args.seed, 0);
    assert.equal(args.baselines, 1);
    assert.equal(args.minScore, 0.8);
    assert.equal(args.keepSession, true);
    assert.throws(() => parseCliArgs(['run', '--budget', '0'], '/w'), /--budget must be at least 1/);
    assert.throws(() => parseCliArgs(['run', '--budget', 'ten'], '/w'), /--budget must be a whole number/);
    assert.throws(() => parseCliArgs(['run', '--min-score', '80'], '/w'), /--min-score must be a number from 0 to 1/);
    assert.throws(() => parseCliArgs(['run', '--min-score', ''], '/w'), /--min-score/);
  });

  test('usage errors', () => {
    assert.throws(() => parseCliArgs([], '/w'), /missing command/);
    assert.throws(() => parseCliArgs(['mutate'], '/w'), /unknown command "mutate"/);
    assert.throws(() => parseCliArgs(['run', '--bugdet', '3'], '/w'), /--bugdet/);
    assert.throws(() => parseCliArgs(['run', 'cypress/e2e/a.cy.js'], '/w'), /pass specs with --spec/);
    assert.throws(() => parseCliArgs(['report'], '/w'), /exactly one argument/);
  });

  test('report, help and version', () => {
    assert.deepEqual(parseCliArgs(['report', 'out/e2e-mutants.json'], '/w'), { command: 'report', input: '/w/out/e2e-mutants.json' });
    assert.deepEqual(parseCliArgs(['--help'], '/w'), { command: 'help' });
    assert.deepEqual(parseCliArgs(['run', '-h'], '/w'), { command: 'help' });
    assert.deepEqual(parseCliArgs(['--version'], '/w'), { command: 'version' });
  });
});

describe('toRoundResult', () => {
  test('maps Cypress results to test ids', () => {
    const result = toRoundResult({
      runs: [
        {
          error: null,
          spec: { relative: 'cypress/e2e/a.cy.js' },
          tests: [
            { title: ['suite', 'passes'], state: 'passed', displayError: null },
            { title: ['suite', 'fails'], state: 'failed', displayError: 'AssertionError: nope' }
          ]
        },
        { error: 'Error: Webpack Compilation Error', spec: { relative: 'cypress/e2e/b.cy.js' }, tests: null }
      ]
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.tests.keys()], ['cypress/e2e/a.cy.js :: suite > passes', 'cypress/e2e/a.cy.js :: suite > fails']);
    assert.equal(result.tests.get('cypress/e2e/a.cy.js :: suite > fails')?.error, 'AssertionError: nope');
    assert.equal(result.specErrors.get('cypress/e2e/b.cy.js'), 'Error: Webpack Compilation Error');
  });

  test('an error outside of a test is a spec error, not a test', () => {
    const result = toRoundResult({
      runs: [
        {
          error: null,
          spec: { relative: 'cypress/e2e/top.cy.js' },
          tests: [{ title: ['An uncaught error was detected outside of a test'], state: 'failed', displayError: 'Error: boom at top level' }]
        }
      ]
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tests.size, 0);
    assert.equal(result.specErrors.get('cypress/e2e/top.cy.js'), 'Error: boom at top level');
  });

  test('two tests with the same title path are reported as duplicates', () => {
    const result = toRoundResult({
      runs: [
        {
          error: null,
          spec: { relative: 'cypress/e2e/dup.cy.js' },
          tests: [
            { title: ['orders', 'opens the order'], state: 'passed', displayError: null },
            { title: ['orders', 'opens the order'], state: 'passed', displayError: null },
            { title: ['orders', 'other'], state: 'passed', displayError: null }
          ]
        }
      ]
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...(result.duplicates ?? [])], ['cypress/e2e/dup.cy.js :: orders > opens the order']);
  });

  test('a failed run is a runner error', () => {
    assert.deepEqual(toRoundResult({ status: 'failed', failures: 1, message: 'Could not find a Cypress configuration file' } as never), {
      ok: false,
      error: 'Could not find a Cypress configuration file'
    });
  });
});

describe('signalExitCode', () => {
  test('is 128 plus the signal number', () => {
    assert.equal(signalExitCode('SIGINT'), 130);
    assert.equal(signalExitCode('SIGTERM'), 143);
  });
});

describe('main', () => {
  test('--help prints usage and exits 0', async () => {
    const out = sink();
    assert.equal(await main(['--help'], out.stream, sink().stream), 0);
    assert.equal(out.text(), HELP);
  });

  test('a project without cypress is a usage error with a hint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mutants-nocy-'));
    const err = sink();
    try {
      assert.equal(await main(['run', '--project', dir], sink().stream, err.stream), 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.match(err.text(), /cannot find the "cypress" package from/);
    assert.match(err.text(), /npm install --save-dev cypress/);
  });

  test('report re-renders the HTML from the JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mutants-report-'));
    try {
      const report = buildReport({
        version: '0.1.0',
        startedAt: '2026-11-17T00:00:00.000Z',
        finishedAt: '2026-11-17T00:01:00.000Z',
        options: { specs: [], budget: 20, seed: 1, baselines: 2, browser: 'electron' },
        tests: [],
        results: []
      });
      const json = path.join(dir, 'e2e-mutants.json');
      fs.writeFileSync(json, JSON.stringify(report));
      const out = sink();
      assert.equal(await main(['report', json], out.stream, sink().stream), 0);
      assert.match(fs.readFileSync(path.join(dir, 'e2e-mutants.html'), 'utf8'), /^<!doctype html>/i);
      fs.writeFileSync(json, '{"tool":"other"}');
      const err = sink();
      assert.equal(await main(['report', json], sink().stream, err.stream), 2);
      assert.match(err.text(), /is not a complete e2e-mutants report/);
      fs.writeFileSync(json, JSON.stringify({ tool: 'e2e-mutants', schemaVersion: 1, tests: [{}], results: [], summary: {} }));
      const partial = sink();
      assert.equal(await main(['report', json], sink().stream, partial.stream), 2);
      assert.match(partial.text(), /is not a complete e2e-mutants report/);
      assert.doesNotMatch(partial.text(), /TypeError|at /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
