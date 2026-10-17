// Нормализация данных о потреблении из потоков провайдеров в единые аналитические образцы и сегменты.
import { createHash } from 'node:crypto';

import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import { canonicalJson } from './canonical.ts';
import { addDecimals } from './decimal.ts';
import {
  AnalyticsExactJsonError,
  decimalFromJsonNumber,
  exactUnsignedInteger,
  parseExactJson,
} from './exactJson.ts';

const EXTRACTOR_VERSION = 'usage-normalizer-1';
const MAX_RAW_BYTES = 512 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 1_000_000;
const HASH_RE = /^[a-f0-9]{64}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIALECTS = Object.freeze({
  codex: new Set(['codex-jsonl-v1']),
  claude: new Set(['claude-code-jsonl-2.1.220']),
});

export class AnalyticsNormalizerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnalyticsNormalizerError';
    this.code = code;
  }
}

/**
 * Отказ нормализации. Объявлен функцией, а не стрелкой в const: только у объявления
 * компилятор считает `never` признаком «дальше кода нет» и сужает по нему тип.
 */
function fail(code: string, message: string): never {
  throw new AnalyticsNormalizerError(code, message);
}

// Свободная запись из потока провайдера: форма у каждого своя, и общего типа у неё нет.
type Row = Record<string, unknown>;

// Разобранный поток: строки с их местом в файле и признак обрыва последней строки.
// Обрыв — не ошибка: процесс могли остановить, и такой хвост честно помечается.
interface StreamRow extends Row {
  // Полезная нагрузка уже проверена разбором: до сюда доходит только объект.
  value: Row;
  sourceOrdinal: string;
  byteOffset: string;
  lineHash: string;
}

interface ParsedStream {
  rows: StreamRow[];
  hasTornTail: boolean;
}

// Прогон, вокруг которого считается потребление: идентичность, окно и модель.
export type RunContext = Record<string, unknown>;

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function deterministicId(prefix: string, tuple: readonly unknown[]): string {
  return `${prefix}_${digest(canonicalJson([1, prefix, tuple])).slice(0, 32)}`;
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function billingWindow(run: RunContext | undefined): Row {
  const notBefore = canonicalInstant(run?.startedAt);
  const notAfter = canonicalInstant(run?.finishedAt);

  if (notBefore && notAfter && notBefore <= notAfter) {
    const basis = run?.billingWindowBasis === 'derived_run_window'
      ? 'derived_run_window'
      : 'trusted_run_window';
    return { kind: 'closed', notBefore, notAfter, basis };
  }
  return { kind: 'unknown', basis: 'unknown' };
}

function selected(record: unknown, keys: readonly string[]): Row {
  const output = Object.create(null);
  for (const key of keys) {
    if (isPlainRecord(record) && Object.hasOwn(record, key)) output[key] = record[key];
  }
  return output;
}

function sanitizeModelUsage(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const output = Object.create(null);
  for (const rawModel of Object.keys(value)) {
    output[rawModel] = selected(value[rawModel], [
      'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
      'webSearchRequests', 'costUSD', 'contextWindow', 'maxOutputTokens',
      'canonicalModel', 'provider',
    ]);
  }
  return output;
}

function sanitizeProviderValue(provider: string, value: Row): Row | null {
  if (provider === 'codex') {
    if (value.type === 'thread.started') return selected(value, ['type', 'thread_id']);
    if (value.type === 'turn.completed') {
      const output = selected(value, ['type']);
      if (Object.hasOwn(value, 'usage')) output.usage = selected(value.usage, [
        'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
        'output_tokens', 'reasoning_output_tokens',
      ]);
      return output;
    }
    return null;
  }
  if (provider !== 'claude') return null;
  if (value.type === 'system' && value.subtype === 'init') {
    return selected(value, ['type', 'subtype', 'session_id', 'claude_code_version']);
  }
  if (value.type === 'assistant') {
    const output = selected(value, [
      'type', 'session_id', 'request_id', 'parent_tool_use_id', 'timestamp',
    ]);
    if (Object.hasOwn(value, 'message')) {
      const message = selected(value.message, ['id', 'model']);

      output.message = message;

      if (isPlainRecord(value.message) && Object.hasOwn(value.message, 'usage')) {
        const usage = selected(value.message.usage, [
          'input_tokens', 'output_tokens', 'cache_read_input_tokens',
          'cache_creation_input_tokens', 'service_tier', 'inference_geo', 'speed',
        ]);

        message.usage = usage;

        if (isPlainRecord(value.message.usage)
            && Object.hasOwn(value.message.usage, 'cache_creation')) {
          usage.cache_creation = selected(value.message.usage.cache_creation, [
            'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens',
          ]);
        }
      }
    }
    return output;
  }
  if (value.type === 'result') {
    const output = selected(value, [
      'type', 'subtype', 'is_error', 'session_id', 'parent_tool_use_id',
    ]);
    if (Object.hasOwn(value, 'origin')) {
      output.origin = value.origin === null ? null : selected(value.origin, ['kind']);
    }
    if (Object.hasOwn(value, 'modelUsage')) output.modelUsage = sanitizeModelUsage(value.modelUsage);
    return output;
  }
  return null;
}

// Одна строка потока провайдера вместе со своим местом в файле: смещение и хеш
// нужны, чтобы образец можно было найти в исходнике и сверить.
export interface ProviderUsageRowInput {
  provider: string;
  text: unknown;
  sourceOrdinal: unknown;
  byteOffset: unknown;
  lineHash: unknown;
}

export function parseProviderUsageRow({
  provider,
  text,
  sourceOrdinal,
  byteOffset,
  lineHash,
}: ProviderUsageRowInput): Row | null {
  if (!Object.hasOwn(DIALECTS, provider)
      || typeof text !== 'string'
      || typeof sourceOrdinal !== 'string' || !/^[1-9][0-9]*$/.test(sourceOrdinal)
      || typeof byteOffset !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(byteOffset)
      || typeof lineHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineHash)) {
    fail('rawRowInvalid', 'Provider raw row metadata invalid.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
    fail('rawLineOversize', `Provider line превышает ${MAX_LINE_BYTES} bytes.`);
  }
  // Потоки провайдера также содержат строки полезной нагрузки prompt/tool/result. Они вне
  // закреплённого диалекта потребления и не должны делать корректную проекцию невалидной
  // только потому, что игнорируемая нагрузка содержит неканоническое число или Unicode-значение.
  // JSON.parse используется лишь как ограниченный разбор внешней оболочки; каждая строка
  // с учётом потребления ниже разбирается повторно точным анализатором, сохраняющим дубли ключей и чисел.
  let envelope: unknown;

  try {
    envelope = JSON.parse(text);
  } catch {
    fail('rawJsonInvalid', 'Provider JSON line невалидна.');
  }
  if (!isPlainRecord(envelope)) fail('rawRowInvalid', 'Provider JSON line обязана быть object.');
  const supportedEnvelope = provider === 'codex'
    ? envelope.type === 'thread.started' || envelope.type === 'turn.completed'
    : envelope.type === 'assistant' || envelope.type === 'result'
      || (envelope.type === 'system' && envelope.subtype === 'init');
  if (!supportedEnvelope) return null;
  let value: unknown;

  try {
    value = parseExactJson(text, { bytes: MAX_LINE_BYTES });
  } catch (error) {
    if (error instanceof AnalyticsExactJsonError) {
      fail('rawJsonInvalid', 'Provider JSON line невалидна.');
    }
    throw error;
  }
  if (!isPlainRecord(value)) fail('rawRowInvalid', 'Provider JSON line обязана быть object.');
  const sanitized = sanitizeProviderValue(provider, value);
  if (sanitized === null) return null;
  return { value: sanitized, sourceOrdinal, byteOffset, lineHash };
}

function parseJsonLines(rawText: unknown, provider: string): ParsedStream {
  if (typeof rawText !== 'string') fail('rawTypeInvalid', 'rawText обязан быть строкой.');
  if (Buffer.byteLength(rawText, 'utf8') > MAX_RAW_BYTES) {
    fail('rawOversize', `Provider raw превышает ${MAX_RAW_BYTES} bytes.`);
  }
  const hasTornTail = rawText.length > 0 && !rawText.endsWith('\n');
  const pieces = rawText.split('\n');
  if (!hasTornTail) pieces.pop();
  if (pieces.length > MAX_LINES) fail('rawLineCap', `Provider raw превышает ${MAX_LINES} lines.`);

  const rows: StreamRow[] = [];
  let byteOffset = 0;
  for (const [index, line] of pieces.entries()) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > MAX_LINE_BYTES) fail('rawLineOversize', `Provider line превышает ${MAX_LINE_BYTES} bytes.`);
    if (line.length === 0) fail('rawEmptyLine', `Provider raw содержит пустую line ${index + 1}.`);
    try {
      const row = parseProviderUsageRow({
        provider,
        text: line,
      sourceOrdinal: String(index + 1),
      byteOffset: String(byteOffset),
      lineHash: digest(line),
      });
      if (row !== null) rows.push(row as StreamRow);
    } catch (error) {
      if (error instanceof AnalyticsNormalizerError) {
        fail(error.code, `Provider line ${index + 1} не прошла strict extraction.`);
      }
      throw error;
    }
    byteOffset += lineBytes + 1;
  }
  return { rows, hasTornTail };
}

function unknownResult(
  provider: string | null,
  dialect: string | null,
  diagnostics: readonly string[],
): Row {
  return {
    provider,
    normalizerDialect: dialect,
    extractorVersion: EXTRACTOR_VERSION,
    source: 'unavailable',
    completeness: 'missing',
    provenance: 'exact',
    samples: [],
    usageSegments: [],
    tokenSummary: emptyTokenSummary(),
    providerReportedCost: null,
    providerRootResult: null,
    terminalCounterCheckpoint: null,
    lastObservedCounter: null,
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

// Сводка токенов: набор метрик закрыт, и отсутствующей среди них быть не может.
// Открытый словарь заставлял бы подставлять ноль на каждом чтении и прятал бы опечатку.
export interface TokenSummary {
  uncachedInput: string;
  output: string;
  cacheRead: string;
  cacheWrite5m: string;
  cacheWrite1h: string;
  cacheWriteUnknown: string;
}

function emptyTokenSummary(): TokenSummary {
  return {
    uncachedInput: '0',
    output: '0',
    cacheRead: '0',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    cacheWriteUnknown: '0',
  };
}

function exactUint(record: Row, key: string, where: string): string | null {
  if (!isPlainRecord(record) || !Object.hasOwn(record, key)) {
    fail('counterComponentMissing', `${where}.${key}: required counter отсутствует.`);
  }
  try {
    return exactUnsignedInteger(record[key], {
      significantDigits: 30,
      maxScale: 0,
      maxWholeDigits: 30,
    });
  } catch (error) {
    if (error instanceof AnalyticsExactJsonError) {
      fail('counterInvalid', `${where}.${key}: counter обязан быть bounded uint.`);
    }
    throw error;
  }
}

function exactCost(record: Row, key: string, where: string): string | null {
  if (!isPlainRecord(record) || !Object.hasOwn(record, key)) {
    fail('modelCostMissing', `${where}.${key}: exact cost отсутствует.`);
  }
  try {
    return decimalFromJsonNumber(record[key], {
      significantDigits: 30,
      maxScale: 18,
      maxWholeDigits: 12,
    });
  } catch (error) {
    if (error instanceof AnalyticsExactJsonError) {
      fail('modelCostInvalid', `${where}.${key}: cost обязан быть bounded non-negative decimal.`);
    }
    throw error;
  }
}

const uintAdd = (...values: string[]) => values.reduce(
  (sum, value) => sum + BigInt(value),
  0n,
).toString();
const uintSubtract = (left: string, right: string) => {
  const result = BigInt(left) - BigInt(right);
  if (result < 0n) fail('negativeDelta', 'Negative cumulative delta запрещён.');
  return result.toString();
};

function uintVectorNondecreasing(
  previous: Record<string, string>,
  current: Record<string, string>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => BigInt(current[key] ?? '0') >= BigInt(previous[key] ?? '0'));
}

// Каноническое значение разбирается на коэффициент и порядок: сравнивать
// десятичные строки текстом нельзя — «0.10» и «0.1» равны, а лексикографически нет.
function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const [whole = '', fraction = ''] = value.split('.');

  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const aValue = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bValue = b.coefficient * 10n ** BigInt(scale - b.scale);
  return aValue === bValue ? 0 : aValue < bValue ? -1 : 1;
}

function sampleId(
  run: RunContext,
  provider: string,
  dialect: string,
  row: Row,
  scope: unknown,
): string {
  return deterministicId('sa', [
    run?.taskId ?? null,
    run?.attemptId ?? null,
    run?.runId ?? null,
    provider,
    dialect,
    scope,
    row.sourceOrdinal,
    row.byteOffset,
    row.lineHash,
  ]);
}

function billingProduct(provider: string): string | null {
  if (provider === 'claude') return 'messages';
  if (provider === 'codex') return 'responses';

  return null;
}

function resolvedModelFromRun(run: RunContext): string | null {
  const value = run?.resolvedModel;
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

// Из чего складывается один сегмент потребления. Атрибуты ценообразования и окно
// приходят от конкретного провайдера, поэтому объявлены свободно.
interface UsageSegmentInput {
  run: RunContext;
  provider: string;
  dialect: string;
  sampleIds: string[];
  metric: string;
  quantity: string;
  resolvedModel?: string | null;
  cacheMode?: string | null;
  cacheTtl?: string | null;
  reasoningTokens?: string | null;
  pricingAttributes?: Row | null;
  segmentWindow?: Row | null;
  completeness: string;
  source: string;
}

function usageSegment({
  run,
  provider,
  dialect,
  sampleIds,
  metric,
  quantity,
  resolvedModel = null,
  cacheMode = null,
  cacheTtl = null,
  reasoningTokens = null,
  pricingAttributes = null,
  segmentWindow = null,
  completeness,
  source,
}: UsageSegmentInput): Row {
  const attributes: Row = {
    billingProduct: billingProduct(provider),
    serviceTier: pricingAttributes?.serviceTier ?? null,
    inferenceGeo: pricingAttributes?.inferenceGeo ?? null,
    speed: pricingAttributes?.speed ?? null,
    contextBand: pricingAttributes?.contextBand ?? null,
    cacheMode,
    cacheTtl,
    toolName: null,
  };
  if (reasoningTokens !== null) attributes.reasoningTokens = reasoningTokens;
  const firstSampleId = sampleIds[0];
  const lastSampleId = sampleIds[sampleIds.length - 1];
  const segmentId = deterministicId('us', [
    run?.taskId ?? null,
    run?.attemptId ?? null,
    run?.runId ?? null,
    EXTRACTOR_VERSION,
    provider,
    dialect,
    firstSampleId,
    lastSampleId,
    metric,
    'token',
    resolvedModel,
    attributes,
  ]);
  return {
    segmentId,
    sampleRange: { firstSampleId, lastSampleId },
    billingWindow: segmentWindow ?? billingWindow(run),
    metric,
    unit: 'token',
    quantity,
    resolvedModel,
    attributes,
    source,
    completeness,
  };
}

function tokenSegments({
  run,
  provider,
  dialect,
  sampleIds,
  vector,
  resolvedModel = null,
  completeness,
  source,
  metricCompleteness = null,
  availableMetrics = null,
}: {
  run: RunContext;
  provider: string;
  dialect: string;
  sampleIds: string[];
  vector: Record<string, string>;
  resolvedModel?: string | null;
  completeness: string;
  source: string;
  metricCompleteness?: Record<string, string> | null;
  availableMetrics?: Set<string> | null;
}): Row[] {
  // [метрика, количество, режим кеша, срок кеша, токены рассуждения, ключ вектора]
  // Отсутствующая метрика — это ноль: вектор собирается выше и всегда полон, а
  // подстановка здесь защищает от опечатки в имени ключа, а не от чужих данных.
  const amount = (key: string) => vector[key] ?? '0';
  const definitions: [string, string, string | null, string | null, string | null, string][] = [
    ['input_tokens', amount('uncachedInput'), 'none', null, null, 'uncachedInput'],
    ['output_tokens', amount('output'), null, null, vector.reasoningOutput ?? null, 'output'],
    ['cache_read_tokens', amount('cacheRead'), 'read', null, null, 'cacheRead'],
    ['cache_write_tokens', amount('cacheWrite5m'), 'write', '5m', null, 'cacheWrite5m'],
    ['cache_write_tokens', amount('cacheWrite1h'), 'write', '1h', null, 'cacheWrite1h'],
    ['cache_write_tokens', amount('cacheWriteUnknown'), 'write', 'unknown', null, 'cacheWriteUnknown'],
  ];
  return definitions
    .filter(([, quantity, , , , key]) => (
      (availableMetrics === null || availableMetrics.has(key)) && BigInt(quantity) > 0n
    ))
    .map(([metric, quantity, cacheMode, cacheTtl, reasoningTokens, key]) => usageSegment({
      run,
      provider,
      dialect,
      sampleIds,
      metric,
      quantity,
      resolvedModel: resolvedModel ?? resolvedModelFromRun(run),
      cacheMode,
      cacheTtl,
      reasoningTokens,
      completeness: metricCompleteness?.[key] ?? completeness,
      source,
    }));
}

const CODEX_COUNTER_KEYS = Object.freeze([
  'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningOutputTokens',
] as const);

// Накопительные счётчики codex: набор закрыт контрактом диалекта. Открытый словарь
// требовал бы подставлять ноль на каждом чтении и прятал бы опечатку в имени.
type CodexCounterKey = typeof CODEX_COUNTER_KEYS[number];
type CodexCounters = Record<CodexCounterKey, string>;

// Итог поиска базовой линии продолженного прогона: либо вектор счётчиков, либо
// причина, по которой его нельзя использовать. Пустой ответ здесь запрещён — иначе
// «нет базовой линии» и «база не подошла» выглядели бы одинаково.
interface CodexBaseline {
  baseline: CodexCounters | null;
  diagnostic: string | null;
}

/**
 * Базовая линия счётчиков для продолженного прогона codex. Счётчики провайдера
 * накопительные, и без проверенной базы разница посчиталась бы от нуля — то есть
 * весь прошлый расход записался бы этому прогону второй раз.
 */
function codexResumeBaseline(
  run: RunContext,
  dialect: string,
  threadId: unknown,
): CodexBaseline {
  const reference = run?.parentUsageRef;

  if (!isPlainRecord(reference)) {
    return { baseline: null, diagnostic: 'baselineMissing' };
  }

  const checkpoint = reference.terminalCounterCheckpoint;

  if (reference.resumeVerified !== true || !isPlainRecord(checkpoint)
      || checkpoint.resumeEligible !== true || !isPlainRecord(checkpoint.vector)) {
    return { baseline: null, diagnostic: 'baselineMissing' };
  }

  const vector = checkpoint.vector;
  const generation = run?.lineageGeneration;

  if (typeof threadId !== 'string' || threadId.length < 1
      || run?.requestedProviderScope !== threadId
      || checkpoint.counterScope !== threadId
      || checkpoint.dialect !== dialect
      || checkpoint.extractorVersion !== EXTRACTOR_VERSION
      || !Number.isSafeInteger(generation) || Number(generation) < 1) {
    return { baseline: null, diagnostic: 'scopeConflict' };
  }

  const mask = checkpoint.presenceMask;

  if (!Array.isArray(mask)
      || mask.length !== CODEX_COUNTER_KEYS.length
      || CODEX_COUNTER_KEYS.some((key, index) => mask[index] !== key)
      || Object.keys(vector).sort().join('\u0000')
        !== [...CODEX_COUNTER_KEYS].sort().join('\u0000')
      || CODEX_COUNTER_KEYS.some((key) => (
        typeof vector[key] !== 'string'
          || !/^(?:0|[1-9][0-9]{0,29})$/u.test(String(vector[key]))
      ))) {
    return { baseline: null, diagnostic: 'baselineMissing' };
  }

  return { baseline: vector as unknown as CodexCounters, diagnostic: null };
}

function normalizeCodex({ provider, dialect, parsed, run }: {
  provider: string;
  dialect: string;
  parsed: ParsedStream;
  run: RunContext;
}): Row {
  const diagnostics = new Set<string>();

  if (parsed.hasTornTail) diagnostics.add('tornRawTail');

  const threadRows: (StreamRow & { rowIndex: number })[] = [];
  const usageRows: StreamRow[] = [];
  let firstUsageIndex: number | null = null;
  for (const [index, row] of parsed.rows.entries()) {
    if (row.value.type === 'thread.started') threadRows.push({ ...row, rowIndex: index });
    if (row.value.type === 'turn.completed' && isPlainRecord(row.value.usage)) {
      if (firstUsageIndex === null) firstUsageIndex = index;
      usageRows.push(row);
    }
  }
  if (usageRows.length === 0) {
    return unknownResult(provider, dialect, [
      ...diagnostics,
      parsed.hasTornTail ? 'providerPartialWithoutUsage' : 'usageSnapshotMissing',
    ]);
  }

  const usageStart = firstUsageIndex ?? 0;
  const precedingThreads = threadRows.filter((row) => row.rowIndex < usageStart);
  // Идентификатор потока берётся, только если он ОДИН до первой записи расхода:
  // два потока означают, что счётчики принадлежат разным сессиям, и складывать их
  // нельзя. Границы длины и запрет управляющих символов — контракт scope.
  const onlyThread = precedingThreads.length === 1 ? precedingThreads[0] : null;
  const rawThreadId = onlyThread?.value.thread_id;
  const threadId = typeof rawThreadId === 'string'
    && rawThreadId.length > 0
    && rawThreadId.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(rawThreadId)
    ? rawThreadId
    : null;
  const freshProof = run?.providerSessionMode === 'fresh'
    && run?.providerScopeUnique === true
    && precedingThreads.length === 1
    && threadId !== null;
  const legacyProof = run?.providerSessionMode === 'legacy-derived'
    && precedingThreads.length === 1
    && threadId !== null;

  let baseline: CodexCounters;

  if (freshProof || legacyProof) {
    baseline = {
      inputTokens: '0', cachedInputTokens: '0', cacheWriteInputTokens: '0',
      outputTokens: '0', reasoningOutputTokens: '0',
    };
  } else if (run?.providerSessionMode === 'resume') {
    const verified = codexResumeBaseline(run, dialect, threadId);
    if (verified.baseline === null) {
      diagnostics.add(verified.diagnostic ?? 'baselineMissing');
      return {
        ...unknownResult(provider, dialect, [...diagnostics]),
        completeness: 'conflict',
      };
    }
    baseline = verified.baseline;
  } else {
    diagnostics.add('baselineMissing');
    diagnostics.add('counterScopeUnproven');
    return {
      ...unknownResult(provider, dialect, [...diagnostics]),
      completeness: 'conflict',
    };
  }

  const keys = CODEX_COUNTER_KEYS;
  const zero = Object.freeze(
    Object.fromEntries(keys.map((key) => [key, '0'])),
  ) as unknown as CodexCounters;
  const initialGeneration = run?.providerSessionMode === 'resume'
    ? String(run.lineageGeneration)
    : '0';
  // Поколение счётчиков: один непрерывный отрезок накопления в пределах одного
  // scope. Новый `thread.started` посреди потока начинает следующее поколение —
  // счётчики там снова идут с нуля, и продолжать прежнюю разницу нельзя.
  interface CounterGeneration {
    scope: string | null;
    generation: string;
    baseline: CodexCounters;
    rows: StreamRow[];
  }

  const generations: CounterGeneration[] = [{
    scope: threadId,
    generation: initialGeneration,
    baseline,
    rows: [],
  }];
  // Терминальное значение счётчиков поколения держится рядом, а не дописывается в
  // саму запись: поколение — данные разбора, а это итог его обхода.
  const terminalByGeneration = new Map<CounterGeneration, CodexCounters>();
  const seenScopes = new Set<string | null>([threadId]);
  let active: CounterGeneration = generations[0] as CounterGeneration;
  for (const [index, row] of parsed.rows.entries()) {
    if (row.value.type === 'thread.started' && index >= usageStart) {
      const nextScope = row.value.thread_id;
      const validScope = typeof nextScope === 'string' && nextScope.length > 0
        && nextScope.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(nextScope);
      if (!freshProof || !validScope || seenScopes.has(String(nextScope))) {
        diagnostics.add('cumulativeResetAmbiguous');
        return {
          ...unknownResult(provider, dialect, [...diagnostics]),
          completeness: 'conflict',
        };
      }
      active = {
        scope: String(nextScope),
        generation: String(generations.length),
        baseline: { ...zero },
        rows: [],
      };
      generations.push(active);
      seenScopes.add(String(nextScope));
      diagnostics.add('cumulativeResetAccepted');
      continue;
    }
    if (row.value.type === 'turn.completed' && isPlainRecord(row.value.usage)) {
      active.rows.push(row);
    }
  }

  // Вход одного сегмента: образцы поколения, его вектор и список метрик, которые
  // в этом поколении вообще известны.
  interface SegmentInput {
    sampleIds: string[];
    vector: Record<string, string>;
    availableMetrics: Set<string>;
    generationIssues: Set<string>;
  }

  const samples: Row[] = [];
  const segmentInputs: SegmentInput[] = [];
  const summary = emptyTokenSummary();
  const componentIssues = new Set<string>();
  let sawUnexplainedDecrease = false;
  const rawFields: Record<string, string> = Object.freeze({
    inputTokens: 'input_tokens',
    cachedInputTokens: 'cached_input_tokens',
    cacheWriteInputTokens: 'cache_write_input_tokens',
    outputTokens: 'output_tokens',
    reasoningOutputTokens: 'reasoning_output_tokens',
  });
  for (const generation of generations) {
    const previous: CodexCounters = { ...generation.baseline };
    const generationIssues = new Set<string>();
    const generationSampleIds: string[] = [];

    for (const row of generation.rows) {
      const vector: Partial<CodexCounters> = {};

      for (const key of keys) {
        try {
          const usage = row.value.usage as Row;
          const value = exactUint(usage, String(rawFields[key]), 'usage') ?? '0';

          vector[key] = value;
          if (BigInt(value) < BigInt(previous[key])) {
            diagnostics.add('cumulativeResetAmbiguous');
            sawUnexplainedDecrease = true;
            generationIssues.add(key);
            componentIssues.add(key);
          } else {
            previous[key] = value;
          }
        } catch (error) {
          if (!(error instanceof AnalyticsNormalizerError)) throw error;
          diagnostics.add(error.code);
          generationIssues.add(key);
          componentIssues.add(key);
        }
      }
      const id = sampleId(run, provider, dialect, row, generation.scope);
      generationSampleIds.push(id);
      samples.push({
        sampleId: id,
        sourceOrdinal: row.sourceOrdinal,
        byteOffset: row.byteOffset,
        lineHash: row.lineHash,
        counterScope: generation.scope,
        counterGeneration: generation.generation,
        quantitySemantics: 'cumulative_snapshot',
        vector,
        providerEventId: null,
        eventAt: null,
      });
    }
    terminalByGeneration.set(generation, previous);
    const inputDelta = uintSubtract(previous.inputTokens, generation.baseline.inputTokens);
    const cachedDelta = uintSubtract(
      previous.cachedInputTokens,
      generation.baseline.cachedInputTokens,
    );
    const cacheWriteDelta = uintSubtract(
      previous.cacheWriteInputTokens,
      generation.baseline.cacheWriteInputTokens,
    );
    let uncachedInput = '0';
    let inputAvailable = !['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens']
      .some((key) => generationIssues.has(key));
    if (inputAvailable) {
      try {
        uncachedInput = uintSubtract(inputDelta, uintAdd(cachedDelta, cacheWriteDelta));
      } catch (error) {
        if (!(error instanceof AnalyticsNormalizerError)) throw error;
        diagnostics.add('inclusiveInputConflict');
        generationIssues.add('inputTokens');
        componentIssues.add('inputTokens');
        inputAvailable = false;
      }
    }
    const output = uintSubtract(previous.outputTokens, generation.baseline.outputTokens);
    const reasoningOutput = generationIssues.has('reasoningOutputTokens')
      ? null
      : uintSubtract(
        previous.reasoningOutputTokens,
        generation.baseline.reasoningOutputTokens,
      );
    const vector = {
      uncachedInput,
      output,
      cacheRead: cachedDelta,
      cacheWrite5m: '0',
      cacheWrite1h: '0',
      cacheWriteUnknown: cacheWriteDelta,
      reasoningOutput,
    };
    const availableMetrics = new Set(['cacheWrite5m', 'cacheWrite1h']);
    if (inputAvailable) availableMetrics.add('uncachedInput');
    availableMetrics.add('cacheRead');
    availableMetrics.add('cacheWriteUnknown');
    availableMetrics.add('output');
    if (inputAvailable) summary.uncachedInput = uintAdd(summary.uncachedInput, uncachedInput);
    summary.output = uintAdd(summary.output, output);
    summary.cacheRead = uintAdd(summary.cacheRead, cachedDelta);
    summary.cacheWriteUnknown = uintAdd(summary.cacheWriteUnknown, cacheWriteDelta);
    if (generationSampleIds.length > 0) {
      segmentInputs.push({
        sampleIds: generationSampleIds,
        vector: vector as Record<string, string>,
        availableMetrics,
        generationIssues,
      });
    }
  }

  // Последнее поколение существует всегда: первое заведено до обхода. Подстановка
  // здесь — не запасной путь, а признание того, что индекс массива необязателен.
  const terminalGeneration = generations[generations.length - 1] as CounterGeneration;
  const terminal = terminalByGeneration.get(terminalGeneration) ?? terminalGeneration.baseline;
  const processFinal = run?.processComplete === true && !parsed.hasTornTail && !legacyProof;
  const exactComplete = processFinal && componentIssues.size === 0;
  const completeness = exactComplete
    ? 'complete'
    : sawUnexplainedDecrease || componentIssues.size === keys.length ? 'conflict' : 'partial';
  const source = exactComplete ? 'provider_final' : 'provider_partial';
  if (legacyProof) diagnostics.add('legacyFreshAssumption');
  if (parsed.hasTornTail) diagnostics.add('tornRawTail');
  const terminalCounterCheckpoint = exactComplete
    ? {
      counterScope: terminalGeneration.scope,
      counterGeneration: terminalGeneration.generation,
      vector: terminal,
      presenceMask: keys,
      dialect,
      extractorVersion: EXTRACTOR_VERSION,
      lifecycleEventHash: HASH_RE.test(String(run?.lifecycleEventHash ?? ''))
        ? run.lifecycleEventHash
        : null,
      checkpointHash: digest(canonicalJson([
        provider, dialect, terminalGeneration.scope, terminalGeneration.generation,
        terminal, run?.lifecycleEventHash ?? null,
      ])),
      resumeEligible: true,
    }
    : null;

  return {
    provider,
    normalizerDialect: dialect,
    extractorVersion: EXTRACTOR_VERSION,
    source,
    completeness,
    provenance: legacyProof ? 'approximate' : 'exact',
    samples,
    usageSegments: segmentInputs.flatMap(({
      sampleIds, vector, availableMetrics, generationIssues,
    }) => tokenSegments({
      run,
      provider,
      dialect,
      sampleIds,
      vector,
      completeness,
      source,
      availableMetrics,
      metricCompleteness: {
        uncachedInput: generationIssues.has('inputTokens')
          || generationIssues.has('cachedInputTokens')
          || generationIssues.has('cacheWriteInputTokens')
          ? 'partial' : processFinal ? 'complete' : 'partial',
        output: generationIssues.has('outputTokens') ? 'partial'
          : processFinal ? 'complete' : 'partial',
        cacheRead: generationIssues.has('cachedInputTokens') ? 'partial'
          : processFinal ? 'complete' : 'partial',
        cacheWriteUnknown: generationIssues.has('cacheWriteInputTokens') ? 'partial'
          : processFinal ? 'complete' : 'partial',
      },
    })),
    tokenSummary: summary,
    providerReportedCost: null,
    providerRootResult: null,
    terminalCounterCheckpoint,
    lastObservedCounter: exactComplete || componentIssues.size > 0 ? null : {
      counterScope: terminalGeneration.scope,
      counterGeneration: terminalGeneration.generation,
      vector: terminal,
      resumeEligible: false,
    },
    diagnostics: [...diagnostics].sort(),
  };
}

const CLAUDE_COUNTERS = Object.freeze([
  'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
]);

// Запись расхода одной модели из накопительного снимка claude. Стоимость бывает
// неизвестной: её отсутствие — отдельное замечание, а не ноль.
interface ClaudeModelEntry {
  rawModel: string;
  canonicalModel: string;
  providerScope: string | null;
  contextWindow: string | null;
  maxOutputTokens: string | null;
  vector: Record<string, string>;
  cost: string | null;
  costIssue: string | null;
}

function claudeModelEntry(rawModel: string, entry: unknown): ClaudeModelEntry {
  if (!isPlainRecord(entry)) fail('modelUsageInvalid', `modelUsage.${rawModel} обязан быть object.`);
  if (typeof rawModel !== 'string' || rawModel.length < 1 || rawModel.length > 160
      || /[\u0000-\u001f\u007f]/u.test(rawModel)) {
    fail('modelUsageInvalid', 'modelUsage raw model identity invalid.');
  }
  const canonicalModel: unknown = entry.canonicalModel === undefined
    ? rawModel
    : entry.canonicalModel;
  if (typeof canonicalModel !== 'string' || canonicalModel.length < 1
      || canonicalModel.length > 160 || /[\u0000-\u001f\u007f]/u.test(canonicalModel)) {
    fail('modelUsageInvalid', `modelUsage.${rawModel}.canonicalModel invalid.`);
  }
  const providerScope: unknown = entry.provider === undefined ? null : entry.provider;
  if (providerScope !== null && (typeof providerScope !== 'string'
      || providerScope.length < 1 || providerScope.length > 160
      || /[\u0000-\u001f\u007f]/u.test(providerScope))) {
    fail('modelUsageInvalid', `modelUsage.${rawModel}.provider invalid.`);
  }
  const vector = {
    inputTokens: exactUint(entry, 'inputTokens', `modelUsage.${rawModel}`),
    outputTokens: exactUint(entry, 'outputTokens', `modelUsage.${rawModel}`),
    cacheReadInputTokens: exactUint(entry, 'cacheReadInputTokens', `modelUsage.${rawModel}`),
    cacheCreationInputTokens: exactUint(entry, 'cacheCreationInputTokens', `modelUsage.${rawModel}`),
  };
  let cost: string | null = null;
  let costIssue: string | null = null;
  try {
    cost = exactCost(entry, 'costUSD', `modelUsage.${rawModel}`);
  } catch (error) {
    if (!(error instanceof AnalyticsNormalizerError)
        || !['modelCostMissing', 'modelCostInvalid'].includes(error.code)) throw error;
    costIssue = error.code;
  }
  return {
    rawModel,
    canonicalModel,
    providerScope: providerScope as string | null,
    contextWindow: Object.hasOwn(entry, 'contextWindow')
      ? exactUint(entry, 'contextWindow', `modelUsage.${rawModel}`)
      : null,
    maxOutputTokens: Object.hasOwn(entry, 'maxOutputTokens')
      ? exactUint(entry, 'maxOutputTokens', `modelUsage.${rawModel}`)
      : null,
    vector: vector as Record<string, string>,
    cost,
    costIssue,
  };
}

function sameClaudeIdentity(left: ClaudeModelEntry, right: ClaudeModelEntry): boolean {
  return left.rawModel === right.rawModel
    && left.canonicalModel === right.canonicalModel
    && left.providerScope === right.providerScope
    && left.contextWindow === right.contextWindow
    && left.maxOutputTokens === right.maxOutputTokens;
}

const ASSISTANT_COUNTERS = Object.freeze([
  'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
  'cacheWrite5m', 'cacheWrite1h',
]);

function optionalStableText(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('assistantIdentityInvalid', `${where}: invalid bounded text.`);
  }
  return value;
}

function requestWindow(entry: AssistantEntry, run: RunContext): Row {
  const fallback = billingWindow(run);
  if (entry.timestampMissing || entry.firstAt === null || entry.lastAt === null) return fallback;
  return {
    kind: 'closed',
    notBefore: entry.firstAt,
    notAfter: entry.lastAt,
    basis: 'provider_event',
  };
}

// Итог обхода потока claude: склеенные ходы, их образцы, накопленные замечания и
// признак того, что данные противоречивы и складывать их нельзя.
interface ClaudeAssistants {
  entries: Map<string, AssistantEntry>;
  samples: Row[];
  diagnostics: Set<string>;
  conflict: boolean;
}

// Один ход ассистента claude: его опознание, модель, атрибуты тарификации и вектор
// счётчиков. Ключ строится из request_id либо id сообщения — по нему ходы одного
// запроса склеиваются, а чужой ход не сливается с ними.
interface AssistantEntry {
  key: string;
  requestId: string | null;
  messageId: string | null;
  parentToolUseId: string | null;
  resolvedModel: string;
  pricingAttributes: Row;
  vector: Record<string, string>;
  eventAt: string | null;
  timestampMissing: boolean;
  row: StreamRow;
  // Дописываются при склейке ходов одного запроса.
  sampleIds?: string[];
  firstAt?: string | null;
  lastAt?: string | null;
}

function assistantEntry(
  row: StreamRow,
  outerSession: unknown,
  run: RunContext,
): AssistantEntry | null {
  const value = row.value;
  const message = value.message;

  if (value.session_id !== outerSession || !isPlainRecord(message)
      || !isPlainRecord(message.usage)) return null;
  const requestId = optionalStableText(value.request_id, 'assistant.request_id');
  const messageId = optionalStableText(message.id, 'assistant.message.id');
  if (requestId === null && messageId === null) {
    fail('assistantIdentityMissing', 'Assistant row не содержит request_id/message.id.');
  }
  const model = optionalStableText(message.model, 'assistant.message.model');

  if (model === null) fail('assistantIdentityMissing', 'Assistant row не содержит model.');

  const usage = message.usage;
  const cacheCreation = usage.cache_creation;
  if (!isPlainRecord(cacheCreation)) {
    fail('assistantCacheSplitMissing', 'Assistant cache_creation split отсутствует.');
  }
  const vector = {
    inputTokens: exactUint(usage, 'input_tokens', 'assistant.usage'),
    outputTokens: exactUint(usage, 'output_tokens', 'assistant.usage'),
    cacheReadInputTokens: exactUint(usage, 'cache_read_input_tokens', 'assistant.usage'),
    cacheCreationInputTokens: exactUint(usage, 'cache_creation_input_tokens', 'assistant.usage'),
    cacheWrite5m: exactUint(
      cacheCreation,
      'ephemeral_5m_input_tokens',
      'assistant.usage.cache_creation',
    ),
    cacheWrite1h: exactUint(
      cacheCreation,
      'ephemeral_1h_input_tokens',
      'assistant.usage.cache_creation',
    ),
  };
  if (uintAdd(String(vector.cacheWrite5m), String(vector.cacheWrite1h))
      !== vector.cacheCreationInputTokens) {
    fail('assistantCacheSplitConflict', 'Assistant cache creation total не сходится с 5m+1h.');
  }
  const timestamp = canonicalInstant(value.timestamp);
  const runStart = canonicalInstant(run?.startedAt);
  const runFinish = canonicalInstant(run?.finishedAt);
  let eventAt = timestamp;
  if (eventAt !== null && runStart !== null && runFinish !== null) {
    const skewMs = 5 * 60 * 1000;
    const valueMs = Date.parse(eventAt);
    if (valueMs < Date.parse(runStart) - skewMs || valueMs > Date.parse(runFinish) + skewMs) {
      fail('assistantTimestampConflict', 'Assistant timestamp вне trusted run window.');
    }
  }
  const key = requestId !== null ? `request:${requestId}` : `message:${messageId}`;

  return {
    key,
    requestId,
    messageId,
    parentToolUseId: optionalStableText(value.parent_tool_use_id, 'assistant.parent_tool_use_id'),
    resolvedModel: model,
    pricingAttributes: {
      serviceTier: optionalStableText(usage.service_tier, 'assistant.usage.service_tier'),
      inferenceGeo: optionalStableText(usage.inference_geo, 'assistant.usage.inference_geo'),
      speed: optionalStableText(usage.speed, 'assistant.usage.speed'),
      contextBand: null,
    },
    vector: vector as Record<string, string>,
    eventAt,
    timestampMissing: eventAt === null,
    row,
  };
}

function sameAssistantIdentity(left: AssistantEntry, right: AssistantEntry): boolean {
  return left.requestId === right.requestId
    && left.messageId === right.messageId
    && left.parentToolUseId === right.parentToolUseId
    && left.resolvedModel === right.resolvedModel
    && JSON.stringify(left.pricingAttributes) === JSON.stringify(right.pricingAttributes);
}

function collectClaudeAssistants(
  parsed: ParsedStream,
  outerSession: unknown,
  run: RunContext,
  provider: string,
  dialect: string,
): ClaudeAssistants {
  const diagnostics = new Set<string>();
  const entries = new Map<string, AssistantEntry>();
  const messageOwners = new Map<string, string>();
  const samples: Row[] = [];
  let conflict = false;

  for (const row of parsed.rows) {
    if (row.value.type !== 'assistant') continue;

    let emission: AssistantEntry | null;
    try {
      emission = assistantEntry(row, outerSession, run);
    } catch (error) {
      if (!(error instanceof AnalyticsNormalizerError)) throw error;
      diagnostics.add(error.code);
      if (error.code !== 'assistantIdentityMissing') conflict = true;
      continue;
    }
    if (emission === null) continue;

    // Ключ запроса и id сообщения — строки по построению `assistantEntry`.
    const emissionKey = String(emission.key);
    const messageId = emission.messageId === null ? null : String(emission.messageId);

    if (messageId !== null) {
      const owner = messageOwners.get(messageId);

      if (owner !== undefined && owner !== emissionKey) {
        diagnostics.add('assistantRequestConflict');
        conflict = true;
        continue;
      }
      messageOwners.set(messageId, emissionKey);
    }

    const id = sampleId(run, provider, dialect, row, `${outerSession}:${emissionKey}`);
    samples.push({
      sampleId: id,
      sourceOrdinal: row.sourceOrdinal,
      byteOffset: row.byteOffset,
      lineHash: row.lineHash,
      counterScope: `${outerSession}:${emissionKey}`,
      counterGeneration: '0',
      quantitySemantics: 'cumulative_snapshot',
      vector: emission.vector,
      providerEventId: emission.requestId,
      eventAt: emission.eventAt,
    });
    const previous = entries.get(emissionKey);
    if (previous && (!sameAssistantIdentity(previous, emission)
      || !uintVectorNondecreasing(previous.vector, emission.vector, ASSISTANT_COUNTERS))) {
      diagnostics.add('assistantRequestConflict');
      conflict = true;
      continue;
    }
    const sampleIds = previous?.sampleIds ?? [];

    sampleIds.push(id);
    entries.set(emissionKey, {
      ...emission,
      sampleIds,
      firstAt: previous?.firstAt ?? emission.eventAt,
      lastAt: emission.eventAt ?? previous?.lastAt ?? null,
      timestampMissing: (previous?.timestampMissing ?? false) || emission.timestampMissing,
    });
  }
  return {
    entries,
    samples,
    diagnostics,
    conflict,
  };
}

/**
 * Порядок образцов: сперва по месту строки в исходном файле, при совпадении — по
 * идентификатору. Устойчивость нужна для повторяемости: один и тот же raw обязан
 * давать одну и ту же проекцию, иначе хеши документов разойдутся между прогонами.
 */
function sampleOrder(left: Row, right: Row): number {
  const leftOrdinal = BigInt(String(left.sourceOrdinal));
  const rightOrdinal = BigInt(String(right.sourceOrdinal));

  if (leftOrdinal !== rightOrdinal) {
    return leftOrdinal < rightOrdinal ? -1 : 1;
  }

  const leftId = String(left.sampleId);
  const rightId = String(right.sampleId);

  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function sumAssistantVector(entries: AssistantEntry[]): Record<string, string> {
  const sum: Record<string, string> = Object.fromEntries(
    ASSISTANT_COUNTERS.map((key) => [key, '0']),
  );

  for (const entry of entries) {
    for (const key of ASSISTANT_COUNTERS) {
      sum[key] = uintAdd(String(sum[key]), String(entry.vector[key]));
    }
  }

  return sum;
}

function assistantMetricSegments({
  entries,
  field,
  metric,
  cacheMode = null,
  cacheTtl = null,
  run,
  provider,
  dialect,
  completeness,
  source,
}: {
  entries: AssistantEntry[];
  field: string;
  metric: string;
  cacheMode?: string | null;
  cacheTtl?: string | null;
  run: RunContext;
  provider: string;
  dialect: string;
  completeness: string;
  source: string;
}): Row[] {
  return entries
    .filter((entry) => BigInt(entry.vector[field] ?? '0') > 0n)
    .map((entry) => usageSegment({
      run,
      provider,
      dialect,
      sampleIds: entry.sampleIds ?? [],
      metric,
      quantity: entry.vector[field] ?? '0',
      resolvedModel: entry.resolvedModel,
      cacheMode,
      cacheTtl,
      pricingAttributes: entry.pricingAttributes,
      segmentWindow: requestWindow(entry, run),
      completeness,
      source,
    }));
}

function lowerBoundFromAssistants({
  assistants,
  run,
  provider,
  dialect,
  providerRootResult,
  diagnostics,
}: {
  assistants: ClaudeAssistants;
  run: RunContext;
  provider: string;
  dialect: string;
  providerRootResult: unknown;
  diagnostics: Set<string>;
}): Row | null {
  const entries = [...assistants.entries.values()];
  if (entries.length === 0) return null;
  const total = sumAssistantVector(entries);
  const summary = {
    uncachedInput: total.inputTokens,
    output: total.outputTokens,
    cacheRead: total.cacheReadInputTokens,
    cacheWrite5m: total.cacheWrite5m,
    cacheWrite1h: total.cacheWrite1h,
    cacheWriteUnknown: '0',
  };
  const usageSegments = [
    ...assistantMetricSegments({ entries, field: 'inputTokens', metric: 'input_tokens', run, provider, dialect, completeness: 'partial', source: 'provider_partial' }),
    ...assistantMetricSegments({ entries, field: 'outputTokens', metric: 'output_tokens', run, provider, dialect, completeness: 'partial', source: 'provider_partial' }),
    ...assistantMetricSegments({ entries, field: 'cacheReadInputTokens', metric: 'cache_read_tokens', cacheMode: 'read', run, provider, dialect, completeness: 'partial', source: 'provider_partial' }),
    ...assistantMetricSegments({ entries, field: 'cacheWrite5m', metric: 'cache_write_tokens', cacheMode: 'write', cacheTtl: '5m', run, provider, dialect, completeness: 'partial', source: 'provider_partial' }),
    ...assistantMetricSegments({ entries, field: 'cacheWrite1h', metric: 'cache_write_tokens', cacheMode: 'write', cacheTtl: '1h', run, provider, dialect, completeness: 'partial', source: 'provider_partial' }),
  ];
  return {
    provider,
    normalizerDialect: dialect,
    extractorVersion: EXTRACTOR_VERSION,
    source: 'provider_partial',
    completeness: assistants.conflict ? 'conflict' : 'partial',
    provenance: 'exact',
    samples: assistants.samples,
    usageSegments: assistants.conflict ? [] : usageSegments,
    tokenSummary: assistants.conflict ? emptyTokenSummary() : summary,
    providerReportedCost: null,
    providerRootResult,
    terminalCounterCheckpoint: null,
    lastObservedCounter: null,
    diagnostics: [...new Set([
      ...diagnostics,
      ...assistants.diagnostics,
      'assistantLowerBoundOnly',
    ])].sort(),
  };
}

function normalizeClaude({ provider, dialect, parsed, run }: {
  provider: string;
  dialect: string;
  parsed: ParsedStream;
  run: RunContext;
}): Row {
  const diagnostics = new Set<string>();
  if (parsed.hasTornTail) diagnostics.add('tornRawTail');
  const initRows = parsed.rows.filter(({ value }) => value.type === 'system' && value.subtype === 'init');
  const firstInit = initRows[0];
  const outerSession = typeof firstInit?.value?.session_id === 'string'
    && firstInit.value.session_id.length > 0
    ? firstInit.value.session_id
    : null;
  if (!outerSession) {
    return { ...unknownResult(provider, dialect, ['outerSessionMissing']), completeness: 'conflict' };
  }
  if (initRows.some(({ value }) => value.session_id !== outerSession)) {
    return { ...unknownResult(provider, dialect, ['outerSessionConflict']), completeness: 'conflict' };
  }
  const assistants = collectClaudeAssistants(parsed, outerSession, run, provider, dialect);
  for (const code of assistants.diagnostics) diagnostics.add(code);

  const rootCandidates: StreamRow[] = [];
  const billingRows: StreamRow[] = [];
  let lastBillingRowIndex = -1;
  let lastChargeableRowIndex = -1;
  let lastUnsupportedResultIndex = -1;

  for (const [rowIndex, row] of parsed.rows.entries()) {
    const value = row.value;
    if (value.type === 'assistant' && value.session_id === outerSession) {
      lastChargeableRowIndex = rowIndex;
    }
    if (value.type !== 'result' || value.session_id !== outerSession) continue;
    const parentAbsent = !Object.hasOwn(value, 'parent_tool_use_id') || value.parent_tool_use_id === null;
    const originAbsent = !Object.hasOwn(value, 'origin') || value.origin === null;
    const taskNotification = isPlainRecord(value.origin) && value.origin.kind === 'task-notification';
    if (!originAbsent && !taskNotification) {
      diagnostics.add('unsupportedResultOrigin');
      if (parentAbsent) lastUnsupportedResultIndex = rowIndex;
    }
    if (parentAbsent && originAbsent) rootCandidates.push(row);
    if (parentAbsent && (originAbsent || taskNotification) && Object.hasOwn(value, 'modelUsage')) {
      billingRows.push(row);
      lastBillingRowIndex = rowIndex;
    }
  }
  let providerRootResult = null;
  if (rootCandidates.length === 1) {
    const row = rootCandidates[0] as StreamRow;

    providerRootResult = {
      sourceOrdinal: row.sourceOrdinal,
      subtype: typeof row.value.subtype === 'string' ? row.value.subtype : null,
      isError: typeof row.value.is_error === 'boolean' ? row.value.is_error : null,
    };
  } else {
    diagnostics.add(rootCandidates.length === 0
      ? 'missingProviderRootResult'
      : 'ambiguousProviderRootResult');
  }

  if (billingRows.length === 0) {
    const lowerBound = lowerBoundFromAssistants({
      assistants,
      run,
      provider,
      dialect,
      providerRootResult,
      diagnostics,
    });
    if (lowerBound) return lowerBound;
    return {
      ...unknownResult(provider, dialect, [...diagnostics, 'modelUsageMissing']),
      providerRootResult,
    };
  }

  const samples: Row[] = [];
  const previous = new Map<string, ClaudeModelEntry>();
  const sampleIdsByModel = new Map<string, string[]>();
  let terminalEntries: Map<string, ClaudeModelEntry> | null = null;
  let modelConflict = false;
  let sawEmpty = false;
  try {
    for (const row of billingRows) {
      const usage = row.value.modelUsage;
      if (!isPlainRecord(usage)) fail('modelUsageInvalid', 'modelUsage обязан быть object map.');
      const rawModels = Object.keys(usage).sort();
      if (rawModels.length === 0) {
        sawEmpty = true;
        if (previous.size > 0) {
          fail('modelUsageConflict', 'modelUsage entries disappeared from cumulative snapshot.');
        }
        continue;
      }
      const current = new Map<string, ClaudeModelEntry>();
      const canonicalIdentities = new Set<string>();
      for (const rawModel of rawModels) {
        const entry = claudeModelEntry(rawModel, usage[rawModel]);
        if (canonicalIdentities.has(entry.canonicalModel)) {
          fail('modelAliasCollision', 'Два raw model keys свелись к одной identity.');
        }
        canonicalIdentities.add(entry.canonicalModel);
        const older = previous.get(rawModel);
        if (entry.costIssue !== null) {
          diagnostics.add(entry.costIssue);
        }
        if (older && !sameClaudeIdentity(older, entry)) {
          fail('modelUsageConflict', `modelUsage.${rawModel} сменил identity/context.`);
        }
        if (older && (!uintVectorNondecreasing(older.vector, entry.vector, CLAUDE_COUNTERS)
          || (entry.cost !== null && older.cost !== null
            && compareDecimal(entry.cost, older.cost) < 0))) {
          fail('modelUsageConflict', `modelUsage.${rawModel} уменьшил cumulative counter.`);
        }
        current.set(rawModel, entry);
        const id = sampleId(run, provider, dialect, row, `${outerSession}:${rawModel}`);
        samples.push({
          sampleId: id,
          sourceOrdinal: row.sourceOrdinal,
          byteOffset: row.byteOffset,
          lineHash: row.lineHash,
          counterScope: `${outerSession}:${rawModel}`,
          counterGeneration: '0',
          quantitySemantics: 'final_total',
          vector: entry.vector,
          providerEventId: null,
          eventAt: null,
        });
        const ids = sampleIdsByModel.get(rawModel) ?? [];
        ids.push(id);
        sampleIdsByModel.set(rawModel, ids);
      }
      for (const existing of previous.keys()) {
        if (!current.has(existing)) fail('modelUsageConflict', `modelUsage.${existing} исчез.`);
      }
      previous.clear();
      for (const [rawModel, entry] of current) previous.set(rawModel, entry);
      terminalEntries = current;
    }
  } catch (error) {
    if (!(error instanceof AnalyticsNormalizerError)) throw error;
    diagnostics.add(error.code);
    modelConflict = true;
  }

  if (modelConflict) {
    return {
      ...unknownResult(provider, dialect, [...diagnostics]),
      completeness: 'conflict',
      samples,
      providerRootResult,
    };
  }
  if (!terminalEntries || terminalEntries.size === 0) {
    if (sawEmpty) diagnostics.add('emptyModelUsage');
    const lowerBound = lowerBoundFromAssistants({
      assistants,
      run,
      provider,
      dialect,
      providerRootResult,
      diagnostics,
    });
    if (lowerBound) return lowerBound;
    return {
      ...unknownResult(provider, dialect, [...diagnostics]),
      providerRootResult,
    };
  }

  const terminalSnapshotProven = lastBillingRowIndex >= lastChargeableRowIndex
    && lastBillingRowIndex >= lastUnsupportedResultIndex;
  if (!terminalSnapshotProven) diagnostics.add('terminalModelUsageUnproven');
  const fullyDrained = run?.processComplete === true && !parsed.hasTornTail
    && terminalSnapshotProven;
  const completeness = fullyDrained ? 'complete' : 'partial';
  const source = fullyDrained ? 'provider_final' : 'provider_partial';
  const summary = emptyTokenSummary();
  const usageSegments: Row[] = [];
  const breakdown: Row[] = [];
  const usableAssistantEntries = assistants.conflict ? [] : [...assistants.entries.values()];
  const matchedAssistantKeys = new Set<string>();

  for (const [rawModel, entry] of [...terminalEntries.entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    const requestEntries = usableAssistantEntries.filter((request) => (
      request.resolvedModel === entry.canonicalModel || request.resolvedModel === rawModel
    ));
    requestEntries.forEach((request) => matchedAssistantKeys.add(request.key));
    const requestTotal = sumAssistantVector(requestEntries);
    summary.uncachedInput = uintAdd(summary.uncachedInput, String(entry.vector.inputTokens));
    summary.output = uintAdd(summary.output, String(entry.vector.outputTokens));
    summary.cacheRead = uintAdd(summary.cacheRead, String(entry.vector.cacheReadInputTokens));
    if (entry.cost !== null) {
      breakdown.push({ model: entry.canonicalModel, rawModel, amount: entry.cost });
    }

    // [поле итога, поле хода ассистента, метрика, режим кеша]
    const metricDefinitions: [string, string, string, string | null][] = [
      ['inputTokens', 'inputTokens', 'input_tokens', null],
      ['outputTokens', 'outputTokens', 'output_tokens', null],
      ['cacheReadInputTokens', 'cacheReadInputTokens', 'cache_read_tokens', 'read'],
    ];
    for (const [finalField, requestField, metric, cacheMode] of metricDefinitions) {
      if (requestEntries.length > 0 && requestTotal[requestField] === entry.vector[finalField]) {
        usageSegments.push(...assistantMetricSegments({
          entries: requestEntries,
          field: requestField,
          metric,
          cacheMode,
          run,
          provider,
          dialect,
          completeness,
          source,
        }));
      } else if (BigInt(entry.vector[finalField] ?? '0') > 0n) {
        if (requestEntries.length > 0) diagnostics.add('assistantReconciliationMismatch');
        usageSegments.push(usageSegment({
          run,
          provider,
          dialect,
          sampleIds: sampleIdsByModel.get(rawModel) ?? [],
          metric,
          quantity: entry.vector[finalField] ?? '0',
          resolvedModel: entry.canonicalModel,
          cacheMode,
          completeness: requestEntries.length > 0 ? 'partial' : completeness,
          source,
        }));
      }
    }

    const cacheMatches = requestEntries.length > 0
      && requestTotal.cacheCreationInputTokens === entry.vector.cacheCreationInputTokens
      && uintAdd(String(requestTotal.cacheWrite5m), String(requestTotal.cacheWrite1h))
        === entry.vector.cacheCreationInputTokens;
    if (cacheMatches) {
      summary.cacheWrite5m = uintAdd(summary.cacheWrite5m, String(requestTotal.cacheWrite5m));
      summary.cacheWrite1h = uintAdd(summary.cacheWrite1h, String(requestTotal.cacheWrite1h));
      usageSegments.push(
        ...assistantMetricSegments({
          entries: requestEntries,
          field: 'cacheWrite5m',
          metric: 'cache_write_tokens',
          cacheMode: 'write',
          cacheTtl: '5m',
          run,
          provider,
          dialect,
          completeness,
          source,
        }),
        ...assistantMetricSegments({
          entries: requestEntries,
          field: 'cacheWrite1h',
          metric: 'cache_write_tokens',
          cacheMode: 'write',
          cacheTtl: '1h',
          run,
          provider,
          dialect,
          completeness,
          source,
        }),
      );
    } else {
      if (requestEntries.length > 0) diagnostics.add('assistantReconciliationMismatch');
      summary.cacheWriteUnknown = uintAdd(
        summary.cacheWriteUnknown,
        String(entry.vector.cacheCreationInputTokens),
      );
      if (BigInt(entry.vector.cacheCreationInputTokens ?? '0') > 0n) {
        usageSegments.push(usageSegment({
          run,
          provider,
          dialect,
          sampleIds: sampleIdsByModel.get(rawModel) ?? [],
          metric: 'cache_write_tokens',
          quantity: entry.vector.cacheCreationInputTokens ?? '0',
          resolvedModel: entry.canonicalModel,
          cacheMode: 'write',
          cacheTtl: 'unknown',
          completeness: requestEntries.length > 0 ? 'partial' : completeness,
          source,
        }));
      }
    }
  }
  if (usableAssistantEntries.some((entry) => !matchedAssistantKeys.has(entry.key))) {
    diagnostics.add('assistantModelUnmatched');
  }
  const providerReportedCost = fullyDrained && breakdown.length === terminalEntries.size
    ? {
      currency: 'USD',
      amount: addDecimals(...breakdown.map((item) => String(item.amount))),
      semantics: 'run_total',
      breakdown,
    }
    : null;

  return {
    provider,
    normalizerDialect: dialect,
    extractorVersion: EXTRACTOR_VERSION,
    source,
    completeness,
    provenance: 'exact',
    samples: [...samples, ...assistants.samples].sort(sampleOrder),
    usageSegments,
    tokenSummary: summary,
    providerReportedCost,
    providerRootResult,
    terminalCounterCheckpoint: null,
    lastObservedCounter: null,
    diagnostics: [...diagnostics].sort(),
  };
}

/** Общая pure-функция runtime/backfill: одинаковый raw даёт одинаковую projection. */
export function normalizeProviderUsage({ provider, dialect, rawText, run = {} }: {
  provider: string;
  dialect: unknown;
  rawText: unknown;
  run?: RunContext;
}): Row {
  if (!Object.hasOwn(DIALECTS, provider) || typeof dialect !== 'string') {
    return unknownResult(provider ?? null, typeof dialect === 'string' ? dialect : null, [
      'unsupportedProvider',
    ]);
  }
  if (!DIALECTS[provider as keyof typeof DIALECTS].has(dialect)) {
    return unknownResult(provider, dialect, ['unsupportedDialect']);
  }

  let parsed: ParsedStream;
  try {
    parsed = parseJsonLines(rawText, provider);
  } catch (error) {
    if (!(error instanceof AnalyticsNormalizerError)) throw error;
    return {
      ...unknownResult(provider, dialect, [error.code]),
      completeness: error.code === 'rawOversize' || error.code === 'rawLineOversize'
        ? 'partial'
        : 'conflict',
    };
  }
  return provider === 'codex'
    ? normalizeCodex({ provider, dialect, parsed, run })
    : normalizeClaude({ provider, dialect, parsed, run });
}

export function normalizeProviderUsageRows({
  provider,
  dialect,
  rows,
  hasTornTail = false,
  run = {},
}: {
  provider: string;
  dialect: unknown;
  rows?: unknown;
  hasTornTail?: boolean;
  run?: RunContext;
}): Row {
  if (!Object.hasOwn(DIALECTS, provider) || typeof dialect !== 'string') {
    return unknownResult(provider ?? null, typeof dialect === 'string' ? dialect : null, [
      'unsupportedProvider',
    ]);
  }
  if (!DIALECTS[provider as keyof typeof DIALECTS].has(dialect)) {
    return unknownResult(provider, dialect, ['unsupportedDialect']);
  }
  if (!Array.isArray(rows) || rows.length > MAX_LINES || typeof hasTornTail !== 'boolean') {
    return { ...unknownResult(provider, dialect, ['rawRowsInvalid']), completeness: 'conflict' };
  }
  for (const row of rows) {
    if (!isPlainRecord(row) || !isPlainRecord(row.value)
        || typeof row.sourceOrdinal !== 'string'
        || typeof row.byteOffset !== 'string'
        || typeof row.lineHash !== 'string') {
      return { ...unknownResult(provider, dialect, ['rawRowsInvalid']), completeness: 'conflict' };
    }
  }
  const parsed: ParsedStream = { rows: rows as StreamRow[], hasTornTail };
  return provider === 'codex'
    ? normalizeCodex({ provider, dialect, parsed, run })
    : normalizeClaude({ provider, dialect, parsed, run });
}

export const ANALYTICS_NORMALIZER_DIALECTS = Object.freeze({
  codex: Object.freeze([...DIALECTS.codex]),
  claude: Object.freeze([...DIALECTS.claude]),
});

export const ANALYTICS_EXTRACTOR_VERSION = EXTRACTOR_VERSION;
