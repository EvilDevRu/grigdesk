// Нормализация ответов Docker Engine API в DTO панели.
//
// Всё здесь — чистые функции над уже полученным JSON: демон в этот файл не ходит.
// Так проверяется главное (группировка compose, склейка портов, счёт занятого места)
// без живого докера в тестах, а модуль сервера остаётся тонким.

import type {
  DockerContainer,
  DockerImage,
  DockerNetwork,
  DockerOverview,
  DockerPort,
  DockerProject,
  DockerStats,
  DockerUsage,
  DockerUsageSummary,
  DockerVolume,
} from '../../../../shared/plugins/docker/dockerContracts.ts';
import type {
  EngineBuildCache,
  EngineContainer,
  EngineDiskUsage,
  EngineImage,
  EngineNetwork,
  EnginePort,
  EngineResourceUsage,
  EngineStats,
  EngineVolume,
} from './dockerEngineTypes.ts';

interface VolumeOptions {
  usage?: EngineVolume[];
  containers?: DockerContainer[];
}

interface UsageOptions {
  df?: EngineDiskUsage | null;
  containers?: DockerContainer[];
  images?: DockerImage[];
  volumes?: DockerVolume[];
  networks?: DockerNetwork[];
}

interface SizedResource {
  size?: number | null;
  sizeRw?: number | null;
}

const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';
const COMPOSE_NUMBER = 'com.docker.compose.container-number';
const COMPOSE_WORKDIR = 'com.docker.compose.project.working_dir';
const COMPOSE_CONFIGS = 'com.docker.compose.project.config_files';

// Сети, созданные самим демоном: их не удаляет ни prune, ни человек, и предлагать
// их к очистке — обман.
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none']);
const shortId = (id: string) => String(id || '').replace(/^sha256:/u, '').slice(0, 12);
const secondsToIso = (value: number | undefined) => (typeof value === 'number'
  && Number.isFinite(value) && value > 0
  ? new Date(value * 1000).toISOString()
  : null);

/**
 * Порты контейнера приезжают отдельной записью на каждый слушающий адрес, поэтому
 * одна проброшенная пара выглядит как два элемента (0.0.0.0 и ::). Панель показывает
 * связь «наружу → внутрь», а не список сокетов, — склеиваем по этой паре.
 */
export function normalizePorts(raw: EnginePort[] = []): DockerPort[] {
  const byKey = new Map<string, DockerPort>();
  for (const port of raw) {
    const key = `${port.PublicPort || 0}:${port.PrivatePort}/${port.Type || 'tcp'}`;
    const existing = byKey.get(key);
    if (existing) {
      if (port.IP && !existing.hosts.includes(port.IP)) {
        existing.hosts.push(port.IP);
      }
      continue;
    }
    byKey.set(key, {
      published: port.PublicPort || 0,
      target: port.PrivatePort,
      protocol: port.Type || 'tcp',
      hosts: port.IP ? [port.IP] : [],
    });
  }
  return [...byKey.values()].sort((a, b) => (b.published - a.published) || (a.target - b.target));
}

/**
 * Имя контейнера у демона всегда с ведущим слэшем; человеку он не нужен.
 */
function containerName(names: string[] = []) {
  const first = String(names[0] || '');
  return first.startsWith('/') ? first.slice(1) : first;
}

/**
 * Нормализованный контейнер имеет одинаковую форму во всех ответах панели.
 */
export function normalizeContainer(raw: EngineContainer): DockerContainer {
  const labels = raw.Labels || {};
  const project = labels[COMPOSE_PROJECT] || '';
  return {
    id: raw.Id,
    shortId: shortId(raw.Id),
    name: containerName(raw.Names),
    image: raw.Image || '',
    imageId: raw.ImageID || '',
    command: raw.Command || '',
    createdAt: secondsToIso(raw.Created),
    state: raw.State || 'unknown',
    status: raw.Status || '',
    health: raw.Health?.Status && raw.Health.Status !== 'none' ? raw.Health.Status : '',
    ports: normalizePorts(raw.Ports),
    networks: Object.keys(raw.NetworkSettings?.Networks || {}),
    mounts: (raw.Mounts || []).map((mount) => ({
      type: mount.Type || '',
      name: mount.Name || '',
      source: mount.Source || '',
      destination: mount.Destination || '',
      rw: mount.RW !== false,
    })),
    sizeRw: typeof raw.SizeRw === 'number' && Number.isFinite(raw.SizeRw) ? raw.SizeRw : null,
    compose: project
      ? {
        project,
        service: labels[COMPOSE_SERVICE] || '',
        number: Number(labels[COMPOSE_NUMBER] || 0) || null,
        workingDir: labels[COMPOSE_WORKDIR] || '',
        configFiles: labels[COMPOSE_CONFIGS] || '',
      }
      : null,
  };
}

/**
 * Работающие контейнеры показываются первыми независимо от порядка ответа демона.
 */
export function normalizeContainers(raw: EngineContainer[] = []): DockerContainer[] {
  // Демон отдаёт массив всегда, но ответ мог прийти от прокси или от чужой версии
  // API: непонятное тело — это пустой список, а не падение всей панели.
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(normalizeContainer).sort((a, b) => {
    // Живые впереди: панель открывают, чтобы посмотреть на работающее, а остановленные
    // интересны в основном как кандидаты на уборку.
    const running = Number(b.state === 'running') - Number(a.state === 'running');
    return running || a.name.localeCompare(b.name, 'ru');
  });
}

/**
 * Compose-проект как единица управления: одна кнопка «Остановить» относится ко всем
 * контейнерам группы. Проект существует, пока жив хотя бы один его контейнер, — того,
 * что описано в yml, но не запущено, демон не знает вовсе.
 */
export function groupComposeProjects(containers: DockerContainer[] = []): DockerProject[] {
  const projects = new Map<string, DockerProject>();
  for (const container of containers) {
    if (!container.compose) {
      continue;
    }
    const key = container.compose.project;
    let project = projects.get(key);
    if (!project) {
      project = {
        project: key,
        workingDir: container.compose.workingDir,
        configFiles: container.compose.configFiles,
        containers: [],
        running: 0,
        total: 0,
        ports: [],
      };
      projects.set(key, project);
    }
    project.containers.push(container.id);
    project.total += 1;
    if (container.state === 'running') {
      project.running += 1;
    }
    for (const port of container.ports) {
      if (port.published) {
        project.ports.push(port.published);
      }
    }
  }
  for (const project of projects.values()) {
    project.ports = [...new Set(project.ports)].sort((a, b) => a - b);
  }
  return [...projects.values()].sort((a, b) => (b.running - a.running)
    || a.project.localeCompare(b.project, 'ru'));
}

/**
 * Занятость образа считается по живому списку контейнеров, а не по полю Containers
 * ответа демона: оно заполняется не всеми версиями API, а ошибиться здесь дорого —
 * именно этот признак решает, предложим ли мы образ к удалению.
 */
export function normalizeImages(raw: EngineImage[] = [], containers: DockerContainer[] = []): DockerImage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const usage = new Map<string, string[]>();
  for (const container of containers) {
    const key = container.imageId || '';
    if (!key) {
      continue;
    }
    const list = usage.get(key) || [];
    list.push(container.name);
    usage.set(key, list);
  }
  return raw.map((image) => {
    const tags = (image.RepoTags || []).filter((tag) => tag && tag !== '<none>:<none>');
    const usedBy = usage.get(image.Id) || [];
    return {
      id: image.Id,
      shortId: shortId(image.Id),
      tags,
      digests: (image.RepoDigests || []).filter((digest) => digest && !digest.includes('<none>')),
      size: Number(image.Size) || 0,
      createdAt: secondsToIso(image.Created),
      dangling: tags.length === 0,
      usedBy,
      inUse: usedBy.length > 0,
    };
  }).sort((a, b) => b.size - a.size);
}

/**
 * Тома: занятость считается по монтированиям живых и остановленных контейнеров —
 * ровно как её понимает сам Docker (том занят, пока на него ссылается хоть один
 * контейнер, пусть и мёртвый). Размер приходит только из `/system/df`, а он на
 * большом хосте считается секундами, поэтому размер здесь необязателен: без него
 * список всё равно отвечает на главный вопрос «что можно убрать».
 */
export function normalizeVolumes(
  raw: EngineVolume[] = [],
  { usage = [], containers = [] }: VolumeOptions = {},
): DockerVolume[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const sizes = new Map(usage.map((item) => [item.Name, item.UsageData || {}]));
  const refs = new Map<string, string[]>();
  for (const container of containers) {
    for (const mount of container.mounts || []) {
      if (mount.type !== 'volume' || !mount.name) {
        continue;
      }
      const list = refs.get(mount.name) || [];
      list.push(container.name);
      refs.set(mount.name, list);
    }
  }
  return raw.map((volume) => {
    const data = sizes.get(volume.Name) || volume.UsageData || {};
    const labels = volume.Labels || {};
    const usedBy = refs.get(volume.Name) || [];
    return {
      name: volume.Name,
      driver: volume.Driver || 'local',
      createdAt: volume.CreatedAt || null,
      mountpoint: volume.Mountpoint || '',
      size: typeof data.Size === 'number' && Number.isFinite(data.Size) && data.Size >= 0
        ? data.Size
        : null,
      usedBy,
      inUse: usedBy.length > 0,
      anonymous: 'com.docker.volume.anonymous' in labels,
      compose: labels[COMPOSE_PROJECT] || '',
    };
  }).sort((a, b) => (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name, 'ru'));
}

/**
 * Связи контейнеров определяют занятость сетей, включая встроенные сети демона.
 */
export function normalizeNetworks(
  raw: EngineNetwork[] = [],
  containers: DockerContainer[] = [],
): DockerNetwork[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const attached = new Map<string, number>();
  for (const container of containers) {
    for (const network of container.networks) {
      attached.set(network, (attached.get(network) || 0) + 1);
    }
  }
  return raw.map((network) => ({
    id: network.Id,
    shortId: shortId(network.Id),
    name: network.Name,
    driver: network.Driver || '',
    scope: network.Scope || '',
    internal: network.Internal === true,
    builtin: BUILTIN_NETWORKS.has(network.Name),
    subnets: (network.IPAM?.Config || []).map((item) => item.Subnet || '').filter(Boolean),
    containers: attached.get(network.Name) || 0,
    createdAt: network.Created || null,
  })).sort((a, b) => (b.containers - a.containers) || a.name.localeCompare(b.name, 'ru'));
}

/**
 * Запасной расчёт кэша нужен старым демонам без готового поля BuildCacheUsage.
 */
export function normalizeBuildCache(raw: EngineBuildCache[] = []) {
  const records = (Array.isArray(raw) ? raw : []).map((item) => ({
    id: item.ID,
    type: item.Type || '',
    inUse: item.InUse === true,
    shared: item.Shared === true,
    size: Number(item.Size) || 0,
    createdAt: item.CreatedAt || null,
    lastUsedAt: item.LastUsedAt || null,
  }));
  return {
    records: records.length,
    size: records.reduce((sum, item) => sum + item.size, 0),
    reclaimable: records.filter((item) => !item.inUse).reduce((sum, item) => sum + item.size, 0),
  };
}

/**
 * Сборка обзора проверяется тем же контрактом, который принимает браузер.
 * Счётчики получают значения из нормализованных списков одного запроса.
 */
export function buildOverview(
  containers: DockerContainer[],
  images: DockerImage[],
  volumes: DockerVolume[],
  networks: DockerNetwork[],
): DockerOverview {
  return {
    containers,
    projects: groupComposeProjects(containers),
    images,
    volumes,
    networks,
    counts: {
      containers: containers.length,
      running: containers.filter((item) => item.state === 'running').length,
      images: images.length,
      volumes: volumes.length,
      networks: networks.length,
    },
  };
}

/**
 * Метка времени относится к вычислению, даже когда ответ обслуживает кэш.
 */
export function buildUsageSnapshot(
  summary: DockerUsageSummary,
  computedAt: number,
  cached: boolean,
): DockerUsage {
  return {
    ...summary,
    cached,
    computedAt: new Date(computedAt).toISOString(),
  };
}

/**
 * Сводка «сколько занято и сколько из этого вернётся».
 *
 * Считать её сложением размеров нельзя: у образов общие слои, и наивная сумма
 * неиспользуемых даёт втрое больше правды (на этой машине 95 ГБ вместо 32.7).
 * Тот же подвох у кэша сборки — там часть записей общая. Поэтому цифры берутся
 * из `*Usage` ответа `/system/df`, где демон уже вычел общее, ровно как это
 * показывает `docker system df`. Ручной счёт остаётся запасным путём для демонов
 * постарше, у которых этих полей нет, и честно помечает себя в `source`.
 */
export function summarizeDiskUsage({
  df = null,
  containers = [],
  images = [],
  volumes = [],
  networks = [],
}: UsageOptions = {}): DockerUsageSummary {
  const sum = (list: SizedResource[], field: 'size' | 'sizeRw' = 'size') => list
    .reduce((total, item) => total + (item[field] || 0), 0);
  const stopped = containers.filter((item) => !['running', 'restarting', 'paused'].includes(item.state));
  const danglingImages = images.filter((item) => item.dangling && !item.inUse);
  const unusedImages = images.filter((item) => !item.inUse);
  const unusedVolumes = volumes.filter((item) => item.inUse === false);
  const unusedNetworks = networks.filter((item) => !item.builtin && item.containers === 0);

  const usage = (
    raw: EngineResourceUsage | undefined,
    computedTotal: number,
    computedReclaimable: number,
    computedCount: number,
  ) => (raw
    ? {
      total: Number(raw.TotalCount ?? computedCount) || 0,
      active: Number(raw.ActiveCount) || 0,
      size: Number(raw.TotalSize) || 0,
      reclaimable: Number(raw.Reclaimable) || 0,
    }
    : {
      total: computedCount,
      active: computedCount - 0,
      size: computedTotal,
      reclaimable: computedReclaimable,
    });

  const cache = df?.BuildCacheUsage || null;
  const buildCacheRecords = normalizeBuildCache(df?.BuildCache || []);

  return {
    source: df?.ImageUsage ? 'daemon' : 'computed',
    containers: {
      ...usage(df?.ContainerUsage, sum(containers, 'sizeRw'), sum(stopped, 'sizeRw'), containers.length),
      total: containers.length,
      active: containers.filter((item) => item.state === 'running').length,
      stopped: stopped.length,
    },
    images: {
      ...usage(df?.ImageUsage, sum(images), sum(unusedImages), images.length),
      total: images.length,
      unused: unusedImages.length,
      dangling: {
        count: danglingImages.length,
        size: sum(danglingImages),
      },
    },
    volumes: {
      ...usage(df?.VolumeUsage, sum(volumes), sum(unusedVolumes), volumes.length),
      total: volumes.length,
      unused: unusedVolumes.length,
    },
    networks: {
      total: networks.length,
      unused: unusedNetworks.length,
    },
    buildCache: {
      total: Number(cache?.TotalCount ?? buildCacheRecords.records) || 0,
      size: Number(cache?.TotalSize ?? buildCacheRecords.size) || 0,
      reclaimable: Number(cache?.Reclaimable ?? buildCacheRecords.reclaimable) || 0,
    },
  };
}

/**
 * Проценты CPU и памяти считаются так же, как их показывает `docker stats`:
 * дельта тактов контейнера к дельте тактов системы, умноженная на число ядер,
 * и вычтенный cache из потребления памяти. Своя формула здесь дала бы цифру,
 * не сходящуюся с терминалом, — а панель обязана сходиться.
 */
export function computeStats(raw: EngineStats | null | undefined): DockerStats | null {
  if (!raw || raw.read === '0001-01-01T00:00:00Z') {
    return null;
  }
  const cpuDelta = (raw.cpu_stats?.cpu_usage?.total_usage || 0)
    - (raw.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (raw.cpu_stats?.system_cpu_usage || 0) - (raw.precpu_stats?.system_cpu_usage || 0);
  const cores = raw.cpu_stats?.online_cpus
    || (raw.cpu_stats?.cpu_usage?.percpu_usage || []).length
    || 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0;

  const cache = raw.memory_stats?.stats?.inactive_file
    ?? raw.memory_stats?.stats?.total_inactive_file
    ?? 0;
  const memoryUsed = Math.max(0, (raw.memory_stats?.usage || 0) - cache);
  const memoryLimit = raw.memory_stats?.limit || 0;

  const networks = Object.values(raw.networks || {});
  const blkio = raw.blkio_stats?.io_service_bytes_recursive || [];
  const blkioSum = (op: string) => blkio
    .filter((item) => String(item.op || '').toLowerCase() === op)
    .reduce((sum, item) => sum + (item.value || 0), 0);

  return {
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memoryUsed,
    memoryLimit,
    memoryPercent: memoryLimit > 0 ? Number(((memoryUsed / memoryLimit) * 100).toFixed(2)) : 0,
    networkRx: networks.reduce((sum, item) => sum + (item.rx_bytes || 0), 0),
    networkTx: networks.reduce((sum, item) => sum + (item.tx_bytes || 0), 0),
    blockRead: blkioSum('read'),
    blockWrite: blkioSum('write'),
    pids: raw.pids_stats?.current || 0,
  };
}
