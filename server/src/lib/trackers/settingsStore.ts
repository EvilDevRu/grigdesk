import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { projectIcon } from '../../../../shared/runtime/projectIcon.ts';
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
  private logos = new Map<string, string>();
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

      if (isRecord(parsed.logos)) {
        for (const [id, value] of Object.entries(parsed.logos)) {
          const logo = projectIcon(value);

          if (logo) {
            this.logos.set(id, logo);
          }
        }
      }

      if (legacy) {
        this.persist(this.value, this.logos);
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

  logo(id: string): string | undefined {
    return this.logos.get(id);
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
   * Выбор и загруженные логотипы записываются вместе, alias вычисляется для старых клиентов.
   * Закрытые права устанавливаются также у уже существовавшего временного файла.
   */
  private persist(value: TrackerSelection, logos: ReadonlyMap<string, string>): void {
    const { drivers, default: defaultId, revision } = value;

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({
      drivers,
      default: defaultId,
      revision,
      ...(logos.size ? { logos: Object.fromEntries(logos) } : {}),
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
  write(
    input: TrackerSelectionInput | string | null,
    logoChanges: Record<string, string | null> = {},
  ): TrackerSelection {
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
    const logos = new Map(this.logos);

    for (const [id, logo] of Object.entries(logoChanges)) {
      if (logo === null) {
        logos.delete(id);
      } else {
        logos.set(id, logo);
      }
    }

    this.persist(next, logos);
    this.value = next;
    this.logos = logos;

    return this.read();
  }
}
