#!/usr/bin/env node
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { testIdFor } from './core/ids';
import { renderHtmlReport } from './core/report-html';
import { formatTextSummary, isE2eMutantsReport, meetsMinScore, formatScore, type E2eMutantsReport } from './core/score';
import type { TestState } from './core/types';
import { SESSION_ENV } from './cypress/shared';
import { runMutation, RunnerError, type RoundResult, type TestOutcome } from './runner';
import { loadCypressModule, resolveCypress, type CypressRunResult, type WorkerReply, type WorkerRequest } from './worker';

export const HELP = `e2e-mutants: mutation testing for Cypress suites

Usage:
  e2e-mutants run [options]          record, mutate and score a Cypress suite
  e2e-mutants report <json> [--out <file>]
                                     render the HTML report again from e2e-mutants.json
  e2e-mutants --help | --version

Options for run:
  --spec <path|glob>      spec to include, relative to --project; repeat it or separate with commas
                          (default: all specs)
  --project <dir>         Cypress project directory (default: current directory)
  --config-file <path>    Cypress config file, relative to --project
  --budget <n>            maximum mutants per test (default: 20)
  --seed <n>              seed for choosing mutants (default: 1)
  --baselines <n>         unmutated recording runs; a test must pass in all of them (default: 2)
  --browser <name>        browser for cypress.run (default: electron)
  --out <dir>             report directory (default: e2e-mutants-report)
  --min-score <0-1>       exit with code 1 when the score is lower
  --time-zone <zone>      extra IANA time zone for matching date-times, such as America/Sao_Paulo;
                          repeat for more (the browser's zone is always used)
  --keep-session          keep the session directory with the raw responses

Setup: call setupE2eMutants(on, config) in setupNodeEvents and return its result,
and import "e2e-mutants/support" in the support file.

Progress and Cypress's own output go to stderr; the summary goes to stdout.
Exit codes: 0 done, 1 score below --min-score, 2 usage or runner error,
128 + signal number when stopped by a signal (130 for Ctrl+C, 143 for SIGTERM).
`;

export class CliError extends Error {}

export interface RunArgs {
  command: 'run';
  specs: string[];
  project: string;
  configFile?: string;
  budget: number;
  seed: number;
  baselines: number;
  browser: string;
  out: string;
  minScore?: number;
  timeZones: string[];
  keepSession: boolean;
}

export interface ReportArgs {
  command: 'report';
  input: string;
  out?: string;
}

export type CliArgs = RunArgs | ReportArgs | { command: 'help' } | { command: 'version' };

function integer(name: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value.trim())) throw new CliError(`--${name} must be a whole number, got "${value}"`);
  const n = Number(value);
  if (n < min) throw new CliError(`--${name} must be at least ${min}, got ${n}`);
  return n;
}

export function splitSpecs(values: readonly string[]): string[] {
  const specs: string[] = [];
  for (const value of values) {
    let depth = 0;
    let current = '';
    for (const ch of value) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        if (current.trim() !== '') specs.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim() !== '') specs.push(current.trim());
  }
  return specs;
}

export function parseCliArgs(argv: readonly string[], cwd: string): CliArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        spec: { type: 'string', multiple: true },
        project: { type: 'string' },
        'config-file': { type: 'string' },
        budget: { type: 'string' },
        seed: { type: 'string' },
        baselines: { type: 'string' },
        browser: { type: 'string' },
        out: { type: 'string' },
        'min-score': { type: 'string' },
        'time-zone': { type: 'string', multiple: true },
        'keep-session': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' }
      }
    });
  } catch (error) {
    throw new CliError((error as Error).message);
  }
  const values = parsed.values as Record<string, string | string[] | boolean | undefined>;
  const str = (key: string): string | undefined => (typeof values[key] === 'string' ? (values[key] as string) : undefined);
  if (values.help) return { command: 'help' };
  if (values.version) return { command: 'version' };
  const [command, ...rest] = parsed.positionals;
  if (command === undefined) throw new CliError('missing command: use "run" or "report"');
  if (command === 'report') {
    if (rest.length !== 1) throw new CliError('report needs exactly one argument: the path of e2e-mutants.json');
    const out = str('out');
    return { command: 'report', input: path.resolve(cwd, rest[0] as string), ...(out !== undefined ? { out: path.resolve(cwd, out) } : {}) };
  }
  if (command !== 'run') throw new CliError(`unknown command "${command}": use "run" or "report"`);
  if (rest.length > 0) throw new CliError(`unexpected argument "${rest[0]}"; pass specs with --spec`);
  const project = path.resolve(cwd, str('project') ?? '.');
  const minScoreText = str('min-score');
  let minScore: number | undefined;
  if (minScoreText !== undefined) {
    minScore = Number(minScoreText);
    if (minScoreText.trim() === '' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new CliError(`--min-score must be a number from 0 to 1, got "${minScoreText}"`);
    }
  }
  const timeZones = (values['time-zone'] as string[] | undefined) ?? [];
  for (const zone of timeZones) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      throw new CliError(`--time-zone "${zone}" is not a time zone this Node.js knows (use an IANA name such as America/Sao_Paulo)`);
    }
  }
  const configFile = str('config-file');
  const args: RunArgs = {
    command: 'run',
    specs: splitSpecs((values.spec as string[] | undefined) ?? []).map((spec) => path.resolve(project, spec)),
    project,
    budget: integer('budget', str('budget'), 20, 1),
    seed: integer('seed', str('seed'), 1, 0),
    baselines: integer('baselines', str('baselines'), 2, 1),
    browser: str('browser') ?? 'electron',
    out: path.resolve(cwd, str('out') ?? 'e2e-mutants-report'),
    timeZones,
    keepSession: values['keep-session'] === true
  };
  if (configFile !== undefined) args.configFile = path.resolve(project, configFile);
  if (minScore !== undefined) args.minScore = minScore;
  return args;
}

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function findCypress(project: string): string {
  const resolved = resolveCypress(project);
  if (resolved === null) {
    throw new CliError(
      `cannot find the "cypress" package from ${project}. Install it in that project (npm install --save-dev cypress) or point --project at the directory that holds your Cypress project.`
    );
  }
  if (loadCypressModule(resolved) === null) throw new CliError(`the cypress package at ${resolved} has no run() function`);
  return resolved;
}

function testState(state: string): TestState {
  return state === 'passed' || state === 'failed' || state === 'pending' || state === 'skipped' ? state : 'missing';
}

const OUTSIDE_TEST = /^An uncaught error was detected outside of a test/;

export function toRoundResult(result: CypressRunResult): RoundResult {
  if (result.status === 'failed' || !Array.isArray(result.runs)) {
    return { ok: false, error: result.message ?? 'cypress.run failed without a message' };
  }
  const tests = new Map<string, TestOutcome>();
  const specErrors = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const run of result.runs) {
    if (run.error) specErrors.set(run.spec.relative, run.error);
    for (const test of run.tests ?? []) {
      if (test.title.length === 1 && OUTSIDE_TEST.test(test.title[0] ?? '')) {
        if (!specErrors.has(run.spec.relative)) specErrors.set(run.spec.relative, test.displayError ?? test.title[0] ?? 'error outside of a test');
        continue;
      }
      const testId = testIdFor(run.spec.relative, test.title);
      if (tests.has(testId)) duplicates.add(testId);
      const outcome: TestOutcome = { testId, spec: run.spec.relative, title: test.title, state: testState(test.state) };
      if (test.displayError) outcome.error = test.displayError;
      tests.set(testId, outcome);
    }
  }
  return { ok: true, tests, specErrors, duplicates };
}

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (os.constants.signals[signal] ?? 1);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  child.kill(signal);
}

function runInWorker(request: WorkerRequest, env: NodeJS.ProcessEnv, onStart: (child: ChildProcess) => void): Promise<RoundResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: RoundResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = fork(path.join(__dirname, 'worker.js'), [], {
      env,
      stdio: ['ignore', 2, 2, 'ipc'],
      detached: process.platform !== 'win32'
    });
    onStart(child);
    child.once('message', (reply: WorkerReply) => done(reply.ok ? toRoundResult(reply.result) : { ok: false, error: reply.error }));
    child.once('error', (error) => done({ ok: false, error: `could not start the Cypress worker: ${error.message}` }));
    child.once('exit', (code, signal) => done({ ok: false, error: `the Cypress worker exited (${signal ?? `code ${code}`}) before it sent results` }));
    child.send(request);
  });
}

function writeReport(report: E2eMutantsReport, outDir: string): { json: string; html: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const json = path.join(outDir, 'e2e-mutants.json');
  const html = path.join(outDir, 'e2e-mutants.html');
  fs.writeFileSync(json, JSON.stringify(report, null, 2));
  fs.writeFileSync(html, renderHtmlReport(report));
  return { json, html };
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`;
}

async function runCommand(args: RunArgs, out: NodeJS.WritableStream, err: NodeJS.WritableStream): Promise<number> {
  if (!fs.existsSync(args.project) || !fs.statSync(args.project).isDirectory()) {
    throw new CliError(`--project ${args.project} is not a directory`);
  }
  const cypressPath = findCypress(args.project);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mutants-'));
  const cleanup = (): void => {
    if (!args.keepSession) fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 3 });
  };
  let worker: ChildProcess | null = null;
  let stopping: NodeJS.Signals | null = null;
  const stop = (signal: NodeJS.Signals): void => {
    cleanup();
    const left = fs.existsSync(sessionDir) && !args.keepSession ? `; could not delete the session directory ${sessionDir}` : '';
    err.write(`e2e-mutants: stopped by ${signal}${args.keepSession ? `; session kept at ${sessionDir}` : left}\n`);
    process.exit(signalExitCode(signal));
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    const child = worker;
    if (stopping !== null) {
      if (child !== null) signalGroup(child, 'SIGKILL');
      stop(stopping);
      return;
    }
    stopping = signal;
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      stop(signal);
      return;
    }
    err.write(`\ne2e-mutants: ${signal} received; stopping Cypress (send it again to force)\n`);
    const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), 15_000);
    child.once('exit', () => {
      clearTimeout(timer);
      stop(signal);
    });
    signalGroup(child, signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const env: NodeJS.ProcessEnv = { ...process.env, [SESSION_ENV]: sessionDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const base: Record<string, unknown> = {
    project: args.project,
    browser: args.browser,
    quiet: true,
    reporter: 'base',
    config: { video: false, screenshotOnRunFailure: false, retries: 0 }
  };
  if (args.configFile !== undefined) base.configFile = args.configFile;
  try {
    const { report, rounds } = await runMutation({
      version: packageVersion(),
      sessionDir,
      specs: args.specs.length > 0 ? args.specs : undefined,
      specLabels: args.specs.map((spec) => path.relative(args.project, spec) || spec),
      budget: args.budget,
      seed: args.seed,
      baselines: args.baselines,
      browser: args.browser,
      minScore: args.minScore ?? null,
      timeZones: args.timeZones,
      specPath: (relative) => path.resolve(args.project, relative),
      log: (line) => err.write(`e2e-mutants: ${line}\n`),
      runRound: (specs) => {
        if (stopping !== null) return new Promise<RoundResult>(() => undefined);
        const options = specs === undefined ? base : { ...base, spec: specs };
        return runInWorker({ cypressPath, options }, env, (child) => {
          worker = child;
        }).then((result) => {
          worker = null;
          return stopping === null ? result : new Promise<RoundResult>(() => undefined);
        });
      }
    });
    const files = writeReport(report, args.out);
    out.write(formatTextSummary(report) + '\n');
    out.write(
      `  rounds: ${rounds.baselines} baseline, ${rounds.mutate} mutation, ${rounds.confirm} confirm; ${duration(Date.now() - started)}\n`
    );
    out.write(`  report: ${files.html}\n          ${files.json}\n`);
    if (args.keepSession) out.write(`  session kept at ${sessionDir} (it holds raw response bodies)\n`);
    if (report.errors.length > 0) return 2;
    if (args.minScore !== undefined && !meetsMinScore(report.summary.score, args.minScore)) {
      out.write(`  score ${formatScore(report.summary.score)} is below --min-score ${args.minScore}\n`);
      return 1;
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanup();
  }
}

function reportCommand(args: ReportArgs, out: NodeJS.WritableStream): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  } catch (error) {
    throw new CliError(`cannot read ${args.input}: ${(error as Error).message}`);
  }
  if (!isE2eMutantsReport(parsed)) throw new CliError(`${args.input} is not a complete e2e-mutants report (schema version 1)`);
  const target = args.out ?? path.join(path.dirname(args.input), 'e2e-mutants.html');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderHtmlReport(parsed));
  out.write(`${target}\n`);
  return 0;
}

export async function main(argv: readonly string[], out: NodeJS.WritableStream = process.stdout, err: NodeJS.WritableStream = process.stderr): Promise<number> {
  try {
    const args = parseCliArgs(argv, process.cwd());
    if (args.command === 'help') {
      out.write(HELP);
      return 0;
    }
    if (args.command === 'version') {
      out.write(packageVersion() + '\n');
      return 0;
    }
    if (args.command === 'report') return reportCommand(args, out);
    return await runCommand(args, out, err);
  } catch (error) {
    if (error instanceof CliError) {
      err.write(`e2e-mutants: ${error.message}\nRun "e2e-mutants --help" for usage.\n`);
      return 2;
    }
    if (error instanceof RunnerError) {
      err.write(`e2e-mutants: ${error.message}\n`);
      return 2;
    }
    err.write(`e2e-mutants: ${(error as Error).stack ?? String(error)}\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
