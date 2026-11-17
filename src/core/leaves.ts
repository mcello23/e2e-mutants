import { isIsoDateString } from './dates';
import type { JsonPrimitive, LeafKind, PathSegment } from './types';

export interface Leaf {
  path: PathSegment[];
  value: JsonPrimitive;
  kind: LeafKind;
  numeric: number | null;
}

export interface ArrayNode {
  path: PathSegment[];
  length: number;
}

export interface JsonWalk {
  leaves: Leaf[];
  arrays: ArrayNode[];
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMERIC_STRING = /^-?(\d{1,15})(?:\.(\d{1,15}))?$/;

export function isNumericString(value: string): boolean {
  return NUMERIC_STRING.test(value) && Number.isFinite(Number(value));
}

export function leafKind(value: JsonPrimitive): LeafKind {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return isIsoDateString(value) ? 'date' : 'string';
}

export function toLeaf(path: PathSegment[], value: JsonPrimitive): Leaf {
  const kind = leafKind(value);
  let numeric: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) numeric = value;
  else if (kind === 'string' && typeof value === 'string' && isNumericString(value)) numeric = Number(value);
  return { path, value, kind, numeric };
}

function isPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

export function walkJson(body: unknown): JsonWalk {
  const leaves: Leaf[] = [];
  const arrays: ArrayNode[] = [];
  const visit = (value: unknown, path: PathSegment[]): void => {
    if (Array.isArray(value)) {
      arrays.push({ path, length: value.length });
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (isPrimitive(value)) {
      leaves.push(toLeaf(path, value));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  };
  visit(body, []);
  return { leaves, arrays };
}

export function formatSegment(segment: PathSegment): string {
  if (typeof segment === 'number') return `[${segment}]`;
  return IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
}

export function formatPath(path: readonly PathSegment[]): string {
  let out = '$';
  for (const segment of path) out += formatSegment(segment);
  return out;
}

export function generalizePath(path: readonly PathSegment[]): string {
  return formatPath(path).replace(/\[\d+\]/g, '[*]');
}

export function getAtPath(root: unknown, path: readonly PathSegment[]): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) return { found: false, value: undefined };
      current = current[segment];
    } else {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) return { found: false, value: undefined };
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false, value: undefined };
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

export function setAtPath(root: unknown, path: readonly PathSegment[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [PathSegment, ...PathSegment[]];
  if (typeof head === 'number') {
    if (!Array.isArray(root)) return root;
    const copy = root.slice();
    copy[head] = setAtPath(root[head], rest, value);
    return copy;
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return root;
  const record = root as Record<string, unknown>;
  return { ...record, [head]: setAtPath(record[head], rest, value) };
}

export function describeValue(value: unknown, max = 120): string {
  let text: string;
  if (Array.isArray(value)) text = describeArrayLength(value.length);
  else if (value === undefined) text = 'undefined';
  else if (typeof value === 'object' && value !== null) text = '{…}';
  else text = JSON.stringify(value) ?? String(value);
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
}

export function describeArrayLength(length: number): string {
  return length === 1 ? '[1 item]' : `[${length} items]`;
}
