import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireDirectoryLock } from '../../../shared/node/directoryLock.ts';
import { isTaskSourceId } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';

export interface FactorySourceRecord {
  taskId: string;
  source: TaskSourceId;
  ticketHash: string;
  dispatchId: string;
  attempt?: string;
}

interface SourceDocument {
  schemaVersion: 1;
  entries: Record<string, FactorySourceRecord>;
}

/**
 * Считает отпечаток проверенного содержимого тикета одинаково до и после запуска.
 * Пробелы и порядок полей JSON не меняют привязку к immutable копии попытки.
 */
export function factoryTicketHash(ticket: unknown): string {
  return createHash('sha256').update(canonicalJson(ticket)).digest('hex');
}

/**
 * Индекс описывает только источник запуска и не заменяет trusted журнал движка.
 * Повреждённый файл остаётся отказом чтения и никогда не перезаписывается пустым.
 */
export class FactoryTaskSources {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Один снимок обслуживает всю проекцию конвейера без обращений к трекеру.
   * Отсутствие файла допустимо для старых установок; неверная схема запрещает запись.
   */
  async read(): Promise<SourceDocument> {
    let value: SourceDocument;

    try {
      value = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, entries: {} };
      }

      throw error;
    }

    if (value?.schemaVersion !== 1 || !value.entries || typeof value.entries !== 'object'
      || Array.isArray(value.entries) || Object.entries(value.entries).some(([id, entry]) => (
        !entry || entry.taskId !== id || !/^[1-9]\d{0,19}$/.test(id)
        || !isTaskSourceId(entry.source) || !/^[a-f0-9]{64}$/.test(entry.ticketHash)
        || !/^[a-f0-9-]{36}$/.test(entry.dispatchId)
        || (entry.attempt !== undefined && !/^a_[a-f0-9]{32}$/.test(entry.attempt))
      ))) {
      throw new Error('Повреждён индекс источников конвейера');
    }

    return value;
  }

  /**
   * Directory lock защищает индекс и от второго процесса сервера.
   * Pending сохраняется до spawn; подтверждение требует той же dispatch identity.
   */
  async put(record: FactorySourceRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    const lock = await acquireDirectoryLock(`${this.filePath}.lock`);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;

    try {
      const document = await this.read();

      document.entries[record.taskId] = record;
      await fs.writeFile(temporary, JSON.stringify(document), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true });
      await lock.release();
    }
  }

  /**
   * Pending разрешается после рестарта только по immutable ticket и dispatch попытки.
   * Равный номер или отпечаток другого запуска не доказывает принадлежность источнику.
   */
  static verified(record: FactorySourceRecord | undefined, proof: {
    attempt: string;
    queueDispatchId?: string | null;
    ticketHash: string;
  } | null): TaskSourceId | undefined {
    return record && proof && record.dispatchId === proof.queueDispatchId
      && record.ticketHash === proof.ticketHash && (!record.attempt || record.attempt === proof.attempt)
      ? record.source : undefined;
  }
}
