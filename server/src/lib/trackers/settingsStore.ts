import fs from 'node:fs';
import path from 'node:path';

import { TrackerError } from './contract.ts';

export interface TrackerSelection {
  drivers: string[];
  default: string | null;
  externalId: string | null;
  revision: number;
}

export type TrackerSelectionInput = Pick<TrackerSelection, 'drivers' | 'default'>;

export class TrackerSettingsStore {
  private value: TrackerSelection;
  private readonly file: string;

  constructor(privateFile: string) {
    this.file = privateFile;
    this.value = {
      drivers: [],
      default: null,
      externalId: null,
      revision: 0,
    };

    try {
      const parsed = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
      const legacy = !Object.hasOwn(parsed, 'drivers');
      const revision = parsed.revision ?? (legacy ? 0 : undefined);
      const drivers = legacy ? (parsed.externalId === null ? [] : [parsed.externalId]) : parsed.drivers;
      const defaultId = legacy ? parsed.externalId : parsed.default;

      if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(drivers)
        || drivers.some((id) => typeof id !== 'string' || !id || id === 'own')
        || new Set(drivers).size !== drivers.length
        || (defaultId !== null && !drivers.includes(defaultId))
        || (drivers.length > 0 && defaultId === null)) {
        throw new Error('Некорректные настройки трекера');
      }

      this.value = {
        drivers,
        default: defaultId,
        externalId: defaultId,
        revision,
      };

      if (legacy) {
        this.persist(this.value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  read(): TrackerSelection {
    return { ...this.value, drivers: [...this.value.drivers] };
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
   * Файл хранит только канонический набор и дефолт, alias вычисляется для старых клиентов.
   * Закрытые права устанавливаются также у уже существовавшего временного файла.
   */
  private persist(value: TrackerSelection): void {
    const { drivers, default: defaultId, revision } = value;

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({
      drivers,
      default: defaultId,
      revision,
    }), {
      mode: 0o600,
    });
    fs.chmodSync(`${this.file}.tmp`, 0o600);
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  /**
   * Старый caller может по-прежнему передать один id: он становится дефолтом.
   * Явный набор сохраняет порядок, необходимый для автоматического выбора следующего.
   */
  write(input: TrackerSelectionInput | string | null): TrackerSelection {
    const drivers = typeof input === 'object' && input !== null ? [...input.drivers]
      : input ? [...new Set([...this.value.drivers, input])] : this.value.drivers
        .filter((id) => id !== this.value.default);
    const requested = typeof input === 'object' && input !== null ? input.default : input;
    const defaultId = requested ?? drivers[0] ?? null;
    const next = {
      drivers,
      default: defaultId,
      externalId: defaultId,
      revision: this.value.revision + 1,
    };

    this.persist(next);
    this.value = next;

    return this.read();
  }
}
