// Сборка, проверка и атомарная публикация неизменяемых документов потребления раннеров.
import { canonicalJson } from './canonical.js';
import { assertAnalyticsIdentity } from './contracts.js';
import { canonicalDecimal } from './decimal.js';
import { publishImmutable } from './durable-fs.js';

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
  constructor(code, message) {
    super(message);
    this.name = 'AnalyticsUsageDocumentError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new AnalyticsUsageDocumentError(code, message);
};

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record, keys, where) {
  if (!isRecord(record)) fail('invalidDocument', `${where}: ожидался object.`);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalidDocument', `${where}: недопустимый набор полей.`);
  }
}

function stringOrNull(value, where, { max = 160, pattern = null } = {}) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > max
      || (pattern && !pattern.test(value))) {
    fail('invalidDocument', `${where}: ожидалась bounded string или null.`);
  }
  return value;
}

function instant(value, where) {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) {
    fail('invalidDocument', `${where}: ожидался canonical UTC instant.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('invalidDocument', `${where}: недопустимый UTC instant.`);
  }
  return value;
}

function uint(value, where, { positive = false } = {}) {
  if (typeof value !== 'string' || !UINT_RE.test(value) || (positive && value === '0')) {
    fail('invalidDocument', `${where}: ожидался canonical uint decimal string.`);
  }
  return value;
}

function decimal(value, where) {
  if (canonicalDecimal(value, { significantDigits: 30, maxScale: 18, where }) === null) {
    fail('invalidQuantity', `${where}: quantity/cost не является canonical decimal.`);
  }
  return value;
}

function hash(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    fail('invalidDocument', `${where}: ожидался SHA-256.`);
  }
  return value;
}

function cloneJson(value, where) {
  try {
    canonicalJson(value, { bytes: MAX_DOCUMENT_BYTES });
    return structuredClone(value);
  } catch (error) {
    fail('invalidDocument', `${where}: значение не входит в canonical JSON contract (${error.message}).`);
  }
}

function validateFingerprint(value) {
  exactKeys(value, [
    'dev', 'ino', 'size', 'mtimeNs', 'sha256', 'finalFstatHash', 'rawFsyncCompleted',
  ], 'sourceFingerprint');
  for (const field of ['dev', 'ino', 'size', 'mtimeNs']) uint(value[field], `sourceFingerprint.${field}`);
  hash(value.sha256, 'sourceFingerprint.sha256');
  hash(value.finalFstatHash, 'sourceFingerprint.finalFstatHash');
  if (typeof value.rawFsyncCompleted !== 'boolean') {
    fail('invalidDocument', 'sourceFingerprint.rawFsyncCompleted обязан быть boolean.');
  }
}

function validateBillingWindow(value, where) {
  if (!isRecord(value)) fail('invalidDocument', `${where}: billingWindow обязан быть object.`);
  if (value.kind === 'unknown') {
    exactKeys(value, ['kind', 'basis'], where);
    if (value.basis !== 'unknown') fail('invalidDocument', `${where}: unknown basis обязан быть unknown.`);
    return;
  }
  exactKeys(value, ['kind', 'notBefore', 'notAfter', 'basis'], where);
  if (value.kind !== 'closed'
      || !['provider_billing', 'provider_event', 'trusted_run_window', 'derived_run_window']
        .includes(value.basis)) {
    fail('invalidDocument', `${where}: неизвестный closed billingWindow.`);
  }
  instant(value.notBefore, `${where}.notBefore`);
  instant(value.notAfter, `${where}.notAfter`);
  if (value.notBefore > value.notAfter) fail('invalidDocument', `${where}: notBefore > notAfter.`);
}

function validateSamples(samples) {
  if (!Array.isArray(samples) || samples.length > MAX_SAMPLES) {
    fail('invalidDocument', `usageSamples превышают cap ${MAX_SAMPLES}.`);
  }
  const ids = new Set();
  for (const [index, sample] of samples.entries()) {
    if (!isRecord(sample) || !SAMPLE_ID_RE.test(sample.sampleId ?? '')) {
      fail('invalidDocument', `usageSamples[${index}]: invalid sampleId.`);
    }
    if (ids.has(sample.sampleId)) fail('invalidDocument', `usageSamples[${index}]: duplicate sampleId.`);
    ids.add(sample.sampleId);
    uint(sample.sourceOrdinal, `usageSamples[${index}].sourceOrdinal`, { positive: true });
    uint(sample.byteOffset, `usageSamples[${index}].byteOffset`);
    hash(sample.lineHash, `usageSamples[${index}].lineHash`);
    if (!isRecord(sample.vector)) fail('invalidDocument', `usageSamples[${index}].vector invalid.`);
    for (const [key, quantity] of Object.entries(sample.vector)) {
      if (!DIALECT_RE.test(key)) fail('invalidDocument', `usageSamples[${index}].vector key invalid.`);
      decimal(quantity, `usageSamples[${index}].vector.${key}`);
    }
  }
  return ids;
}

function validateSegments(segments, sampleIds) {
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
    fail('invalidDocument', `usageSegments превышают cap 10 000.`);
  }
  const ids = new Set();
  for (const [index, segment] of segments.entries()) {
    const where = `usageSegments[${index}]`;
    if (!isRecord(segment) || !SEGMENT_ID_RE.test(segment.segmentId ?? '')) {
      fail('invalidDocument', `${where}: invalid segmentId.`);
    }
    if (ids.has(segment.segmentId)) fail('invalidDocument', `${where}: duplicate segmentId.`);
    ids.add(segment.segmentId);
    if (!isRecord(segment.sampleRange)
        || !sampleIds.has(segment.sampleRange.firstSampleId)
        || !sampleIds.has(segment.sampleRange.lastSampleId)) {
      fail('invalidDocument', `${where}.sampleRange не ссылается на usageSamples.`);
    }
    validateBillingWindow(segment.billingWindow, `${where}.billingWindow`);
    stringOrNull(segment.metric, `${where}.metric`, { max: 80, pattern: DIALECT_RE });
    stringOrNull(segment.unit, `${where}.unit`, { max: 40, pattern: DIALECT_RE });
    decimal(segment.quantity, `${where}.quantity`);
    stringOrNull(segment.resolvedModel, `${where}.resolvedModel`, { max: 160 });
    if (!SOURCE.has(segment.source) || !COMPLETENESS.has(segment.completeness)) {
      fail('invalidDocument', `${where}: source/completeness invalid.`);
    }
    cloneJson(segment.attributes, `${where}.attributes`);
  }
}

function validateTokenSummary(value) {
  exactKeys(value, [
    'uncachedInput', 'output', 'cacheRead',
    'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown',
  ], 'tokenSummary');
  for (const [key, quantity] of Object.entries(value)) decimal(quantity, `tokenSummary.${key}`);
}

function validateReportedCost(value) {
  if (value === null) return;
  exactKeys(value, ['currency', 'amount', 'semantics', 'breakdown'], 'providerReportedCost');
  if (value.currency !== 'USD' || value.semantics !== 'run_total' || !Array.isArray(value.breakdown)) {
    fail('invalidDocument', 'providerReportedCost contract invalid.');
  }
  decimal(value.amount, 'providerReportedCost.amount');
  if (value.breakdown.length > 1_000) fail('invalidDocument', 'providerReportedCost breakdown oversize.');
  for (const [index, entry] of value.breakdown.entries()) {
    exactKeys(entry, ['model', 'rawModel', 'amount'], `providerReportedCost.breakdown[${index}]`);
    stringOrNull(entry.model, `providerReportedCost.breakdown[${index}].model`, { max: 160 });
    stringOrNull(entry.rawModel, `providerReportedCost.breakdown[${index}].rawModel`, { max: 160 });
    decimal(entry.amount, `providerReportedCost.breakdown[${index}].amount`);
  }
}

function validateCheckpoint(value, where) {
  if (value === null) return;
  if (!isRecord(value) || typeof value.resumeEligible !== 'boolean') {
    fail('invalidDocument', `${where}: invalid counter checkpoint.`);
  }
  if (Object.hasOwn(value, 'checkpointHash')) hash(value.checkpointHash, `${where}.checkpointHash`);
  if (Object.hasOwn(value, 'lifecycleEventHash')) {
    hash(value.lifecycleEventHash, `${where}.lifecycleEventHash`, { nullable: true });
  }
  if (!isRecord(value.vector)) fail('invalidDocument', `${where}.vector invalid.`);
  for (const [key, quantity] of Object.entries(value.vector)) {
    if (!DIALECT_RE.test(key)) fail('invalidDocument', `${where}.vector key invalid.`);
    decimal(quantity, `${where}.vector.${key}`);
  }
  cloneJson(value, where);
}

function validateParentUsageRef(value) {
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

export function assertUsageDocument(document) {
  exactKeys(document, OUTER_KEYS, 'usageDocument');
  if (document.schemaVersion !== 1) fail('invalidDocument', 'schemaVersion обязан быть 1.');
  for (const field of [
    'taskId', 'attemptId', 'nodeVisitId', 'nodeExecutionId', 'dispatchId', 'runId',
  ]) {
    try {
      assertAnalyticsIdentity(field, document[field]);
    } catch {
      fail('invalidDocument', `${field}: invalid analytics identity.`);
    }
  }
  if (!Number.isSafeInteger(document.epoch) || document.epoch < 1) {
    fail('invalidDocument', 'epoch обязан быть positive safe integer.');
  }
  if (typeof document.provider !== 'string' || !PROVIDER_RE.test(document.provider)) {
    fail('invalidDocument', 'provider invalid.');
  }
  stringOrNull(document.requestedModel, 'requestedModel');
  stringOrNull(document.resolvedModel, 'resolvedModel');
  if (!SOURCE.has(document.source) || !COMPLETENESS.has(document.completeness)) {
    fail('invalidDocument', 'source/completeness invalid.');
  }
  instant(document.observedAt, 'observedAt');
  for (const field of ['extractorVersion', 'normalizerDialect', 'normalizerVersion']) {
    stringOrNull(document[field], field, { max: 128, pattern: DIALECT_RE });
  }
  validateFingerprint(document.sourceFingerprint);
  if (!SESSION_MODE.has(document.providerSessionMode)) fail('invalidDocument', 'providerSessionMode invalid.');
  stringOrNull(document.requestedProviderScope, 'requestedProviderScope', { max: 160 });
  stringOrNull(document.observedProviderScope, 'observedProviderScope', { max: 160 });
  validateParentUsageRef(document.parentUsageRef);
  validateCheckpoint(document.terminalCounterCheckpoint, 'terminalCounterCheckpoint');
  validateCheckpoint(document.lastObservedCounter, 'lastObservedCounter');
  if (typeof document.resumeEligible !== 'boolean'
      || document.resumeEligible !== (document.terminalCounterCheckpoint?.resumeEligible === true)) {
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
  const sortedCodes = [...new Set(document.diagnostics)].sort();
  if (sortedCodes.length !== document.diagnostics.length
      || sortedCodes.some((code, index) => code !== document.diagnostics[index])
      || sortedCodes.some((code) => typeof code !== 'string' || !CODE_RE.test(code))) {
    fail('invalidDocument', 'diagnostics обязаны быть unique sorted bounded codes.');
  }
  const bytes = Buffer.byteLength(`${canonicalJson(document, { bytes: MAX_DOCUMENT_BYTES })}\n`, 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) fail('documentOversize', 'Usage document превышает 2 MiB.');
  return document;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
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
}) {
  if (!isRecord(identity) || !isRecord(normalization)) {
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
    schemaVersion: 1,
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
    resumeEligible: normalization.terminalCounterCheckpoint?.resumeEligible === true,
    usageSamples: cloneJson(normalization.samples, 'usageSamples'),
    usageSegments: cloneJson(normalization.usageSegments, 'usageSegments'),
    tokenSummary: cloneJson(normalization.tokenSummary, 'tokenSummary'),
    providerReportedCost: cloneJson(normalization.providerReportedCost, 'providerReportedCost'),
    providerRootResult: cloneJson(normalization.providerRootResult, 'providerRootResult'),
    diagnostics: [...new Set(normalization.diagnostics ?? [])].sort(),
  };
  assertUsageDocument(document);
  return deepFreeze(document);
}

export function encodeUsageDocument(document) {
  assertUsageDocument(document);
  return Buffer.from(`${canonicalJson(document, { bytes: MAX_DOCUMENT_BYTES })}\n`, 'utf8');
}

export async function publishUsageDocument({ directory, document, durable = null }) {
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
