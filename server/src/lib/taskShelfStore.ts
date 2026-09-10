// Account-scoped полка задач. Одна очередь охватывает весь read-modify-write:
// временный файл и rename защищают от обрыва, очередь — от потерянных параллельных правок.
import fs from 'node:fs';
import path from 'node:path';

import { parseB24TaskId } from './b24TaskId.ts';
import type {
  ShelfAnalysisSnapshot,
  ShelfAnalysisState,
  ShelfB24Snapshot,
  ShelfEntry,
  ShelfEntrySnapshot,
  ShelfPipelineSnapshot,
  ShelfPutInput,
  ShelfReason,
} from '../../../shared/shelfContracts.ts';

const SCHEMA_VERSION = 1;

export interface ShelfSnapshot {
  revision: number;
  entries: ShelfEntry[];
  // Служебный флаг рассылки события: он не перечисляется и в JSON ответа не попадает.
  readonly changed?: boolean;
}

interface ShelfScopeRecord {
  revision: number;
  entries: ShelfEntry[];
}

interface ShelfDocument {
  schemaVersion: number;
  scopes: Record<string, ShelfScopeRecord>;
}

export class TaskShelfStoreError extends Error {
  code: string;

  constructor(code: string, message: string, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskShelfStoreError';
    this.code = code;
  }
}

export function normalizeShelfTaskId(value: unknown): string {
  const normalized = parseB24TaskId(value);
  if (!normalized) {
    throw new TaskShelfStoreError(
      'BAD_SHELF_TASK_ID',
      'taskId должен быть положительным целым числом',
    );
  }

  return normalized;
}

function isReason(value: unknown): value is ShelfReason {
  return value === 'manual' || value === 'analysis' || value === 'pipeline' || value === 'comments';
}

function isAnalysisState(value: unknown): value is ShelfAnalysisState {
  return value === 'queued' || value === 'running' || value === 'done'
    || value === 'finished' || value === 'failed' || value === 'interrupted';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function nullableText(value: unknown, limit = 500): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > limit) throw new Error('invalid text');
  return value;
}

function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('invalid date');
  }

  return value;
}

/**
 * Время оценки — миллисекунды. Клиент присылает число, а записи прошлого формата
 * держат ISO-строку: она читается и переводится, иначе полка человека отказала бы
 * на первом же старом снимке. Строка `generated_at` — не время, а отметка модели,
 * и её по-прежнему проверяет nullableDate.
 */
function nullableMoment(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;

  if (!Number.isFinite(parsed)) {
    throw new Error('invalid date');
  }

  return parsed;
}

function normalizeAnalysis(value: unknown): ShelfAnalysisSnapshot | null {
  if (value === null) return null;
  const source = asRecord(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isAnalysisState(source.state)) {
    throw new Error('invalid analysis snapshot');
  }

  return {
    state: source.state,
    queuedAt: nullableMoment(source.queuedAt),
    startedAt: nullableMoment(source.startedAt),
    finishedAt: nullableMoment(source.finishedAt),
    generatedAt: nullableDate(source.generatedAt),
  };
}

function normalizePipeline(value: unknown): ShelfPipelineSnapshot | null {
  if (value === null) return null;
  const source = asRecord(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof source.gateKnown !== 'boolean') {
    throw new Error('invalid pipeline snapshot');
  }

  return {
    attempt: nullableText(source.attempt, 200),
    daemon: nullableText(source.daemon, 40),
    result: nullableText(source.result, 100),
    stall: nullableText(source.stall, 500),
    gateKnown: source.gateKnown,
    gate: nullableText(source.gate, 500),
  };
}

function normalizeB24(value: unknown): ShelfB24Snapshot | null {
  if (value === null) return null;
  const source = asRecord(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof source.present !== 'boolean'
    || !Number.isSafeInteger(source.unread) || Number(source.unread) < 0) {
    throw new Error('invalid b24 snapshot');
  }

  return {
    present: source.present,
    status: nullableText(source.status, 100),
    statusKind: nullableText(source.statusKind, 100),
    unread: Number(source.unread),
  };
}

function normalizeSnapshot(value: unknown): ShelfEntrySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid snapshot');
  }
  const source = asRecord(value);

  return {
    analysis: normalizeAnalysis(source.analysis),
    pipeline: normalizePipeline(source.pipeline),
    b24: normalizeB24(source.b24),
  };
}

function normalizeInput(value: unknown): ShelfPutInput {
  const source = asRecord(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 300
    || !isReason(source.reason) || typeof source.createIfMissing !== 'boolean') {
    throw new TaskShelfStoreError('BAD_SHELF_REQUEST', 'Некорректная запись полки');
  }

  try {
    return {
      title: source.title.trim(),
      reason: source.reason,
      snapshot: normalizeSnapshot(source.snapshot),
      createIfMissing: source.createIfMissing,
    };
  } catch (error) {
    throw new TaskShelfStoreError('BAD_SHELF_REQUEST', 'Некорректный снимок полки', error);
  }
}

function normalizeEntry(value: unknown): ShelfEntry {
  const source = asRecord(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 300
    || !isReason(source.reason) || typeof source.addedAt !== 'string'
    || !Number.isFinite(Date.parse(source.addedAt))) {
    throw new Error('invalid shelf entry');
  }

  return {
    taskId: normalizeShelfTaskId(source.taskId),
    title: source.title.trim(),
    addedAt: source.addedAt,
    reason: source.reason,
    snapshot: normalizeSnapshot(source.snapshot),
  };
}

function emptyDocument(): ShelfDocument {
  return { schemaVersion: SCHEMA_VERSION, scopes: {} };
}

function normalizeDocument(value: unknown): ShelfDocument {
  const source = asRecord(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || source.schemaVersion !== SCHEMA_VERSION
    || !source.scopes || typeof source.scopes !== 'object' || Array.isArray(source.scopes)) {
    throw new TaskShelfStoreError(
      'TASK_SHELF_CORRUPT',
      'Файл полки имеет неизвестный или повреждённый формат',
    );
  }

  const scopes: Record<string, ShelfScopeRecord> = {};
  try {
    for (const [scope, rawRecord] of Object.entries(asRecord(source.scopes))) {
      const record = asRecord(rawRecord);
      if (!scope || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)
        || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
        || !Array.isArray(record.entries)) {
        throw new Error('invalid scope record');
      }
      const entries = new Map<string, ShelfEntry>();
      for (const rawEntry of record.entries) {
        const entry = normalizeEntry(rawEntry);
        if (!entries.has(entry.taskId)) entries.set(entry.taskId, entry);
      }
      scopes[scope] = { revision: Number(record.revision), entries: [...entries.values()] };
    }
  } catch (error) {
    if (error instanceof TaskShelfStoreError && error.code === 'TASK_SHELF_CORRUPT') {
      throw error;
    }
    throw new TaskShelfStoreError(
      'TASK_SHELF_CORRUPT',
      'Файл полки содержит некорректные данные',
      error,
    );
  }

  return { schemaVersion: SCHEMA_VERSION, scopes };
}

function sameEntry(left: ShelfEntry, right: ShelfEntry): boolean {
  return left.title === right.title && left.reason === right.reason
    && JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot);
}

export class TaskShelfStore {
  filePath: string;

  _chain: Promise<void>;

  _writeSeq: number;

  constructor({ filePath }: { filePath: string }) {
    this.filePath = filePath;
    this._chain = Promise.resolve();
    this._writeSeq = 0;
  }

  _enqueue<Result>(operation: () => Result): Promise<Result> {
    const result = this._chain.then(operation);
    this._chain = result.then(() => undefined, () => undefined);
    return result;
  }

  _read(): ShelfDocument {
    let source;
    try {
      source = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (asRecord(error).code === 'ENOENT') return emptyDocument();
      throw new TaskShelfStoreError(
        'TASK_SHELF_UNAVAILABLE',
        'Не удалось прочитать файл полки',
        error,
      );
    }

    try {
      return normalizeDocument(JSON.parse(source));
    } catch (error) {
      if (error instanceof TaskShelfStoreError) throw error;
      throw new TaskShelfStoreError(
        'TASK_SHELF_CORRUPT',
        'Файл полки содержит повреждённый JSON',
        error,
      );
    }
  }

  _write(document: ShelfDocument): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this._writeSeq += 1;
    const temporary = `${this.filePath}.${process.pid}.${this._writeSeq}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* файл мог не создаться */ }
      throw new TaskShelfStoreError(
        'TASK_SHELF_UNAVAILABLE',
        'Не удалось сохранить полку',
        error,
      );
    }
  }

  _snapshot(document: ShelfDocument, scope: string, changed = false): ShelfSnapshot {
    const record = document.scopes[scope];
    const result: ShelfSnapshot = {
      revision: record?.revision || 0,
      entries: structuredClone(record?.entries || []),
    };
    Object.defineProperty(result, 'changed', { value: changed, enumerable: false });
    return result;
  }

  async list(scope: string): Promise<ShelfSnapshot> {
    return this._enqueue(() => this._snapshot(this._read(), String(scope)));
  }

  async put(scope: string, taskId: unknown, value: unknown): Promise<ShelfSnapshot> {
    const id = normalizeShelfTaskId(taskId);
    const input = normalizeInput(value);
    const key = String(scope);
    return this._enqueue(() => {
      const document = this._read();
      const current = document.scopes[key] || { revision: 0, entries: [] };
      const index = current.entries.findIndex((entry) => entry.taskId === id);
      if (index < 0 && !input.createIfMissing) return this._snapshot(document, key);
      // createIfMissing — операция ensure для ручной/автоматической постановки.
      // Уже лежащую запись и её снимок меняет только acknowledge (false).
      if (index >= 0 && input.createIfMissing) return this._snapshot(document, key);

      const existing = index >= 0 ? current.entries[index] : null;
      const entry: ShelfEntry = {
        taskId: id,
        title: input.title,
        addedAt: existing?.addedAt || new Date().toISOString(),
        reason: input.reason,
        snapshot: input.snapshot,
      };
      if (existing && sameEntry(existing, entry)) return this._snapshot(document, key);

      const entries = [...current.entries];
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      document.scopes[key] = { revision: current.revision + 1, entries };
      this._write(document);
      return this._snapshot(document, key, true);
    });
  }

  async remove(scope: string, taskId: unknown): Promise<ShelfSnapshot> {
    const id = normalizeShelfTaskId(taskId);
    const key = String(scope);
    return this._enqueue(() => {
      const document = this._read();
      const current = document.scopes[key];
      if (!current || !current.entries.some((entry) => entry.taskId === id)) {
        return this._snapshot(document, key);
      }

      document.scopes[key] = {
        revision: current.revision + 1,
        entries: current.entries.filter((entry) => entry.taskId !== id),
      };
      this._write(document);
      return this._snapshot(document, key, true);
    });
  }
}
