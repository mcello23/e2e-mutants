import { shiftIsoDate } from './dates';
import { describeValue, getAtPath, isNumericString, setAtPath } from './leaves';
import { foldCase, normalizeText } from './text';
import type { FieldKind, FieldStatus, JsonPrimitive, Mutation, MutationApplication, OperatorName, PathSegment } from './types';

export const OPERATORS: readonly OperatorName[] = [
  'num-shift',
  'str-reverse',
  'str-empty',
  'date-shift',
  'set-null',
  'array-drop-first',
  'array-empty'
];

export const DATE_SHIFT_DAYS = 3;

export type OperatorResult = { ok: true; value: unknown } | { ok: false; reason: string };

export interface OperatorTarget {
  kind: FieldKind;
  status: FieldStatus;
  value?: JsonPrimitive;
  length?: number;
}

export function operatorsFor(target: OperatorTarget): OperatorName[] {
  if (target.status !== 'observed') return [];
  switch (target.kind) {
    case 'number':
      return ['num-shift', 'set-null'];
    case 'string':
      return typeof target.value === 'string' && isNumericString(target.value)
        ? ['num-shift', 'set-null']
        : ['str-reverse', 'str-empty', 'set-null'];
    case 'date':
      return ['date-shift', 'set-null'];
    case 'array': {
      const length = target.length ?? 0;
      if (length >= 2) return ['array-drop-first', 'array-empty'];
      return length === 1 ? ['array-empty'] : [];
    }
    default:
      return [];
  }
}

export function decimalsOf(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return 0;
  const text = String(value);
  const exponentAt = text.indexOf('e');
  const mantissa = exponentAt === -1 ? text : text.slice(0, exponentAt);
  const exponent = exponentAt === -1 ? 0 : Number(text.slice(exponentAt + 1));
  const dot = mantissa.indexOf('.');
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaDecimals - exponent);
}

export function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

export function shiftNumber(value: number, decimals = decimalsOf(value)): number {
  if (Number.isInteger(value) && decimals === 0) return value + Math.max(7, Math.round(Math.abs(value) * 0.37));
  let shifted: number;
  if (value > 0 && value <= 1) shifted = roundTo(value < 0.5 ? value + 0.37 : value - 0.37, 2);
  else shifted = roundTo(value * 1.37 + 7.13, Math.max(decimals, 2));
  if (roundTo(shifted, 2) === roundTo(value, 2)) shifted = roundTo(value + 7.13, Math.max(decimals, 2));
  return shifted;
}

export function shiftNumericString(value: string): string {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const decimals = fraction.length;
  const original = Number(value);
  const shifted = shiftNumber(original, decimals);
  let text = decimals > 0 ? shifted.toFixed(decimals) : String(shifted);
  if (roundTo(Number(text), 2) === roundTo(original, 2)) text = (original + 7).toFixed(decimals);
  if (whole.length > 1 && whole.startsWith('0')) {
    const negative = text.startsWith('-');
    const digits = negative ? text.slice(1) : text;
    const [shiftedWhole = '', shiftedFraction] = digits.split('.');
    const padded = shiftedWhole.padStart(whole.length, '0') + (shiftedFraction === undefined ? '' : `.${shiftedFraction}`);
    text = (negative ? '-' : '') + padded;
  }
  return text;
}

export function reverseString(value: string): string {
  const reversed = Array.from(value.normalize('NFC')).reverse().join('');
  return foldCase(normalizeText(reversed)) === foldCase(normalizeText(value)) ? reversed + 'zq' : reversed;
}

export function applyOperator(operator: OperatorName, value: unknown): OperatorResult {
  switch (operator) {
    case 'num-shift':
      if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: shiftNumber(value) };
      if (typeof value === 'string' && isNumericString(value)) return { ok: true, value: shiftNumericString(value) };
      return { ok: false, reason: 'value is not numeric' };
    case 'str-reverse':
      if (typeof value === 'string' && value !== '') return { ok: true, value: reverseString(value) };
      return { ok: false, reason: 'value is not a non-empty string' };
    case 'str-empty':
      if (typeof value === 'string' && value !== '') return { ok: true, value: '' };
      return { ok: false, reason: 'value is not a non-empty string' };
    case 'date-shift': {
      const shifted = typeof value === 'string' ? shiftIsoDate(value, DATE_SHIFT_DAYS) : null;
      return shifted === null ? { ok: false, reason: 'value is not an ISO date' } : { ok: true, value: shifted };
    }
    case 'set-null':
      if (value !== null && value !== undefined) return { ok: true, value: null };
      return { ok: false, reason: 'value is already null' };
    case 'array-drop-first':
      if (Array.isArray(value) && value.length > 0) return { ok: true, value: value.slice(1) };
      return { ok: false, reason: 'value is not a non-empty array' };
    case 'array-empty':
      if (Array.isArray(value) && value.length > 0) return { ok: true, value: [] };
      return { ok: false, reason: 'value is not a non-empty array' };
    default:
      return { ok: false, reason: `unknown operator ${String(operator)}` };
  }
}

export function applyMutationInPlace(body: unknown, mutation: Pick<Mutation, 'path' | 'operator'>): MutationApplication {
  const target = getAtPath(body, mutation.path);
  if (!target.found) return { applied: false, body, reason: 'path not found in response' };
  const result = applyOperator(mutation.operator, target.value);
  if (!result.ok) return { applied: false, body, reason: result.reason };
  const change = { before: describeValue(target.value), after: describeValue(result.value) };
  const last = mutation.path[mutation.path.length - 1];
  if (last === undefined) {
    if (Array.isArray(body) && Array.isArray(result.value)) {
      body.splice(0, body.length, ...result.value);
      return { applied: true, body, ...change };
    }
    return { applied: true, body: result.value, ...change };
  }
  const parent = getAtPath(body, mutation.path.slice(0, -1)).value as Record<PathSegment, unknown>;
  parent[last] = result.value;
  return { applied: true, body, ...change };
}

export function applyMutation(body: unknown, mutation: Pick<Mutation, 'path' | 'operator'>): MutationApplication {
  const target = getAtPath(body, mutation.path);
  if (!target.found) return { applied: false, body, reason: 'path not found in response' };
  const result = applyOperator(mutation.operator, target.value);
  if (!result.ok) return { applied: false, body, reason: result.reason };
  return {
    applied: true,
    body: setAtPath(body, mutation.path, result.value),
    before: describeValue(target.value),
    after: describeValue(result.value)
  };
}
