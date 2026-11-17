import type { AppliedRecord, PlanResponse, RoundPlan, TestRecording } from '../core/types';
import { readPlan, writeApplied, writeRecord } from '../session';
import { APPLIED_TASK, FLAG, PLAN_TASK, RECORD_TASK, SESSION_ENV } from './shared';

export type E2eMutantsTasks = Record<string, (arg: any) => unknown>;

export type E2eMutantsOn = (action: 'task', tasks: E2eMutantsTasks) => void;

export interface E2eMutantsConfig {
  env?: Record<string, unknown>;
  expose?: Record<string, unknown>;
}

interface ActiveSession {
  dir: string;
  plan: RoundPlan;
}

const OFF: PlanResponse = { mode: 'off', mutation: null };

function testIdOf(arg: unknown): string | null {
  if (typeof arg !== 'object' || arg === null) return null;
  const testId = (arg as { testId?: unknown }).testId;
  return typeof testId === 'string' && testId !== '' ? testId : null;
}

function planFor(session: ActiveSession | null, arg: unknown): PlanResponse {
  const testId = testIdOf(arg);
  if (session === null || testId === null) return OFF;
  if (session.plan.mode === 'record') return { mode: 'record', mutation: null };
  const mutation = Object.prototype.hasOwnProperty.call(session.plan.mutations, testId) ? session.plan.mutations[testId] : undefined;
  return mutation === undefined ? OFF : { mode: 'mutate', mutation };
}

function enable<C extends E2eMutantsConfig>(config: C): C {
  if (config.expose !== undefined && config.expose !== null) config.expose[FLAG] = true;
  else config.env = { ...(config.env ?? {}), [FLAG]: true };
  return config;
}

function isThenable<C>(value: C | PromiseLike<C>): value is PromiseLike<C> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

export function setupE2eMutants<C extends E2eMutantsConfig>(on: E2eMutantsOn, config: C): C;
export function setupE2eMutants<C extends E2eMutantsConfig>(on: E2eMutantsOn, config: PromiseLike<C>): Promise<C>;
export function setupE2eMutants<C extends E2eMutantsConfig>(on: E2eMutantsOn, config: C | PromiseLike<C>): C | Promise<C> {
  const dir = process.env[SESSION_ENV];
  const session: ActiveSession | null = dir ? { dir, plan: readPlan(dir) } : null;
  on('task', {
    [PLAN_TASK]: (arg: unknown) => planFor(session, arg),
    [RECORD_TASK]: (arg: unknown) => {
      if (session !== null && session.plan.mode === 'record' && testIdOf(arg) !== null) {
        writeRecord(session.dir, session.plan.tag, arg as TestRecording);
      }
      return null;
    },
    [APPLIED_TASK]: (arg: unknown) => {
      if (session !== null && session.plan.mode === 'mutate' && testIdOf(arg) !== null) {
        writeApplied(session.dir, session.plan.tag, arg as AppliedRecord);
      }
      return null;
    }
  });
  if (isThenable(config)) return Promise.resolve(config).then((resolved) => (session === null ? resolved : enable(resolved)));
  return session === null ? config : enable(config);
}
