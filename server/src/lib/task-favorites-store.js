// Серверное избранное задач. Одна promise-очередь охватывает весь read-modify-write:
// атомарный rename защищает файл от обрыва записи, но сам по себе не предотвращает lost update.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_TASK_ID_DIGITS = 20;

export class TaskFavoritesStoreError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskFavoritesStoreError';
    this.code = code;
  }
}

export function normalizeFavoriteTaskId(value) {
  let raw;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) raw = '';
    else raw = String(value);
  } else if (typeof value === 'string') {
    raw = value.trim();
  } else {
    raw = '';
  }

  if (!/^\d+$/.test(raw) || raw.length > MAX_TASK_ID_DIGITS) {
    throw new TaskFavoritesStoreError(
      'BAD_FAVORITE_TASK_ID',
      'taskId должен быть положительным целым числом',
    );
  }

  const normalized = BigInt(raw);
  if (normalized <= 0n) {
    throw new TaskFavoritesStoreError(
      'BAD_FAVORITE_TASK_ID',
      'taskId должен быть положительным целым числом',
    );
  }
  return normalized.toString();
}

function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, scopes: {} };
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes)) {
    throw new TaskFavoritesStoreError(
      'TASK_FAVORITES_CORRUPT',
      'Файл избранного имеет неизвестный или повреждённый формат',
    );
  }

  const scopes = {};
  try {
    for (const [scope, record] of Object.entries(value.scopes)) {
      if (!scope || !record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isSafeInteger(record.revision) || record.revision < 0
        || !Array.isArray(record.taskIds)) {
        throw new Error('invalid scope record');
      }
      scopes[scope] = {
        revision: record.revision,
        taskIds: [...new Set(record.taskIds.map(normalizeFavoriteTaskId))],
      };
    }
  } catch (error) {
    if (error instanceof TaskFavoritesStoreError
      && error.code === 'TASK_FAVORITES_CORRUPT') throw error;
    throw new TaskFavoritesStoreError(
      'TASK_FAVORITES_CORRUPT',
      'Файл избранного содержит некорректные данные',
      error,
    );
  }
  return { schemaVersion: SCHEMA_VERSION, scopes };
}

export class TaskFavoritesStore {
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
      throw new TaskFavoritesStoreError(
        'TASK_FAVORITES_UNAVAILABLE',
        'Не удалось прочитать файл избранного',
        error,
      );
    }

    try {
      return normalizeDocument(JSON.parse(source));
    } catch (error) {
      if (error instanceof TaskFavoritesStoreError) throw error;
      throw new TaskFavoritesStoreError(
        'TASK_FAVORITES_CORRUPT',
        'Файл избранного содержит повреждённый JSON',
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
      try { fs.unlinkSync(temporary); } catch { /* временный файл мог не создаться */ }
      throw new TaskFavoritesStoreError(
        'TASK_FAVORITES_UNAVAILABLE',
        'Не удалось сохранить избранное',
        error,
      );
    }
  }

  _snapshot(document, scope) {
    const record = document.scopes[scope];
    return {
      revision: record?.revision || 0,
      taskIds: [...(record?.taskIds || [])],
    };
  }

  async list(scope) {
    return this._enqueue(() => this._snapshot(this._read(), String(scope)));
  }

  async add(scope, taskId) {
    const id = normalizeFavoriteTaskId(taskId);
    const key = String(scope);
    return this._enqueue(() => {
      const document = this._read();
      const current = document.scopes[key] || { revision: 0, taskIds: [] };
      if (current.taskIds.includes(id)) return this._snapshot(document, key);

      document.scopes[key] = {
        revision: current.revision + 1,
        taskIds: [...current.taskIds, id],
      };
      this._write(document);
      return this._snapshot(document, key);
    });
  }

  async remove(scope, taskId) {
    const id = normalizeFavoriteTaskId(taskId);
    const key = String(scope);
    return this._enqueue(() => {
      const document = this._read();
      const current = document.scopes[key];
      if (!current || !current.taskIds.includes(id)) return this._snapshot(document, key);

      document.scopes[key] = {
        revision: current.revision + 1,
        taskIds: current.taskIds.filter((value) => value !== id),
      };
      this._write(document);
      return this._snapshot(document, key);
    });
  }
}
