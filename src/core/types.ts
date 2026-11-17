export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PathSegment = string | number;

export type LeafKind = 'number' | 'string' | 'date' | 'boolean' | 'null';

export type FieldKind = LeafKind | 'array';

export type FieldStatus = 'observed' | 'unobserved' | 'trivial' | 'sensitive';

export type OperatorName =
  | 'num-shift'
  | 'str-reverse'
  | 'str-empty'
  | 'date-shift'
  | 'set-null'
  | 'array-drop-first'
  | 'array-empty';

export type Verdict = 'killed' | 'killed-crash' | 'survived' | 'not-applied' | 'flaky' | 'error';

export type TestState = 'passed' | 'failed' | 'pending' | 'skipped' | 'missing';

export type SessionMode = 'off' | 'record' | 'mutate';

export interface Span {
  start: number;
  end: number;
}

export interface Evidence {
  before: string;
  match: string;
  after: string;
  matches?: number;
}

export interface RecordedResponse {
  method: string;
  url: string;
  status?: number;
  key?: string;
  occurrence?: number;
  body: unknown;
}

export interface TestRecording {
  testId: string;
  responses: RecordedResponse[];
  domSnapshots: string[];
  timeZone?: string;
  crashes?: string[];
  testIsolation?: boolean;
}

export interface Mutation {
  id: string;
  testId: string;
  requestKey: string;
  occurrence: number;
  path: PathSegment[];
  pathText: string;
  operator: OperatorName;
}

export interface MutationApplication {
  applied: boolean;
  body: unknown;
  before?: string;
  after?: string;
  reason?: string;
}

export interface AppliedRecord {
  testId: string;
  mutantId: string;
  applied: boolean;
  seen: boolean;
  before?: string;
  after?: string;
  reason?: string;
  crashes?: string[];
}

export interface PlanResponse {
  mode: SessionMode;
  mutation: Mutation | null;
}

export interface RoundPlan {
  mode: 'record' | 'mutate';
  round: number;
  tag: string;
  mutations: Record<string, Mutation>;
}
