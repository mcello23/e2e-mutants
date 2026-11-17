import type { OperatorName } from './types';

export const TEST_ID_SEPARATOR = ' :: ';
export const TITLE_SEPARATOR = ' > ';
export const ALL_OCCURRENCES = -1;

export function hash53(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hash32(input: string): number {
  return hash53(input) >>> 0;
}

export function shortHash(input: string): string {
  return hash53(input).toString(36).padStart(11, '0');
}

export function testIdFor(specRelative: string, titlePath: readonly string[]): string {
  return specRelative + TEST_ID_SEPARATOR + titlePath.join(TITLE_SEPARATOR);
}

export function specOfTestId(testId: string): string {
  const index = testId.indexOf(TEST_ID_SEPARATOR);
  return index === -1 ? '' : testId.slice(0, index);
}

export function titleOfTestId(testId: string): string {
  const index = testId.indexOf(TEST_ID_SEPARATOR);
  return index === -1 ? testId : testId.slice(index + TEST_ID_SEPARATOR.length);
}

export function occurrenceLabel(occurrence: number): string {
  return occurrence === ALL_OCCURRENCES ? '*' : String(occurrence);
}

export function fieldIdFor(requestKey: string, occurrence: number, pathText: string): string {
  return `${requestKey} #${occurrenceLabel(occurrence)} ${pathText}`;
}

export function mutantIdFor(
  testId: string,
  requestKey: string,
  occurrence: number,
  pathText: string,
  operator: OperatorName
): string {
  return shortHash([testId, requestKey, occurrenceLabel(occurrence), pathText, operator].join('\u0000'));
}
