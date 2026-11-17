import { hash32, mutantIdFor } from './ids';
import { describeArrayLength, describeValue } from './leaves';
import type { FieldObservation } from './observe';
import { applyOperator, OPERATORS, operatorsFor } from './operators';
import type { Evidence, FieldKind, Mutation } from './types';

export interface PlannedMutant extends Mutation {
  fieldId: string;
  kind: FieldKind;
  before: string;
  after: string;
  evidence?: Evidence;
}

export interface PlanOptions {
  budget: number;
  seed: number;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function preview(field: FieldObservation, operator: PlannedMutant['operator']): { before: string; after: string } {
  if (field.kind === 'array') {
    const length = field.length ?? 0;
    return {
      before: describeArrayLength(length),
      after: describeArrayLength(operator === 'array-drop-first' ? Math.max(0, length - 1) : 0)
    };
  }
  const result = applyOperator(operator, field.value);
  return { before: describeValue(field.value), after: result.ok ? describeValue(result.value) : describeValue(null) };
}

export function mutationCandidates(testId: string, fields: readonly FieldObservation[]): PlannedMutant[] {
  const candidates: PlannedMutant[] = [];
  for (const field of fields) {
    for (const operator of operatorsFor(field)) {
      const { before, after } = preview(field, operator);
      const candidate: PlannedMutant = {
        id: mutantIdFor(testId, field.requestKey, field.occurrence, field.pathText, operator),
        testId,
        requestKey: field.requestKey,
        occurrence: field.occurrence,
        path: field.path,
        pathText: field.pathText,
        operator,
        fieldId: field.id,
        kind: field.kind,
        before,
        after
      };
      if (field.evidence !== undefined) candidate.evidence = field.evidence;
      candidates.push(candidate);
    }
  }
  return candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

export function planMutants(testId: string, fields: readonly FieldObservation[], options: PlanOptions): PlannedMutant[] {
  const budget = Math.max(0, Math.floor(options.budget));
  const candidates = mutationCandidates(testId, fields);
  if (budget === 0 || candidates.length === 0) return [];
  const byField = new Map<string, PlannedMutant[]>();
  for (const candidate of candidates) {
    const list = byField.get(candidate.fieldId);
    if (list === undefined) byField.set(candidate.fieldId, [candidate]);
    else list.push(candidate);
  }
  for (const list of byField.values()) list.sort((a, b) => OPERATORS.indexOf(a.operator) - OPERATORS.indexOf(b.operator));
  const random = mulberry32(hash32(`${options.seed}\u0000${testId}`));
  const order = shuffle([...byField.keys()], random);
  const rotation = new Map<string, number>();
  const start = new Map<string, number>();
  for (const fieldId of order) {
    const list = byField.get(fieldId) ?? [];
    const signature = list.map((candidate) => candidate.operator).join(',');
    const next = rotation.get(signature) ?? Math.floor(random() * list.length);
    start.set(fieldId, next);
    rotation.set(signature, next + 1);
  }
  const depth = Math.max(...[...byField.values()].map((list) => list.length));
  const planned: PlannedMutant[] = [];
  for (let stratum = 0; stratum < depth && planned.length < budget; stratum++) {
    for (const fieldId of order) {
      if (planned.length >= budget) break;
      const list = byField.get(fieldId) ?? [];
      if (stratum >= list.length) continue;
      const pick = list[((start.get(fieldId) ?? 0) + stratum) % list.length];
      if (pick !== undefined) planned.push(pick);
    }
  }
  return planned;
}
