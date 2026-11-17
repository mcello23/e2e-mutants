import { findDateMentions, findTimeSpans, isoDateCandidates, type DateMention } from './dates';
import { ALL_OCCURRENCES, fieldIdFor } from './ids';
import { formatPath, formatSegment, walkJson, type Leaf } from './leaves';
import { extractNumberTokens, NumberIndex } from './numbers';
import { keyResponses } from './requests';
import { findAllStrings, foldCase, hasLetterOrDigit, makeEvidence, normalizeText } from './text';
import type { Evidence, FieldKind, FieldStatus, JsonPrimitive, PathSegment, Span, TestRecording } from './types';

export const SENSITIVE_KEY =
  /password|passwd|secret|token|authorization|cookie|api[_-]?key|session|credential|private[_-]?key|access[_-]?key|bearer|jwt|card[_-]?number/i;
export const SENSITIVE_WORDS: ReadonlySet<string> = new Set(['ssn', 'otp', 'cvv', 'cvc', 'pin']);
export const REDACTED = '[redacted]';
export const MATCH_LIMIT = 10;
export const REPORT_VALUE_LIMIT = 60;

const MIN_SECRET_LENGTH = 4;
const MIN_SECRET_DIGITS = 6;

export interface FieldObservation {
  id: string;
  requestKey: string;
  occurrence: number;
  path: PathSegment[];
  pathText: string;
  kind: FieldKind;
  status: FieldStatus;
  value?: JsonPrimitive;
  length?: number;
  evidence?: Evidence;
}

export interface TestObservation {
  testId: string;
  fields: FieldObservation[];
}

export interface ObserveOptions {
  timeZones?: readonly string[];
  evidenceRadius?: number;
}

export interface TextIndex {
  text: string;
  folded: string;
  numbers: NumberIndex;
  dates: Map<string, DateMention[]>;
}

function keyWords(key: string): string[] {
  return key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || keyWords(key).some((word) => SENSITIVE_WORDS.has(word));
}

export function isSensitivePath(path: readonly PathSegment[]): boolean {
  return path.some((segment) => typeof segment === 'string' && isSensitiveKey(segment));
}

export function redactSensitive(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactSensitive);
  if (typeof body !== 'object' || body === null) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    Object.defineProperty(out, key, {
      value: isSensitiveKey(key) ? REDACTED : redactSensitive(value),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return out;
}

export function collectSensitiveValues(body: unknown): string[] {
  const values = new Set<string>();
  const addAll = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) addAll(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) addAll(child);
      return;
    }
    if (typeof value === 'string') {
      const text = normalizeText(value);
      if (Array.from(text).length >= MIN_SECRET_LENGTH) values.add(text);
    } else if (typeof value === 'number' && Number.isFinite(value) && String(Math.abs(Math.trunc(value))).length >= MIN_SECRET_DIGITS) {
      values.add(String(value));
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) addAll(child);
      else visit(child);
    }
  };
  visit(body);
  return [...values].sort((a, b) => b.length - a.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === '') continue;
    out = out.replace(new RegExp(escapeRegExp(secret), 'giu'), REDACTED);
  }
  return out;
}

export function reportValue(value: JsonPrimitive | undefined): JsonPrimitive | undefined {
  if (typeof value !== 'string') return value;
  const chars = Array.from(value);
  return chars.length > REPORT_VALUE_LIMIT ? chars.slice(0, REPORT_VALUE_LIMIT - 1).join('') + '…' : value;
}

export function isTrivialLeaf(leaf: Pick<Leaf, 'kind' | 'value' | 'numeric'>): boolean {
  if (leaf.kind === 'boolean' || leaf.kind === 'null') return true;
  if (leaf.kind === 'number') return leaf.numeric === null || (Number.isInteger(leaf.numeric) && Math.abs(leaf.numeric) < 10);
  if (typeof leaf.value !== 'string') return true;
  const trimmed = normalizeText(leaf.value);
  if (Array.from(trimmed).length < 3 || !hasLetterOrDigit(trimmed)) return true;
  if (leaf.kind === 'string' && leaf.numeric !== null) return Number.isInteger(leaf.numeric) && Math.abs(leaf.numeric) < 10;
  return false;
}

export function buildTextIndex(snapshot: string): TextIndex {
  const text = normalizeText(snapshot);
  const folded = foldCase(text);
  const mentions = findDateMentions(folded);
  const exclude: Span[] = [...mentions, ...findTimeSpans(text)];
  const numbers = new NumberIndex(extractNumberTokens(text, exclude));
  const dates = new Map<string, DateMention[]>();
  for (const mention of mentions) {
    for (const key of mention.dates) {
      const list = dates.get(key);
      if (list === undefined) dates.set(key, [mention]);
      else list.push(mention);
    }
  }
  return { text, folded, numbers, dates };
}

function evidenceFor(index: TextIndex, spans: readonly Span[], radius: number): Evidence | null {
  const [first] = spans;
  if (first === undefined) return null;
  const evidence = makeEvidence(index.text, first, radius);
  return spans.length > 1 ? { ...evidence, matches: Math.min(spans.length, MATCH_LIMIT) } : evidence;
}

export function findLeafInText(
  leaf: Pick<Leaf, 'kind' | 'value' | 'numeric'>,
  index: TextIndex,
  options: ObserveOptions = {}
): Evidence | null {
  const radius = options.evidenceRadius ?? 40;
  if (leaf.numeric !== null) {
    const evidence = evidenceFor(index, index.numbers.findAll(leaf.numeric), radius);
    if (evidence !== null) return evidence;
  }
  if (typeof leaf.value !== 'string') return null;
  if (leaf.kind === 'date') {
    for (const key of isoDateCandidates(leaf.value, options.timeZones ?? [])) {
      const evidence = evidenceFor(index, index.dates.get(key) ?? [], radius);
      if (evidence !== null) return evidence;
    }
  }
  return evidenceFor(index, findAllStrings(index.folded, leaf.value, MATCH_LIMIT), radius);
}

function observedPrefixes(fields: readonly FieldObservation[], arrayPaths: ReadonlySet<string>): Map<string, Evidence> {
  const witnesses = new Map<string, Evidence>();
  if (arrayPaths.size === 0) return witnesses;
  for (const field of fields) {
    if (field.status !== 'observed' || field.evidence === undefined) continue;
    let prefix = '$';
    for (let i = 0; i < field.path.length; i++) {
      if (arrayPaths.has(prefix) && !witnesses.has(prefix)) witnesses.set(prefix, field.evidence);
      prefix += formatSegment(field.path[i] as PathSegment);
    }
  }
  return witnesses;
}

function sameField(a: FieldObservation, b: FieldObservation): boolean {
  return a.kind === b.kind && a.status === b.status && a.value === b.value && a.length === b.length;
}

export function mergeRepeatedResponses(fields: readonly FieldObservation[]): FieldObservation[] {
  const groups = new Map<string, FieldObservation[]>();
  for (const field of fields) {
    const key = `${field.requestKey}\u0000${field.pathText}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [field]);
    else list.push(field);
  }
  const out: FieldObservation[] = [];
  for (const list of groups.values()) {
    const [first] = list;
    if (first === undefined) continue;
    if (list.length > 1 && list.every((field) => sameField(field, first))) {
      out.push({ ...first, id: fieldIdFor(first.requestKey, ALL_OCCURRENCES, first.pathText), occurrence: ALL_OCCURRENCES });
    } else {
      for (const field of list) out.push(field);
    }
  }
  return out;
}

export function observeTest(recording: TestRecording, options: ObserveOptions = {}): TestObservation {
  const timeZones = [...(options.timeZones ?? []), ...(recording.timeZone ? [recording.timeZone] : [])];
  const effective: ObserveOptions = { ...options, timeZones };
  const indexes = [...new Set(recording.domSnapshots)].map(buildTextIndex).filter((index) => index.text !== '');
  const fields: FieldObservation[] = [];
  for (const response of keyResponses(recording.responses)) {
    const requestKey = response.key;
    const occurrence = response.occurrence;
    const walk = walkJson(response.body);
    const leafFields: FieldObservation[] = [];
    for (const leaf of walk.leaves) {
      const pathText = formatPath(leaf.path);
      const base = { id: fieldIdFor(requestKey, occurrence, pathText), requestKey, occurrence, path: leaf.path, pathText, kind: leaf.kind };
      if (isSensitivePath(leaf.path)) {
        leafFields.push({ ...base, status: 'sensitive' });
        continue;
      }
      if (isTrivialLeaf(leaf)) {
        leafFields.push({ ...base, status: 'trivial', value: reportValue(leaf.value) as JsonPrimitive });
        continue;
      }
      let evidence: Evidence | null = null;
      for (const index of indexes) {
        evidence = findLeafInText(leaf, index, effective);
        if (evidence !== null) break;
      }
      leafFields.push(
        evidence === null
          ? { ...base, status: 'unobserved', value: reportValue(leaf.value) as JsonPrimitive }
          : { ...base, status: 'observed', value: leaf.value, evidence }
      );
    }
    const arrayTexts = walk.arrays.map((array) => formatPath(array.path));
    const witnesses = observedPrefixes(leafFields, new Set(arrayTexts));
    walk.arrays.forEach((array, i) => {
      const pathText = arrayTexts[i] as string;
      const base = {
        id: fieldIdFor(requestKey, occurrence, pathText),
        requestKey,
        occurrence,
        path: array.path,
        pathText,
        kind: 'array' as const,
        length: array.length
      };
      if (isSensitivePath(array.path)) {
        fields.push({ ...base, status: 'sensitive' });
        return;
      }
      if (array.length === 0) {
        fields.push({ ...base, status: 'trivial' });
        return;
      }
      const witness = witnesses.get(pathText);
      fields.push(witness === undefined ? { ...base, status: 'unobserved' } : { ...base, status: 'observed', evidence: witness });
    });
    for (const field of leafFields) fields.push(field);
  }
  return { testId: recording.testId, fields: mergeRepeatedResponses(fields) };
}

export function mergeBaselineObservations(observations: readonly TestObservation[]): TestObservation {
  const [first] = observations;
  if (first === undefined) throw new Error('mergeBaselineObservations needs at least one observation');
  const merged = new Map<string, FieldObservation>();
  const observedCount = new Map<string, number>();
  for (const observation of observations) {
    for (const field of observation.fields) {
      if (!merged.has(field.id)) merged.set(field.id, field);
      if (field.status === 'observed') observedCount.set(field.id, (observedCount.get(field.id) ?? 0) + 1);
    }
  }
  const fields: FieldObservation[] = [];
  for (const field of merged.values()) {
    if (field.status === 'observed' && (observedCount.get(field.id) ?? 0) < observations.length) {
      const { evidence: _evidence, ...rest } = field;
      const demoted: FieldObservation = { ...rest, status: 'unobserved' };
      if (rest.value !== undefined) demoted.value = reportValue(rest.value) as JsonPrimitive;
      fields.push(demoted);
    } else {
      fields.push(field);
    }
  }
  return { testId: first.testId, fields };
}

export function observedFields(observation: TestObservation): FieldObservation[] {
  return observation.fields.filter((field) => field.status === 'observed');
}
