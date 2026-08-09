// Просмотренные B24-задачи. Набор серверный (как избранное), потому что метка «новая»
// обязана сниматься на всех устройствах разом: открыл задачу на компьютере — на планшете
// она уже не новая. Одна promise-очередь охватывает весь read-modify-write: атомарный
// rename защищает файл от обрыва записи, но сам по себе не спасает от lost update.
import fs from 'node:fs';
import path from 'node:path';

import { parseB24TaskId } from './b24-task-id.js';

const SCHEMA_VERSION = 1;
// Потолок набора: доска отдаёт около сотни задач, так что обрезка хвоста наступит
// очень нескоро и не воскресит задачу, которая ещё в списке.
const MAX_SEEN_TASK_IDS = 2000;

export class TaskSeenStoreError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskSeenStoreError';
    this.code = code;
  }
}

export function normalizeSeenTaskId(value) {
  const normalized = parseB24TaskId(value);
  if (!normalized) {
    throw new TaskSeenStoreError(
      'BAD_SEEN_TASK_ID',
      'taskId должен быть положительным целым числом',
    );
  }
  return normalized;
}

function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, scopes: {} };
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes)) {
    throw new TaskSeenStoreError(
      'TASK_SEEN_CORRUPT',
      'Файл просмотренных задач имеет неизвестный или повреждённый формат',
    );
  }

  const scopes = {};
  try {
    for (const [scope, record] of Object.entries(value.scopes)) {
      if (!scope || !record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isSafeInteger(record.revision) || record.revision < 0
        || typeof record.initialized !== 'boolean'
        || !Array.isArray(record.taskIds)) {
        throw new Error('invalid scope record');
      }
      scopes[scope] = {
        revision: record.revision,
        initialized: record.initialized,
        taskIds: [...new Set(record.taskIds.map(normalizeSeenTaskId))],
      };
    }
  } catch (error) {
    if (error instanceof TaskSeenStoreError && error.code === 'TASK_SEEN_CORRUPT') throw error;
    throw new TaskSeenStoreError(
      'TASK_SEEN_CORRUPT',
      'Файл просмотренных задач содержит некорректные данные',
      error,
    );
  }
  return { schemaVersion: SCHEMA_VERSION, scopes };
}

export class TaskSeenStore {
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
      throw new TaskSeenStoreError(
        'TASK_SEEN_UNAVAILABLE',
        'Не удалось прочитать файл просмотренных задач',
        error,
      );
    }

    try {
      return normalizeDocument(JSON.parse(source));
    } catch (error) {
      if (error instanceof TaskSeenStoreError) throw error;
      throw new TaskSeenStoreError(
        'TASK_SEEN_CORRUPT',
        'Файл просмотренных задач содержит повреждённый JSON',
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
      throw new TaskSeenStoreError(
        'TASK_SEEN_UNAVAILABLE',
        'Не удалось сохранить просмотренные задачи',
        error,
      );
    }
  }

  _snapshot(document, scope) {
    const record = document.scopes[scope];
    return {
      revision: record?.revision || 0,
      initialized: !!record?.initialized,
      taskIds: [...(record?.taskIds || [])],
    };
  }

  async list(scope) {
    return this._enqueue(() => this._snapshot(this._read(), String(scope)));
  }

  /**
   * Помечает задачи просмотренными.
   * `baseline` ставит признак инициализации: до него метки «новая» не показываются вовсе,
   * иначе первое же включение объявило бы новыми все давние задачи доски. Обычная пометка
   * из карточки задачи признак НЕ трогает — она может прийти раньше первой загрузки доски.
   */
  async markSeen(scope, taskIds, { baseline = false } = {}) {
    const ids = [...new Set((Array.isArray(taskIds) ? taskIds : [taskIds])
      .map(normalizeSeenTaskId))];
    const key = String(scope);
    return this._enqueue(() => {
      const document = this._read();
      const current = document.scopes[key] || { revision: 0, initialized: false, taskIds: [] };
      const known = new Set(current.taskIds);
      const added = ids.filter((id) => !known.has(id));
      const initialized = current.initialized || !!baseline;
      if (!added.length && initialized === current.initialized) {
        return this._snapshot(document, key);
      }

      let next = [...current.taskIds, ...added];
      if (next.length > MAX_SEEN_TASK_IDS) next = next.slice(next.length - MAX_SEEN_TASK_IDS);
      document.scopes[key] = { revision: current.revision + 1, initialized, taskIds: next };
      this._write(document);
      return this._snapshot(document, key);
    });
  }
}
