import type { TrackerCatalog } from '../../../shared/trackers/contracts.ts';
import { useTrackersStore } from './trackers.ts';
import { useGrigdeskTasksStore } from './grigdeskTasks.ts';
import { useTaskFavoritesStore } from './taskFavorites.ts';
// Кеш доски B24. При переходе в раздел данные показываются мгновенно из кеша,
// обновление идёт в фоне + периодический поллинг (не тормозит навигацию).
import { useAuthStore } from './auth.ts';
import { useShellStore } from './shell.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';

import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { measureChatPerformance } from '../shared/chatPerformance.ts';
import { boardActivity, boardTaskIds } from '../shared/boardActivity.ts';
import { useTaskSeenStore } from './taskSeen.ts';
import { errorMessage } from '../../../shared/lib/errors.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { decodeBoardDashboard, isBoardDashboard } from '../shared/boardContracts.ts';
import type { BoardDashboard } from '../shared/boardContracts.ts';

const mirrors = new WeakMap<object, () => void>();
const reads = new WeakMap<object, AbortController>();
const loadingJobs = new WeakMap<object, Promise<number | undefined>>();
const forcedJobs = new WeakMap<object, Promise<number | undefined>>();

/**
 * Владелец снимка проверяется по локальному API, независимо от доступности портала.
 * Ни секреты, ни ключ источника не передаются в диагностику или наружный запрос.
 */
async function readBoardSource(
  signal?: AbortSignal, receive?: (catalog: TrackerCatalog) => void,
): Promise<string> {
  const raw = await api.get('/api/trackers', {
    signal,
    timeoutMs: 5000,
    retry: false,
  });

  if (!isRecord(raw) || (raw.externalId !== null && typeof raw.externalId !== 'string')
    || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) {
    throw new Error(localeTranslator(uiLocalePort)('core.invalidBoardSnapshot'));
  }

  receive?.(raw as unknown as TrackerCatalog);

  return JSON.stringify([
    useAuthStore().clientScope,
    useShellStore().profile?.id ?? '',
    ...(Array.isArray(raw.enabledIds) ? [
      (raw.drivers as TrackerCatalog['drivers']).map((driver) => [driver.id, driver.dataRevision]),
    ] : [raw.externalId, raw.revision]),
  ]);
}


export const useBoardStore = defineStore('board', {
  state: () => ({
    data: null as BoardDashboard | null,
    branches: {} as Record<string, {
      snapshot: BoardDashboard;
      dataRevision?: number;
      error?: string;
    }>,
    branchEpochs: {} as Record<string, number>,
    suspendedIds: [] as string[],
    loading: false,
    error: null as string | null,
    loadedAt: 0,
    readAt: 0,
    sourceKey: '',
    sourceEpoch: 0,
    sourceSuspended: false,
    _polling: false,
    _timer: null as ReturnType<typeof setInterval> | null,
  }),
  getters: {
    fresh: (s) => Date.now() - s.loadedAt < 20000,
    // Отметки просмотра лежат на сервере (как избранное), поэтому у окна своей копии нет:
    // открытая на компьютере задача перестаёт быть новой и на планшете.
    activity: (s) => {
      const seen = useTaskSeenStore();

      const activities = s.data?.multiSource ? Object.values(s.branches).map((branch) => {
        const marks = useTaskSeenStore().forSource(branch.snapshot.source);

        return boardActivity(branch.snapshot, marks.taskIds, { ready: marks.ready });
      }) : [boardActivity(s.data, seen.taskIds, { ready: seen.ready })];
      const external = {
        activeTimerCount: activities.reduce((total, activity) => total + activity.activeTimerCount, 0),
        unseenCount: activities.reduce((total, activity) => total + activity.unseenCount, 0),
        unseenTaskIds: activities.flatMap((activity) => activity.unseenTaskIds),
      };
      const own = useGrigdeskTasksStore();
      const internal = boardActivity({ tasks: own.tasks }, seen.own.taskIds, { ready: seen.own.ready });

      return {
        ...external,
        unseenCount: external.unseenCount + internal.unseenCount,
        unseenTaskIds: [...external.unseenTaskIds, ...internal.unseenTaskIds]
      };
    },
  },
  actions: {
    /**
     * Смена трекера снимает чтения и снимки предыдущего поколения.
     * Общая очистка также отсекает ожидающие принудительные обновления.
     */
    invalidate() {
      this.clearSource();
    },
    /**
     * Принудительный refresh во время чтения не теряется и объединяется до своего старта.
     * Следующая мутация во время уже начатого refresh получает новое отложенное чтение.
     */
    load(force = false): Promise<number | undefined> {
      if (this.sourceSuspended) {
        return Promise.resolve(undefined);
      }

      const active = loadingJobs.get(this);

      if (active) {
        if (!force) {
          return Promise.resolve(undefined);
        }

        const waiting = forcedJobs.get(this);

        if (waiting) {
          return waiting;
        }

        const epoch = this.sourceEpoch;
        const queued: Promise<number | undefined> = active.catch(() => undefined).then(() => {
          if (forcedJobs.get(this) === queued) {
            forcedJobs.delete(this);
          }
          if (this.sourceSuspended || this.sourceEpoch !== epoch) {
            return;
          }

          return this.load(true);
        });

        forcedJobs.set(this, queued);

        return queued;
      }

      const work = this._loadSnapshot(force);

      loadingJobs.set(this, work);
      void work.finally(() => {
        if (loadingJobs.get(this) === work) {
          loadingJobs.delete(this);
        }
      }).catch(() => undefined);

      return work;
    },
    /**
     * Старые данные показываются только после проверки владельца, в том числе у зеркала.
     * Порядок readAt защищает новый relay и от позднего ответа, и от ошибки старого GET.
     */
    async _loadSnapshot(force: boolean): Promise<number | undefined> {
      const epoch = this.sourceEpoch;
      const controller = new AbortController();
      let readAt = this.readAt;

      reads.set(this, controller);
      this.loading = true;

      try {
        let catalog: TrackerCatalog | undefined;
        const source = await readBoardSource(controller.signal, (value) => {
          catalog = value;
        });

        if (catalog?.enabledIds && this.sourceKey && JSON.stringify(JSON.parse(this.sourceKey).slice(0, 2))
          !== JSON.stringify(JSON.parse(source).slice(0, 2))) {
          this.clearSource();

          return this.load(force);
        }
        if (catalog?.enabledIds) {
          return await this.loadMulti(catalog, source, force, controller, epoch);
        }

        if (controller.signal.aborted || epoch !== this.sourceEpoch || this.sourceSuspended) {
          return;
        }
        if (this.sourceKey && this.sourceKey !== source) {
          this.clearSource();

          return this.load(force);
        }

        this.sourceKey = source;

        const mirror = mirrors.get(this);

        if (mirror && !force) {
          mirror();

          return;
        }
        if (this.data && !force && this.fresh) {
          return;
        }

        readAt = Math.max(Date.now(), this.readAt + 1);

        const raw = await api.get('/api/tracker/dashboard', {
          signal: controller.signal,
          retry: false,
        });
        const confirmed = await readBoardSource(controller.signal);

        if (controller.signal.aborted || epoch !== this.sourceEpoch || this.sourceSuspended) {
          return;
        }
        if (source !== confirmed) {
          this.clearSource();
          this.error = localeTranslator(uiLocalePort)('core.boardSourceChanged');

          return;
        }

        const accepted = measureChatPerformance('board.apply', () => {
          const dashboard = decodeBoardDashboard(raw);

          if (controller.signal.aborted || readAt <= this.readAt) {
            return false;
          }

          this.data = dashboard;
          this.loadedAt = Date.now();
          this.readAt = readAt;
          this.error = null;

          return true;
        });

        if (!accepted) {
          return;
        }

        await this.markBaselineSeen();

        return readAt;
      } catch (error) {
        if (!controller.signal.aborted && epoch === this.sourceEpoch
          && !this.sourceSuspended && readAt >= this.readAt) {
          try {
            const confirmed = await readBoardSource(controller.signal);

            if (controller.signal.aborted || epoch !== this.sourceEpoch
              || this.sourceSuspended || readAt < this.readAt) {
              return;
            }
            if (confirmed !== this.sourceKey) {
              this.clearSource();
              this.sourceKey = confirmed;
            }
          } catch {
            if (controller.signal.aborted || epoch !== this.sourceEpoch
              || this.sourceSuspended || readAt < this.readAt) {
              return;
            }

            this.clearSource();
          }

          this.error = errorMessage(error, 'Доска недоступна');
        }
      } finally {
        if (reads.get(this) === controller) {
          reads.delete(this);
          this.loading = false;
        }
      }
    },
    /**
     * Публикует каждый источник сразу после его ответа, сохраняя последний успешный снимок.
     * Поколение владельца и локальная эпоха не дают вернуть прежний аккаунт после записи.
     */
    async loadMulti(
      catalog: TrackerCatalog, source: string, force: boolean, controller: AbortController, epoch: number,
    ): Promise<number | undefined> {
      this.sourceKey = source;

      for (const [id, branch] of Object.entries(this.branches)) {
        const descriptor = catalog.drivers.find((entry) => entry.id === id);

        if (descriptor && descriptor.dataRevision !== branch.dataRevision) {
          this.dropDriver(id);
        }
      }

      const mirror = mirrors.get(this);

      if (mirror && !force) {
        mirror();

        return;
      }

      this.mergeBranches(catalog);

      await Promise.all((catalog.enabledIds ?? []).map(async (id) => {
        if (this.suspendedIds.includes(id)) {
          return;
        }

        const token = this.branchEpochs[id] ?? 0;
        const descriptor = catalog.drivers.find((entry) => entry.id === id);

        try {
          const raw = await api.get(`/api/tracker/${encodeURIComponent(id)}/dashboard`, {
            signal: controller.signal, retry: false,
          });
          const snapshot = decodeBoardDashboard(raw);
          const context = await api.get(`/api/tracker/${encodeURIComponent(id)}/context`, {
            signal: controller.signal, retry: false,
          }) as { source: string; generation: number };

          if (controller.signal.aborted || epoch !== this.sourceEpoch
            || token !== (this.branchEpochs[id] ?? 0) || this.suspendedIds.includes(id)
            || context.source !== snapshot.source || context.generation !== snapshot.generation) {
            return;
          }

          this.branches[id] = { snapshot, dataRevision: descriptor?.dataRevision };
          this.mergeBranches(catalog);

          if (snapshot.source) {
            void useTaskFavoritesStore().forSource(snapshot.source).load();

            const seen = useTaskSeenStore().forSource(snapshot.source);

            await seen.load();

            if (seen.loaded && !seen.initialized && Array.isArray(snapshot.tasks)) {
              await seen.markSeen(boardTaskIds(snapshot.tasks), { baseline: true });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted && token === (this.branchEpochs[id] ?? 0)) {
            const branch = this.branches[id];

            if (branch) {
              branch.error = errorMessage(error, 'Доска недоступна');
            }
          }
        }
      }));

      await useTrackersStore().load(true);

      return this.readAt;
    },
    /**
     * Метрики принадлежат дефолтной доске; списки ролей объединяются без склейки номеров.
     * Выключенный пакет остаётся в памяти до смены владельца или выхода из сессии.
     */
    mergeBranches(catalog: TrackerCatalog) {
      const ids = [...new Set([...Object.keys(this.branches), ...(catalog.enabledIds ?? [])])];
      const primary = this.branches[catalog.default ?? catalog.externalId ?? '']?.snapshot;
      const data: BoardDashboard = {
        ...primary,
        multiSource: true,
        driverSnapshots: { ...this.branches },
      };

      for (const role of ['tasks', 'toReview', 'created', 'accomplice', 'auditor'] as const) {
        data[role] = ids.flatMap((id) => (this.branches[id]?.snapshot[role] ?? []).map((task) => ({
          ...task,
          source: this.branches[id]!.snapshot.source,
          driverId: id,
        })));
      }

      this.data = data;
      this.readAt = Math.max(Date.now(), this.readAt + 1);
      this.loadedAt = Date.now();
      this.error = null;
    },
    /**
     * Удаляет только данные затронутого подключения перед сменой реквизитов.
     * Остальные источники и их личные отметки сохраняют свои эпохи.
     */
    dropDriver(id: string) {
      const source = this.branches[id]?.snapshot.source;

      this.branchEpochs[id] = (this.branchEpochs[id] ?? 0) + 1;
      delete this.branches[id];

      if (source) {
        useTaskFavoritesStore().forSource(source).clear();
        useTaskSeenStore().forSource(source).clear();
      }
    },
    /**
     * Очистка отсекает поздний HTTP и ожидающие refresh прежнего источника.
     * Пауза включается только владельцем незавершённой записи credentials.
     */
    clearSource(suspended = false) {
      useTaskFavoritesStore().clear({ source: 'tracker' });
      useTaskSeenStore().clear({ source: 'tracker' });
      this.sourceEpoch += 1;
      reads.get(this)?.abort();
      reads.delete(this);
      loadingJobs.delete(this);
      forcedJobs.delete(this);
      this.branches = {};
      this.suspendedIds = [];
      this.data = null;
      this.loadedAt = 0;
      this.readAt = 0;
      this.sourceKey = '';
      this.sourceSuspended = suspended;
      this.error = null;
      this.loading = false;
    },
    /**
     * Начало смены credentials закрывает восстановление снимка до исхода POST.
     * Токен является эпохой этого источника и не разблокирует более новую запись.
     */
    beginSourceChange(settings?: Record<string, Record<string, unknown>>): number {
      const catalog = useTrackersStore().catalog;

      if (catalog?.enabledIds) {
        this.suspendedIds = Object.keys(settings ?? {}).filter((id) =>
          Object.keys(settings![id] ?? {}).length > 0);

        for (const id of this.suspendedIds) {
          this.dropDriver(id);
        }

        this.mergeBranches(catalog);

        return this.sourceEpoch;
      }

      this.clearSource(true);

      return this.sourceEpoch;
    },
    /**
     * Любой исход снимает только собственную паузу и заново проверяет локальные настройки.
     * Неизвестный результат не разрешает повтор POST или восстановление старого снимка.
     */
    finishSourceChange(token: number): Promise<number | undefined> {
      if (token === this.sourceEpoch && this.suspendedIds.length) {
        this.suspendedIds = [];

        return this.load(true);
      }

      if (token !== this.sourceEpoch || !this.sourceSuspended) {
        return Promise.resolve(undefined);
      }

      this.clearSource();

      return this.load(true);
    },
    /**
     * Окно карточки регистрирует запрос снимка у главного окна; null возвращает обычное чтение.
     * Функция хранится в WeakMap, а не в сериализуемом состоянии Pinia.
     */
    setMirror(request: (() => void) | null) {
      if (request) {
        mirrors.set(this, request);
      }
      else {
        mirrors.delete(this);
      }
    },
    /**
     * Межоконный снимок допускается только от уже проверенного источника этого документа.
     * Поздний снимок A не восстанавливает данные после перехода на B даже с новым readAt.
     */
    applySnapshot(data: unknown, readAt: number, sourceKey?: string) {
      const key = sourceKey ?? this.sourceKey;

      if (this.sourceSuspended || !this.sourceKey || key !== this.sourceKey || !isBoardDashboard(data)
        || !Number.isFinite(readAt) || readAt <= this.readAt) {
        return;
      }

      this.data = data;
      this.branches = data.driverSnapshots ?? {};
      this.readAt = readAt;
      this.loadedAt = Date.now();
      this.error = null;
    },
    /**
     * Первая загрузка объявляет прежние задачи базовым списком владельца.
     * Пока базовая линия неизвестна, давние задачи не объявляются новыми.
     */
    async markBaselineSeen() {
      const seen = useTaskSeenStore();

      await seen.load();

      if (!seen.loaded || seen.initialized) {
        return;
      }
      if (!Array.isArray(this.data?.tasks)) {
        return;
      }

      await seen.markSeen(boardTaskIds(this.data.tasks), { baseline: true });
    },
    /**
     * Фоновый опрос по-прежнему запускается один раз для экземпляра доски.
     * Таймер остаётся в прежнем state, чтобы не менять контракт его очистки.
     */
    startPolling(ms = 45000) {
      if (this._polling) {
        return;
      }

      this._polling = true;
      this.load();
      this._timer = setInterval(() => this.load(true), ms);

      const timer: unknown = this._timer;

      if (isRecord(timer) && typeof timer.unref === 'function') {
        timer.unref();
      }
    },
    /**
     * Потеря сессии снимает и таймер, и ожидание текущего чтения в общей очереди.
     * Отменённый запрос не обновляет доску и не оставляет повтор после остановки.
     */
    stopPolling() {
      this.sourceEpoch += 1;
      forcedJobs.delete(this);
      reads.get(this)?.abort();

      if (this._timer) {
        clearInterval(this._timer);
      }

      this._timer = null;
      this._polling = false;
    },
  },
});
