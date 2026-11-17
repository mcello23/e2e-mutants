import { isWordChar } from './text';
import type { Span } from './types';

export interface NumberInterpretation {
  value: number;
  decimals: number;
}

export interface NumberToken {
  raw: string;
  start: number;
  end: number;
  negative: boolean;
  percent: boolean;
  currency: string | null;
  interpretations: NumberInterpretation[];
}

const MINUS_SIGNS = new Set(['-', '−']);
const PREFIX_CURRENCIES = ['US$', 'R$', '$', '€', 'BRL', 'USD', 'EUR'];
const SUFFIX_CURRENCIES = ['US$', 'R$', '€', '$', 'BRL', 'USD', 'EUR'];
const CURRENCY_CODES = new Set(['BRL', 'USD', 'EUR']);
const CURRENCY_NAMES: Record<string, string> = {
  'US$': 'USD',
  'R$': 'BRL',
  $: '$',
  '€': 'EUR',
  BRL: 'BRL',
  USD: 'USD',
  EUR: 'EUR'
};
const LETTER = /^[\p{L}\p{M}]$/u;

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && LETTER.test(ch);
}

function isGroupedInteger(parts: string[]): boolean {
  const [first, ...rest] = parts;
  if (first === undefined || first.length < 1 || first.length > 3) return false;
  if (first.length > 1 && first.startsWith('0')) return false;
  if (first === '0') return false;
  return rest.length > 0 && rest.every((part) => part.length === 3);
}

export function parseNumberLiteral(literal: string): NumberInterpretation[] {
  if (!/^\d(?:[\d.,]*\d)?$/.test(literal)) return [];
  const dots = literal.split('.').length - 1;
  const commas = literal.split(',').length - 1;
  if (dots === 0 && commas === 0) return [{ value: Number(literal), decimals: 0 }];
  if (dots > 0 && commas > 0) {
    const decimalSep = literal.lastIndexOf('.') > literal.lastIndexOf(',') ? '.' : ',';
    const groupSep = decimalSep === '.' ? ',' : '.';
    if ((decimalSep === '.' ? dots : commas) !== 1) return [];
    const at = literal.lastIndexOf(decimalSep);
    const intPart = literal.slice(0, at);
    const fraction = literal.slice(at + 1);
    const groups = intPart.split(groupSep);
    if (!isGroupedInteger(groups) || groups.some((group) => !/^\d+$/.test(group))) return [];
    return [{ value: Number(groups.join('') + '.' + fraction), decimals: fraction.length }];
  }
  const sep = dots > 0 ? '.' : ',';
  const parts = literal.split(sep);
  if (parts.some((part) => part === '')) return [];
  if (parts.length === 2) {
    const [whole = '', fraction = ''] = parts;
    const out: NumberInterpretation[] = [{ value: Number(whole + '.' + fraction), decimals: fraction.length }];
    if (isGroupedInteger(parts)) out.push({ value: Number(whole + fraction), decimals: 0 });
    return out;
  }
  return isGroupedInteger(parts) ? [{ value: Number(parts.join('')), decimals: 0 }] : [];
}

function currencyEndingAt(text: string, end: number): string | null {
  for (const symbol of PREFIX_CURRENCIES) {
    if (end - symbol.length < 0 || !text.startsWith(symbol, end - symbol.length)) continue;
    if (CURRENCY_CODES.has(symbol) && isLetter(text[end - symbol.length - 1])) continue;
    return symbol;
  }
  return null;
}

function currencyStartingAt(text: string, start: number): string | null {
  for (const symbol of SUFFIX_CURRENCIES) {
    if (!text.startsWith(symbol, start)) continue;
    if (CURRENCY_CODES.has(symbol) && isLetter(text[start + symbol.length])) continue;
    return symbol;
  }
  return null;
}

interface PrefixScan {
  start: number;
  negative: boolean;
  currency: string | null;
}

function scanPrefix(text: string, digitsStart: number): PrefixScan | null {
  let start = digitsStart;
  let negative = false;
  let currency: string | null = null;
  const previous = text[start - 1];
  if (previous === '_') return null;
  if (isLetter(previous)) {
    const code = currencyEndingAt(text, start);
    if (code === null || !CURRENCY_CODES.has(code)) return null;
  }
  if (previous !== undefined && MINUS_SIGNS.has(previous)) {
    if (isWordChar(text[start - 2])) return null;
    negative = true;
    start -= 1;
  }
  const probe = text[start - 1] === ' ' ? start - 1 : start;
  const symbol = currencyEndingAt(text, probe);
  if (symbol !== null) {
    currency = CURRENCY_NAMES[symbol] ?? null;
    start = probe - symbol.length;
    const beforeSymbol = text[start - 1];
    if (!negative && beforeSymbol !== undefined && MINUS_SIGNS.has(beforeSymbol) && !isWordChar(text[start - 2])) {
      negative = true;
      start -= 1;
    }
  }
  return { start, negative, currency };
}

interface SuffixScan {
  end: number;
  percent: boolean;
  currency: string | null;
}

function scanSuffix(text: string, digitsEnd: number): SuffixScan | null {
  const next = text[digitsEnd];
  if (next === '_') return null;
  if (next !== undefined && MINUS_SIGNS.has(next) && isWordChar(text[digitsEnd + 1])) return null;
  const probe = text[digitsEnd] === ' ' ? digitsEnd + 1 : digitsEnd;
  if (text[probe] === '%') return { end: probe + 1, percent: true, currency: null };
  const symbol = currencyStartingAt(text, probe);
  if (symbol !== null) return { end: probe + symbol.length, percent: false, currency: CURRENCY_NAMES[symbol] ?? null };
  return { end: digitsEnd, percent: false, currency: null };
}

export function extractNumberTokens(text: string, exclude: readonly Span[] = []): NumberToken[] {
  const spans = [...exclude].sort((a, b) => a.start - b.start);
  const tokens: NumberToken[] = [];
  let pointer = 0;
  for (const match of text.matchAll(/\d(?:[\d.,]*\d)?/g)) {
    const digitsStart = match.index ?? 0;
    const digitsEnd = digitsStart + match[0].length;
    while (pointer < spans.length && (spans[pointer]?.end ?? 0) <= digitsStart) pointer += 1;
    const span = spans[pointer];
    if (span !== undefined && span.start < digitsEnd) continue;
    const interpretations = parseNumberLiteral(match[0]);
    if (interpretations.length === 0) continue;
    const prefix = scanPrefix(text, digitsStart);
    if (prefix === null) continue;
    const suffix = scanSuffix(text, digitsEnd);
    if (suffix === null) continue;
    tokens.push({
      raw: text.slice(prefix.start, suffix.end),
      start: prefix.start,
      end: suffix.end,
      negative: prefix.negative,
      percent: suffix.percent,
      currency: prefix.currency ?? suffix.currency,
      interpretations
    });
  }
  return tokens;
}

export function toleranceFor(decimals: number, magnitude: number): number {
  return 0.5 * 10 ** -decimals + 1e-12 * Math.max(1, Math.abs(magnitude));
}

export function numberMatchesToken(value: number, token: NumberToken): boolean {
  if (!Number.isFinite(value)) return false;
  const candidates = token.percent ? [value * 100, value] : [value];
  for (const interpretation of token.interpretations) {
    const shown = token.negative ? -interpretation.value : interpretation.value;
    for (const candidate of candidates) {
      if (!token.percent && interpretation.decimals === 0 && !Number.isInteger(candidate) && Math.abs(candidate) < 10) continue;
      const tolerance = toleranceFor(interpretation.decimals, candidate);
      if (Math.abs(shown - candidate) <= tolerance) return true;
      if (!token.negative && Math.abs(interpretation.value - Math.abs(candidate)) <= tolerance) return true;
    }
  }
  return false;
}

function bucketKey(decimals: number, scaled: number): string {
  return `${decimals}:${scaled}`;
}

export class NumberIndex {
  readonly tokens: readonly NumberToken[];
  private readonly buckets = new Map<string, NumberToken[]>();
  private readonly decimals: number[] = [];

  constructor(tokens: readonly NumberToken[]) {
    this.tokens = tokens;
    const seen = new Set<number>();
    for (const token of tokens) {
      for (const interpretation of token.interpretations) {
        if (!seen.has(interpretation.decimals)) {
          seen.add(interpretation.decimals);
          this.decimals.push(interpretation.decimals);
        }
        const key = bucketKey(interpretation.decimals, Math.round(interpretation.value * 10 ** interpretation.decimals));
        const list = this.buckets.get(key);
        if (list === undefined) this.buckets.set(key, [token]);
        else if (list[list.length - 1] !== token) list.push(token);
      }
    }
  }

  find(value: number): NumberToken | null {
    return this.findAll(value)[0] ?? null;
  }

  findAll(value: number): NumberToken[] {
    if (!Number.isFinite(value)) return [];
    const magnitudes = [...new Set([Math.abs(value), Math.abs(value * 100)])];
    const found = new Set<NumberToken>();
    for (const decimals of this.decimals) {
      const scale = 10 ** decimals;
      for (const magnitude of magnitudes) {
        const scaled = Math.round(magnitude * scale);
        for (const key of [scaled - 1, scaled, scaled + 1]) {
          for (const token of this.buckets.get(bucketKey(decimals, key)) ?? []) {
            if (!found.has(token) && numberMatchesToken(value, token)) found.add(token);
          }
        }
      }
    }
    return [...found].sort((a, b) => a.start - b.start);
  }
}

export function findNumber(value: number, tokens: readonly NumberToken[]): NumberToken | null {
  return tokens.find((token) => numberMatchesToken(value, token)) ?? null;
}
