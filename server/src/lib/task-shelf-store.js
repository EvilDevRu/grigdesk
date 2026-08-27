// Account-scoped полка задач. Одна очередь охватывает весь read-modify-write:
// временный файл и rename защищают от обрыва, очередь — от потерянных параллельных правок.
import fs from 'node:fs';
import path from 'node:path';

import { parseB24TaskId } from './b24-task-id.js';

const SCHEMA_VERSION = 1;
const REASONS = new Set(['manual', 'analysis', 'pipeline', 'comments']);
const ANALYSIS_STATES = new Set([
  'queued',
  'running',
  'done',
  'finished',
  'failed',
  'interrupted',
]);

export class TaskShelfStoreError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskShelfStoreError';
    this.code = code;
  }
}

export function normalizeShelfTaskId(value) {
  const normalized = parseB24TaskId(value);
  if (!normalized) {
    throw new TaskShelfStoreError(
      'BAD_SHELF_TASK_ID',
      'taskId должен быть положительным целым числом',
    );
  }

  return normalized;
}

function nullableText(value, limit = 500) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > limit) throw new Error('invalid text');
  return value;
}

function nullableDate(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('invalid date');
  }

  return value;
}

function normalizeAnalysis(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !ANALYSIS_STATES.has(value.state)) {
    throw new Error('invalid analysis snapshot');
  }

  return {
    state: value.state,
    queuedAt: nullableDate(value.queuedAt),
    startedAt: nullableDate(value.startedAt),
    finishedAt: nullableDate(value.finishedAt),
    generatedAt: nullableDate(value.generatedAt),
  };
}

function normalizePipeline(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.gateKnown !== 'boolean') {
    throw new Error('invalid pipeline snapshot');
  }

  return {
    attempt: nullableText(value.attempt, 200),
    daemon: nullableText(value.daemon, 40),
    result: nullableText(value.result, 100),
    stall: nullableText(value.stall, 500),
    gateKnown: value.gateKnown,
    gate: nullableText(value.gate, 500),
  };
}

function normalizeB24(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.present !== 'boolean'
    || !Number.isSafeInteger(value.unread) || value.unread < 0) {
    throw new Error('invalid b24 snapshot');
  }

  return {
    present: value.present,
    status: nullableText(value.status, 100),
    statusKind: nullableText(value.statusKind, 100),
    unread: value.unread,
  };
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid snapshot');
  }

  return {
    analysis: normalizeAnalysis(value.analysis),
    pipeline: normalizePipeline(value.pipeline),
    b24: normalizeB24(value.b24),
  };
}

function normalizeInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300
    || !REASONS.has(value.reason) || typeof value.createIfMissing !== 'boolean') {
    throw new TaskShelfStoreError('BAD_SHELF_REQUEST', 'Некорректная запись полки');
  }

  try {
    return {
      title: value.title.trim(),
      reason: value.reason,
      snapshot: normalizeSnapshot(value.snapshot),
      createIfMissing: value.createIfMissing,
    };
  } catch (error) {
    throw new TaskShelfStoreError('BAD_SHELF_REQUEST', 'Некорректный снимок полки', error);
  }
}

function normalizeEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300
    || !REASONS.has(value.reason) || typeof value.addedAt !== 'string'
    || !Number.isFinite(Date.parse(value.addedAt))) {
    throw new Error('invalid shelf entry');
  }

  return {
    taskId: normalizeShelfTaskId(value.taskId),
    title: value.title.trim(),
    addedAt: value.addedAt,
    reason: value.reason,
    snapshot: normalizeSnapshot(value.snapshot),
  };
}

function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, scopes: {} };
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes)) {
    throw new TaskShelfStoreError(
      'TASK_SHELF_CORRUPT',
      'Файл полки имеет неизвестный или повреждённый формат',
    );
  }

  const scopes = {};
  try {
    for (const [scope, record] of Object.entries(value.scopes)) {
      if (!scope || !record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isSafeInteger(record.revision) || record.revision < 0
        || !Array.isArray(record.entries)) {
        throw new Error('invalid scope record');
      }
      const entries = new Map();
      for (const rawEntry of record.entries) {
        const entry = normalizeEntry(rawEntry);
        if (!entries.has(entry.taskId)) entries.set(entry.taskId, entry);
      }
      scopes[scope] = { revision: record.revision, entries: [...entries.values()] };
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

function sameEntry(left, right) {
  return left.title === right.title && left.reason === right.reason
    && JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot);
}

export class TaskShelfStore {
  /** @param {{ filePath: string }} opts */
  constructor({ filePath }) {
    this.filePath = filePath;
    this._chain = Promise.resolve();
    this._writeSeq = 0;
  }

  _enqueue(operation) {
    const result = this._chain.then(operation);
    this._chain = result.then(() => undefined, () => undefined);
    return result;
  }

  _read() {
    let source;
    try {
      source = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyDocument();
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

  _write(document) {
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

  _snapshot(document, scope, changed = false) {
    const record = document.scopes[scope];
    const result = {
      revision: record?.revision || 0,
      entries: structuredClone(record?.entries || []),
    };
    Object.defineProperty(result, 'changed', { value: changed, enumerable: false });
    return result;
  }

  async list(scope) {
    return this._enqueue(() => this._snapshot(this._read(), String(scope)));
  }

  async put(scope, taskId, value) {
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
      const entry = {
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

  async remove(scope, taskId) {
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
