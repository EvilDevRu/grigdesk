// Сборка, проверка и атомарная публикация неизменяемых документов потребления раннеров.
import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import { canonicalJson } from './canonical.ts';
import { assertAnalyticsIdentity } from './contracts.ts';
import { canonicalDecimal } from './decimal.ts';
import { publishImmutable } from './durableFs.ts';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 10_000;
const MAX_SAMPLES = 50_000;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const SAMPLE_ID_RE = /^sa_[a-f0-9]{32}$/;
const SEGMENT_ID_RE = /^us_[a-f0-9]{32}$/;
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const DIALECT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE = new Set(['provider_final', 'provider_partial', 'unavailable']);
const COMPLETENESS = new Set(['complete', 'partial', 'missing', 'conflict']);
const SESSION_MODE = new Set(['fresh', 'resume', 'legacy-derived', 'unknown']);
const OUTER_KEYS = Object.freeze([
  'schemaVersion',
  'taskId', 'attemptId', 'nodeVisitId', 'nodeExecutionId', 'dispatchId', 'runId', 'epoch',
  'provider', 'requestedModel', 'resolvedModel',
  'source', 'completeness', 'observedAt',
  'extractorVersion', 'normalizerDialect', 'normalizerVersion',
  'sourceFingerprint', 'providerSessionMode',
  'requestedProviderScope', 'observedProviderScope', 'parentUsageRef',
  'terminalCounterCheckpoint', 'lastObservedCounter', 'resumeEligible',
  'usageSamples', 'usageSegments', 'tokenSummary',
  'providerReportedCost', 'providerRootResult', 'diagnostics',
]);

export class AnalyticsUsageDocumentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnalyticsUsageDocumentError';
    this.code = code;
  }
}

/**
 * Отказ проверки. Объявлен функцией, а не стрелкой в const: только у объявления
 * компилятор считает `never` признаком «дальше кода нет» и сужает по нему тип.
 */
function fail(code: string, message: string): never {
  throw new AnalyticsUsageDocumentError(code, message);
}

// Неизменяемый документ потребления раннера. Все количества и деньги — КАНОНИЧЕСКИЕ
// СТРОКИ: токены выходят за 2^53, а у цены до восемнадцати знаков, и `number` терял бы
// точность молча. Поля читаются из недоверенного ввода и проверяются по одному.
export interface UsageDocument {
  schemaVersion: 1;
  taskId: string;
  attemptId: string;
  nodeVisitId: string;
  nodeExecutionId: string;
  dispatchId: string;
  runId: string;
  epoch: number;
  provider: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  source: string;
  completeness: string;
  observedAt: string;
  extractorVersion: string | null;
  normalizerDialect: string | null;
  normalizerVersion: string | null;
  sourceFingerprint: Record<string, unknown>;
  providerSessionMode: string;
  requestedProviderScope: string | null;
  observedProviderScope: string | null;
  parentUsageRef: Record<string, unknown> | null;
  terminalCounterCheckpoint: Record<string, unknown> | null;
  lastObservedCounter: Record<string, unknown> | null;
  resumeEligible: boolean;
  usageSamples: Record<string, unknown>[];
  usageSegments: Record<string, unknown>[];
  tokenSummary: Record<string, string>;
  providerReportedCost: Record<string, unknown> | null;
  providerRootResult: unknown;
  diagnostics: string[];
}

// Поля, которые складывает вызывающий. Их проверяет тот же `assertUsageDocument`:
// собранный документ и прочитанный с диска обязаны проходить одну проверку.
export interface UsageDocumentInput {
  identity: Record<string, unknown>;
  provider: string;
  requestedModel?: string | null;
  resolvedModel?: string | null;
  observedAt: string;
  sourceFingerprint: unknown;
  providerSessionMode: string;
  requestedProviderScope?: unknown;
  observedProviderScope?: unknown;
  parentUsageRef?: unknown;
  normalization: Record<string, unknown>;
}

/** Ровно объявленный набор полей: лишнее поле означает документ не по контракту. */
function exactKeys(
  record: unknown,
  keys: readonly string[],
  where: string,
): asserts record is Record<string, unknown> {
  if (!isPlainRecord(record)) fail('invalidDocument', `${where}: ожидался object.`);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalidDocument', `${where}: недопустимый набор полей.`);
  }
}

function stringOrNull(
  value: unknown,
  where: string,
  { max = 160, pattern = null }: { max?: number; pattern?: RegExp | null } = {},
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > max
      || (pattern && !pattern.test(value))) {
    fail('invalidDocument', `${where}: ожидалась bounded string или null.`);
  }
  return value;
}

function instant(value: unknown, where: string): string {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) {
    fail('invalidDocument', `${where}: ожидался canonical UTC instant.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('invalidDocument', `${where}: недопустимый UTC instant.`);
  }
  return value;
}

function uint(value: unknown, where: string, { positive = false } = {}): string {
  if (typeof value !== 'string' || !UINT_RE.test(value) || (positive && value === '0')) {
    fail('invalidDocument', `${where}: ожидался canonical uint decimal string.`);
  }
  return value;
}

function decimal(value: unknown, where: string): string {
  if (canonicalDecimal(value, { significantDigits: 30, maxScale: 18, where }) === null) {
    fail('invalidQuantity', `${where}: quantity/cost не является canonical decimal.`);
  }
  return value as string;
}

function hash(value: unknown, where: string, { nullable = false } = {}): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    fail('invalidDocument', `${where}: ожидался SHA-256.`);
  }
  return value;
}

/**
 * Копия значения после проверки его каноничности. Клон обязателен: документ
 * неизменяем, а вызывающий вправе продолжать менять свой объект.
 */
function cloneJson<Value>(value: Value, where: string): Value {
  try {
    canonicalJson(value, { bytes: MAX_DOCUMENT_BYTES });

    return structuredClone(value);
  } catch (error) {
    const reason = String((error as { message?: unknown } | null)?.message || error);

    fail('invalidDocument', `${where}: значение не входит в canonical JSON contract (${reason}).`);
  }
}

function validateFingerprint(value: unknown): void {
  exactKeys(value, [
    'dev', 'ino', 'size', 'mtimeNs', 'sha256', 'finalFstatHash', 'rawFsyncCompleted',
  ], 'sourceFingerprint');
  for (const field of ['dev', 'ino', 'size', 'mtimeNs']) {
    uint(value[field], `sourceFingerprint.${field}`);
  }
  hash(value.sha256, 'sourceFingerprint.sha256');
  hash(value.finalFstatHash, 'sourceFingerprint.finalFstatHash');
  if (typeof value.rawFsyncCompleted !== 'boolean') {
    fail('invalidDocument', 'sourceFingerprint.rawFsyncCompleted обязан быть boolean.');
  }
}

function validateBillingWindow(value: unknown, where: string): void {
  if (!isPlainRecord(value)) fail('invalidDocument', `${where}: billingWindow обязан быть object.`);
  if (value.kind === 'unknown') {
    exactKeys(value, ['kind', 'basis'], where);
    if (value.basis !== 'unknown') fail('invalidDocument', `${where}: unknown basis обязан быть unknown.`);
    return;
  }
  exactKeys(value, ['kind', 'notBefore', 'notAfter', 'basis'], where);

  if (value.kind !== 'closed'
      || typeof value.basis !== 'string'
      || !['provider_billing', 'provider_event', 'trusted_run_window', 'derived_run_window']
        .includes(value.basis)) {
    fail('invalidDocument', `${where}: неизвестный closed billingWindow.`);
  }
  instant(value.notBefore, `${where}.notBefore`);
  instant(value.notAfter, `${where}.notAfter`);
  if (String(value.notBefore) > String(value.notAfter)) {
    fail('invalidDocument', `${where}: notBefore > notAfter.`);
  }
}

function validateSamples(samples: unknown): Set<unknown> {
  if (!Array.isArray(samples) || samples.length > MAX_SAMPLES) {
    fail('invalidDocument', `usageSamples превышают cap ${MAX_SAMPLES}.`);
  }
  const ids = new Set<unknown>();

  for (const [index, sample] of samples.entries()) {
    if (!isPlainRecord(sample) || !SAMPLE_ID_RE.test(String(sample.sampleId ?? ''))) {
      fail('invalidDocument', `usageSamples[${index}]: invalid sampleId.`);
    }
    if (ids.has(sample.sampleId)) fail('invalidDocument', `usageSamples[${index}]: duplicate sampleId.`);
    ids.add(sample.sampleId);
    uint(sample.sourceOrdinal, `usageSamples[${index}].sourceOrdinal`, { positive: true });
    uint(sample.byteOffset, `usageSamples[${index}].byteOffset`);
    hash(sample.lineHash, `usageSamples[${index}].lineHash`);
    if (!isPlainRecord(sample.vector)) fail('invalidDocument', `usageSamples[${index}].vector invalid.`);

    for (const [key, quantity] of Object.entries(sample.vector)) {
      if (!DIALECT_RE.test(key)) fail('invalidDocument', `usageSamples[${index}].vector key invalid.`);
      decimal(quantity, `usageSamples[${index}].vector.${key}`);
    }
  }
  return ids;
}

function validateSegments(segments: unknown, sampleIds: Set<unknown>): void {
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
    fail('invalidDocument', `usageSegments превышают cap 10 000.`);
  }
  const ids = new Set<unknown>();

  for (const [index, segment] of segments.entries()) {
    const where = `usageSegments[${index}]`;

    if (!isPlainRecord(segment) || !SEGMENT_ID_RE.test(String(segment.segmentId ?? ''))) {
      fail('invalidDocument', `${where}: invalid segmentId.`);
    }
    if (ids.has(segment.segmentId)) fail('invalidDocument', `${where}: duplicate segmentId.`);
    ids.add(segment.segmentId);
    const range = segment.sampleRange;

    if (!isPlainRecord(range)
        || !sampleIds.has(range.firstSampleId)
        || !sampleIds.has(range.lastSampleId)) {
      fail('invalidDocument', `${where}.sampleRange не ссылается на usageSamples.`);
    }
    validateBillingWindow(segment.billingWindow, `${where}.billingWindow`);
    stringOrNull(segment.metric, `${where}.metric`, { max: 80, pattern: DIALECT_RE });
    stringOrNull(segment.unit, `${where}.unit`, { max: 40, pattern: DIALECT_RE });
    decimal(segment.quantity, `${where}.quantity`);
    stringOrNull(segment.resolvedModel, `${where}.resolvedModel`, { max: 160 });
    if (typeof segment.source !== 'string' || !SOURCE.has(segment.source)
        || typeof segment.completeness !== 'string' || !COMPLETENESS.has(segment.completeness)) {
      fail('invalidDocument', `${where}: source/completeness invalid.`);
    }
    cloneJson(segment.attributes, `${where}.attributes`);
  }
}

function validateTokenSummary(value: unknown): void {
  exactKeys(value, [
    'uncachedInput', 'output', 'cacheRead',
    'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown',
  ], 'tokenSummary');
  for (const [key, quantity] of Object.entries(value)) decimal(quantity, `tokenSummary.${key}`);
}

function validateReportedCost(value: unknown): void {
  if (value === null) return;
  exactKeys(value, ['currency', 'amount', 'semantics', 'breakdown'], 'providerReportedCost');

  const breakdown = value.breakdown;
  if (value.currency !== 'USD' || value.semantics !== 'run_total' || !Array.isArray(breakdown)) {
    fail('invalidDocument', 'providerReportedCost contract invalid.');
  }
  decimal(value.amount, 'providerReportedCost.amount');

  if (breakdown.length > 1_000) fail('invalidDocument', 'providerReportedCost breakdown oversize.');

  for (const [index, entry] of breakdown.entries()) {
    exactKeys(entry, ['model', 'rawModel', 'amount'], `providerReportedCost.breakdown[${index}]`);
    stringOrNull(entry.model, `providerReportedCost.breakdown[${index}].model`, { max: 160 });
    stringOrNull(entry.rawModel, `providerReportedCost.breakdown[${index}].rawModel`, { max: 160 });
    decimal(entry.amount, `providerReportedCost.breakdown[${index}].amount`);
  }
}

function validateCheckpoint(value: unknown, where: string): void {
  if (value === null) return;
  if (!isPlainRecord(value) || typeof value.resumeEligible !== 'boolean') {
    fail('invalidDocument', `${where}: invalid counter checkpoint.`);
  }
  if (Object.hasOwn(value, 'checkpointHash')) hash(value.checkpointHash, `${where}.checkpointHash`);
  if (Object.hasOwn(value, 'lifecycleEventHash')) {
    hash(value.lifecycleEventHash, `${where}.lifecycleEventHash`, { nullable: true });
  }
  if (!isPlainRecord(value.vector)) fail('invalidDocument', `${where}.vector invalid.`);
  for (const [key, quantity] of Object.entries(value.vector)) {
    if (!DIALECT_RE.test(key)) fail('invalidDocument', `${where}.vector key invalid.`);
    decimal(quantity, `${where}.vector.${key}`);
  }
  cloneJson(value, where);
}

function validateParentUsageRef(value: unknown): void {
  if (value === null) return;
  exactKeys(value, [
    'runId', 'documentHash', 'checkpointHash', 'provider', 'normalizerDialect',
  ], 'parentUsageRef');
  try {
    assertAnalyticsIdentity('runId', value.runId);
  } catch {
    fail('invalidDocument', 'parentUsageRef.runId invalid.');
  }
  hash(value.documentHash, 'parentUsageRef.documentHash');
  hash(value.checkpointHash, 'parentUsageRef.checkpointHash');
  stringOrNull(value.provider, 'parentUsageRef.provider', { max: 40, pattern: PROVIDER_RE });
  stringOrNull(value.normalizerDialect, 'parentUsageRef.normalizerDialect', {
    max: 128,
    pattern: DIALECT_RE,
  });
}

/**
 * Полная проверка документа. Она одна и та же для собранного здесь и прочитанного с
 * диска: расхождение проверок означало бы, что часть документов никто не сверял.
 */
export function assertUsageDocument(document: unknown): UsageDocument {
  exactKeys(document, OUTER_KEYS, 'usageDocument');
  if (document.schemaVersion !== 1) fail('invalidDocument', 'schemaVersion обязан быть 1.');
  for (const field of [
    'taskId', 'attemptId', 'nodeVisitId', 'nodeExecutionId', 'dispatchId', 'runId',
  ] as const) {
    try {
      assertAnalyticsIdentity(field, document[field]);
    } catch {
      fail('invalidDocument', `${field}: invalid analytics identity.`);
    }
  }
  if (!Number.isSafeInteger(document.epoch) || Number(document.epoch) < 1) {
    fail('invalidDocument', 'epoch обязан быть positive safe integer.');
  }
  if (typeof document.provider !== 'string' || !PROVIDER_RE.test(document.provider)) {
    fail('invalidDocument', 'provider invalid.');
  }
  stringOrNull(document.requestedModel, 'requestedModel');
  stringOrNull(document.resolvedModel, 'resolvedModel');
  // Проверяем исходный тип: String(["complete"]) скрыл бы повреждённое поле,
  // которое затем не пройдёт строгую схему события reconciliation.
  if (typeof document.source !== 'string' || !SOURCE.has(document.source)
      || typeof document.completeness !== 'string' || !COMPLETENESS.has(document.completeness)) {
    fail('invalidDocument', 'source/completeness invalid.');
  }
  instant(document.observedAt, 'observedAt');
  for (const field of ['extractorVersion', 'normalizerDialect', 'normalizerVersion']) {
    stringOrNull(document[field], field, { max: 128, pattern: DIALECT_RE });
  }
  validateFingerprint(document.sourceFingerprint);
  if (typeof document.providerSessionMode !== 'string' || !SESSION_MODE.has(document.providerSessionMode)) {
    fail('invalidDocument', 'providerSessionMode invalid.');
  }
  stringOrNull(document.requestedProviderScope, 'requestedProviderScope', { max: 160 });
  stringOrNull(document.observedProviderScope, 'observedProviderScope', { max: 160 });
  validateParentUsageRef(document.parentUsageRef);
  validateCheckpoint(document.terminalCounterCheckpoint, 'terminalCounterCheckpoint');
  validateCheckpoint(document.lastObservedCounter, 'lastObservedCounter');
  const checkpoint = document.terminalCounterCheckpoint as { resumeEligible?: unknown } | null;

  if (typeof document.resumeEligible !== 'boolean'
      || document.resumeEligible !== (checkpoint?.resumeEligible === true)) {
    fail('invalidDocument', 'resumeEligible не сходится с terminalCounterCheckpoint.');
  }
  const sampleIds = validateSamples(document.usageSamples);
  validateSegments(document.usageSegments, sampleIds);
  validateTokenSummary(document.tokenSummary);
  validateReportedCost(document.providerReportedCost);
  cloneJson(document.providerRootResult, 'providerRootResult');
  if (!Array.isArray(document.diagnostics) || document.diagnostics.length > 128) {
    fail('invalidDocument', 'diagnostics invalid/oversize.');
  }
  const diagnostics = document.diagnostics as unknown[];
  const sortedCodes = [...new Set(diagnostics)].sort();

  if (sortedCodes.length !== diagnostics.length
      || sortedCodes.some((code, index) => code !== diagnostics[index])
      || sortedCodes.some((code) => typeof code !== 'string' || !CODE_RE.test(code))) {
    fail('invalidDocument', 'diagnostics обязаны быть unique sorted bounded codes.');
  }
  const bytes = Buffer.byteLength(`${canonicalJson(document, { bytes: MAX_DOCUMENT_BYTES })}\n`, 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) fail('documentOversize', 'Usage document превышает 2 MiB.');

  // Каждое поле проверено выше по одному: приведение здесь фиксирует итог проверки,
  // а не заменяет её.
  return document as unknown as UsageDocument;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function buildUsageDocument({
  identity,
  provider,
  requestedModel = null,
  resolvedModel = null,
  observedAt,
  sourceFingerprint,
  providerSessionMode,
  requestedProviderScope = null,
  observedProviderScope = null,
  parentUsageRef = null,
  normalization,
}: UsageDocumentInput): UsageDocument {
  if (!isPlainRecord(identity) || !isPlainRecord(normalization)) {
    fail('invalidDocument', 'identity и normalization обязательны.');
  }
  if (!Array.isArray(normalization.usageSegments)
      || normalization.usageSegments.length > MAX_SEGMENTS) {
    fail('invalidDocument', 'usageSegments превышают cap 10 000.');
  }
  if (!Array.isArray(normalization.samples) || normalization.samples.length > MAX_SAMPLES) {
    fail('invalidDocument', `usageSamples превышают cap ${MAX_SAMPLES}.`);
  }
  const document = {
    schemaVersion: 1 as const,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    nodeVisitId: identity.nodeVisitId,
    nodeExecutionId: identity.nodeExecutionId,
    dispatchId: identity.dispatchId,
    runId: identity.runId,
    epoch: identity.epoch,
    provider,
    requestedModel,
    resolvedModel,
    source: normalization.source,
    completeness: normalization.completeness,
    observedAt,
    extractorVersion: normalization.extractorVersion,
    normalizerDialect: normalization.normalizerDialect,
    normalizerVersion: normalization.extractorVersion,
    sourceFingerprint: cloneJson(sourceFingerprint, 'sourceFingerprint'),
    providerSessionMode,
    requestedProviderScope: cloneJson(requestedProviderScope, 'requestedProviderScope'),
    observedProviderScope: cloneJson(observedProviderScope, 'observedProviderScope'),
    parentUsageRef: cloneJson(parentUsageRef, 'parentUsageRef'),
    terminalCounterCheckpoint: cloneJson(
      normalization.terminalCounterCheckpoint,
      'terminalCounterCheckpoint',
    ),
    lastObservedCounter: cloneJson(normalization.lastObservedCounter, 'lastObservedCounter'),
    resumeEligible: (normalization.terminalCounterCheckpoint as {
      resumeEligible?: unknown;
    } | null)?.resumeEligible === true,
    usageSamples: cloneJson(normalization.samples, 'usageSamples'),
    usageSegments: cloneJson(normalization.usageSegments, 'usageSegments'),
    tokenSummary: cloneJson(normalization.tokenSummary, 'tokenSummary'),
    providerReportedCost: cloneJson(normalization.providerReportedCost, 'providerReportedCost'),
    providerRootResult: cloneJson(normalization.providerRootResult, 'providerRootResult'),
    diagnostics: [...new Set((normalization.diagnostics ?? []) as string[])].sort(),
  };

  assertUsageDocument(document);

  return deepFreeze(document) as unknown as UsageDocument;
}

export function encodeUsageDocument(document: unknown): Buffer {
  assertUsageDocument(document);
  return Buffer.from(`${canonicalJson(document, { bytes: MAX_DOCUMENT_BYTES })}\n`, 'utf8');
}

// Публикатор подменяется в проверках: настоящая запись на диск там не нужна.
export interface UsagePublisher {
  publishImmutable?: typeof publishImmutable;
}

export async function publishUsageDocument({ directory, document, durable = null }: {
  directory: string;
  document: UsageDocument;
  durable?: UsagePublisher | null;
}): Promise<Readonly<Record<string, unknown>>> {
  const bytes = encodeUsageDocument(document);
  const publisher = durable?.publishImmutable ?? publishImmutable;
  if (typeof publisher !== 'function') fail('invalidPublisher', 'Immutable publisher недоступен.');
  const publication = await publisher({
    directory,
    name: `${document.runId}.json`,
    bytes,
    maxBytes: MAX_DOCUMENT_BYTES,
  });
  return Object.freeze({
    ...publication,
    documentHash: publication.sha256,
    name: `${document.runId}.json`,
  });
}

export const USAGE_DOCUMENT_LIMITS = Object.freeze({
  bytes: MAX_DOCUMENT_BYTES,
  segments: MAX_SEGMENTS,
  samples: MAX_SAMPLES,
});
