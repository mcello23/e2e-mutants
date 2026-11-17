import type { Span } from './types';

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface IsoDate {
  literal: string;
  utc: string;
  hasTime: boolean;
  hasOffset: boolean;
  instant: number | null;
}

export interface DateMention extends Span {
  raw: string;
  dates: string[];
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

const MONTH_NAMES: ReadonlyArray<readonly [number, readonly string[]]> = [
  [1, ['january', 'jan', 'janeiro', 'enero', 'ene']],
  [2, ['february', 'feb', 'fevereiro', 'fev', 'febrero']],
  [3, ['march', 'mar', 'março', 'marzo']],
  [4, ['april', 'apr', 'abril', 'abr']],
  [5, ['may', 'maio', 'mai', 'mayo']],
  [6, ['june', 'jun', 'junho', 'junio']],
  [7, ['july', 'jul', 'julho', 'julio']],
  [8, ['august', 'aug', 'agosto', 'ago']],
  [9, ['september', 'sept', 'sep', 'setembro', 'set', 'septiembre', 'setiembre']],
  [10, ['october', 'oct', 'outubro', 'out', 'octubre']],
  [11, ['november', 'nov', 'novembro', 'noviembre']],
  [12, ['december', 'dec', 'dezembro', 'dez', 'diciembre', 'dic']]
];

const MONTH_BY_NAME = new Map<string, number>();
for (const [month, names] of MONTH_NAMES) for (const name of names) MONTH_BY_NAME.set(name, month);

const MONTH_ALTERNATION = [...MONTH_BY_NAME.keys()].sort((a, b) => b.length - a.length).join('|');

const NAMED_DAY_DE_MONTH = new RegExp(
  `(?<!\\p{N})(\\d{1,2})(?:º|°)?\\s+de\\s+(${MONTH_ALTERNATION})(?!\\p{L})\\.?\\s+de\\s+(\\d{4})(?!\\p{N})`,
  'gu'
);
const NAMED_DAY_MONTH = new RegExp(
  `(?<!\\p{N})(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(${MONTH_ALTERNATION})(?!\\p{L})\\.?,?\\s+(\\d{4})(?!\\p{N})`,
  'gu'
);
const NAMED_MONTH_DAY = new RegExp(
  `(?<!\\p{L})(${MONTH_ALTERNATION})(?!\\p{L})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\p{N})`,
  'gu'
);
const NUMERIC_DAY_MONTH = /(?<![\p{N}./-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\p{N}]|[./-]\p{N})/gu;
const NUMERIC_YEAR_FIRST = /(?<![\p{N}./-])(\d{4})([/.-])(\d{1,2})\2(\d{1,2})(?![\p{N}]|[./-]\p{N})/gu;
const TIME_OF_DAY = /(?<![\p{N}:])\d{1,2}:\d{2}(?::\d{2})?(?![\p{N}]|:\d)/gu;

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

export function dateKey(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

export function isValidDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function utcDateKey(instant: number): string {
  const date = new Date(instant);
  return dateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

function offsetMinutes(offset: string): number {
  if (offset === 'Z' || offset === 'z') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  return sign * (hours * 60 + minutes);
}

export function parseIsoDate(value: string): IsoDate | null {
  const match = ISO_DATE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDate(year, month, day)) return null;
  const literal = dateKey({ year, month, day });
  if (match[4] === undefined) {
    return { literal, utc: literal, hasTime: false, hasOffset: false, instant: Date.UTC(year, month - 1, day) };
  }
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  if (hours > 23 || minutes > 59 || seconds > 60) return null;
  const millis = match[7] === undefined ? 0 : Math.floor(Number(`0.${match[7]}`) * 1000);
  const offset = match[8];
  if (offset === undefined) return { literal, utc: literal, hasTime: true, hasOffset: false, instant: null };
  const instant = Date.UTC(year, month - 1, day, hours, minutes, seconds, millis) - offsetMinutes(offset) * 60_000;
  return { literal, utc: utcDateKey(instant), hasTime: true, hasOffset: true, instant };
}

export function isIsoDateString(value: string): boolean {
  return parseIsoDate(value) !== null;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!zoneFormatters.has(timeZone)) {
    let formatter: Intl.DateTimeFormat | null = null;
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    } catch {
      formatter = null;
    }
    zoneFormatters.set(timeZone, formatter);
  }
  return zoneFormatters.get(timeZone) ?? null;
}

export function dateInTimeZone(instant: number, timeZone: string): string | null {
  const formatter = zoneFormatter(timeZone);
  if (formatter === null) return null;
  const parts = formatter.formatToParts(new Date(instant));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const date = { year: part('year'), month: part('month'), day: part('day') };
  return isValidDate(date.year, date.month, date.day) ? dateKey(date) : null;
}

export function isoDateCandidates(value: string, timeZones: readonly string[] = []): string[] {
  const parsed = parseIsoDate(value);
  if (parsed === null) return [];
  const keys = new Set([parsed.literal, parsed.utc]);
  if (parsed.instant !== null) {
    for (const zone of timeZones) {
      const key = dateInTimeZone(parsed.instant, zone);
      if (key !== null) keys.add(key);
    }
  }
  return [...keys];
}

export function shiftIsoDate(value: string, days: number): string | null {
  const parsed = parseIsoDate(value);
  if (parsed === null) return null;
  const [year, month, day] = parsed.literal.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const key = dateKey({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() });
  return key + value.slice(10);
}

function expandYear(text: string): number {
  return text.length === 2 ? 2000 + Number(text) : Number(text);
}

function addMention(mentions: Map<string, DateMention>, text: string, start: number, end: number, dates: string[]): void {
  if (dates.length === 0) return;
  const id = `${start}:${end}`;
  const existing = mentions.get(id);
  if (existing === undefined) {
    mentions.set(id, { start, end, raw: text.slice(start, end), dates: [...new Set(dates)] });
    return;
  }
  for (const date of dates) if (!existing.dates.includes(date)) existing.dates.push(date);
}

function keyIfValid(year: number, month: number, day: number): string[] {
  return isValidDate(year, month, day) ? [dateKey({ year, month, day })] : [];
}

export function findDateMentions(foldedText: string): DateMention[] {
  const mentions = new Map<string, DateMention>();
  for (const m of foldedText.matchAll(NUMERIC_DAY_MONTH)) {
    const [raw, a = '', sep = '', b = '', y = ''] = m;
    if (y.length === 2 && sep !== '/') continue;
    const year = expandYear(y);
    const start = m.index ?? 0;
    addMention(mentions, foldedText, start, start + raw.length, [
      ...keyIfValid(year, Number(b), Number(a)),
      ...keyIfValid(year, Number(a), Number(b))
    ]);
  }
  for (const m of foldedText.matchAll(NUMERIC_YEAR_FIRST)) {
    const [raw, y = '', , mo = '', d = ''] = m;
    const start = m.index ?? 0;
    addMention(mentions, foldedText, start, start + raw.length, keyIfValid(Number(y), Number(mo), Number(d)));
  }
  for (const pattern of [NAMED_DAY_DE_MONTH, NAMED_DAY_MONTH]) {
    for (const m of foldedText.matchAll(pattern)) {
      const [raw, d = '', name = '', y = ''] = m;
      const start = m.index ?? 0;
      const month = MONTH_BY_NAME.get(name) ?? 0;
      addMention(mentions, foldedText, start, start + raw.length, keyIfValid(Number(y), month, Number(d)));
    }
  }
  for (const m of foldedText.matchAll(NAMED_MONTH_DAY)) {
    const [raw, name = '', d = '', y = ''] = m;
    const start = m.index ?? 0;
    const month = MONTH_BY_NAME.get(name) ?? 0;
    addMention(mentions, foldedText, start, start + raw.length, keyIfValid(Number(y), month, Number(d)));
  }
  return [...mentions.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function findTimeSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(TIME_OF_DAY)) {
    const start = m.index ?? 0;
    spans.push({ start, end: start + m[0].length });
  }
  return spans;
}
