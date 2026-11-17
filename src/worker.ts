import { createRequire } from 'node:module';
import * as path from 'node:path';

export interface CypressTestResult {
  title: string[];
  state: string;
  displayError: string | null;
}

export interface CypressRunResult {
  status?: string;
  message?: string;
  runs?: Array<{ error: string | null; spec: { relative: string }; tests: CypressTestResult[] | null }>;
}

export interface CypressModule {
  run(options: Record<string, unknown>): Promise<CypressRunResult>;
}

export interface WorkerRequest {
  cypressPath: string;
  options: Record<string, unknown>;
}

export type WorkerReply = { ok: true; result: CypressRunResult } | { ok: false; error: string };

export function resolveCypress(project: string): string | null {
  try {
    return createRequire(path.join(project, 'package.json')).resolve('cypress');
  } catch {
    return null;
  }
}

export function loadCypressModule(resolved: string): CypressModule | null {
  const loaded = require(resolved) as Partial<CypressModule> & { default?: Partial<CypressModule> };
  const api = typeof loaded.run === 'function' ? loaded : loaded.default;
  return api !== undefined && typeof api.run === 'function' ? (api as CypressModule) : null;
}

export function slimResult(result: CypressRunResult): CypressRunResult {
  const slim: CypressRunResult = {};
  if (result.status !== undefined) slim.status = result.status;
  if (result.message !== undefined) slim.message = result.message;
  if (Array.isArray(result.runs)) {
    slim.runs = result.runs.map((run) => ({
      error: run.error ?? null,
      spec: { relative: run.spec.relative },
      tests: run.tests === null ? null : (run.tests ?? []).map((test) => ({ title: test.title, state: test.state, displayError: test.displayError ?? null }))
    }));
  }
  return slim;
}

async function handle(request: WorkerRequest): Promise<WorkerReply> {
  try {
    const api = loadCypressModule(request.cypressPath);
    if (api === null) return { ok: false, error: `the cypress package at ${request.cypressPath} has no run() function` };
    return { ok: true, result: slimResult(await api.run(request.options)) };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? String(error) };
  }
}

if (require.main === module) {
  process.once('message', (request: WorkerRequest) => {
    void handle(request).then((reply) => {
      if (process.send) process.send(reply, () => process.exit(0));
      else process.exit(1);
    });
  });
}
