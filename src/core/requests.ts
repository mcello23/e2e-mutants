const URL_BASE = 'http://e2e-mutants.invalid';
const DIGITS = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const JSON_CONTENT_TYPE = /\bjson\b/i;

export function templateSegment(segment: string): string {
  if (DIGITS.test(segment)) return ':n';
  if (UUID.test(segment)) return ':uuid';
  if (OBJECT_ID.test(segment)) return ':oid';
  return segment;
}

export function urlTemplate(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, URL_BASE).pathname;
  } catch {
    pathname = url.split(/[?#]/, 1)[0] ?? '';
  }
  return pathname.split('/').map(templateSegment).join('/');
}

export function requestKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${urlTemplate(url)}`;
}

export class OccurrenceCounter {
  private readonly counts = new Map<string, number>();

  next(key: string): number {
    const occurrence = this.counts.get(key) ?? 0;
    this.counts.set(key, occurrence + 1);
    return occurrence;
  }

  reset(): void {
    this.counts.clear();
  }
}

export function keyResponses<T extends { method: string; url: string }>(
  responses: readonly T[]
): Array<T & { key: string; occurrence: number }> {
  const counter = new OccurrenceCounter();
  return responses.map((response) => {
    const key = requestKey(response.method, response.url);
    return { ...response, key, occurrence: counter.next(key) };
  });
}

export function isJsonContentType(contentType: string | readonly string[] | undefined | null): boolean {
  if (contentType === undefined || contentType === null) return false;
  const value = typeof contentType === 'string' ? contentType : contentType.join(',');
  return JSON_CONTENT_TYPE.test(value);
}

export type JsonBodyResult = { ok: true; value: unknown; wasString: boolean } | { ok: false };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function parseJsonBody(body: unknown, contentType?: string | readonly string[] | null): JsonBodyResult {
  if (typeof body === 'object' && body !== null) {
    if (Array.isArray(body) || isPlainObject(body)) return { ok: true, value: body, wasString: false };
    return { ok: false };
  }
  const declaredJson = isJsonContentType(contentType);
  if (typeof body === 'number' || typeof body === 'boolean') {
    return declaredJson && (typeof body === 'boolean' || Number.isFinite(body)) ? { ok: true, value: body, wasString: false } : { ok: false };
  }
  if (typeof body !== 'string') return { ok: false };
  const trimmed = body.trim();
  if (!declaredJson && !/^[[{]/.test(trimmed)) return { ok: false };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === 'object' && value !== null) return { ok: true, value, wasString: true };
    return declaredJson ? { ok: true, value, wasString: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}
