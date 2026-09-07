import { defineStore } from 'pinia';
import { dockerApi, dockerErrorMessage } from '../shared/dockerApi';
import { parseDockerStatsMessage } from '../../../shared/dockerContracts';
import type { DockerPruneOptions } from '../shared/dockerApi';
import type {
  DockerActionResult,
  DockerContainer,
  DockerContainerAction,
  DockerHealth,
  DockerImage,
  DockerNetwork,
  DockerOverview,
  DockerProject,
  DockerProjectAction,
  DockerProjectActionResponse,
  DockerPruneResponse,
  DockerStatsMap,
  DockerStatsInput,
  DockerUsage,
  DockerVolume,
} from '../../../shared/dockerContracts';

interface DockerState {
  health: DockerHealth | null;
  containers: DockerContainer[];
  projects: DockerProject[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  counts: DockerOverview['counts'];
  usage: DockerUsage | null;
  stats: DockerStatsMap;
  loading: boolean;
  usageLoading: boolean;
  busyIds: string[];
  error: string;
  usageError: string;
}

interface DockerRuntime {
  WebSocket: typeof WebSocket | undefined;
  socket: WebSocket | null;
  generation: number;
  watched: string;
}

export type DockerProjectWithContainers = DockerProject & { items: DockerContainer[] };

type DockerActionFailure = Extract<DockerActionResult, { ok: false }>;

// Сокет статистики не должен попадать в state: Pinia делает состояние реактивным,
// а WebSocket реактивным быть не может и не хочет. Тот же приём, что в сторе SSH.
const runtimes = new WeakMap<object, DockerRuntime>();

/**
 * Хранит нереактивное соединение отдельно для каждого экземпляра стора.
 */
function runtimeOf(store: object): DockerRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = {
      WebSocket: globalThis.WebSocket,
      socket: null,
      generation: 0,
      watched: '',
    };
    runtimes.set(store, runtime);
  }

  return runtime;
}

export const useDockerStore = defineStore('docker', {
  state: (): DockerState => ({
    health: null,
    containers: [],
    projects: [],
    images: [],
    volumes: [],
    networks: [],
    counts: {
      containers: 0,
      running: 0,
      images: 0,
      volumes: 0,
      networks: 0,
    },
    usage: null,
    stats: {},
    loading: false,
    usageLoading: false,
    busyIds: [],
    error: '',
    usageError: '',
  }),

  getters: {
    // Занятость по compose-проектам — то, ради чего панель открывают чаще всего:
    // «что из моих стендов сейчас поднято и на каких портах».
    projectsWithContainers(state): DockerProjectWithContainers[] {
      const byId = new Map(state.containers.map((container) => [container.id, container]));

      return state.projects.map((project) => ({
        ...project,
        items: project.containers.map((id) => byId.get(id)).filter((item) => item !== undefined),
      }));
    },

    // Контейнеры без compose-проекта показываются отдельной группой, иначе они
    // просто исчезли бы из сгруппированного списка.
    looseContainers(state): DockerContainer[] {
      return state.containers.filter((container) => !container.compose);
    },

    isBusy(state) {
      return (id: string) => state.busyIds.includes(id);
    },
  },

  actions: {
    /**
     * Обновляет обзор только после полной проверки ответа.
     * Повреждённый ответ сохраняет прошлые списки и счётчики целиком.
     */
    async load(): Promise<void> {
      this.loading = true;
      this.error = '';

      try {
        const health = await dockerApi.health();

        this.health = health;

        if (!health.available) {
          this.containers = [];
          this.projects = [];
          this.images = [];
          this.volumes = [];
          this.networks = [];

          return;
        }

        const overview = await dockerApi.overview();

        this.containers = overview.containers;
        this.projects = overview.projects;
        this.images = overview.images;
        this.volumes = overview.volumes;
        this.networks = overview.networks;
        this.counts = overview.counts;
      } catch (error) {
        this.error = dockerErrorMessage(error, 'не удалось получить состояние Docker');
      } finally {
        this.loading = false;
      }
    },

    /**
     * Сводка занятого места считается демоном секундами, поэтому она грузится
     * отдельно от обзора и по умолчанию берётся из серверного кэша. `force` —
     * это кнопка «пересчитать», а не фоновое обновление.
     */
    async loadUsage({ force = false }: { force?: boolean } = {}): Promise<void> {
      this.usageLoading = true;
      this.usageError = '';

      try {
        this.usage = await dockerApi.usage(force);
      } catch (error) {
        this.usageError = dockerErrorMessage(error, 'не удалось посчитать занятое место');
      } finally {
        this.usageLoading = false;
      }
    },

    /** Пометка «занят» держится на id, чтобы кнопки конкретной карточки гасли точечно. */
    markBusy(id: string, busy: boolean): void {
      const next = new Set(this.busyIds);

      if (busy) {
        next.add(id);
      } else {
        next.delete(id);
      }

      this.busyIds = [...next];
    },

    /**
     * Выполняет действие только один раз, затем перечитывает состояние демона.
     * Блокировка строки держится до завершения обновления обзора.
     */
    async containerAction(id: string, action: DockerContainerAction): Promise<DockerActionResult> {
      this.markBusy(id, true);

      try {
        await dockerApi.containerAction(id, action);
        await this.load();

        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: dockerErrorMessage(error, 'не удалось выполнить действие'),
        };
      } finally {
        this.markBusy(id, false);
      }
    },

    /**
     * Возвращает частичные отказы проекта вместе с результатами контейнеров.
     * Блокировка группы снимается и после отказа общего запроса.
     */
    async projectAction(
      project: string,
      action: DockerProjectAction,
    ): Promise<DockerProjectActionResponse | DockerActionFailure> {
      this.markBusy(project, true);

      try {
        const result = await dockerApi.projectAction(project, action);

        await this.load();

        return result;
      } catch (error) {
        return {
          ok: false,
          message: dockerErrorMessage(error, 'не удалось выполнить действие проекта'),
        };
      } finally {
        this.markBusy(project, false);
      }
    },

    /**
     * Передаёт принудительное удаление и удаление томов отдельными флагами.
     * Оба разрешения по умолчанию выключены, даже если вызывающий опустил параметры.
     */
    async removeContainer(
      id: string,
      { force = false, volumes = false }: { force?: boolean; volumes?: boolean } = {},
    ): Promise<DockerActionResult> {
      return this.remove(id, `/api/docker/containers/${encodeURIComponent(id)}`
        + `?force=${force ? 1 : 0}&volumes=${volumes ? 1 : 0}`);
    },

    async removeImage(id: string, { force = false }: { force?: boolean } = {}): Promise<DockerActionResult> {
      return this.remove(id, `/api/docker/images/${encodeURIComponent(id)}?force=${force ? 1 : 0}`);
    },

    async removeVolume(name: string): Promise<DockerActionResult> {
      return this.remove(name, `/api/docker/volumes/${encodeURIComponent(name)}`);
    },

    async removeNetwork(id: string): Promise<DockerActionResult> {
      return this.remove(id, `/api/docker/networks/${encodeURIComponent(id)}`);
    },

    /**
     * После удаления обновляет список ресурсов и закэшированную сводку места.
     * Даже повреждённый ответ снимает блокировку и возвращает объяснение ошибки.
     */
    async remove(key: string, path: string): Promise<DockerActionResult> {
      this.markBusy(key, true);

      try {
        await dockerApi.remove(path);
        await Promise.all([this.load(), this.loadUsage({ force: false })]);

        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: dockerErrorMessage(error, 'не удалось удалить ресурс Docker'),
        };
      } finally {
        this.markBusy(key, false);
      }
    },

    /**
     * Пересчитывает место после уборки и сохраняет отчёт по каждой выбранной цели.
     * Ошибка отдельной цели остаётся частью отчёта, а не потерей всего результата.
     */
    async prune(options: DockerPruneOptions = {}): Promise<DockerPruneResponse | DockerActionFailure> {
      try {
        const result = await dockerApi.prune(options);

        await Promise.all([this.load(), this.loadUsage({ force: true })]);

        return result;
      } catch (error) {
        return {
          ok: false,
          message: dockerErrorMessage(error, 'не удалось выполнить уборку'),
        };
      }
    },

    /**
     * Живая статистика: одно соединение на панель, список наблюдаемых контейнеров
     * пересылается по мере того, как человек листает и фильтрует. Срез считает
     * сервер — вкладка только рисует.
     */
    watchStats(ids: string[] = [], { interval = 3 }: { interval?: number } = {}): void {
      const runtime = runtimeOf(this);
      const Socket = runtime.WebSocket;

      if (!Socket) {
        return;
      }

      const wanted = [...new Set(ids)].filter(Boolean);
      const key = wanted.join(',');

      if (runtime.socket && runtime.socket.readyState <= 1) {
        if (key === runtime.watched) {
          return;
        }

        runtime.watched = key;

        if (runtime.socket.readyState === 1) {
          const message: DockerStatsInput = {
            t: 'watch',
            ids: wanted,
          };

          runtime.socket.send(JSON.stringify(message));
        }

        return;
      }

      const own = ++runtime.generation;

      runtime.watched = key;

      const socket = new Socket(dockerApi.wsUrl(`/api/docker/stats?interval=${interval}`));

      runtime.socket = socket;
      socket.onopen = () => {
        if (runtime.generation !== own) {
          return;
        }

        const message: DockerStatsInput = {
          t: 'watch',
          ids: wanted,
        };

        socket.send(JSON.stringify(message));
      };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (runtime.generation !== own || typeof event.data !== 'string') {
          return;
        }

        try {
          const value: unknown = JSON.parse(event.data);
          const message = parseDockerStatsMessage(value);

          if (message.t === 'stats') {
            this.stats = message.items;
          }
        } catch {
          // Неполный кадр не заменяет последний корректный срез статистики.
        }
      };
      socket.onclose = () => {
        if (runtime.socket === socket) {
          runtime.socket = null;
        }
      };
    },

    /**
     * Закрывает поток и очищает последний показанный срез.
     * Новое поколение делает запоздалые сообщения старого соединения недействительными.
     */
    stopStats(): void {
      const runtime = runtimeOf(this);

      runtime.generation += 1;
      runtime.watched = '';

      try {
        runtime.socket?.close();
      } catch {
        // Соединение могло уже закрыться на стороне демона.
      }

      runtime.socket = null;
      this.stats = {};
    },
  },
});
