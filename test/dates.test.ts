import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateInTimeZone,
  findDateMentions,
  findTimeSpans,
  isIsoDateString,
  isoDateCandidates,
  parseIsoDate,
  shiftIsoDate
} from '../src/core/dates';
import { foldCase, normalizeText } from '../src/core/text';

function datesIn(text: string): string[] {
  return findDateMentions(foldCase(normalizeText(text))).flatMap((m) => m.dates);
}

function intlDate(iso: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(new Date(iso));
}

describe('ISO dates in JSON', () => {
  test('date only', () => {
    const parsed = parseIsoDate('2026-11-10');
    assert.equal(parsed?.literal, '2026-11-10');
    assert.equal(parsed?.utc, '2026-11-10');
    assert.equal(parsed?.hasTime, false);
  });

  test('datetime with Z', () => {
    const parsed = parseIsoDate('2026-11-12T09:30:00Z');
    assert.equal(parsed?.literal, '2026-11-12');
    assert.equal(parsed?.utc, '2026-11-12');
    assert.equal(parsed?.instant, Date.UTC(2026, 10, 12, 9, 30));
  });

  test('datetime with offset and fractional seconds', () => {
    const parsed = parseIsoDate('2026-11-12T23:30:00.123-03:00');
    assert.equal(parsed?.literal, '2026-11-12');
    assert.equal(parsed?.utc, '2026-11-13');
  });

  test('space separator and compact offset', () => {
    assert.equal(parseIsoDate('2026-11-12 09:30:00+0530')?.utc, '2026-11-12');
  });

  test('rejects impossible dates and non-ISO strings', () => {
    assert.equal(parseIsoDate('2026-13-01'), null);
    assert.equal(parseIsoDate('2026-02-30'), null);
    assert.equal(parseIsoDate('2026-11-10T25:00:00Z'), null);
    assert.equal(parseIsoDate('10/11/2026'), null);
    assert.equal(parseIsoDate('ORD-2026-11'), null);
    assert.equal(isIsoDateString('2028-02-29'), true);
    assert.equal(isIsoDateString('2027-02-29'), false);
  });

  test('datetime with Z near midnight: literal and UTC date, plus the date in given time zones', () => {
    assert.deepEqual(isoDateCandidates('2026-11-10T23:45:00Z'), ['2026-11-10']);
    assert.deepEqual(isoDateCandidates('2026-11-10T23:45:00Z', ['Asia/Tokyo']).sort(), ['2026-11-10', '2026-11-11']);
    assert.deepEqual(isoDateCandidates('2026-11-10T23:45:00Z', ['America/Sao_Paulo']), ['2026-11-10']);
    assert.deepEqual(isoDateCandidates('2026-11-11T00:30:00+01:00').sort(), ['2026-11-10', '2026-11-11']);
    assert.deepEqual(isoDateCandidates('2026-11-11T00:15:00Z', ['America/Sao_Paulo']).sort(), ['2026-11-10', '2026-11-11']);
  });

  test('a datetime without offset is local time: no extra zone dates', () => {
    assert.deepEqual(isoDateCandidates('2026-11-10T23:45:00', ['Asia/Tokyo']), ['2026-11-10']);
  });

  test('date-only values follow the JavaScript reading of UTC midnight in a given zone', () => {
    assert.deepEqual(isoDateCandidates('2026-11-10', ['America/Sao_Paulo']).sort(), ['2026-11-09', '2026-11-10']);
  });

  test('unknown time zones are ignored', () => {
    assert.equal(dateInTimeZone(Date.UTC(2026, 10, 10), 'Not/AZone'), null);
    assert.deepEqual(isoDateCandidates('2026-11-10T12:00:00Z', ['Not/AZone']), ['2026-11-10']);
  });
});

describe('dates in page text', () => {
  test('10/11/2026 yields both day-month and month-day readings', () => {
    assert.deepEqual(datesIn('Atualizado em 10/11/2026').sort(), ['2026-10-11', '2026-11-10']);
  });

  test('13/11/2026 has only one valid reading', () => {
    assert.deepEqual(datesIn('13/11/2026'), ['2026-11-13']);
  });

  test('two-digit years with slashes', () => {
    assert.deepEqual(datesIn('10/11/26').sort(), ['2026-10-11', '2026-11-10']);
  });

  test('dotted and dashed day-first dates', () => {
    assert.ok(datesIn('10.11.2026').includes('2026-11-10'));
    assert.ok(datesIn('10-11-2026').includes('2026-11-10'));
  });

  test('2026-11-10', () => {
    assert.deepEqual(datesIn('criado 2026-11-10'), ['2026-11-10']);
    assert.deepEqual(datesIn('2026-11-12T09:30:00Z'), ['2026-11-12']);
  });

  test('10 de novembro de 2026 (pt) and 10 de noviembre de 2026 (es)', () => {
    assert.deepEqual(datesIn('terça-feira, 10 de novembro de 2026'), ['2026-11-10']);
    assert.deepEqual(datesIn('martes, 10 de noviembre de 2026'), ['2026-11-10']);
    assert.deepEqual(datesIn('10 de nov. de 2026'), ['2026-11-10']);
    assert.deepEqual(datesIn('1º de março de 2026'), ['2026-03-01']);
  });

  test('Nov 10, 2026 / November 10, 2026 / 10 Nov 2026 / 10 November 2026', () => {
    assert.deepEqual(datesIn('Nov 10, 2026'), ['2026-11-10']);
    assert.deepEqual(datesIn('November 10th, 2026'), ['2026-11-10']);
    assert.deepEqual(datesIn('10 Nov 2026'), ['2026-11-10']);
    assert.deepEqual(datesIn('10 November 2026'), ['2026-11-10']);
    assert.deepEqual(datesIn('10 dic 2026'), ['2026-12-10']);
  });

  test('Intl date output in pt-BR, es-ES, en-US and en-GB', () => {
    const iso = '2026-11-10T12:00:00Z';
    assert.deepEqual(datesIn(intlDate(iso, 'pt-BR', { dateStyle: 'long' })), ['2026-11-10']);
    assert.deepEqual(datesIn(intlDate(iso, 'es-ES', { dateStyle: 'long' })), ['2026-11-10']);
    assert.deepEqual(datesIn(intlDate(iso, 'en-US', { dateStyle: 'medium' })), ['2026-11-10']);
    assert.deepEqual(datesIn(intlDate(iso, 'en-GB', { dateStyle: 'medium' })), ['2026-11-10']);
    assert.ok(datesIn(intlDate(iso, 'pt-BR', { dateStyle: 'short' })).includes('2026-11-10'));
    assert.ok(datesIn(intlDate(iso, 'pt-BR', { dateStyle: 'medium' })).includes('2026-11-10'));
  });

  test('month words need word boundaries', () => {
    assert.deepEqual(datesIn('10 novembers 2026'), []);
    assert.deepEqual(datesIn('enovember 10, 2026'), []);
  });

  test('invalid dates and version-like strings are not dates', () => {
    assert.deepEqual(datesIn('31/02/2026'), []);
    assert.deepEqual(datesIn('10.0.0.12026'), []);
  });

  test('time spans', () => {
    const text = 'às 09:30 e 23:59:58, não 2026:01';
    assert.deepEqual(
      findTimeSpans(text).map((s) => text.slice(s.start, s.end)),
      ['09:30', '23:59:58']
    );
  });
});

describe('shiftIsoDate', () => {
  test('keeps the original format', () => {
    assert.equal(shiftIsoDate('2026-11-10', 3), '2026-11-13');
    assert.equal(shiftIsoDate('2026-11-12T09:30:00Z', 3), '2026-11-15T09:30:00Z');
    assert.equal(shiftIsoDate('2026-11-12T09:30:00.250-03:00', 3), '2026-11-15T09:30:00.250-03:00');
  });

  test('rolls over months, years and leap days', () => {
    assert.equal(shiftIsoDate('2026-12-30', 3), '2027-01-02');
    assert.equal(shiftIsoDate('2028-02-27', 3), '2028-03-01');
  });

  test('returns null for non-dates', () => {
    assert.equal(shiftIsoDate('next week', 3), null);
  });
});
