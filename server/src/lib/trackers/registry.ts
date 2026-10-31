import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { NO_TRACKER_CAPABILITIES } from '../../../../shared/trackers/contracts.ts';
import type { TrackerDescriptor } from '../../../../shared/trackers/contracts.ts';
import { importRuntimeModule } from '../runtimeImport.ts';
import { TrackerError } from './contract.ts';
import type { DriverManifest, TaskRef, TaskTracker, TrackerFactory, TrackerHost } from './contract.ts';
import { readDriverManifest, validateDriverPackage } from './driverPackage.ts';

interface Entry {
  descriptor: TrackerDescriptor;
  tracker?: TaskTracker;
  directory?: string;
  loaded: boolean;
  closed: boolean;
  pending: Set<Promise<unknown>>;
  loading?: Promise<void>;
  busy?: 'credentials' | 'replacement';
}

export class TrackerRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<string>(['own']);
  private closed = false;

  constructor(
    privateOptions: { directory: string; host: (id: string) => TrackerHost },
  ) {
    this.options = privateOptions;
  }

  private readonly options: { directory: string; host: (id: string) => TrackerHost };

  get activeIds(): string[] {
    return [...this.active].filter((id) => !this.entries.get(id)?.closed);
  }

  descriptors(): TrackerDescriptor[] {
    return [...this.entries.values()].map(({ descriptor, tracker }) => ({
      ...descriptor,
      capabilities: { ...descriptor.capabilities },
      configured: !descriptor.deleted && (tracker?.isConfigured() ?? false),
    }));
  }

  /**
   * Системные экземпляры регистрируются до сканирования пользовательской папки.
   * Файловый пакет никогда не заменяет own или встроенный облачный драйвер.
   */
  register(tracker: TaskTracker, name: string, schema: DriverManifest['settings'] = {}): void {
    this.entries.set(tracker.id, {
      tracker,
      descriptor: {
        id: tracker.id,
        name,
        version: '1.0.0',
        contract: 1,
        configured: tracker.isConfigured(),
        capabilities: tracker.capabilities,
        schema,
        status: tracker.id === 'own' ? 'active' : 'available',
      },
      loaded: false,
      closed: false,
      pending: new Set(),
    });
  }

  /**
   * Недоступный выбранный id остаётся в каталоге с явной причиной отказа.
   * Это исключает молчаливое переключение действий на другой аккаунт.
   */
  unavailable(id: string, reason: string): void {
    const existing = this.entries.get(id);

    if (existing?.descriptor.deleted) {
      return;
    }

    if (existing?.tracker && !existing.directory) {
      return;
    }

    this.active.delete(id);
    this.entries.set(id, {
      ...existing,
      descriptor: {
        id,
        name: existing?.descriptor.name ?? id,
        version: existing?.descriptor.version ?? '',
        contract: 1,
        configured: false,
        capabilities: { ...NO_TRACKER_CAPABILITIES },
        schema: {},
        ...existing?.descriptor,
        status: 'unavailable',
        reason,
      },
      closed: true,
      loaded: existing?.loaded ?? false,
      pending: existing?.pending ?? new Set(),
    });
  }

  /**
   * Манифесты всех папок проверяются до первого импорта: дубликат закрывает оба пакета.
   * Обновление описаний не очищает sticky loaded и не исполняет заменённый код.
   */
  async refresh(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });

    const directories = await readdir(this.options.directory, { withFileTypes: true });
    const seen = new Map<string, string[]>();

    for (const entry of directories) {
      if (entry.name.startsWith('.') || ['own'].includes(entry.name)) {
        continue;
      }

      const directory = path.join(this.options.directory, entry.name);

      try {
        const raw = await readDriverManifest(directory);
        const id = typeof raw.id === 'string' ? raw.id : entry.name;

        seen.set(id, [...(seen.get(id) ?? []), entry.name]);

        await validateDriverPackage(directory, {
          expectedId: entry.name,
          version: String(raw.version),
          reservedIds: new Set(['own']),
          grigDeskVersion: '1.0.0',
        }, true);

        if (this.entries.get(id)?.loaded || this.entries.get(id)?.descriptor.deleted) {
          continue;
        }

        const manifest = raw as unknown as DriverManifest;

        this.entries.set(id, {
          descriptor: {
            ...manifest,
            configured: false,
            status: 'available',
            capabilities: { ...NO_TRACKER_CAPABILITIES },
            schema: manifest.settings,
          },
          directory,
          loaded: false,
          closed: false,
          pending: new Set(),
        });
      } catch {
        this.unavailable(entry.name, 'Пакет драйвера не прошёл проверку');
      }
    }

    for (const [id, names] of seen) {
      if (names.length > 1) {
        this.unavailable(id, 'Повторяющийся идентификатор драйвера');
      }
    }
  }

  /**
   * Импорт помечается loaded заранее: упавший модуль тоже мог выполнить побочный эффект.
   * Параллельные активации разделяют единственную попытку фабрики и её host-сессию.
   */
  private async load(id: string): Promise<Entry> {
    const entry = this.entries.get(id);

    if (this.closed || !entry || entry.closed) {
      throw new TrackerError('tracker_unavailable', 'Трекер не настроен или недоступен');
    }

    if (!entry.tracker && !entry.loading) {
      entry.loaded = true;
      entry.loading = (async () => {
        try {
          const module = await importRuntimeModule<{ default: TrackerFactory }>(
            path.join(entry.directory!, 'driver.ts'),
          );
          const tracker = await module.default(this.options.host(id));

          if (tracker.id !== id || typeof tracker.taskDetail !== 'function'
            || typeof tracker.isConfigured !== 'function') {
            throw new Error('Неверный контракт экземпляра');
          }

          entry.tracker = tracker;
          entry.descriptor.capabilities = { ...NO_TRACKER_CAPABILITIES, ...tracker.capabilities };
        } catch {
          this.unavailable(id, 'Не удалось загрузить драйвер');

          throw new TrackerError('tracker_unavailable', 'Трекер не настроен или недоступен');
        }
      })();
    }

    await entry.loading;

    return entry;
  }

  /**
   * Активация меняет допуск только после единственного успешного импорта.
   * Само чтение пакета для проверки реквизитов не меняет выбранный источник доски.
   */
  async activate(id: string): Promise<void> {
    const entry = await this.load(id);

    if (entry.closed) {
      throw new TrackerError('tracker_busy', 'Драйвер занят изменением подключения', 409);
    }

    this.active.add(id);
    entry.descriptor.status = 'active';
  }

  /**
   * Проверка реквизитов адресует переданный драйвер независимо от выбора доски.
   * Проверка использует тот же экземпляр, lease и очередь, не активируя второй внешний источник.
   */
  async testAuth(id: string) {
    await this.load(id);

    return this.dispatch(id, (tracker) => tracker.testAuth(), false);
  }

  /**
   * Выбор доски снимает внешний допуск без выгрузки кешированного ESM.
   * Собственный источник сохраняет постоянную активность при любом выборе.
   */
  deactivate(id: string): void {
    if (id !== 'own') {
      this.active.delete(id);

      const entry = this.entries.get(id);

      if (entry && !entry.closed) {
        entry.descriptor.status = 'available';
      }
    }
  }

  /**
   * Допуск фиксирует экземпляр синхронно до первого ожидания.
   * Lease ждёт весь принятый вызов, включая очередь драйвера, но не принимает новый.
   */
  call<T>(id: string, operation: (tracker: TaskTracker) => Promise<T>): Promise<T> {
    return this.dispatch(id, operation, true);
  }

  /**
   * Общий допуск учитывает lease и закрытие runtime и для обычного вызова, и для testAuth.
   * Только пользовательская проверка соединения допускает неактивный выбранным UI экземпляр.
   */
  private dispatch<T>(
    id: string,
    operation: (tracker: TaskTracker) => Promise<T>,
    active: boolean,
  ): Promise<T> {
    const entry = this.entries.get(id);

    if (this.closed || (active && !this.active.has(id)) || !entry?.tracker || entry.closed) {
      return Promise.reject(new TrackerError('tracker_unavailable', 'Трекер не настроен или недоступен'));
    }

    const result = Promise.resolve().then(() => operation(entry.tracker!));

    entry.pending.add(result);
    result.then(() => entry.pending.delete(result), () => entry.pending.delete(result));

    return result;
  }

  taskDetail(ref: TaskRef): Promise<unknown> {
    return this.call(ref.trackerId, (tracker) => tracker.taskDetail(ref.id));
  }

  isLoaded(id: string): boolean {
    return this.entries.get(id)?.loaded ?? false;
  }

  /**
   * Удалённый пакет теряет допуск, но сохраняет честную пометку кешированного ESM до рестарта.
   * Сканирование и смена выбора не должны снова разрешить вызовы старого экземпляра.
   */
  deleted(id: string): void {
    const entry = this.entries.get(id);

    if (!entry) {
      return;
    }

    this.active.delete(id);
    entry.closed = true;
    entry.busy = undefined;
    entry.descriptor.deleted = true;
    entry.descriptor.status = 'restartRequired';
    entry.descriptor.capabilities = { ...NO_TRACKER_CAPABILITIES };
  }

  /**
   * Переустановка снимает отметку удаления после commit нового пакета.
   * Допуск загруженного старого ESM по-прежнему определяет lease и требует рестарта.
   */
  installed(id: string): void {
    const entry = this.entries.get(id);

    if (entry) {
      entry.descriptor.deleted = false;
    }
  }

  /**
   * Смена реквизитов ждёт все уже принятые вызовы до записи нового аккаунта.
   * Поколение и secrets меняются синхронно внутри закрытого допуска, без окна для старого запроса.
   */
  async changeCredentials(ids: string[], write: () => void): Promise<void> {
    const entries = ids.map((id) => this.entries.get(id)).filter((entry): entry is Entry => !!entry?.tracker);

    if (this.closed || entries.some((entry) => entry.closed || entry.busy)) {
      throw new TrackerError('tracker_busy', 'Драйвер занят установкой или требует перезапуска', 409);
    }

    for (const entry of entries) {
      entry.closed = true;
      entry.busy = 'credentials';
    }

    try {
      await Promise.allSettled(entries.flatMap((entry) => [...entry.pending]));
      write();
    } finally {
      for (const entry of entries) {
        entry.closed = false;
        entry.busy = undefined;
      }
    }
  }

  /**
   * Замена блокирует новые вызовы до завершения файловой транзакции.
   * После публикации загруженный ESM остаётся закрытым до ручного перезапуска.
   */
  async prepareReplace(id: string, signal: AbortSignal) {
    const entry = this.entries.get(id);
    const wasClosed = entry?.closed ?? false;

    if (entry) {
      if (entry.busy) {
        throw new TrackerError('tracker_busy', 'Драйвер занят изменением подключения', 409);
      }

      entry.closed = true;
      entry.busy = 'replacement';

      try {
        await Promise.allSettled([...entry.pending, ...(entry.loading ? [entry.loading] : [])]);
        signal.throwIfAborted();
      } catch (error) {
        entry.closed = wasClosed;
        entry.busy = undefined;

        throw error;
      }
    }

    let finished = false;

    return {
      finish: async (outcome: 'installed' | 'reverted' | 'blocked') => {
        if (finished || !entry) {
          return;
        }

        finished = true;
        entry.busy = undefined;
        entry.closed = entry.descriptor.deleted || (outcome === 'reverted' ? wasClosed
          : outcome === 'blocked' || (outcome === 'installed' && entry.loaded));
        entry.descriptor.status = outcome === 'blocked' ? 'unavailable'
          : entry.closed ? 'restartRequired' : this.active.has(id) ? 'active' : 'available';
      },
    };
  }

  /**
   * Закрытие снимает допуск до ожидания уже принятых операций.
   * Завершение экземпляров принадлежит runtime, а не файловому установщику.
   */
  async close(): Promise<void> {
    this.closed = true;

    for (const entry of this.entries.values()) {
      await Promise.allSettled([...entry.pending]);
      await entry.tracker?.dispose?.();
    }
  }
}
