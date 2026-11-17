import { ALL_OCCURRENCES, testIdFor } from '../core/ids';
import { getAtPath } from '../core/leaves';
import { collectSensitiveValues, redactSensitive, scrubText } from '../core/observe';
import { applyMutationInPlace } from '../core/operators';
import { OccurrenceCounter, parseJsonBody, requestKey } from '../core/requests';
import { truncateSnapshot } from '../core/text';
import type { AppliedRecord, Mutation, PathSegment, PlanResponse, RecordedResponse, SessionMode, TestRecording } from '../core/types';
import { APPLIED_TASK, FLAG, PLAN_TASK, RECORD_TASK } from './shared';

type DeliveryStatus = 'pending' | 'confirmed' | 'replaced' | 'changed';

interface Delivery {
  path: PathSegment[];
  original: string;
  status: DeliveryStatus;
}

interface TestState {
  testId: string;
  mode: SessionMode;
  mutation: Mutation | null;
  counter: OccurrenceCounter;
  responses: RecordedResponse[];
  snapshots: string[];
  secrets: Set<string>;
  crashes: string[];
  deliveries: Delivery[];
  active: boolean;
  seen: boolean;
  before?: string;
  after?: string;
  reason?: string;
}

interface InterceptedRequest {
  method: string;
  url: string;
  resourceType?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'before:response' | 'response' | 'after:response', handler: (res: InterceptedResponse) => void): unknown;
}

interface InterceptedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const SKIPPED_RESOURCE_TYPES = new Set([
  'document',
  'stylesheet',
  'script',
  'image',
  'font',
  'websocket',
  'manifest',
  'ping',
  'cspviolationreport'
]);

const SKIPPED_INPUT_TYPES = new Set(['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image']);
const NOT_RENDERED_TAGS = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT']);
const MAX_SHADOW_DEPTH = 32;
const CRASH_LENGTH = 300;

function flagValue(): unknown {
  const api = Cypress as unknown as { expose?: (key: string) => unknown; env?: (key: string) => unknown };
  if (typeof api.expose === 'function') return api.expose(FLAG);
  return typeof api.env === 'function' ? api.env(FLAG) : undefined;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function currentTestId(): string {
  const test = Cypress.currentTest as { titlePath?: string[]; title: string };
  return testIdFor(Cypress.spec.relative, test.titlePath ?? [test.title]);
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

function newState(testId: string): TestState {
  return {
    testId,
    mode: 'off',
    mutation: null,
    counter: new OccurrenceCounter(),
    responses: [],
    snapshots: [],
    secrets: new Set(),
    crashes: [],
    deliveries: [],
    active: true,
    seen: false
  };
}

let autWindow: Window | null = null;

function formValue(element: Element): string | null {
  if (element.tagName === 'TEXTAREA') return (element as HTMLTextAreaElement).value;
  if (element.tagName !== 'INPUT') return null;
  const input = element as HTMLInputElement;
  return SKIPPED_INPUT_TYPES.has((input.type || 'text').toLowerCase()) ? null : input.value;
}

function shadowText(root: ShadowRoot): string {
  const parts: string[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) parts.push(node.textContent ?? '');
    else if (node.nodeType === 1 && !NOT_RENDERED_TAGS.has((node as Element).tagName)) parts.push((node as HTMLElement).innerText ?? '');
  }
  return parts.join('\n');
}

function collectHiddenText(root: Document | ShadowRoot, parts: string[], depth: number): void {
  for (const element of Array.from(root.querySelectorAll('*'))) {
    const value = formValue(element);
    if (value !== null && value.trim() !== '') parts.push(value);
    const shadow = (element as HTMLElement).shadowRoot;
    if (shadow && depth < MAX_SHADOW_DEPTH) {
      parts.push(shadowText(shadow));
      collectHiddenText(shadow, parts, depth + 1);
    }
  }
}

function pageText(doc: Document): string {
  const parts = [doc.body.innerText ?? ''];
  collectHiddenText(doc, parts, 0);
  return parts.filter((part) => part.trim() !== '').join('\n');
}

function takeSnapshot(state: TestState): void {
  if (!state.active || state.mode !== 'record') return;
  try {
    const win = autWindow;
    if (win === null || win.location.protocol === 'about:') return;
    const doc = win.document;
    if (!doc || !doc.body) return;
    const text = pageText(doc);
    if (text.trim() !== '') state.snapshots.push(truncateSnapshot(text));
  } catch {
    return;
  }
}

function onResponse(state: TestState, req: InterceptedRequest, key: string, res: InterceptedResponse): Delivery | null {
  if (!state.active) return null;
  const parsed = parseJsonBody(res.body, header(res.headers, 'content-type'));
  if (!parsed.ok) return null;
  res.headers['cache-control'] = 'no-store';
  delete res.headers.etag;
  delete res.headers['last-modified'];
  const occurrence = state.counter.next(key);
  if (state.mode === 'record') {
    for (const secret of collectSensitiveValues(parsed.value)) state.secrets.add(secret);
    state.responses.push({ method: req.method, url: withoutQuery(req.url), status: res.statusCode, body: redactSensitive(parsed.value) });
    return null;
  }
  const mutation = state.mutation;
  if (state.mode !== 'mutate' || mutation === null || mutation.requestKey !== key) return null;
  if (mutation.occurrence !== ALL_OCCURRENCES && mutation.occurrence !== occurrence) return null;
  state.seen = true;
  const original = JSON.stringify(getAtPath(parsed.value, mutation.path).value);
  const result = applyMutationInPlace(parsed.value, mutation);
  if (!result.applied) {
    state.reason = state.reason ?? result.reason;
    return null;
  }
  state.before = state.before ?? result.before;
  state.after = state.after ?? result.after;
  res.body = parsed.wasString ? JSON.stringify(result.body) : result.body;
  const delivery: Delivery = { path: mutation.path, original, status: 'pending' };
  state.deliveries.push(delivery);
  return delivery;
}

function verify(delivery: Delivery | null, res: InterceptedResponse): void {
  if (delivery === null || delivery.status !== 'pending') return;
  const parsed = parseJsonBody(res.body, header(res.headers, 'content-type'));
  const found = parsed.ok ? getAtPath(parsed.value, delivery.path) : { found: false, value: undefined };
  delivery.status = found.found && JSON.stringify(found.value) !== delivery.original ? 'confirmed' : 'changed';
}

function interceptFor(state: TestState): void {
  cy.intercept({ url: '**', middleware: true }, (request) => {
    const req = request as unknown as InterceptedRequest;
    if (req.resourceType !== undefined && SKIPPED_RESOURCE_TYPES.has(req.resourceType)) return;
    if (/text\/event-stream/i.test(header(req.headers, 'accept') ?? '')) return;
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
    const key = requestKey(req.method, req.url);
    let delivery: Delivery | null = null;
    req.on('before:response', (res) => {
      delivery = onResponse(state, req, key, res);
    });
    if (state.mode === 'mutate' && state.mutation !== null && state.mutation.requestKey === key) {
      req.on('response', (res) => verify(delivery, res));
      req.on('after:response', () => {
        if (delivery !== null && delivery.status === 'pending') delivery.status = 'replaced';
      });
    }
  });
}

function crashMessage(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  const quoted = /^\s*> (.+)$/m.exec(message);
  return (quoted?.[1] ?? message.split('\n', 1)[0] ?? '').trim().slice(0, CRASH_LENGTH);
}

function appliedState(state: TestState): Pick<AppliedRecord, 'applied' | 'reason'> {
  if (state.deliveries.some((delivery) => delivery.status === 'confirmed')) return { applied: true };
  if (!state.seen) return { applied: false, reason: 'the targeted response did not arrive during the test' };
  const last = state.deliveries[state.deliveries.length - 1];
  if (last === undefined) return { applied: false, reason: state.reason ?? 'the mutation could not be applied' };
  if (last.status === 'replaced') {
    return { applied: false, reason: 'another intercept replaced the mutated response (res.send or a static response) before the page received it' };
  }
  if (last.status === 'changed') return { applied: false, reason: 'another intercept put the original value back before the page received it' };
  return { applied: false, reason: 'the mutated response had not reached the page when the test ended' };
}

function ignoreLateAppError(): false {
  return false;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

if (flagValue()) {
  let current: TestState | null = null;

  Cypress.on('window:before:load', (win: Window) => {
    autWindow = win;
  });

  beforeEach(() => {
    const state = newState(currentTestId());
    current = state;
    cy.on('window:before:unload', () => takeSnapshot(state));
    cy.on('uncaught:exception', (error: unknown) => {
      if (!state.active) return;
      const message = crashMessage(error);
      if (!state.crashes.includes(message)) state.crashes.push(message);
    });
    cy.task<PlanResponse>(PLAN_TASK, { testId: state.testId }, { log: false }).then((plan) => {
      state.mode = plan.mode;
      state.mutation = plan.mutation;
      interceptFor(state);
    });
  });

  afterEach(() => {
    const state = current;
    current = null;
    if (state === null) return;
    takeSnapshot(state);
    state.active = false;
    if (state.mode === 'off') return;
    const secrets = [...state.secrets].sort((a, b) => b.length - a.length);
    const payload =
      state.mode === 'record'
        ? ({
            testId: state.testId,
            responses: state.responses,
            domSnapshots: state.snapshots.map((snapshot) => scrubText(snapshot, secrets)),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            crashes: state.crashes,
            testIsolation: Cypress.config('testIsolation') !== false
          } satisfies TestRecording)
        : compact<AppliedRecord>({
            testId: state.testId,
            mutantId: state.mutation?.id ?? '',
            seen: state.seen,
            before: state.before,
            after: state.after,
            crashes: state.crashes,
            ...appliedState(state)
          });
    cy.on('uncaught:exception', ignoreLateAppError);
    cy.task(state.mode === 'record' ? RECORD_TASK : APPLIED_TASK, payload, { log: false }).then(() => {
      cy.removeListener('uncaught:exception', ignoreLateAppError);
    });
  });
}
