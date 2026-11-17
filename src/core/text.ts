import type { Evidence, Span } from './types';

export const MAX_SNAPSHOT_LENGTH = 200_000;
export const LONG_STRING_LENGTH = 200;
export const LONG_STRING_PREFIX = 60;

const REMOVED_CHARS = /[­​⁠﻿]/g;
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function normalizeText(input: string): string {
  return input.normalize('NFC').replace(REMOVED_CHARS, '').replace(/\s+/g, ' ').trim();
}

export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (const ch of text) {
    const folded = ch.toLowerCase();
    out += folded.length === ch.length ? folded : ch;
  }
  return out;
}

export function truncateSnapshot(text: string, max = MAX_SNAPSHOT_LENGTH): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && WORD_CHAR.test(ch);
}

export function hasLetterOrDigit(text: string): boolean {
  return LETTER_OR_DIGIT.test(text);
}

export function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text.charAt(index - 1);
}

export function codePointAt(text: string, index: number): string | undefined {
  if (index < 0 || index >= text.length) return undefined;
  const cp = text.codePointAt(index);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

export function findBounded(haystack: string, needle: string, boundedEnd = true, fromIndex = 0): Span | null {
  if (needle === '') return null;
  const checkStart = isWordChar(codePointAt(needle, 0));
  const checkEnd = boundedEnd && isWordChar(codePointBefore(needle, needle.length));
  let from = fromIndex;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) return null;
    const end = start + needle.length;
    const startOk = !checkStart || !isWordChar(codePointBefore(haystack, start));
    const endOk = !checkEnd || !isWordChar(codePointAt(haystack, end));
    if (startOk && endOk) return { start, end };
    from = start + 1;
  }
  return null;
}

export interface StringNeedle {
  needle: string;
  boundedEnd: boolean;
}

export function stringNeedle(value: string): StringNeedle | null {
  const normalized = foldCase(normalizeText(value));
  if (normalized === '') return null;
  const chars = Array.from(normalized);
  if (chars.length <= LONG_STRING_LENGTH) return { needle: normalized, boundedEnd: true };
  return { needle: chars.slice(0, LONG_STRING_PREFIX).join('').trimEnd(), boundedEnd: false };
}

export function findString(foldedHaystack: string, value: string): Span | null {
  const needle = stringNeedle(value);
  return needle ? findBounded(foldedHaystack, needle.needle, needle.boundedEnd) : null;
}

export function findAllStrings(foldedHaystack: string, value: string, limit = Infinity): Span[] {
  const needle = stringNeedle(value);
  if (needle === null) return [];
  const spans: Span[] = [];
  let from = 0;
  while (spans.length < limit) {
    const span = findBounded(foldedHaystack, needle.needle, needle.boundedEnd, from);
    if (span === null) return spans;
    spans.push(span);
    from = span.end;
  }
  return spans;
}

export function makeEvidence(text: string, span: Span, radius = 40): Evidence {
  let from = Math.max(0, span.start - radius);
  let to = Math.min(text.length, span.end + radius);
  const fromCode = text.charCodeAt(from);
  if (from > 0 && fromCode >= 0xdc00 && fromCode <= 0xdfff) from -= 1;
  const toCode = text.charCodeAt(to - 1);
  if (to < text.length && toCode >= 0xd800 && toCode <= 0xdbff) to += 1;
  return {
    before: (from > 0 ? '…' : '') + text.slice(from, span.start),
    match: text.slice(span.start, span.end),
    after: text.slice(span.end, to) + (to < text.length ? '…' : '')
  };
}

export function evidenceText(evidence: Evidence): string {
  return evidence.before + evidence.match + evidence.after;
}
