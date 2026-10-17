// Runtime владеет библиотекой, worker и единственным допуском настройки/POST.
// Выключенный startup не создаёт контекст; принятые заказы продолжаются после disable.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ACTIVE_STATUSES, parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dState } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dProvider, Balance } from '../../lib/studio3d/provider.ts';
import { createLibrary } from '../../lib/studio3d/library.ts';
import { createIntents } from '../../lib/studio3d/intents.ts';
import { createJobs } from '../../lib/studio3d/jobs.ts';
import { createImporter } from '../../lib/studio3d/importer.ts';
import { createAdmission } from '../../lib/studio3d/admission.ts';
import { createLocalStudio } from '../../lib/studio3d/local.ts';
import { downloadToFile } from '../../lib/studio3d/download.ts';
import type { DownloadOptions } from '../../lib/studio3d/download.ts';
import type { DocumentReader } from '../../lib/documents/reader.ts';
import { studioProviders } from '../../lib/studio3d/providers.ts';
import { getProviderAdapters } from '../../lib/executors/index.ts';
import { createStudioFiles } from './files.ts';
import { StudioHttpError } from './errors.ts';

export interface StudioProject {
  id: string;
  archivedAt?: string | null;
  archived?: boolean;
  repos: { key: string; dir: string }[];
}

export interface StudioProjectService {
  list(): Promise<StudioProject[]>;
  read(id: string): Promise<StudioProject>;
}

export interface StudioSettings {
  autoImport: boolean;
  lowDiskGb: number;
  libraryDir: string;
}

export interface StudioRuntimeOptions {
  config: {
    rootDir: string;
    studio3dDir: string;
  };
  enabled: () => boolean;
  settings: () => unknown;
  documentReader: DocumentReader;
  projects?: () => StudioProjectService | undefined;
  providers?: Studio3dProvider[] | (() => Promise<Studio3dProvider[]>);
  broadcast?: (name: string, data: Record<string, unknown>) => void;
  download?: (request: DownloadOptions) => ReturnType<typeof downloadToFile>;
  statfs?: typeof fs.statfs;
  now?: () => number;
  setHistoryTimer?: (callback: () => Promise<void>, delay: number) => unknown;
  clearHistoryTimer?: (timer: unknown) => void;
}

export interface StudioTransition {
  commit(): void;
  rollback(): Promise<void>;
  afterCommit(): Promise<void>;
}

export interface StudioContext {
  library: ReturnType<typeof createLibrary>;
  intents: ReturnType<typeof createIntents>;
  jobs: ReturnType<typeof createJobs>;
  importer: ReturnType<typeof createImporter>;
  files: ReturnType<typeof createStudioFiles>;
  providers: Studio3dProvider[];
}

/**
 * Настройки проверяются до файловых эффектов; невалидная папка не попадает в prefs.
 * Умолчания соответствуют манифесту и не читаются из живого состояния factory.
 */
export function studioSettings(raw: unknown): StudioSettings {
  const values = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};

  if (values.libraryDir !== undefined && typeof values.libraryDir !== 'string') {
    throw new StudioHttpError(400, 'invalid_settings', 'Папка библиотеки должна быть строкой.');
  }

  const lowDiskGb = values.lowDiskGb ?? 10;

  if (typeof lowDiskGb !== 'number' || !Number.isFinite(lowDiskGb) || lowDiskGb < 1 || lowDiskGb > 1000
    || (values.autoImport !== undefined && typeof values.autoImport !== 'boolean')) {
    throw new StudioHttpError(400, 'invalid_settings', 'Проверьте параметры библиотеки.');
  }

  return {
    autoImport: values.autoImport !== false,
    lowDiskGb,
    libraryDir: String(values.libraryDir ?? '')
  };
}

/**
 * Один download pool используется worker и importer: максимум два сетевых файла.
 * Отменённая queued операция проверяет signal до начала transport.
 */
function downloadPool(download: (options: DownloadOptions) => ReturnType<typeof downloadToFile>) {
  let running = 0;
  const queue: (() => void)[] = [];

  return (request: DownloadOptions): ReturnType<typeof downloadToFile> => new Promise((resolve, reject) => {
    const start = () => {
      running += 1;
      Promise.resolve().then(() => download(request)).then(resolve, reject).finally(() => {
        running -= 1;
        queue.shift()?.();
      });
    };

    if (running < 2) {
      start();
    } else {
      queue.push(start);
    }
  });
}

/**
 * Context переключается только синхронным commit после успешного prefs.write.
 * Подготовленная новая библиотека остаётся закрытой для заказов до этого момента.
 */
export function createStudioRuntime(options: StudioRuntimeOptions) {
  return new StudioRuntimeInstance(options);
}

class StudioRuntimeInstance {
  readonly admission = createAdmission(randomUUID());
  readonly options: StudioRuntimeOptions;
  context: StudioContext | null = null;
  private generation = 0;
  private readonly unavailableId = randomUUID();
  private unavailable: string | null = null;
  private historyTimer: unknown = null;
  private readonly balances = new Map<string, { at: number; value: unknown }>();
  private readonly download: ReturnType<typeof downloadPool>;
  private closing = false;

  constructor(options: StudioRuntimeOptions) {
    this.options = options;
    this.download = downloadPool(options.download ?? downloadToFile);
    this.admission.configure({ enabled: false });
  }

  current(context: StudioContext, generation: number): boolean {
    return this.context === context && generation === this.generation && this.options.enabled() &&
      !this.closing;
  }

  /**
   * Snapshot допускается только для включённого и подготовленного контекста.
   * Поколение позволяет отклонить ответ операции после смены библиотеки.
   */
  snapshot() {
    if (!this.options.enabled()) {
      throw new StudioHttpError(404, 'plugin_disabled', 'Плагин «3D» выключен.');
    }

    if (!this.context || this.unavailable) {
      throw new StudioHttpError(409, 'library_unavailable', 'Папка библиотеки недоступна.');
    }

    return { context: this.context, generation: this.generation };
  }

  /**
   * Папка должна быть абсолютной и не пересекаться с системными хранилищами.
   * Canonical путь проверяется ещё раз после ensure, чтобы symlink не дал новые права.
   */
  private directory(settings: StudioSettings): string {
    const candidate = settings.libraryDir || this.options.config.studio3dDir;

    if (!path.isAbsolute(candidate) || candidate.includes('\0') || /%(?:2e|2f|5c)/i.test(candidate)) {
      throw new StudioHttpError(409, 'invalid_library_dir', 'Укажите абсолютную папку библиотеки.');
    }

    const target = path.resolve(candidate);
    const protectedKeys = new RegExp(
      '(?:dataStateDir|mobileDir|stateDir|chatsDir|telegramDir|githubDir|profilesDir|credentialsDir)$',
    );
    const protectedDirs = Object.entries(this.options.config)
      .filter(([key, value]) => protectedKeys.test(key)
        && typeof value === 'string').map(([, value]) => path.resolve(String(value)));
    const intersects = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`)
      || b.startsWith(`${a}${path.sep}`);

    if (target === path.parse(target).root || target === os.homedir()
      || target === path.resolve(this.options.config.rootDir) || target.split(path.sep).includes('.git')
      || protectedDirs.some((directory) => intersects(target, directory))) {
      throw new StudioHttpError(409, 'invalid_library_dir', 'Эта папка занята системным хранилищем.');
    }

    return target;
  }

  /**
   * Канонический путь строится и для ещё не существующего потомка symlink.
   * Защищённые хранилища проверяются до mkdir, lock и записи marker библиотеки.
   */
  private async checkedDirectory(settings: StudioSettings): Promise<string> {
    const requested = this.directory(settings);

    /**
     * Ближайший существующий предок разрешается без создания новых каталогов.
     * Сегменты отсутствующего потомка сохраняются после раскрытия ссылок.
     */
    const canonical = async (candidate: string): Promise<string> => {
      let ancestor = path.resolve(candidate);
      const suffix: string[] = [];

      for (;;) {
        try {
          return path.join(await fs.realpath(ancestor), ...suffix);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
          
          suffix.unshift(path.basename(ancestor));
          ancestor = path.dirname(ancestor);
        }
      }
    };
    const target = await canonical(requested);
    const protectedKeys = new RegExp(
      '(?:dataStateDir|mobileDir|stateDir|chatsDir|telegramDir|githubDir|profilesDir|credentialsDir)$',
    );
    const protectedDirs = await Promise.all(Object.entries(this.options.config)
      .filter(([key, value]) => protectedKeys.test(key) && typeof value === 'string')
      .map(([, value]) => canonical(String(value))));
    const intersects = (directory: string) => target === directory
      || target.startsWith(`${directory}${path.sep}`) || directory.startsWith(`${target}${path.sep}`);

    this.directory({ ...settings, libraryDir: target });
    
    if (target === await canonical(os.homedir())
      || target === await canonical(this.options.config.rootDir) || protectedDirs.some(intersects)) {
      throw new StudioHttpError(409, 'invalid_library_dir', 'Эта папка занята системным хранилищем.');
    }
    
    return target;
  }

  /**
   * Новые ресурсы берутся до commit и освобождаются при любой ошибке подготовки.
   * Constructors providers/jobs/importer не обращаются к облаку до lifecycle.
   */
  private async prepareContext(settings: StudioSettings): Promise<StudioContext> {
    const requested = await this.checkedDirectory(settings);
    const library = createLibrary({
      dir: requested,
      ensureGitignore: requested.startsWith(this.options.config.rootDir + path.sep),
      now: this.options.now,
    });

    try {
      await library.ensure();
      this.directory({ ...settings, libraryDir: library.dir });

      const configured = typeof this.options.providers === 'function'
        ? await this.options.providers() : this.options.providers;
      const providers = configured ? [...configured.filter((provider) => provider.id !== 'local'),
        createLocalStudio()]
        : studioProviders({ adapters: await getProviderAdapters() });
      const intents = createIntents({ library });

      await intents.load();

      const jobs = createJobs({
        library,
        intents,
        providers,
        admission: this.admission,
        broadcast: this.options.broadcast,
        download: this.download,
        now: this.options.now,
      });
      const importer = this.newImporter(library, intents, providers, jobs);
      const files = createStudioFiles({
        library,
        reader: this.options.documentReader,
        now: this.options.now,
        enabled: () => this.options.enabled() && !this.unavailable && this.context?.library === library,
        projectRoots: () => this.projectRoots(),
      });

      return {
        library,
        intents,
        jobs,
        importer,
        files,
        providers
      };
    } catch (error) {
      await library.close();

      throw error;
    }
  }

  private newImporter(library: StudioContext['library'], intents: StudioContext['intents'],
    providers: Studio3dProvider[], jobs: StudioContext['jobs']) {
    return createImporter({
      library,
      intents,
      providers,
      roots: async () => [this.options.config.rootDir, ...await this.projectRoots()],
      enabled: () => this.options.enabled() && !this.unavailable && this.context?.library === library,
      download: this.download,
      now: this.options.now,
      broadcast: this.options.broadcast,
      observeUsage: (provider, captured, usages) => jobs.observeUsage(provider, captured, usages),
    });
  }

  /**
   * Корни проектов получаются из серверного реестра при каждом использовании.
   * Архивный проект и прежний путь не сохраняют права через старый viewer token.
   */
  async projectRoots(): Promise<string[]> {
    const projects = await this.options.projects?.()?.list() ?? [];

    return projects.filter((project) => !project.archived && !project.archivedAt)
      .flatMap((project) => project.repos.map((repo) => repo.dir));
  }

  /**
   * Prepare удерживает тот же admission lock, что run и последний POST. Caller
   * пишет prefs и завершает commit/rollback, пока никакой send не может пройти.
   */
  async prepareChange(change: { enabled?: boolean; values?: unknown }): Promise<StudioTransition> {
    let resolveReady!: (transition: StudioTransition) => void;
    let rejectReady!: (error: unknown) => void;
    let release!: () => void;
    const ready = new Promise<StudioTransition>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let old: StudioContext | null = null;
    let prepared: StudioContext | null = null;
    let enabled = false;
    let committed = false;
    let finished = false;
    const locked = this.admission.locked(async () => {
      try {
        const current = studioSettings(this.options.settings());
        const settings = change.values === undefined ? current
          : studioSettings({ ...current, ...change.values as Record<string, unknown> });

        enabled = change.enabled ?? this.options.enabled();
        old = this.context;

        const requested = this.directory(settings);
        const same = old && (requested === old.library.dir
          || await fs.realpath(requested).catch(() => '') === old.library.dir);

        if (old && !same && await old.jobs.busy()) {
          throw new StudioHttpError(409, 'library_busy', 'Сначала завершите задания и разберите unknown.');
        }

        if ((enabled || old) && !same) {
          prepared = await this.prepareContext(settings);
        } else {
          prepared = old;
        }

        resolveReady({
          commit: () => {
            if (finished) {
              return;
            }

            finished = true;
            committed = true;
            this.context = prepared;
            this.unavailable = null;
            this.generation += 1;
            this.balances.clear();
            old?.files.clear();
            this.admission.configure({ enabled,
              libraryId: prepared?.library.libraryId ?? this.unavailableId });
            release();
          },
          rollback: async () => {
            if (finished) {
              return;
            }

            finished = true;

            if (prepared && prepared !== old) {
              await prepared.jobs.stop();
              await prepared.importer.stop();
              await prepared.library.close();
            }

            release();
            await locked;
          },
          afterCommit: async () => {
            await locked;

            if (!committed) {
              return;
            }

            if (old && old !== prepared) {
              await old.jobs.stop();
              await old.importer.stop();
              await old.library.close();
            }

            this.stopHistory();

            if (enabled && prepared) {
              await prepared.importer.stop();
              prepared.importer = this.newImporter(prepared.library, prepared.intents,
                prepared.providers, prepared.jobs);
              await prepared.jobs.resume();
              this.startHistory(prepared);
            } else {
              await prepared?.importer.stop();
              prepared?.providers.forEach((provider) => provider.cancelReads?.());
            }
          },
        });
        await hold;
      } catch (error) {
        rejectReady(error);
      }
    });

    void locked.catch(rejectReady);

    return ready;
  }

  /**
   * onReady выключенного плагина не открывает диск. Недоступность configured root
   * видна в state, но не срывает весь Cockpit; mutations остаются закрыты.
   */
  async start(): Promise<void> {
    if (!this.options.enabled()) {
      return;
    }

    try {
      const transition = await this.prepareChange({ enabled: true });

      transition.commit();
      await transition.afterCommit();
    } catch {
      this.unavailable = 'Не удалось открыть и закрепить папку библиотеки.';
    }
  }

  /**
   * Первичный scan запускается один раз на библиотеку, затем только history.
   * Все фоновые отказы изолированы, refresh вручную доступен через API.
   */
  private startHistory(context: StudioContext): void {
    const generation = this.generation;
    
    if (studioSettings(this.options.settings()).autoImport) {
      void context.importer.scan({ automatic: true }).catch(() => {});
    }

    /**
     * History refresh не переживает смену контекста и повторяет таймер после ответа.
     * Ошибка чтения истории изолирована от worker и доступности остальных плагинов.
     */
    const refresh = async () => {
      if (!this.current(context, generation)) {
        return;
      }

      await context.importer.syncHistory({ autoImport: studioSettings(this.options.settings()).autoImport })
        .catch(() => {});
      await context.jobs.cleanup().catch(() => {});
      await context.library.cleanUploads(86_400_000).catch(() => {});

      if (this.current(context, generation)) {
        this.scheduleHistory(refresh, 15 * 60_000);
      }
    };

    this.scheduleHistory(refresh, 60_000);
  }

  /**
   * Собственный timer можно заменить изолированными часами offline-теста.
   * Production timer не удерживает процесс, но close обязательно его снимает.
   */
  private scheduleHistory(callback: () => Promise<void>, delay: number): void {
    if (this.options.setHistoryTimer) {
      this.historyTimer = this.options.setHistoryTimer(callback, delay);
    } else {
      const timer = setTimeout(callback, delay);

      timer.unref();
      this.historyTimer = timer;
    }
  }

  /**
   * Снимает только timer этого runtime при disable, смене настроек и close.
   * Инъецированные offline часы освобождаются через тот же lifecycle.
   */
  private stopHistory(): void {
    if (this.historyTimer !== null) {
      if (this.options.clearHistoryTimer) {
        this.options.clearHistoryTimer(this.historyTimer);
      } else {
        clearTimeout(this.historyTimer as ReturnType<typeof setTimeout>);
      }
      
      this.historyTimer = null;
    }
  }

  /**
   * Баланс кешируется по captured account ровно на минуту. Ответ другого аккаунта
   * после await не становится состоянием текущей карточки исполнителя.
   */
  async state(): Promise<Studio3dState> {
    const context = this.context;
    const generation = this.generation;
    const settings = studioSettings(this.options.settings());
    const now = (this.options.now ?? Date.now)();

    if (!context || this.unavailable) {
      return parseStudio3d.state({
        libraryId: this.unavailableId,
        library: {
          dir: settings.libraryDir || this.options.config.studio3dDir,
          ok: false,
          error: this.unavailable ?? 'Библиотека недоступна.',
          bytes: 0,
          freeBytes: null,
          lowDisk: false,
          modelBytes: 0,
          inputBytes: 0,
          temporaryBytes: 0
        },
        providers: [],
        active: 0,
        autoImport: settings.autoImport,
      });
    }

    let usage;
    let usageError: string | null = null;

    try {
      usage = await context.library.diskUsage();
    } catch {
      if (!this.current(context, generation)) {
        throw new StudioHttpError(409, 'stale_library', 'Контекст библиотеки изменился.');
      }

      try {
        await context.library.assertOwner();
      } catch {
        this.unavailable = 'Папка библиотеки изменилась или недоступна. '
          + 'Восстановите её или смените настройку.';
        this.admission.configure({ enabled: false });

        return this.state();
      }

      usageError = 'Не удалось подсчитать место на диске. Следующее обновление повторит подсчёт.';
      usage = {
        bytes: 0,
        modelBytes: 0,
        inputBytes: 0,
        temporaryBytes: 0
      };
    }

    const providers = [];

    for (const provider of context.providers) {
      const captured = provider.snapshot?.();
      const available = await provider.available();
      const key = `${provider.id}:${captured?.accountKey ?? 'local'}`;
      let balance = this.balances.get(key);

      if (available && provider.balance && (!balance || now - balance.at >= 60_000)) {
        const value = await provider.balance(captured).catch(() => null);

        balance = { at: now, value: captured && !provider.isCurrent?.(captured) ? null : value };
        this.balances.set(key, balance);
      }

      if (captured && !provider.isCurrent?.(captured)) {
        throw new StudioHttpError(409, 'account_changed', 'Доступ исполнителя изменился. Обновите раздел.');
      }

      providers.push({
        id: provider.id,
        name: provider.name,
        available,
        local: provider.local,
        unit: provider.unit,
        balance: available ? await context.jobs.balanceView(provider, captured,
          balance?.value as Balance | null ?? null) : null,
        billingUrl: captured?.billingUrl ?? null
      });
    }

    const disk = await (this.options.statfs ?? fs.statfs)(context.library.dir).catch(() => null);
    const freeBytes = disk ? Number(disk.bavail) * Number(disk.bsize) : null;
    const active = (await context.jobs.tasks()).filter((row) => ACTIVE_STATUSES.includes(row.status)).length;

    if (!this.current(context, generation)) {
      throw new StudioHttpError(409, 'stale_library', 'Контекст библиотеки изменился.');
    }

    return parseStudio3d.state({
      libraryId: context.library.libraryId,
      library: {
        dir: context.library.dir,
        ok: true,
        error: usageError,
        ...usage,
        freeBytes,
        lowDisk: freeBytes !== null && freeBytes < settings.lowDiskGb * 1024 ** 3
      },
      providers,
      active,
      autoImport: settings.autoImport,
    });
  }

  /**
   * onClose закрывает допуск до ожидания собственной работы и отменяет её чтения.
   * Owner lock освобождается после durable исходов, а не одновременно с записью worker.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.stopHistory();
    this.admission.configure({ enabled: false, closing: true });

    const context = this.context;

    if (context) {
      context.files.clear();
      await Promise.all([context.jobs.stop(), context.importer.stop()]);
      await context.library.close();
    }
  }
}

export type StudioRuntime = ReturnType<typeof createStudioRuntime>;
