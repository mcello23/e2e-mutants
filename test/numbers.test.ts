import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNumberTokens, findNumber, NumberIndex, numberMatchesToken, parseNumberLiteral } from '../src/core/numbers';
import { normalizeText } from '../src/core/text';

function tokens(text: string) {
  return extractNumberTokens(normalizeText(text));
}

function shows(text: string, value: number): boolean {
  const list = tokens(text);
  const linear = findNumber(value, list) !== null;
  const indexed = new NumberIndex(list).find(value) !== null;
  assert.equal(indexed, linear, `index and linear scan disagree for ${value} in ${JSON.stringify(text)}`);
  return linear;
}

function intl(value: number, locale: string, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

describe('parseNumberLiteral', () => {
  test('plain integers', () => {
    assert.deepEqual(parseNumberLiteral('1450'), [{ value: 1450, decimals: 0 }]);
  });

  test('one separator followed by three digits is ambiguous', () => {
    assert.deepEqual(parseNumberLiteral('1.450'), [
      { value: 1.45, decimals: 3 },
      { value: 1450, decimals: 0 }
    ]);
    assert.deepEqual(parseNumberLiteral('1,450'), [
      { value: 1.45, decimals: 3 },
      { value: 1450, decimals: 0 }
    ]);
  });

  test('one separator not followed by three digits is a decimal', () => {
    assert.deepEqual(parseNumberLiteral('4,25'), [{ value: 4.25, decimals: 2 }]);
    assert.deepEqual(parseNumberLiteral('1450.5'), [{ value: 1450.5, decimals: 1 }]);
    assert.deepEqual(parseNumberLiteral('1450,5'), [{ value: 1450.5, decimals: 1 }]);
  });

  test('both separators: the last one is the decimal separator', () => {
    assert.deepEqual(parseNumberLiteral('1.450,50'), [{ value: 1450.5, decimals: 2 }]);
    assert.deepEqual(parseNumberLiteral('1,450.50'), [{ value: 1450.5, decimals: 2 }]);
    assert.deepEqual(parseNumberLiteral('128.450,50'), [{ value: 128450.5, decimals: 2 }]);
    assert.deepEqual(parseNumberLiteral('1,234,567.8'), [{ value: 1234567.8, decimals: 1 }]);
  });

  test('repeated grouping separators', () => {
    assert.deepEqual(parseNumberLiteral('1.234.567'), [{ value: 1234567, decimals: 0 }]);
    assert.deepEqual(parseNumberLiteral('1,234,567'), [{ value: 1234567, decimals: 0 }]);
  });

  test('invalid groupings have no interpretation', () => {
    assert.deepEqual(parseNumberLiteral('10.0.0.1'), []);
    assert.deepEqual(parseNumberLiteral('1,45.0'), []);
    assert.deepEqual(parseNumberLiteral('1.450.5,0'), []);
    assert.deepEqual(parseNumberLiteral('1.2,3.4'), []);
    assert.deepEqual(parseNumberLiteral('1450,1460,1470'), []);
  });

  test('a leading zero is never a thousands group', () => {
    assert.deepEqual(parseNumberLiteral('0,450'), [{ value: 0.45, decimals: 3 }]);
  });
});

describe('number tokens', () => {
  test('flags and strips currency and percent', () => {
    const [brl] = tokens('R$ 1.450,00');
    assert.equal(brl?.currency, 'BRL');
    assert.equal(brl?.raw, 'R$ 1.450,00');
    const [eur] = tokens('1.450,00 €');
    assert.equal(eur?.currency, 'EUR');
    const [usd] = tokens('US$ 1,450.00');
    assert.equal(usd?.currency, 'USD');
    const [code] = tokens('1450 BRL');
    assert.equal(code?.currency, 'BRL');
    const [pct] = tokens('4,25%');
    assert.equal(pct?.percent, true);
    const [spaced] = tokens('4.25 %');
    assert.equal(spaced?.percent, true);
  });

  test('negative amounts with the sign before or after the currency', () => {
    assert.equal(tokens('-R$ 1.450,00')[0]?.negative, true);
    assert.equal(tokens('R$ -1.450,00')[0]?.negative, true);
    assert.equal(tokens('saldo −1.450,00')[0]?.negative, true);
  });

  test('identifiers glued with a hyphen or letters are not numbers', () => {
    assert.deepEqual(tokens('ORD-1001'), []);
    assert.deepEqual(tokens('v2 build A12'), []);
    assert.deepEqual(tokens('1001-A'), []);
    assert.deepEqual(tokens('row_1450'), []);
  });

  test('units glued after the number are allowed', () => {
    assert.equal(tokens('512MB')[0]?.interpretations[0]?.value, 512);
  });

  test('excluded spans (dates, times) produce no tokens', () => {
    const text = 'em 10/11/2026 às 09:30, total 312';
    const list = extractNumberTokens(text, [
      { start: 3, end: 13 },
      { start: 17, end: 22 }
    ]);
    assert.deepEqual(
      list.map((t) => t.raw),
      ['312']
    );
  });
});

describe('numeric matching', () => {
  test('R$ 1.450,00 shows 1450', () => assert.ok(shows('R$ 1.450,00', 1450)));
  test('1.450,00 € shows 1450', () => assert.ok(shows('1.450,00 €', 1450)));
  test('$1,450.00 shows 1450', () => assert.ok(shows('$1,450.00', 1450)));
  test('1450 shows 1450', () => assert.ok(shows('1450', 1450)));
  test('1.450 shows 1450', () => assert.ok(shows('1.450', 1450)));
  test('1.450 also shows 1.45', () => assert.ok(shows('1.450', 1.45)));
  test('4,25% shows 0.0425 and 4.25', () => {
    assert.ok(shows('4,25%', 0.0425));
    assert.ok(shows('4,25%', 4.25));
  });
  test('4.25 % shows 0.0425', () => assert.ok(shows('4.25 %', 0.0425)));
  test('0.0425 formatted by Intl as pt-BR percent', () => {
    const text = intl(0.0425, 'pt-BR', { style: 'percent', minimumFractionDigits: 2 });
    assert.equal(normalizeText(text), '4,25%');
    assert.ok(shows(text, 0.0425));
  });
  test('a non-percent token does not show a ratio', () => assert.ok(!shows('4,25', 0.0425)));

  test('1450 does not match inside 14500 or 21450', () => {
    assert.ok(!shows('14500', 1450));
    assert.ok(!shows('21450', 1450));
    assert.ok(!shows('R$ 14.500,00', 1450));
    assert.ok(!shows('21.450', 1450));
  });

  test('1450 does not match 1450.9 shown as 1.450,90', () => assert.ok(!shows('1.450,90', 1450)));

  test('rounding tolerance follows the decimals shown', () => {
    assert.ok(shows('1.450,57', 1450.567));
    assert.ok(!shows('1.450,56', 1450.567));
    assert.ok(shows('1.451', 1450.567));
    assert.ok(shows('1,01', 1.005));
  });

  test('a small non-integer is not matched by a whole-number token unless it is a percent', () => {
    assert.ok(!shows('4 itens', 4.25));
    assert.ok(!shows('3 dias', 2.5));
    assert.ok(shows('4%', 0.0425));
    assert.ok(shows('4,3 estrelas', 4.25));
    assert.ok(shows('Total 12', 12.4));
  });

  test('Intl outputs in several locales', () => {
    assert.ok(shows(intl(128450.5, 'pt-BR', { style: 'currency', currency: 'BRL' }), 128450.5));
    assert.ok(shows(intl(128450.5, 'en-US', { style: 'currency', currency: 'USD' }), 128450.5));
    assert.ok(shows(intl(128450.5, 'de-DE', { style: 'currency', currency: 'EUR' }), 128450.5));
    assert.ok(shows(intl(1450, 'es-ES'), 1450));
    assert.equal(intl(1450, 'es-ES'), '1450');
    assert.ok(shows(intl(12345.5, 'es-ES'), 12345.5));
    assert.ok(shows(intl(1450.5, 'en-US'), 1450.5));
  });

  test('signs: negative tokens need negative values, unsigned tokens accept both', () => {
    assert.ok(shows('-R$ 1.450,00', -1450));
    assert.ok(!shows('-R$ 1.450,00', 1450));
    assert.ok(shows('(1,450.00)', -1450));
  });

  test('numberMatchesToken is false for non-finite values', () => {
    const [token] = tokens('1450');
    assert.ok(token);
    assert.equal(numberMatchesToken(Number.NaN, token), false);
  });

  test('NumberIndex returns the earliest matching token', () => {
    const list = tokens('Total 1.450 e depois 1450');
    const found = new NumberIndex(list).find(1450);
    assert.equal(found?.raw, '1.450');
  });
});
