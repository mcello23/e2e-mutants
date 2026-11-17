import * as fs from 'node:fs';
import * as path from 'node:path';
import { shortHash } from './core/ids';
import type { AppliedRecord, RoundPlan, TestRecording } from './core/types';
import { APPLIED_SUFFIX, PLAN_FILE, RECORD_SUFFIX, ROUNDS_DIR } from './cypress/shared';

export interface RoundData {
  records: Map<string, TestRecording>;
  applied: Map<string, AppliedRecord>;
}

export function planPath(sessionDir: string): string {
  return path.join(sessionDir, PLAN_FILE);
}

export function roundDir(sessionDir: string, tag: string): string {
  return path.join(sessionDir, ROUNDS_DIR, tag.replace(/[^A-Za-z0-9._-]/g, '_'));
}

export function writePlan(sessionDir: string, plan: RoundPlan): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(planPath(sessionDir), JSON.stringify(plan));
}

function isRoundPlan(value: unknown): value is RoundPlan {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as Record<string, unknown>;
  return (
    (plan.mode === 'record' || plan.mode === 'mutate') &&
    typeof plan.round === 'number' &&
    typeof plan.tag === 'string' &&
    typeof plan.mutations === 'object' &&
    plan.mutations !== null
  );
}

export function readPlan(sessionDir: string): RoundPlan {
  const file = planPath(sessionDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`e2e-mutants: cannot read the session plan ${file}: ${(error as Error).message}`);
  }
  if (!isRoundPlan(parsed)) throw new Error(`e2e-mutants: the session plan ${file} is not valid`);
  return parsed;
}

function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return true;
    if (code === 'ENOENT') return false;
    throw error;
  }
}

function writeRoundFile(sessionDir: string, tag: string, testId: string, suffix: string, payload: unknown): boolean {
  const dir = roundDir(sessionDir, tag);
  if (!ensureDir(path.dirname(dir)) || !ensureDir(dir)) return false;
  try {
    fs.writeFileSync(path.join(dir, shortHash(testId) + suffix), JSON.stringify(payload), { mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function writeRecord(sessionDir: string, tag: string, recording: TestRecording): boolean {
  return writeRoundFile(sessionDir, tag, recording.testId, RECORD_SUFFIX, recording);
}

export function writeApplied(sessionDir: string, tag: string, record: AppliedRecord): boolean {
  return writeRoundFile(sessionDir, tag, record.testId, APPLIED_SUFFIX, record);
}

export function readRound(sessionDir: string, tag: string): RoundData {
  const dir = roundDir(sessionDir, tag);
  const data: RoundData = { records: new Map(), applied: new Map() };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return data;
  }
  for (const name of names.sort()) {
    const isRecord = name.endsWith(RECORD_SUFFIX);
    const isApplied = name.endsWith(APPLIED_SUFFIX);
    if (!isRecord && !isApplied) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { testId?: unknown }).testId !== 'string') continue;
    if (isRecord) {
      const recording = parsed as TestRecording;
      data.records.set(recording.testId, recording);
    } else {
      const record = parsed as AppliedRecord;
      data.applied.set(record.testId, record);
    }
  }
  return data;
}
