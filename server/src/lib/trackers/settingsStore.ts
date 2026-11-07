import fs from 'node:fs';
import path from 'node:path';

import { TrackerError } from './contract.ts';

export interface TrackerSelection {
  externalId: string | null;
  revision: number;
}

export class TrackerSettingsStore {
  private value: TrackerSelection;

  constructor(privateFile: string) {
    this.file = privateFile;
    this.value = { externalId: null, revision: 0 };

    try {
      const parsed = JSON.parse(fs.readFileSync(privateFile, 'utf8')) as TrackerSelection;

      if ((parsed.externalId === null || typeof parsed.externalId === 'string')
        && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0) {
        this.value = parsed;
      } else {
        throw new Error('Некорректные настройки трекера');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private readonly file: string;

  read(): TrackerSelection {
    return { ...this.value };
  }

  /**
   * Сравнение ревизии выполняется до секретов и любых эффектов выбора.
   * Синхронная запись сохраняет последовательность запросов внутри процесса.
   */
  assertRevision(revision: unknown): void {
    if (revision !== this.value.revision) {
      throw new TrackerError('tracker_context_changed', 'Подключение уже изменилось', 409);
    }
  }

  /**
   * Публикует поколение только после атомарной замены файла выбора.
   * Даже смена реквизитов того же драйвера инвалидирует подготовленные действия.
   */
  write(externalId: string | null): TrackerSelection {
    const next = { externalId, revision: this.value.revision + 1 };

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.value = next;

    return this.read();
  }
}
