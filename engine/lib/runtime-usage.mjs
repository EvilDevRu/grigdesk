#!/usr/bin/env node
// Runtime-мост к общему нормализатору аналитики. Поток провайдера читается только через
// удерживаемые дескрипторы, унаследованные от runner-launcher.

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

import { canonicalJson } from '../../server/src/lib/analytics/canonical.ts';
import {
  ANALYTICS_EXTRACTOR_VERSION,
  normalizeProviderUsage,
} from '../../server/src/lib/analytics/normalizers.ts';
import {
  assertUsageDocument,
  buildUsageDocument,
  encodeUsageDocument,
  publishUsageDocument,
} from '../../server/src/lib/analytics/usageDocument.ts';
import { ensurePrivateDirectory } from '../../server/src/lib/analytics/durableFs.ts';
import {
  inspectCodexFailure,
  inspectGlmFactoryFailure,
  runnerFailureDetail,
} from '../../server/src/lib/runnerFailure.ts';

const EVENTS_READ_FD = 7;
const EVENTS_WRITE_FD = 8;
const RUN_DIRECTORY_FD = 9;
const MAX_RAW_BYTES = 512 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_PREPARED_BYTES = 2 * 1024 * 1024;
const MAX_USAGE_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_USAGE_DOCUMENTS = 10_000;
const MAX_LIFECYCLE_PROJECTION_BYTES = 512 * 1024 * 1024;
const MAX_LIFECYCLE_ROWS = 250_000;
const HASH_RE = /^[a-f0-9]{64}$/;
const TASK_RE = /^t[1-9][0-9]{0,18}$/;
const ATTEMPT_RE = /^a_[a-f0-9]{32}$/;
const RUN_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const ORPHAN_TEMP_RE = /^\.analytics-tmp-[a-f0-9]{64}-[a-f0-9]{16,}\.tmp$/;
const SAFE_VALUE_RE = /^[^\0\r\n]*$/u;

class RuntimeUsageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeUsageError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new RuntimeUsageError(code, message);
};

function exactJsonFile(path, maxBytes) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    fail('inputUnavailable', `Cannot read ${path}.`);
  }
  if (bytes.length > maxBytes) fail('inputOversize', `${path} exceeds its bound.`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('inputInvalid', `${path} is not strict JSON.`);
  }
}

function uint(value, where) {
  const raw = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) fail('contextInvalid', `${where} is not uint.`);
  return raw;
}

function fingerprint(stat) {
  const mtimeNs = Object.hasOwn(stat, 'mtimeNs')
    ? stat.mtimeNs
    : BigInt(Math.trunc(Number(stat.mtimeMs) * 1_000_000));
  return Object.freeze({
    dev: uint(stat.dev, 'dev'),
    ino: uint(stat.ino, 'ino'),
    size: uint(stat.size, 'size'),
    mtimeNs: uint(mtimeNs, 'mtimeNs'),
    mode: Number(stat.mode & 0o777n),
    nlink: uint(stat.nlink, 'nlink'),
    regular: stat.isFile(),
    directory: stat.isDirectory(),
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.regular === right.regular;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function finalFstatHash(snapshot) {
  return sha256(Buffer.from(canonicalJson({
    dev: snapshot.dev,
    ino: snapshot.ino,
    size: snapshot.size,
    mtimeNs: snapshot.mtimeNs,
    mode: snapshot.mode,
    nlink: snapshot.nlink,
  }), 'utf8'));
}

function namedEventsSnapshot() {
  try {
    return fingerprint(lstatSync(`/proc/self/fd/${RUN_DIRECTORY_FD}/events.jsonl`, {
      bigint: true,
    }));
  } catch {
    fail('eventsPathMissing', 'events.jsonl path disappeared before sealing.');
  }
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    fail('contextInvalid', 'Context must be an object.');
  }
  const required = [
    'identity', 'provider', 'dialect', 'requestedModel', 'resolvedModel',
    'providerSessionMode', 'requestedProviderScope', 'parentUsageRef',
    'startedAt', 'quiescedAt', 'processComplete', 'runnerStartedEventHash',
    'usageDirectory', 'runDirectoryPath', 'runDirectoryIdentity', 'eventsIdentity',
  ];
  for (const key of required) {
    if (!Object.hasOwn(context, key)) fail('contextInvalid', `Context misses ${key}.`);
  }
  if (!HASH_RE.test(context.runnerStartedEventHash)) {
    fail('contextInvalid', 'runnerStartedEventHash is invalid.');
  }
  return context;
}

function readRetainedSource(context) {
  try {
    fsyncSync(EVENTS_WRITE_FD);
  } catch {
    fail('rawFsyncFailed', 'Retained events write descriptor could not be fsynced.');
  }
  const writeBefore = fingerprint(fstatSync(EVENTS_WRITE_FD, { bigint: true }));
  const readBefore = fingerprint(fstatSync(EVENTS_READ_FD, { bigint: true }));
  const namedBefore = namedEventsSnapshot();
  const expected = context.eventsIdentity;
  if (!writeBefore.regular || !readBefore.regular || !namedBefore.regular
      || writeBefore.mode !== 0o600 || readBefore.mode !== 0o600 || namedBefore.mode !== 0o600
      || writeBefore.nlink !== '1' || readBefore.nlink !== '1' || namedBefore.nlink !== '1'
      || !sameIdentity(writeBefore, readBefore) || !sameIdentity(writeBefore, namedBefore)
      || writeBefore.dev !== String(expected.dev) || writeBefore.ino !== String(expected.ino)) {
    fail('eventsIdentityMismatch', 'Retained descriptor/path identity does not match safe-open.');
  }
  const size = Number(BigInt(readBefore.size));
  if (!Number.isSafeInteger(size) || size > MAX_RAW_BYTES) {
    fail('eventsOversize', 'events.jsonl exceeds the bounded runtime reader.');
  }
  const raw = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(EVENTS_READ_FD, raw, offset, Math.min(1024 * 1024, size - offset), offset);
    if (read === 0) fail('eventsChangedDuringRead', 'events.jsonl became short during sealing.');
    offset += read;
  }
  const writeAfter = fingerprint(fstatSync(EVENTS_WRITE_FD, { bigint: true }));
  const readAfter = fingerprint(fstatSync(EVENTS_READ_FD, { bigint: true }));
  const namedAfter = namedEventsSnapshot();
  if (!sameSnapshot(writeBefore, writeAfter)
      || !sameSnapshot(readBefore, readAfter)
      || !sameSnapshot(namedBefore, namedAfter)
      || !sameIdentity(writeAfter, readAfter)
      || !sameIdentity(writeAfter, namedAfter)) {
    fail('eventsChangedDuringRead', 'events.jsonl changed during bounded sealing.');
  }
  return Object.freeze({
    raw,
    sourceFingerprint: Object.freeze({
      dev: readAfter.dev,
      ino: readAfter.ino,
      size: readAfter.size,
      mtimeNs: readAfter.mtimeNs,
      sha256: sha256(raw),
      finalFstatHash: finalFstatHash(readAfter),
      rawFsyncCompleted: true,
    }),
  });
}

function observedScope(provider, raw, normalization) {
  if (provider === 'codex') {
    return normalization.terminalCounterCheckpoint?.counterScope
      ?? normalization.lastObservedCounter?.counterScope
      ?? null;
  }
  if (provider !== 'claude') return null;
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === 'system' && row?.subtype === 'init'
          && typeof row.session_id === 'string' && row.session_id.length <= 160) {
        return row.session_id;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function conflictNormalization(provider, dialect, code) {
  return Object.freeze({
    provider,
    normalizerDialect: dialect,
    extractorVersion: ANALYTICS_EXTRACTOR_VERSION,
    source: 'unavailable',
    completeness: 'conflict',
    provenance: 'exact',
    samples: [],
    usageSegments: [],
    tokenSummary: Object.freeze({
      uncachedInput: '0', output: '0', cacheRead: '0',
      cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
    }),
    providerReportedCost: null,
    providerRootResult: null,
    terminalCounterCheckpoint: null,
    lastObservedCounter: null,
    diagnostics: [code],
  });
}

function sameStableStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function lifecycleProjection(path) {
  let info;
  let raw;
  try {
    info = lstatSync(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()
        || info.size > BigInt(MAX_LIFECYCLE_PROJECTION_BYTES)) {
      fail('reconcileInputInvalid', 'Lifecycle reconciliation projection is unsafe.');
    }
    raw = readFileSync(path);
  } catch (error) {
    if (error instanceof RuntimeUsageError) throw error;
    fail('reconcileInputInvalid', 'Lifecycle reconciliation projection is unavailable.');
  }
  const rows = [];
  let offset = 0;
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.length === 0 && offset === raw.length) break;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (rows.length >= MAX_LIFECYCLE_ROWS || Buffer.byteLength(line, 'utf8') > 64 * 1024) {
      fail('reconcileInputInvalid', 'Lifecycle reconciliation projection exceeds its bound.');
    }
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
      rows.push(value);
    } catch {
      fail('reconcileInputInvalid', 'Lifecycle reconciliation projection is invalid.');
    }
  }
  if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
    fail('reconcileInputInvalid', 'Lifecycle reconciliation projection has a torn tail.');
  }
  return rows;
}

function stableUsageDocument(directory, name, taskId, attemptId, runId) {
  const path = `${directory}/${name}`;
  let fd = null;
  try {
    const namedBefore = lstatSync(path, { bigint: true });
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()
        || namedBefore.uid !== BigInt(process.geteuid())
        || Number(namedBefore.mode & 0o777n) !== 0o600
        || namedBefore.nlink !== 1n
        || namedBefore.size < 1n
        || namedBefore.size > BigInt(MAX_USAGE_DOCUMENT_BYTES)) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!sameStableStat(namedBefore, openedBefore)) return null;
    const bytes = readFileSync(fd);
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!sameStableStat(openedBefore, openedAfter)
        || !sameStableStat(openedAfter, namedAfter)
        || bytes.length !== Number(openedAfter.size)) return null;
    const document = JSON.parse(bytes.toString('utf8'));
    assertUsageDocument(document);
    if (document.taskId !== taskId || document.attemptId !== attemptId
        || document.runId !== runId || !bytes.equals(encodeUsageDocument(document))) return null;
    return Object.freeze({
      document,
      documentHash: sha256(bytes),
      documentSizeBytes: bytes.length,
    });
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function sameRunIdentity(event, document) {
  return event.taskId === document.taskId
    && event.attemptId === document.attemptId
    && event.nodeVisitId === document.nodeVisitId
    && event.nodeExecutionId === document.nodeExecutionId
    && event.dispatchId === document.dispatchId
    && event.runId === document.runId
    && event.epoch === document.epoch;
}

function usageReconcilePlan(controlRoot, taskId, attemptId, lifecyclePath, targetRunId = null) {
  if (typeof controlRoot !== 'string' || !controlRoot.startsWith('/') || controlRoot.includes('\0')
      || !TASK_RE.test(taskId) || !ATTEMPT_RE.test(attemptId)
      || (targetRunId !== null && RUN_FILE_RE.exec(`${targetRunId}.json`)?.[1] !== targetRunId)) {
    fail('reconcileInputInvalid', 'Usage reconciliation identity is invalid.');
  }
  const rows = lifecycleProjection(lifecyclePath);
  // Reconciliation может сопоставлять 10k неизменяемых документов с lifecycle из 250k
  // событий. Один раз индексируем по ограниченной run-идентичности: фильтрация всего
  // lifecycle для каждого документа превратила бы startup recovery в квадратичное
  // сканирование под контролем атакующего.
  const eventsByRun = new Map();
  for (const event of rows) {
    if (!['runner_started', 'runner_finished', 'runner_usage_recorded',
      'runner_usage_reconciled'].includes(event.kind)
        || typeof event.runId !== 'string'
        || !Number.isSafeInteger(event.epoch) || event.epoch < 1) continue;
    const key = `${event.runId}\0${event.epoch}`;
    let grouped = eventsByRun.get(key);
    if (!grouped) {
      grouped = { started: [], finished: [], usage: [] };
      eventsByRun.set(key, grouped);
    }
    if (event.kind === 'runner_started') grouped.started.push(event);
    else if (event.kind === 'runner_finished') grouped.finished.push(event);
    else grouped.usage.push(event);
  }
  const directory = `${controlRoot}/protocol-v2/tasks/${taskId}/attempts/${attemptId}/lifecycle/usage`;
  let directoryBefore;
  let names;
  try {
    directoryBefore = lstatSync(directory, { bigint: true });
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
        || directoryBefore.uid !== BigInt(process.geteuid())
        || Number(directoryBefore.mode & 0o777n) !== 0o700) {
      fail('reconcileInputInvalid', 'Usage reconciliation directory is unsafe.');
    }
    names = targetRunId === null
      ? readdirSync(directory).sort()
      : [`${targetRunId}.json`];
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof RuntimeUsageError) throw error;
    fail('reconcileInputInvalid', 'Usage reconciliation directory is unavailable.');
  }
  if (targetRunId === null && names.length > MAX_USAGE_DOCUMENTS) {
    fail('reconcileInputInvalid', 'Usage reconciliation directory exceeds its bound.');
  }
  for (const name of names) {
    if (ORPHAN_TEMP_RE.test(name)) continue;
    const match = RUN_FILE_RE.exec(name);
    if (!match) continue;
    const entry = stableUsageDocument(directory, name, taskId, attemptId, match[1]);
    if (!entry) continue;
    const { document, documentHash, documentSizeBytes } = entry;
    const grouped = eventsByRun.get(`${document.runId}\0${document.epoch}`)
      ?? { started: [], finished: [], usage: [] };
    const usageEvents = grouped.usage;
    if (usageEvents.length > 0) {
      const exact = usageEvents.filter((event) => (
        sameRunIdentity(event, document)
        && event.details?.documentSha256 === documentHash
        && event.details?.documentSizeBytes === documentSizeBytes
      ));
      // Любая конкурирующая ссылка lifecycle — конфликт целостности. Нельзя добавлять
      // второе событие, из-за которого испорченная сторона выглядела бы авторитетной.
      if (exact.length !== 1 || usageEvents.length !== 1) continue;
      continue;
    }
    const started = grouped.started.filter((event) => (
      sameRunIdentity(event, document)
      && typeof event.spanId === 'string'
      && HASH_RE.test(event.eventHash ?? '')
    ));
    const finished = grouped.finished.filter((event) => (
      sameRunIdentity(event, document)
      && event.details?.processSessionQuiesced === true
      && event.details?.quiescedAt === document.observedAt
      && HASH_RE.test(event.eventHash ?? '')
    ));
    if (started.length !== 1 || finished.length !== 1
        || started[0].spanId !== finished[0].spanId) continue;
    const checkpointHash = document.terminalCounterCheckpoint?.checkpointHash ?? null;
    const details = {
      documentSha256: documentHash,
      documentSizeBytes,
      source: document.source,
      completeness: document.completeness,
      coverage: {
        linkCoverage: 'reconciled',
        acceptedSegmentCount: document.usageSegments.length,
        rejectedSampleCount: 0,
        diagnosticCodes: document.diagnostics,
      },
      checkpointHash,
      resumeEligible: document.resumeEligible,
      reasonCode: 'crash_gap',
      observedAt: document.observedAt,
      runnerFinishedEventHash: finished[0].eventHash,
    };
    process.stdout.write(`${canonicalJson({
      schemaVersion: 1,
      runId: document.runId,
      epoch: document.epoch,
      documentHash,
      details,
      runnerFinished: finished[0],
    })}\n`);
  }
  if (targetRunId === null) {
    let directoryAfter;
    try { directoryAfter = lstatSync(directory, { bigint: true }); } catch {
      fail('reconcileInputInvalid', 'Usage reconciliation directory disappeared.');
    }
    if (!sameStableStat(directoryBefore, directoryAfter)) {
      fail('reconcileInputInvalid', 'Usage reconciliation directory changed during scan.');
    }
  }
}

function prepare(contextPath) {
  const context = validateContext(exactJsonFile(contextPath, MAX_CONTEXT_BYTES));
  const source = readRetainedSource(context);
  const run = {
    ...context.identity,
    startedAt: context.startedAt,
    finishedAt: context.quiescedAt,
    lifecycleEventHash: context.runnerStartedEventHash,
    processComplete: context.processComplete === true,
    providerScopeUnique: context.providerSessionMode === 'fresh',
    providerSessionMode: context.providerSessionMode,
    requestedProviderScope: context.requestedProviderScope,
    // Публичный parentUsageRef — только неизменяемая ссылка на lineage. Для вычитания
    // счётчиков берём независимо безопасно открытый и привязанный к scope checkpoint,
    // собранный runner-launcher.
    parentUsageRef: context.normalizerParentUsage ?? null,
    lineageGeneration: context.lineageGeneration ?? null,
    resolvedModel: context.resolvedModel,
  };
  const normalization = normalizeProviderUsage({
    provider: context.provider,
    dialect: context.dialect,
    rawText: source.raw.toString('utf8'),
    run,
  });
  const prepared = {
    schemaVersion: 1,
    sourceFingerprint: source.sourceFingerprint,
    observedProviderScope: observedScope(context.provider, source.raw, normalization),
    normalization,
    failure: retainedFailure(context, source.raw.toString('utf8')),
  };
  process.stdout.write(`${canonicalJson(prepared, { bytes: MAX_PREPARED_BYTES })}\n`);
}

/**
 * Диагностика остановки читается из того же retained-потока, что и usage: второго
 * писателя meta.env нет. Таймаут и сигналы прерывания пояснения ошибки не получают.
 */
function retainedFailure(context, raw) {
  if (context.rc === 0 || [124, 130, 143].includes(context.rc)) {
    return null;
  }
  if (context.provider === 'codex') {
    return inspectCodexFailure(raw).failure;
  }

  return context.provider === 'glm' ? inspectGlmFactoryFailure(raw) : null;
}

function invalidate(preparedPath, code) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code)) fail('inputInvalid', 'Invalid diagnostic code.');
  const prepared = exactJsonFile(preparedPath, MAX_PREPARED_BYTES);
  const provider = prepared?.normalization?.provider;
  const dialect = prepared?.normalization?.normalizerDialect;
  prepared.normalization = conflictNormalization(provider, dialect, code);
  process.stdout.write(`${canonicalJson(prepared, { bytes: MAX_PREPARED_BYTES })}\n`);
}

async function publish(contextPath, preparedPath) {
  const context = validateContext(exactJsonFile(contextPath, MAX_CONTEXT_BYTES));
  const prepared = exactJsonFile(preparedPath, MAX_PREPARED_BYTES);
  const document = buildUsageDocument({
    identity: { ...context.identity, epoch: Number(context.identity.epoch) },
    provider: context.provider,
    requestedModel: context.requestedModel,
    resolvedModel: context.resolvedModel,
    observedAt: context.quiescedAt,
    sourceFingerprint: prepared.sourceFingerprint,
    providerSessionMode: context.providerSessionMode,
    requestedProviderScope: context.requestedProviderScope,
    observedProviderScope: prepared.observedProviderScope,
    parentUsageRef: context.parentUsageRef,
    normalization: prepared.normalization,
  });
  await ensurePrivateDirectory({ directory: context.usageDirectory });
  const publication = await publishUsageDocument({
    directory: context.usageDirectory,
    document,
  });
  const result = {
    schemaVersion: 1,
    outcome: publication.outcome,
    documentHash: publication.documentHash,
    documentSizeBytes: publication.bytes,
    source: document.source,
    completeness: document.completeness,
    acceptedSegmentCount: document.usageSegments.length,
    rejectedSampleCount: 0,
    diagnosticCodes: document.diagnostics,
    resumeEligible: document.resumeEligible,
    checkpointHash: document.terminalCounterCheckpoint?.checkpointHash ?? null,
    observedProviderScope: document.observedProviderScope,
    tokenSummary: document.tokenSummary,
    providerReportedCost: document.providerReportedCost,
  };
  process.stdout.write(`${canonicalJson(result)}\n`);
}

function assertMetaValue(key, value) {
  const raw = String(value);
  if (!SAFE_VALUE_RE.test(raw)) fail('metaValueInvalid', `${key} contains a line boundary.`);
  return `${key}=${raw}\n`;
}

function validateRunDirectory(context) {
  const opened = fingerprint(fstatSync(RUN_DIRECTORY_FD, { bigint: true }));
  let named;
  try {
    named = fingerprint(lstatSync(context.runDirectoryPath, { bigint: true }));
  } catch {
    fail('metaMirrorConflict', 'Run directory path is unavailable.');
  }
  const expected = context.runDirectoryIdentity;
  if (!opened.directory || !named.directory || !sameIdentity(opened, named)
      || opened.dev !== String(expected.dev) || opened.ino !== String(expected.ino)) {
    fail('metaMirrorConflict', 'Run directory path no longer names the retained directory.');
  }
  return opened;
}

function meta(contextPath, phase, preparedPath = null, resultClass = null) {
  const context = validateContext(exactJsonFile(contextPath, MAX_CONTEXT_BYTES));
  if (!['initial', 'final'].includes(phase)) fail('inputInvalid', 'Unknown meta phase.');
  validateRunDirectory(context);
  const prepared = preparedPath && preparedPath !== '-'
    ? exactJsonFile(preparedPath, MAX_PREPARED_BYTES)
    : null;
  const summary = prepared?.normalization?.tokenSummary ?? null;
  const reportedCost = prepared?.normalization?.providerReportedCost?.amount ?? null;
  const fields = [
    ['SCHEMA', '2'],
    ['RUNNER', context.provider],
    ['TASK', context.identity.taskId],
    ['STAGE', context.runKey],
    ['RUN_ID', context.identity.runId],
    ['EPOCH', context.identity.epoch],
    ['MODEL', context.requestedModel ?? ''],
    ['RESOLVED_MODEL', context.resolvedModel ?? ''],
    ['EFFORT', context.effort ?? ''],
    ['SOURCE', 'runtime'],
    ['ATTEMPT_ID', context.identity.attemptId],
    ['NODE_VISIT_ID', context.identity.nodeVisitId],
    ['NODE_EXECUTION_ID', context.identity.nodeExecutionId],
    ['DISPATCH_ID', context.identity.dispatchId],
    ['STARTED_AT', context.startedAt],
    ['PID', context.process.pid],
    ['PGID', context.process.processGroupId],
    ['SESSION', context.process.sessionId],
    ['STARTTIME', context.process.startTimeTicks],
    ['ROUTE_REASON', context.runReason],
    ['CLI_VERSION', context.runnerVersion],
    ['STATUS_MODE', context.statusMode],
    ['PROVIDER_SESSION_MODE', context.providerSessionMode],
    ['DEBUG_LEVEL', context.debugLevel ?? 'off'],
    ['DEBUG_SOURCE', context.debugSource ?? 'default'],
  ];
  if (phase === 'final') {
    fields.push(
      ['RESULT_CLASS', resultClass ?? context.resultClass ?? 'unknown'],
      ['RC', context.rc],
      ['FINISHED_AT', context.quiescedAt],
      ['USAGE_SCHEMA', '2'],
    );

    const showFailure = !['ok', 'timeout', 'manual_switch'].includes(resultClass ?? context.resultClass);

    if (prepared?.failure && showFailure) {
      fields.push(
        ['FAILURE_CODE', prepared.failure.code],
        ['FAILURE_MESSAGE', prepared.failure.message],
        ['FAILURE_DETAIL', runnerFailureDetail(prepared.failure, context.resolvedModel).slice(0, 220)],
      );
    }
    if (prepared && ['complete', 'partial'].includes(prepared.normalization?.completeness)) {
      fields.push(
        ['TOKENS_IN', summary.uncachedInput],
        ['TOKENS_OUT', summary.output],
        ['TOKENS_CACHE_READ', summary.cacheRead],
        ['TOKENS_CACHE_WRITE_5M', summary.cacheWrite5m],
        ['TOKENS_CACHE_WRITE_1H', summary.cacheWrite1h],
        ['TOKENS_CACHE_WRITE_UNKNOWN', summary.cacheWriteUnknown],
      );
      if (reportedCost !== null) fields.push(['COST_USD', reportedCost]);
    }
    fields.push(
      ['USAGE_COMPLETE', prepared?.normalization?.completeness === 'complete' ? '1' : '0'],
      ['META_COMPLETE', '1'],
    );
  }
  const bytes = Buffer.from(fields.map(([key, value]) => assertMetaValue(key, value)).join(''), 'utf8');
  const temp = `.meta.env.${process.pid}.${randomBytes(12).toString('hex')}`;
  const tempPath = `/proc/self/fd/${RUN_DIRECTORY_FD}/${temp}`;
  const targetPath = `/proc/self/fd/${RUN_DIRECTORY_FD}/meta.env`;
  let fd = null;
  try {
    fd = openSync(tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, targetPath);
    fsyncSync(RUN_DIRECTORY_FD);
    validateRunDirectory(context);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tempPath); } catch {}
    if (error instanceof RuntimeUsageError) throw error;
    fail('metaMirrorIoFailure', 'Atomic meta mirror publication failed.');
  }
  process.stdout.write(`${canonicalJson({ schemaVersion: 1, outcome: 'published', bytes: bytes.length })}\n`);
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'prepare' && args.length === 1) prepare(args[0]);
  else if (operation === 'invalidate' && args.length === 2) invalidate(args[0], args[1]);
  else if (operation === 'publish' && args.length === 2) await publish(args[0], args[1]);
  else if (operation === 'reconcile-plan' && (args.length === 4 || args.length === 5)) {
    usageReconcilePlan(args[0], args[1], args[2], args[3], args[4] ?? null);
  }
  else if (operation === 'meta' && args.length >= 2 && args.length <= 4) {
    meta(args[0], args[1], args[2] ?? null, args[3] ?? null);
  } else fail('inputInvalid', 'Invalid runtime-usage invocation.');
}

try {
  await main();
} catch (error) {
  const code = error?.code ?? 'runtimeUsageFailure';
  const message = error?.message ?? 'Runtime usage failed.';
  process.stderr.write(`[FACTORY_ERROR=${code}] ${message}\n`);
  process.exitCode = code === 'inputInvalid' || code === 'contextInvalid' ? 2 : 78;
}
