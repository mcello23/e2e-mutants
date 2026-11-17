export type {
  AppliedRecord,
  Evidence,
  FieldKind,
  FieldStatus,
  JsonPrimitive,
  JsonValue,
  LeafKind,
  Mutation,
  MutationApplication,
  OperatorName,
  PathSegment,
  PlanResponse,
  RecordedResponse,
  RoundPlan,
  SessionMode,
  Span,
  TestRecording,
  TestState,
  Verdict
} from './types';

export {
  LONG_STRING_LENGTH,
  LONG_STRING_PREFIX,
  MAX_SNAPSHOT_LENGTH,
  evidenceText,
  findBounded,
  findString,
  foldCase,
  makeEvidence,
  normalizeText,
  truncateSnapshot
} from './text';

export {
  NumberIndex,
  extractNumberTokens,
  findNumber,
  numberMatchesToken,
  parseNumberLiteral,
  type NumberInterpretation,
  type NumberToken
} from './numbers';

export {
  dateKey,
  dateInTimeZone,
  findDateMentions,
  findTimeSpans,
  isIsoDateString,
  isoDateCandidates,
  parseIsoDate,
  shiftIsoDate,
  type CalendarDate,
  type DateMention,
  type IsoDate
} from './dates';

export {
  describeValue,
  formatPath,
  generalizePath,
  getAtPath,
  isNumericString,
  setAtPath,
  walkJson,
  type ArrayNode,
  type JsonWalk,
  type Leaf
} from './leaves';

export {
  OccurrenceCounter,
  isJsonContentType,
  keyResponses,
  parseJsonBody,
  requestKey,
  urlTemplate,
  type JsonBodyResult
} from './requests';

export {
  REDACTED,
  SENSITIVE_KEY,
  buildTextIndex,
  findLeafInText,
  isSensitiveKey,
  isSensitivePath,
  isTrivialLeaf,
  mergeBaselineObservations,
  observeTest,
  observedFields,
  redactSensitive,
  type FieldObservation,
  type ObserveOptions,
  type TestObservation,
  type TextIndex
} from './observe';

export {
  DATE_SHIFT_DAYS,
  OPERATORS,
  applyMutation,
  applyMutationInPlace,
  applyOperator,
  operatorsFor,
  reverseString,
  shiftNumber,
  shiftNumericString,
  type OperatorResult
} from './operators';

export { mulberry32, mutationCandidates, planMutants, type PlanOptions, type PlannedMutant } from './plan';

export {
  TEST_ID_SEPARATOR,
  TITLE_SEPARATOR,
  fieldIdFor,
  mutantIdFor,
  shortHash,
  specOfTestId,
  testIdFor,
  titleOfTestId
} from './ids';

export {
  REPORT_SCHEMA_VERSION,
  VERDICTS,
  buildReport,
  classifyMutantRun,
  computeScore,
  confirmVerdict,
  fieldKeyOf,
  formatScore,
  formatTextSummary,
  groupScores,
  isCrashMessage,
  isE2eMutantsReport,
  meetsMinScore,
  scoreBreakdown,
  sortResults,
  summarize,
  type BaselineStatus,
  type E2eMutantsReport,
  type GroupScore,
  type MutantResult,
  type ReportInput,
  type ReportOptions,
  type ReportTest,
  type RunOutcome,
  type ScoreBreakdown,
  type ScoreSummary,
  type UnstableTest
} from './score';

export { REPORT_CSP, escapeHtml, renderHtmlReport } from './report-html';
