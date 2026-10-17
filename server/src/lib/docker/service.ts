// Сервис плагина «Докер»: обзор хоста, действия над контейнерами и очистка места.
//
// Разделение обязанностей: client.ts знает протокол демона, inventory.ts — форму
// данных, а здесь живёт политика. Политика — это ответ на два вопроса: «что вообще
// разрешено настройками плагина» и «что считается опасным». Опасное (снос томов,
// массовая очистка образов) человек подтверждает в панели, а сервер дополнительно
// держит собственный предохранитель: подтверждение в браузере не должно быть
// единственной преградой между случайным кликом и чужими данными.
import { createDockerClient, DockerError } from './client.ts';
import type { DockerClient } from './client.ts';
import type {
  DockerContainerAction,
  DockerHealth,
  DockerOkResponse,
  DockerProjectAction,
  DockerProjectActionResponse,
  DockerPruneItem,
  DockerPruneReport,
  DockerPruneResponse,
  DockerPruneTarget,
  DockerUsageSummary,
} from '../../../../shared/plugins/docker/dockerContracts.ts';
import {
  decodeEngineContainers,
  decodeEngineDiskUsage,
  decodeEngineExecId,
  decodeEngineImages,
  decodeEngineInspect,
  decodeEngineNetworks,
  decodeEnginePrune,
  decodeEngineStats,
  decodeEngineVersion,
  decodeEngineVolumes,
} from './dockerEngineDecoders.ts';
import {
  buildOverview,
  buildUsageSnapshot,
  computeStats,
  normalizeContainers,
  normalizeImages,
  normalizeNetworks,
  normalizeVolumes,
  summarizeDiskUsage,
} from './inventory.ts';

export { computeStats } from './inventory.ts';

export interface DockerSettings {
  allowVolumeRemoval?: boolean;
  allowImagePruneAll?: boolean;
  allowExec?: boolean;
  logTailLines?: number;
}

interface ServiceOptions {
  client?: DockerClient;
  settings?: () => DockerSettings;
}

interface StreamHandle {
  abort(): void;
}

interface UsageCache {
  at: number;
  value: DockerUsageSummary;
}

interface RemoveOptions {
  force?: boolean;
  volumes?: boolean;
}

interface PruneOptions {
  targets?: readonly unknown[];
  allImages?: boolean;
}

interface LogOptions {
  tail?: number | string | null;
  follow?: boolean;
  timestamps?: boolean;
}

// Полный расчёт занятого места демон делает секундами (на живой машине — 2.6 с),
// поэтому обзор его не ждёт: сводка приезжает отдельным запросом и живёт в кэше.
const USAGE_TTL_MS = 60_000;

// Срок мягкой остановки контейнера: 10 секунд — умолчание самого docker.
const STOP_TIMEOUT_SECONDS = 10;

const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart', 'kill', 'pause', 'unpause']);
export const PRUNE_TARGETS: readonly DockerPruneTarget[] = [
  'containers',
  'images',
  'volumes',
  'networks',
  'buildCache',
];

function fail(message: string, status = 400, code = 'docker_error'): never {
  throw new DockerError(message, status, code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'ошибка Docker';
}

function containerActionAllowed(action: string): action is DockerContainerAction {
  return CONTAINER_ACTIONS.has(action);
}

function projectActionAllowed(action: string): action is DockerProjectAction {
  return ['start', 'stop', 'restart'].includes(action);
}

/**
 * Сервис держит открытые потоки (логи, статистика, терминалы) и обязан уметь
 * закрыть их разом: выключенный плагин не должен продолжать говорить с демоном
 * через уже открытые каналы.
 */
export function createDockerService({
  client = createDockerClient(),
  settings = () => ({}),
}: ServiceOptions = {}) {
  const streams = new Set<StreamHandle>();
  let usageCache: UsageCache | null = null;

  function track(handle: StreamHandle) {
    streams.add(handle);

    return () => streams.delete(handle);
  }

  /**
   * Доступность демона: панель отличает отсутствие Docker от выключенного плагина.
   */
  async function health(): Promise<DockerHealth> {
    try {
      const version = decodeEngineVersion(await client.get('/version'));

      return {
        available: true,
        version: version.Version || '',
        apiVersion: version.ApiVersion || '',
        socketPath: client.socketPath,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof DockerError ? error.code : 'docker_error',
        message: errorMessage(error),
        socketPath: client.socketPath,
      };
    }
  }

  /**
   * Обзор хоста одним запросом панели. Сюда намеренно не входит `/system/df`:
   * он считает размеры слоёв и на большом хосте держит ответ секундами, а обзор
   * открывают, чтобы быстро увидеть «что поднято и на каком порту».
   */
  async function overview() {
    const [rawContainers, rawImages, rawVolumes, rawNetworks] = await Promise.all([
      client.get('/containers/json', { all: true }),
      client.get('/images/json'),
      client.get('/volumes'),
      client.get('/networks'),
    ]);
    const containers = normalizeContainers(decodeEngineContainers(rawContainers));
    const images = normalizeImages(decodeEngineImages(rawImages), containers);
    const volumes = normalizeVolumes(decodeEngineVolumes(rawVolumes), { containers });
    const networks = normalizeNetworks(decodeEngineNetworks(rawNetworks), containers);

    return buildOverview(containers, images, volumes, networks);
  }

  /**
   * Занятое место и что из него вернётся. Кэш здесь не оптимизация, а условие
   * годного интерфейса: без него любое обновление панели упиралось бы в секунды
   * расчёта. Кнопка «пересчитать» проходит мимо кэша.
   */
  async function usage({ force = false }: { force?: boolean } = {}) {
    if (!force && usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
      return buildUsageSnapshot(usageCache.value, usageCache.at, true);
    }
    const [rawDf, rawContainers, rawImages, rawVolumes, rawNetworks] = await Promise.all([
      client.get('/system/df'),
      client.get('/containers/json', { all: true }),
      client.get('/images/json'),
      client.get('/volumes'),
      client.get('/networks'),
    ]);
    const containers = normalizeContainers(decodeEngineContainers(rawContainers));
    const images = normalizeImages(decodeEngineImages(rawImages), containers);
    const df = decodeEngineDiskUsage(rawDf);
    const volumes = normalizeVolumes(decodeEngineVolumes(rawVolumes), {
      containers,
      usage: df?.Volumes || [],
    });
    const networks = normalizeNetworks(decodeEngineNetworks(rawNetworks), containers);
    const value = summarizeDiskUsage({
      df,
      containers,
      images,
      volumes,
      networks,
    });
    usageCache = {
      at: Date.now(),
      value,
    };
    return buildUsageSnapshot(value, usageCache.at, false);
  }

  /** Кэш сводки перестаёт быть правдой после любой уборки — сбрасываем явно. */
  function invalidateUsage() {
    usageCache = null;
  }

  /**
   * Карточка контейнера. Переменные окружения сюда не попадают сознательно: в них
   * живут пароли БД и токены, а панель — обычная страница в браузере, которую
   * открывают с планшета и показывают коллеге. Кому нужен env, у того есть терминал.
   */
  async function inspect(id: string) {
    const raw = decodeEngineInspect(await client.get(`/containers/${encodeURIComponent(id)}/json`));

    return {
      id: raw.Id,
      name: String(raw.Name || '').replace(/^\//u, ''),
      image: raw.Config?.Image || '',
      tty: raw.Config?.Tty === true,
      command: [raw.Path, ...(raw.Args || [])].filter(Boolean).join(' '),
      workingDir: raw.Config?.WorkingDir || '',
      user: raw.Config?.User || '',
      createdAt: raw.Created || null,
      startedAt: raw.State?.StartedAt || null,
      finishedAt: raw.State?.FinishedAt || null,
      state: raw.State?.Status || '',
      exitCode: typeof raw.State.ExitCode === 'number' ? raw.State.ExitCode : null,
      restartCount: Number(raw.RestartCount) || 0,
      restartPolicy: raw.HostConfig?.RestartPolicy?.Name || '',
      health: raw.State?.Health?.Status || '',
      labels: raw.Config?.Labels || {},
      mounts: (raw.Mounts || []).map((mount) => ({
        type: mount.Type || '',
        name: mount.Name || '',
        source: mount.Source || '',
        destination: mount.Destination || '',
        rw: mount.RW !== false,
      })),
      networks: Object.entries(raw.NetworkSettings?.Networks || {}).map(([name, net]) => ({
        name,
        ip: net.IPAddress || '',
        gateway: net.Gateway || '',
      })),
    };
  }

  async function containerAction(
    id: string,
    action: string,
  ): Promise<{
    ok: true;
    action: DockerContainerAction;
  }> {
    if (!containerActionAllowed(action)) {
      fail(`действие «${action}» не поддерживается`, 400, 'bad_action');
    }

    const query = ['stop', 'restart'].includes(action) ? { t: STOP_TIMEOUT_SECONDS } : undefined;
    await client.post(`/containers/${encodeURIComponent(id)}/${action}`, { query });
    invalidateUsage();

    return {
      ok: true,
      action,
    };
  }

  /**
   * Compose-проект как единица: те же действия, но сразу по всей группе. Порядок
   * важен — останавливаем от последнего к первому, поднимаем в прямом, чтобы
   * зависимости compose (база раньше приложения) соблюдались хотя бы приблизительно.
   */
  async function projectAction(project: string, action: string): Promise<DockerProjectActionResponse> {
    if (!projectActionAllowed(action)) {
      fail(`действие «${action}» не поддерживается для проекта`, 400, 'bad_action');
    }
    const containers = normalizeContainers(decodeEngineContainers(await client.get('/containers/json', {
      all: true,
      filters: { label: [`com.docker.compose.project=${project}`] },
    })));
    if (!containers.length) {
      fail('проект не найден', 404, 'not_found');
    }
    const ordered = action === 'start' ? [...containers].reverse() : containers;
    const results: DockerProjectActionResponse['results'] = [];
    for (const container of ordered) {
      try {
        await containerAction(container.id, action);
        results.push({
          id: container.id,
          name: container.name,
          ok: true,
        });
      } catch (error) {
        results.push({
          id: container.id,
          name: container.name,
          ok: false,
          message: errorMessage(error),
        });
      }
    }
    invalidateUsage();

    return {
      ok: results.every((item) => item.ok),
      project,
      action,
      results,
    };
  }

  async function removeContainer(
    id: string,
    { force = false, volumes: withVolumes = false }: RemoveOptions = {},
  ): Promise<DockerOkResponse> {
    if (withVolumes && settings().allowVolumeRemoval !== true) {
      fail('удаление томов запрещено настройками плагина', 403, 'volumes_forbidden');
    }
    await client.del(`/containers/${encodeURIComponent(id)}`, {
      force,
      v: withVolumes,
    });
    invalidateUsage();

    return { ok: true };
  }

  async function removeImage(
    id: string,
    { force = false }: RemoveOptions = {},
  ): Promise<DockerOkResponse> {
    await client.del(`/images/${encodeURIComponent(id)}`, { force });
    invalidateUsage();

    return { ok: true };
  }

  async function removeVolume(
    name: string,
    { force = false }: RemoveOptions = {},
  ): Promise<DockerOkResponse> {
    if (settings().allowVolumeRemoval !== true) {
      fail('удаление томов запрещено настройками плагина', 403, 'volumes_forbidden');
    }
    await client.del(`/volumes/${encodeURIComponent(name)}`, { force });
    invalidateUsage();

    return { ok: true };
  }

  async function removeNetwork(id: string): Promise<DockerOkResponse> {
    await client.del(`/networks/${encodeURIComponent(id)}`);
    invalidateUsage();

    return { ok: true };
  }

  /**
   * Очистка. Два предохранителя сверх подтверждения в панели: тома убираются только
   * при явно разрешённом удалении томов, а образы по умолчанию чистятся ТОЛЬКО
   * висячие — «все неиспользуемые» на этой машине означает десятки гигабайт и часы
   * пересборки, и такое решение должно быть отдельно включённым, а не побочным
   * эффектом кнопки уборки.
   */
  async function prune({ targets = [], allImages = false }: PruneOptions = {}): Promise<DockerPruneResponse> {
    const wanted = PRUNE_TARGETS.filter((target) => targets.includes(target));
    if (!wanted.length) {
      fail('не выбрано, что чистить', 400, 'nothing_to_prune');
    }
    const options = settings();
    if (wanted.includes('volumes') && options.allowVolumeRemoval !== true) {
      fail('очистка томов запрещена настройками плагина', 403, 'volumes_forbidden');
    }
    const removeAllImages = allImages && options.allowImagePruneAll === true;
    if (allImages && !removeAllImages) {
      fail('очистка всех неиспользуемых образов запрещена настройками плагина', 403, 'images_all_forbidden');
    }

    const report: DockerPruneReport = {};
    for (const target of wanted) {
      report[target] = await pruneOne(target, { removeAllImages });
    }
    invalidateUsage();

    return {
      ok: true,
      report,
    };
  }

  /**
   * Одна цель уборки. Отказ по одной не отменяет остальные: демон часто не отдаёт
   * занятый том или образ под работающим контейнером, и это нормальный исход,
   * о котором человеку сообщают строкой в отчёте, а не общей ошибкой на всё.
   */
  async function pruneOne(
    target: DockerPruneTarget,
    { removeAllImages }: { removeAllImages: boolean },
  ): Promise<DockerPruneItem> {
    try {
      if (target === 'containers') {
        const result = await client.post('/containers/prune');
        return decodeEnginePrune(result, 'ContainersDeleted');
      }
      if (target === 'images') {
        const result = await client.post('/images/prune', {
          query: { filters: { dangling: [removeAllImages ? 'false' : 'true'] } },
        });
        return decodeEnginePrune(result, 'ImagesDeleted');
      }
      if (target === 'volumes') {
        const result = await client.post('/volumes/prune');
        return decodeEnginePrune(result, 'VolumesDeleted');
      }
      if (target === 'networks') {
        const result = await client.post('/networks/prune');
        return decodeEnginePrune(result, 'NetworksDeleted', false);
      }
      const result = await client.post('/build/prune', { query: { all: removeAllImages } });
      return decodeEnginePrune(result, 'CachesDeleted');
    } catch (error) {
      return {
        removed: 0,
        freed: 0,
        error: errorMessage(error),
      };
    }
  }

  /**
   * Поток логов. Контейнер с TTY отдаёт сырые байты, без TTY — кадры с 8-байтовым
   * заголовком; разбор кадров живёт в client.ts, а знание про TTY берётся из inspect.
   */
  async function logStream(
    id: string,
    { tail = null, follow = true, timestamps = false }: LogOptions = {},
  ) {
    const info = await inspect(id);
    const limit = Number(tail) > 0 ? Number(tail) : Number(settings().logTailLines) || 500;
    const handle = await client.stream('GET', `/containers/${encodeURIComponent(id)}/logs`, {
      query: {
        stdout: 1,
        stderr: 1,
        follow: follow ? 1 : 0,
        tail: limit,
        timestamps: timestamps ? 1 : 0,
      },
    });
    const untrack = track(handle);

    return {
      res: handle.res,
      tty: info.tty,
      abort: () => {
        untrack();
        handle.abort();
      },
    };
  }

  /**
   * Мгновенный срез статистики по контейнеру. Именно срез, а не поток демона:
   * держать по потоку на каждый из полусотни контейнеров — верный способ нагрузить
   * машину сильнее, чем всё, за чем сюда пришли смотреть.
   */
  async function statsOnce(id: string) {
    const raw = await client.get(`/containers/${encodeURIComponent(id)}/stats`, {
      stream: false,
      'one-shot': true,
    });
    return computeStats(decodeEngineStats(raw));
  }

  /**
   * Терминал в контейнере. Оболочка выбирается на месте: в alpine нет bash,
   * в slim-образах может не быть и его — тогда демон честно ответит ошибкой запуска.
   */
  async function execStart(id: string, { shell = '' }: { shell?: string } = {}) {
    if (settings().allowExec === false) {
      fail('терминал в контейнер запрещён настройками плагина', 403, 'exec_forbidden');
    }
    const command = shell
      ? [shell]
      : ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'];
    const created = await client.post(`/containers/${encodeURIComponent(id)}/exec`, {
      body: {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: command,
        Env: ['TERM=xterm-256color'],
      },
    });
    const execId = decodeEngineExecId(created);
    if (!execId) {
      fail('демон не создал exec-сессию', 502, 'exec_failed');
    }
    const socket = await client.hijack(`/exec/${execId}/start`, {
      Detach: false,
      Tty: true,
    });
    const handle = { abort: () => socket.destroy() };
    const untrack = track(handle);
    socket.once('close', untrack);
    return {
      execId,
      socket,
      resize: (nextCols: number, nextRows: number) => client
        .post(`/exec/${execId}/resize`, {
          query: {
            w: nextCols,
            h: nextRows,
          },
        })
        .catch(() => {
          // Контейнер мог уже завершиться; повторный resize не требуется.
        }),
      close: () => {
        untrack();
        socket.destroy();
      },
    };
  }

  /**
   * Выключение плагина закрывает все уже открытые каналы и сбрасывает сводку.
   */
  async function disable() {
    for (const handle of [...streams]) {
      try {
        handle.abort();
      } catch {
        // Канал уже закрыт.
      }
      streams.delete(handle);
    }
    invalidateUsage();
  }

  return {
    health,
    overview,
    usage,
    inspect,
    containerAction,
    projectAction,
    removeContainer,
    removeImage,
    removeVolume,
    removeNetwork,
    prune,
    logStream,
    statsOnce,
    execStart,
    disable,
    activeStreams: () => streams.size,
  };
}

export type DockerService = ReturnType<typeof createDockerService>;
