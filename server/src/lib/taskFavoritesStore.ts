// Серверное избранное задач. Одна promise-очередь охватывает весь read-modify-write:
// атомарный rename защищает файл от обрыва записи, но сам по себе не предотвращает lost update.
import fs from 'node:fs';
import path from 'node:path';

import { parseB24TaskId } from './b24TaskId.ts';

const SCHEMA_VERSION = 1;

export class TaskFavoritesStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskFavoritesStoreError';
    this.code = code;
  }
}

// Набор избранного одной учётной записи. Ревизия растёт при каждом изменении:
// по ней клиент понимает, что его список устарел.
export interface FavoritesScope {
  revision: number;
  taskIds: string[];
}

interface FavoritesDocument {
  schemaVersion: number;
  scopes: Record<string, FavoritesScope>;
}

export function normalizeFavoriteTaskId(value: unknown): string {
  const normalized = parseB24TaskId(value);
  if (!normalized) {
    throw new TaskFavoritesStoreError(
      'BAD_FAVORITE_TASK_ID',
      'taskId должен быть положительным целым числом',
    );
  }
  return normalized;
}

function emptyDocument(): FavoritesDocument {
  return { schemaVersion: SCHEMA_VERSION, scopes: {} };
}

function normalizeDocument(value: unknown): FavoritesDocument {
  const source = value as Partial<FavoritesDocument> | null;

  if (!source || typeof source !== 'object' || Array.isArray(source)
    || source.schemaVersion !== SCHEMA_VERSION
    || !source.scopes || typeof source.scopes !== 'object' || Array.isArray(source.scopes)) {
    throw new TaskFavoritesStoreError(
      'TASK_FAVORITES_CORRUPT',
      'Файл избранного имеет неизвестный или повреждённый формат',
    );
  }

  const scopes: Record<string, FavoritesScope> = {};

  try {
    for (const [scope, entry] of Object.entries(source.scopes)) {
      const record = entry as Partial<FavoritesScope> | null;

      if (!scope || !record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
        || !Array.isArray(record.taskIds)) {
        throw new Error('invalid scope record');
      }
      scopes[scope] = {
        revision: Number(record.revision),
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
  readonly filePath: string;

  // Одна очередь на весь read-modify-write: атомарный rename защищает файл от
  // обрыва записи, но сам по себе не предотвращает потерю параллельной правки.
  private _chain: Promise<unknown>;

  private _writeSeq: number;

  constructor({ filePath }: { filePath: string }) {
    this.filePath = filePath;
    this._chain = Promise.resolve();
    this._writeSeq = 0;
  }

  private _enqueue<Value>(operation: () => Value): Promise<Value> {
    const result = this._chain.then(operation);

    this._chain = result.then(() => undefined, () => undefined);

    return result;
  }

  private _read(): FavoritesDocument {
    let source: string;

    try {
      source = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return emptyDocument();
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

  private _write(document: FavoritesDocument): void {
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

  private _snapshot(document: FavoritesDocument, scope: string): FavoritesScope {
    const record = document.scopes[scope];
    return {
      revision: record?.revision || 0,
      taskIds: [...(record?.taskIds || [])],
    };
  }

  async list(scope: unknown): Promise<FavoritesScope> {
    return this._enqueue(() => this._snapshot(this._read(), String(scope)));
  }

  async add(scope: unknown, taskId: unknown): Promise<FavoritesScope> {
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

  async remove(scope: unknown, taskId: unknown): Promise<FavoritesScope> {
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
