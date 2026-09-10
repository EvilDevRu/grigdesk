// Просмотренные B24-задачи. Набор серверный (как избранное), потому что метка «новая»
// обязана сниматься на всех устройствах разом: открыл задачу на компьютере — на планшете
// она уже не новая. Одна promise-очередь охватывает весь read-modify-write: атомарный
// rename защищает файл от обрыва записи, но сам по себе не спасает от lost update.
import fs from 'node:fs';
import path from 'node:path';

import { parseB24TaskId } from './b24TaskId.ts';

const SCHEMA_VERSION = 1;
// Потолок набора: доска отдаёт около сотни задач, так что обрезка хвоста наступит
// очень нескоро и не воскресит задачу, которая ещё в списке.
const MAX_SEEN_TASK_IDS = 2000;

export class TaskSeenStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskSeenStoreError';
    this.code = code;
  }
}

// Набор просмотренных одной учётной записи. Ревизия растёт при каждом изменении:
// по ней клиент понимает, что его список устарел.
export interface SeenScope {
  revision: number;
  // Был ли набор заполнен первой сверкой с доской. До этого «не просмотрено» ещё не
  // означает «новая»: иначе после подключения все задачи разом стали бы новыми.
  initialized: boolean;
  taskIds: string[];
}

interface SeenDocument {
  schemaVersion: number;
  scopes: Record<string, SeenScope>;
}

export function normalizeSeenTaskId(value: unknown): string {
  const normalized = parseB24TaskId(value);
  if (!normalized) {
    throw new TaskSeenStoreError(
      'BAD_SEEN_TASK_ID',
      'taskId должен быть положительным целым числом',
    );
  }
  return normalized;
}

function emptyDocument(): SeenDocument {
  return { schemaVersion: SCHEMA_VERSION, scopes: {} };
}

function normalizeDocument(value: unknown): SeenDocument {
  const source = value as Partial<SeenDocument> | null;

  if (!source || typeof source !== 'object' || Array.isArray(source)
    || source.schemaVersion !== SCHEMA_VERSION
    || !source.scopes || typeof source.scopes !== 'object' || Array.isArray(source.scopes)) {
    throw new TaskSeenStoreError(
      'TASK_SEEN_CORRUPT',
      'Файл просмотренных задач имеет неизвестный или повреждённый формат',
    );
  }

  const scopes: Record<string, SeenScope> = {};

  try {
    for (const [scope, entry] of Object.entries(source.scopes)) {
      const record = entry as Partial<SeenScope> | null;

      if (!scope || !record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
        || typeof record.initialized !== 'boolean'
        || !Array.isArray(record.taskIds)) {
        throw new Error('invalid scope record');
      }
      scopes[scope] = {
        revision: Number(record.revision),
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

  private _read(): SeenDocument {
    let source: string;

    try {
      source = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return emptyDocument();
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

  private _write(document: SeenDocument): void {
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

  private _snapshot(document: SeenDocument, scope: string): SeenScope {
    const record = document.scopes[scope];
    return {
      revision: record?.revision || 0,
      initialized: !!record?.initialized,
      taskIds: [...(record?.taskIds || [])],
    };
  }

  async list(scope: unknown): Promise<SeenScope> {
    return this._enqueue(() => this._snapshot(this._read(), String(scope)));
  }

  /**
   * Помечает задачи просмотренными.
   * `baseline` ставит признак инициализации: до него метки «новая» не показываются вовсе,
   * иначе первое же включение объявило бы новыми все давние задачи доски. Обычная пометка
   * из карточки задачи признак НЕ трогает — она может прийти раньше первой загрузки доски.
   */
  async markSeen(scope: unknown, taskIds: unknown, { baseline = false } = {}): Promise<SeenScope> {
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
