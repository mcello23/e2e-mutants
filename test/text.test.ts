import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evidenceText,
  findBounded,
  findString,
  foldCase,
  makeEvidence,
  normalizeText,
  stringNeedle,
  truncateSnapshot
} from '../src/core/text';

describe('normalizeText', () => {
  test('turns no-break, narrow no-break and thin spaces into plain spaces', () => {
    assert.equal(normalizeText('R$ 128.450,50'), 'R$ 128.450,50');
    assert.equal(normalizeText('4,25 %'), '4,25 %');
    assert.equal(normalizeText('1 450'), '1 450');
  });

  test('collapses whitespace runs and trims', () => {
    assert.equal(normalizeText('  Ana \n\t  Souza  '), 'Ana Souza');
  });

  test('removes zero-width and soft hyphen characters', () => {
    assert.equal(normalizeText('Pe­dido​ 1'), 'Pedido 1');
  });

  test('composes decomposed accents (NFC)', () => {
    assert.equal(normalizeText('José'), 'José');
  });
});

describe('foldCase', () => {
  test('lowercases', () => {
    assert.equal(foldCase('ANA Souza ÉLIO'), 'ana souza élio');
  });

  test('keeps the same length so indexes map back to the original text', () => {
    const text = 'İstanbul Ana';
    const folded = foldCase(text);
    assert.equal(folded.length, text.length);
    assert.equal(folded.slice(9), 'ana');
  });
});

describe('findBounded', () => {
  test('"ana" does not match inside "banana"', () => {
    assert.equal(findBounded('banana split', 'ana'), null);
  });

  test('"ana" matches as a whole word', () => {
    assert.deepEqual(findBounded('cliente: ana souza', 'ana'), { start: 9, end: 12 });
  });

  test('accented boundaries: "josé" in "josé silva" but not in "josélia"', () => {
    assert.notEqual(findBounded('josé silva', 'josé'), null);
    assert.equal(findBounded('josélia lima', 'josé'), null);
  });

  test('a letter after an accented letter blocks the match', () => {
    assert.equal(findBounded('joséa', 'josé'), null);
  });

  test('digits count as word characters', () => {
    assert.equal(findBounded('ord-10012', 'ord-1001'), null);
    assert.notEqual(findBounded('ord-1001 paid', 'ord-1001'), null);
  });

  test('needles that start or end with punctuation do not need a boundary there', () => {
    assert.notEqual(findBounded('total(usd)', '(usd)'), null);
  });

  test('skips a bad first occurrence and finds a later good one', () => {
    assert.deepEqual(findBounded('banana ana', 'ana'), { start: 7, end: 10 });
  });

  test('unbounded end matches a prefix', () => {
    assert.notEqual(findBounded('lorem ipsumdolor', 'lorem ipsum', false), null);
    assert.equal(findBounded('lorem ipsumdolor', 'lorem ipsum', true), null);
  });
});

describe('findString', () => {
  test('is case-insensitive and whitespace-normalized', () => {
    const folded = foldCase(normalizeText('Cliente: ANA   SOUZA'));
    assert.notEqual(findString(folded, 'Ana Souza'), null);
  });

  test('strings longer than 200 characters match on their first 60', () => {
    const long = 'Entrega agendada para a janela da manhã, portão lateral, falar com a portaria. '.repeat(4);
    assert.ok(long.length > 200);
    const needle = stringNeedle(long);
    assert.equal(needle?.boundedEnd, false);
    assert.ok((needle?.needle.length ?? 0) <= 60);
    const page = foldCase(normalizeText('Notas: ' + long.slice(0, 90) + '… ver mais'));
    assert.notEqual(findString(page, long), null);
  });

  test('empty values never match', () => {
    assert.equal(findString('anything', '   '), null);
  });
});

describe('evidence', () => {
  test('makeEvidence returns the match with surrounding context', () => {
    const text = 'Pedidos recentes: Ana Souza pagou R$ 1.450,00 ontem à tarde';
    const start = text.indexOf('R$');
    const evidence = makeEvidence(text, { start, end: start + 11 }, 12);
    assert.equal(evidence.match, 'R$ 1.450,00');
    assert.ok(evidence.before.startsWith('…'));
    assert.ok(evidence.after.endsWith('…'));
    assert.ok(evidenceText(evidence).includes('Souza pagou R$ 1.450,00 ontem'));
  });

  test('truncateSnapshot caps length without splitting a surrogate pair', () => {
    assert.equal(truncateSnapshot('abcdef', 4), 'abcd');
    const emoji = 'ab\u{1F600}cd';
    assert.equal(truncateSnapshot(emoji, 3), 'ab');
  });
});
