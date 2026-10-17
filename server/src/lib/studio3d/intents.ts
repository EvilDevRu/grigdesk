// Durable журнал находится вне проекций моделей. UUID и исходный fingerprint
// сохраняются навсегда; replay не разрешает исчезнувшие upload/parent заново.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  VERSION_STATUSES,
  PAYMENT_STATES,
  parseStudio3d,
} from '../../../../shared/studio3d/studio3dContracts.ts';
import type {
  PaymentState,
  Studio3dBatchSnapshot,
  VersionStatus,
} from '../../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues, UnitForms } from '../../../../shared/studio3d/studio3dOperations.ts';
import { VERSION_KINDS } from '../../../../shared/studio3d/studio3dOperations.ts';
import { withPathLock } from '../pathLock.ts';
import { decodeModel, decodeVersion, LIBRARY_UUID_RE, MODEL_ID_RE, VERSION_ID_RE } from './library.ts';
import type { DiskModel, DiskVersion, StudioLibrary } from './library.ts';
import { ensureDirectory, isSafeName, pinDirectory, readJson } from './safePath.ts';
import type { InputContext, PlannedTask, ProviderError, RemoteTask } from './provider.ts';

export interface RunRequest {
  libraryId: string;
  idempotencyKey: string;
  provider: string;
  operation: string;
  values: FieldValues;
  expectedPrice: number;
  modelId?: string;
  versionId?: string;
  uploads?: {
    uploadId: string;
    role: 'primary' | 'front' | 'left' | 'back' | 'right';
  }[];
  name?: string;
  project?: string | null;
  category?: DiskModel['category'];
}

export const CHILD_STAGES = [
  'prepared', 'submitting', 'accepted', 'rejected', 'unknown', 'unresolved', 'done',
] as const;

export interface InputSnapshot {
  role: 'primary' | 'front' | 'left' | 'back' | 'right';
  name: string | null;
  size: number | null;
  sha256: string | null;
  native: {
    taskId: string;
    taskType: string;
    accountKey: string;
  } | null;
}

export interface IntentChild {
  childId: string;
  operation: string;
  values: FieldValues;
  plan: PlannedTask | null;
  version: DiskVersion | null;
  stage: typeof CHILD_STAGES[number];
  status: VersionStatus;
  progress: number;
  etaSeconds: number | null;
  estimated: number;
  actual: number | null;
  paymentState: PaymentState;
  balanceBefore: number | null;
  taskId: string | null;
  taskType: string | null;
  pool: { key: string; limit: number | null } | null;
  retryAt: number | null;
  submittedAt: string | null;
  updatedAt: string;
  // Момент входа в ожидание денег: такты обновляют waitReason, но не этот срок.
  waitingSince?: string | null;
  completedAt: string | null;
  chargedAt?: string | null;
  actualSource?: 'task' | 'usage' | null;
  waitReason: string | null;
  error: ProviderError | null;
  remote: RemoteTask | null;
  candidates: {
    taskId: string;
    type: string;
    createdAt: string | null;
    credits: number | null;
  }[];
  missedPolls: number;
  notified: boolean;
  confirmationExpired: boolean;
}

export interface IntentRecord {
  schema: 1;
  kind: 'run' | 'batch';
  intentId: string;
  libraryId: string;
  request: RunRequest | Record<string, unknown>;
  requestFingerprint: string;
  executionFingerprint: string;
  accountKey: string | null;
  provider: string;
  operation: string;
  values: FieldValues;
  confirmedPrice: number;
  unit: UnitForms | null;
  catalogVersion: string;
  context: InputContext;
  model: DiskModel | null;
  modelId: string | null;
  parentVersionId: string | null;
  inputs: InputSnapshot[];
  children: IntentChild[];
  projectionReady: boolean;
  preparation: 'pending' | 'complete';
  batch: {
    snapshot: Studio3dBatchSnapshot;
    snapshotHash: string;
    rows: {
      childId: string;
      intentId: string;
      template: IntentRecord;
    }[];
  } | null;
  batchParent: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface IntentsOptions {
  library: StudioLibrary;
  beforeWrite?: (record: IntentRecord) => Promise<void>;
  afterWrite?: (record: IntentRecord) => Promise<void>;
  beforeRead?: (id: string) => Promise<void>;
}

export class IntentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code === 'stale_library' ? 'Библиотека изменилась — старый запрос не отправлен.'
      : code === 'idempotency_conflict' ? 'Этот ключ уже относится к другому запросу.'
        : 'Не удалось безопасно прочитать или записать журнал заказов.');
    this.name = 'IntentError';
    this.code = code;
  }
}

const recordKeys = new Set([
  'schema', 'kind', 'intentId', 'libraryId', 'request', 'requestFingerprint', 'executionFingerprint',
  'accountKey', 'provider', 'operation', 'values', 'confirmedPrice', 'unit', 'catalogVersion',
  'context', 'model', 'modelId', 'parentVersionId', 'inputs', 'children', 'projectionReady',
  'preparation', 'batch', 'batchParent', 'createdAt', 'updatedAt', 'revision',
]);
const childKeys = new Set([
  'childId', 'operation', 'values', 'plan', 'version', 'stage', 'status', 'progress', 'etaSeconds',
  'estimated', 'actual', 'paymentState', 'taskId', 'taskType', 'pool', 'retryAt', 'submittedAt',
  'updatedAt', 'completedAt', 'waitReason', 'error', 'remote', 'candidates', 'missedPolls',
  'notified', 'confirmationExpired',
  'balanceBefore',
  'chargedAt', 'actualSource',
  'waitingSince',
]);

/**
 * Канонизация только синтаксическая: сортирует ключи, не меняет поля каталога,
 * строки и порядок массивов. Недопустимые числа не становятся JSON null.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) {
    throw new IntentError('invalid_request');
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IntentError('invalid_request');
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(',')}]`;
  }

  if (value && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const fields = Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

    return `{${fields.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, depth + 1)}`)
      .join(',')}}`;
  }

  throw new IntentError('invalid_request');
}

/**
 * Fingerprint хранит именно исходное нажатие, отдельно от execution hash.
 * Поздний replay не зависит от файлов, моделей, ключа или текущей версии каталога.
 */
export function requestFingerprint(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

/**
 * Закрытая schema журнала проверяется до worker. File paths внутри payload
 * могут ссылаться только на его собственные snapshot имена в текущей библиотеке.
 */
function validateRecord(value: unknown, expectedId: string, library: StudioLibrary): IntentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !recordKeys.has(key))) {
    throw new IntentError('invalid_intent');
  }

  const record = value as IntentRecord;

  if (record.schema !== 1 || record.intentId !== expectedId || !LIBRARY_UUID_RE.test(expectedId)
    || record.libraryId !== library.libraryId || !['run', 'batch'].includes(record.kind)
    || !['pending', 'complete'].includes(record.preparation) || !Array.isArray(record.children)
    || record.children.length > 50 || !Array.isArray(record.inputs) || record.inputs.length > 128
    || typeof record.projectionReady !== 'boolean' || !Number.isFinite(record.confirmedPrice)
    || record.confirmedPrice < 0 || !Number.isSafeInteger(record.revision) || record.revision < 0
    || record.requestFingerprint !== requestFingerprint(record.request)
    || (record.batchParent !== null && !LIBRARY_UUID_RE.test(record.batchParent))) {
    throw new IntentError('invalid_intent');
  }

  for (const key of ['provider', 'operation', 'catalogVersion', 'executionFingerprint',
    'createdAt', 'updatedAt'] as const) {
    if (typeof record[key] !== 'string' || !record[key] || record[key].length > 512) {
      throw new IntentError('invalid_intent');
    }
  }

  if (record.accountKey !== null && (typeof record.accountKey !== 'string' || !record.accountKey
    || record.accountKey.length > 512)) {
    throw new IntentError('invalid_intent');
  }

  const ids = new Set<string>();
  const files = new Set<string>();

  for (const input of record.inputs) {
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => ![
      'role', 'name', 'size', 'sha256', 'native',
    ].includes(key)) || (input.name !== null && (!isSafeName(input.name) || files.has(input.name)))
      || !['primary', 'front', 'left', 'back', 'right'].includes(input.role)
      || (input.name === null ? input.size !== null || input.sha256 !== null || input.native === null
        : !Number.isSafeInteger(input.size) || input.size! < 0 || !/^[a-f0-9]{64}$/.test(input.sha256!))) {
      throw new IntentError('invalid_intent');
    }

    if (input.name) {
      files.add(input.name);
    }

    if (input.native !== null && (!input.native || typeof input.native !== 'object'
      || Object.keys(input.native).some((key) => !['taskId', 'taskType', 'accountKey'].includes(key))
      || typeof input.native.taskId !== 'string' || !input.native.taskId || input.native.taskId.length > 200
      || typeof input.native.taskType !== 'string' || !input.native.taskType
      || input.native.accountKey !== record.accountKey)) {
      throw new IntentError('invalid_intent');
    }
  }

  const allowed = new Set(record.inputs.filter((input) => input.name !== null)
    .map((input) => path.join(library.dir, '.jobs', expectedId, 'inputs', input.name!)));

  for (const child of record.children) {
    if (!child || typeof child !== 'object' || Object.keys(child).some((key) => !childKeys.has(key))
      || !isSafeName(child.childId) || ids.has(child.childId) || !CHILD_STAGES.includes(child.stage)
      || !VERSION_STATUSES.includes(child.status) || !PAYMENT_STATES.includes(child.paymentState)
      || !Number.isFinite(child.estimated) || child.estimated < 0
      || (child.actual !== null && (!Number.isFinite(child.actual) || child.actual < 0))
      || (child.chargedAt != null && (typeof child.chargedAt !== 'string'
        || !Number.isFinite(Date.parse(child.chargedAt))))
      || (child.actualSource != null && !['task', 'usage'].includes(child.actualSource))
      || !Number.isInteger(child.progress) || child.progress < 0 || child.progress > 100
      || !Array.isArray(child.candidates) || typeof child.notified !== 'boolean'
      || typeof child.confirmationExpired !== 'boolean') {
      throw new IntentError('invalid_intent');
    }

    ids.add(child.childId);
    validatePayload(child.plan?.payload, allowed, library.dir);
  }

  validateTypedFields(record, library);

  if (record.kind === 'batch') {
    if (!record.batch || record.modelId !== null || record.children.length || record.batchParent !== null
      || !Array.isArray(record.batch.rows) || !record.batch.rows.length || record.batch.rows.length > 50
      || record.batch.snapshotHash !== requestFingerprint(record.batch.snapshot)) {
      throw new IntentError('invalid_intent');
    }

    parseStudio3d.batchQuote({
      libraryId: record.libraryId,
      snapshot: record.batch.snapshot,
      snapshotHash: record.batch.snapshotHash,
      totalEstimated: record.confirmedPrice,
      unit: record.unit
    });

    const rowIds = new Set<string>();

    for (const row of record.batch.rows) {
      if (!row || Object.keys(row).some((key) => !['childId', 'intentId', 'template'].includes(key))
        || !isSafeName(row.childId) || rowIds.has(row.intentId) || row.template?.kind !== 'run'
        || row.template.batchParent !== record.intentId) {
        throw new IntentError('invalid_intent');
      }

      rowIds.add(row.intentId);
      validateRecord(row.template, row.intentId, library);
    }
  } else if (record.batch !== null) {
    throw new IntentError('invalid_intent');
  }

  return record;
}

/**
 * Nested schema проверяется до recovery, не только при materialize проекций.
 * План привязан к values/child/type; metadata не заменяет оплачиваемое действие.
 */
function validateTypedFields(record: IntentRecord, library: StudioLibrary): void {
  try {
    parseStudio3d.values(record.values);
    parseStudio3d.unit(record.unit);
    validateContext(record.context);

    if (record.modelId !== null && !MODEL_ID_RE.test(record.modelId)) {
      throw new IntentError('invalid_intent');
    }

    if (record.parentVersionId !== null && !VERSION_ID_RE.test(record.parentVersionId)) {
      throw new IntentError('invalid_intent');
    }

    if (record.model !== null) {
      if (record.model.id !== record.modelId) {
        throw new IntentError('invalid_intent');
      }

      decodeModel(record.model, record.model.id, library.libraryId);
    }

    for (const child of record.children) {
      parseStudio3d.values(child.values);

      if (child.operation !== record.operation || !isSafeName(child.operation)
        || (child.balanceBefore !== null && (!Number.isFinite(child.balanceBefore) ||
          child.balanceBefore < 0))
        || !Number.isSafeInteger(child.missedPolls) || child.missedPolls < 0
        || (child.retryAt !== null && (!Number.isFinite(child.retryAt) || child.retryAt < 0))
        || (child.etaSeconds !== null && (!Number.isFinite(child.etaSeconds) || child.etaSeconds < 0))
        || child.candidates.length > 100) {
        throw new IntentError('invalid_intent');
      }

      if (child.plan !== null && (!child.plan || Object.keys(child.plan).some((key) => ![
        'childId', 'label', 'values', 'taskType', 'payload',
      ].includes(key)) || child.plan.childId !== child.childId || typeof child.plan.label !== 'string'
        || child.plan.label.length > 1000 || child.plan.taskType !== child.taskType
        || canonicalJson(child.plan.values) !== canonicalJson(child.values))) {
        throw new IntentError('invalid_intent');
      }

      if (child.version) {
        decodeVersion(child.version, child.version.id, library.libraryId);

        if (child.version.intentId !== record.intentId || child.version.childId !== child.childId
          || child.version.accountKey !== record.accountKey || child.version.provider !== record.provider
          || child.version.operation !== child.operation) {
          throw new IntentError('invalid_intent');
        }
      }

      if (child.taskId !== null && (typeof child.taskId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,100}$/.test(child.taskId))) {
        throw new IntentError('invalid_intent');
      }

      if (child.stage === 'accepted' && child.taskId === null) {
        throw new IntentError('invalid_intent');
      }

      if (child.remote && (child.remote.id !== child.taskId || child.remote.type !== child.taskType
        || !Array.isArray(child.remote.outputs) || child.remote.outputs.length > 128
        || !Array.isArray(child.remote.requiredRoles) || child.remote.requiredRoles.length > 128)) {
        throw new IntentError('invalid_intent');
      }
    }
  } catch {
    throw new IntentError('invalid_intent');
  }
}

/**
 * Контекст не даёт path/workspace прав и имеет закрытый набор полей.
 * Неизвестный kind, повтор видов и недостоверные bounds отвергаются до worker.
 */
function validateContext(context: InputContext): void {
  if (!context || typeof context !== 'object' || Object.keys(context).some((key) => ![
    'kind', 'format', 'stats', 'params', 'nativeTaskType', 'rigCheck', 'views',
  ].includes(key)) || (context.kind !== null && !VERSION_KINDS.includes(context.kind))
    || (context.format !== null && !/^[a-z0-9]{1,10}$/.test(context.format))
    || !Array.isArray(context.views) || context.views.length > 4
    || new Set(context.views).size !== context.views.length
    || context.views.some((view) => !['front', 'left', 'back', 'right'].includes(view))
    || (context.nativeTaskType !== null && (typeof context.nativeTaskType !== 'string'
      || context.nativeTaskType.length > 200))) {
    throw new IntentError('invalid_intent');
  }

  if (context.params !== null) {
    parseStudio3d.values(context.params);
  }

  if (context.rigCheck !== null && (!context.rigCheck || Object.keys(context.rigCheck).some((key) => ![
    'riggable', 'rigType',
  ].includes(key)) || typeof context.rigCheck.riggable !== 'boolean'
    || (context.rigCheck.rigType !== null && typeof context.rigCheck.rigType !== 'string'))) {
    throw new IntentError('invalid_intent');
  }

  if (context.stats?.size !== undefined && context.stats.size !== null
    && (context.stats.size.length !== 3 ||
      context.stats.size.some((size) => !Number.isFinite(size) || size < 0))) {
    throw new IntentError('invalid_intent');
  }

  if (context.stats !== null) {
    parseStudio3d.stats({
      triangles: 0,
      vertices: 0,
      meshes: 0,
      materials: 0,
      bones: 0,
      animations: [],
      textures: [],
      size: null,
      facing: null,
      parts: [],
      extensions: [],
      ...context.stats
    });
  }
}

/**
 * Saved opaque payload не получает новых прав на файл после правки metadata.
 * Проверка касается файловых дескрипторов запроса, а не текста prompt.
 */
function validatePayload(value: unknown, allowed: Set<string>, root: string): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  const stack = [value];
  let count = 0;

  while (stack.length) {
    const current = stack.pop()!;

    count += 1;

    if (count > 10_000) {
      throw new IntentError('invalid_intent');
    }

    for (const [key, item] of Object.entries(current)) {
      if (key === 'file' && item && typeof item === 'object' && !Array.isArray(item)) {
        const file = item as Record<string, unknown>;

        if (typeof file.path === 'string' && (!allowed.has(file.path)
          || (file.root !== undefined && file.root !== root))) {
          throw new IntentError('invalid_intent');
        }
      }

      if (item && typeof item === 'object') {
        stack.push(item);
      }
    }
  }
}

class Intents {
  private readonly options: IntentsOptions;
  private readonly records = new Map<string, IntentRecord>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  constructor(options: IntentsOptions) {
    this.options = options;
  }

  private assertId(id: string): void {
    if (!LIBRARY_UUID_RE.test(id)) {
      throw new IntentError('invalid_intent');
    }
  }

  directory(id: string): string {
    this.assertId(id);

    return path.join(this.options.library.dir, '.jobs', id);
  }

  inputPath(id: string, name: string): string {
    if (!isSafeName(name)) {
      throw new IntentError('invalid_intent');
    }

    return path.join(this.directory(id), 'inputs', name);
  }

  /**
   * Load вызывается только при включённом lifecycle и восстанавливает весь журнал.
   * Битая schema закрывает dispatch, а orphan без intent не считается оплаченным заказом.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loading ??= this.loadSnapshot().catch((error) => {
      this.loading = null;

      throw error;
    });

    await this.loading;
  }

  /**
   * Одно initial чтение разделяется всеми ключами. Поздняя копия списка не
   * очищает cache поверх уже записанного соседнего намерения.
   */
  private async loadSnapshot(): Promise<void> {
    const library = this.options.library;

    await library.assertOwner();

    const directory = await pinDirectory(library.dir, path.join(library.dir, '.jobs'));
    const loaded = new Map<string, IntentRecord>();

    try {
      for (const item of await fs.readdir(directory.child('.'), { withFileTypes: true })) {
        if (!LIBRARY_UUID_RE.test(item.name)) {
          continue;
        }

        if (!item.isDirectory() || item.isSymbolicLink()) {
          throw new IntentError('invalid_intent');
        }

        let raw;

        try {
          await this.options.beforeRead?.(item.name);
          raw = await readJson(library.dir, path.join(this.directory(item.name), 'intent.json'),
            16 * 1024 * 1024);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }

          throw error;
        }

        loaded.set(item.name, validateRecord(raw, item.name, library));
      }

      await directory.verify();

      this.records.clear();

      for (const [id, record] of loaded) {
        this.records.set(id, record);
      }

      this.loaded = true;
    } finally {
      await directory.close();
    }
  }

  /**
   * Get возвращает копию, чтобы случайная мутация не опередила fsync.
   * Старый libraryId отклоняется до просмотра ключей другой библиотеки.
   */
  async get(id: string, libraryId = this.options.library.libraryId): Promise<IntentRecord | null> {
    this.assertId(id);

    if (libraryId !== this.options.library.libraryId) {
      throw new IntentError('stale_library');
    }

    if (!this.loaded) {
      await this.load();
    }

    const record = this.records.get(id);

    return record ? structuredClone(record) : null;
  }

  /**
   * Список сохраняет метаданные всех терминальных/удалённых/unknown намерений.
   * Никакой срок не удаляет ключ и финансовый исход автоматически.
   */
  async list(): Promise<IntentRecord[]> {
    if (!this.loaded) {
      await this.load();
    }

    return [...this.records.values()].map((record) => structuredClone(record));
  }

  /**
   * Reserve атомарно сравнивает исходный fingerprint и фиксирует единственный UUID.
   * Свои входы уже скопированы, а проекции/POST создаются только после успешного fsync.
   */
  async reserve(source: IntentRecord): Promise<{ created: boolean; record: IntentRecord }> {
    const library = this.options.library;

    if (source.libraryId !== library.libraryId) {
      throw new IntentError('stale_library');
    }

    this.assertId(source.intentId);

    return withPathLock(`studio3d:intent:${library.dir}:${source.intentId}`, async () => {
      const previous = await this.get(source.intentId);

      if (previous) {
        if (previous.requestFingerprint !== source.requestFingerprint) {
          throw new IntentError('idempotency_conflict');
        }

        return { created: false, record: previous };
      }

      const record = validateRecord(structuredClone(source), source.intentId, library);

      await ensureDirectory(library.dir, this.directory(source.intentId));
      await this.write(record, false);

      return { created: true, record: structuredClone(record) };
    });
  }

  /**
   * Callback изменяет отдельную копию под lock, durable запись предшествует cache.
   * Fault после fsync уже виден recovery; ошибка до fsync не меняет старое состояние.
   */
  async update(id: string, change: (record: IntentRecord) => void): Promise<IntentRecord> {
    return withPathLock(`studio3d:intent:${this.options.library.dir}:${id}`, async () => {
      const record = await this.get(id);

      if (!record) {
        throw new IntentError('intent_not_found');
      }

      const identity = record.requestFingerprint;
      const previous = canonicalJson(record);

      change(record);

      if (record.requestFingerprint !== identity || record.intentId !== id) {
        throw new IntentError('immutable_intent');
      }

      if (canonicalJson(record) === previous) {
        return structuredClone(record);
      }

      record.revision += 1;

      validateRecord(record, id, this.options.library);
      await this.write(record, true);

      return structuredClone(record);
    });
  }

  /**
   * Запись проходит owner lock и durable atomic publish библиотеки.
   * После успешного fsync cache заменяется целиком, никогда частично.
   */
  private async write(record: IntentRecord, replace: boolean): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(record, null, 2)) > 16 * 1024 * 1024) {
      throw new IntentError('invalid_intent');
    }

    await this.options.beforeWrite?.(structuredClone(record));
    await this.options.library.persist(path.join(this.directory(record.intentId), 'intent.json'),
      record, replace);

    this.records.set(record.intentId, structuredClone(record));

    await this.options.afterWrite?.(structuredClone(record));
  }
}

/**
 * Фабрика журнала не читает диск до load/get/reserve. Это позволяет disabled
 * плагину регистрироваться без открытия библиотеки и восстановления заданий.
 */
export function createIntents(options: IntentsOptions): Intents {
  return new Intents(options);
}

export type StudioIntents = ReturnType<typeof createIntents>;
