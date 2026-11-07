import { DockerError } from './client.ts';
import type {
  EngineBuildCache,
  EngineContainer,
  EngineDiskUsage,
  EngineImage,
  EngineMount,
  EngineNetwork,
  EnginePort,
  EngineResourceUsage,
  EngineStats,
  EngineVolume,
} from './dockerEngineTypes.ts';

type Decoder<T> = (value: unknown, path: string) => T;

/**
 * Ошибка показывает только путь поля: ответы inspect могут содержать секреты,
 * поэтому исходное значение никогда не добавляется в текст исключения.
 */
function invalid(path: string): never {
  throw new DockerError(`некорректный ответ Docker Engine: ${path}`, 502, 'docker_bad_response');
}

/**
 * Приведение разрешено только после проверки формы объекта. Дальнейшие чтения
 * остаются unknown, пока конкретный декодер не проверит используемое поле.
 */
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(path);
  }

  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    return invalid(path);
  }

  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalid(path);
  }

  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return invalid(path);
  }

  return value;
}

/**
 * Старые версии Engine опускают часть полей или возвращают null. Оба варианта
 * сохраняют прежние значения по умолчанию в нормализаторах панели.
 */
function optional<T>(value: unknown, path: string, decode: Decoder<T>): T | undefined {
  return value == null ? undefined : decode(value, path);
}

function list<T>(value: unknown, path: string, decode: Decoder<T>): T[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return invalid(path);
  }

  return value.map((item: unknown, index) => decode(item, `${path}[${index}]`));
}

function map<T>(value: unknown, path: string, decode: Decoder<T>): Record<string, T> {
  if (value == null) {
    return {};
  }

  const entries = Object.entries(object(value, path));

  return Object.fromEntries(entries.map(([key, item]) => [key, decode(item, `${path}.${key}`)]));
}

function mount(value: unknown, path: string): EngineMount {
  const raw = object(value, path);

  return {
    Type: optional(raw.Type, `${path}.Type`, text),
    Name: optional(raw.Name, `${path}.Name`, text),
    Source: optional(raw.Source, `${path}.Source`, text),
    Destination: optional(raw.Destination, `${path}.Destination`, text),
    RW: optional(raw.RW, `${path}.RW`, boolean),
  };
}

function port(value: unknown, path: string): EnginePort {
  const raw = object(value, path);

  return {
    PrivatePort: number(raw.PrivatePort, `${path}.PrivatePort`),
    PublicPort: optional(raw.PublicPort, `${path}.PublicPort`, number),
    Type: optional(raw.Type, `${path}.Type`, text),
    IP: optional(raw.IP, `${path}.IP`, text),
  };
}

function health(value: unknown, path: string) {
  const raw = object(value, path);

  return { Status: optional(raw.Status, `${path}.Status`, text) };
}

function networkSettings(value: unknown, path: string) {
  const raw = object(value, path);

  return { Networks: map(raw.Networks, `${path}.Networks`, (item) => item) };
}

function container(value: unknown, path: string): EngineContainer {
  const raw = object(value, path);

  return {
    Id: text(raw.Id, `${path}.Id`),
    Names: list(raw.Names, `${path}.Names`, text),
    Image: optional(raw.Image, `${path}.Image`, text),
    ImageID: optional(raw.ImageID, `${path}.ImageID`, text),
    Command: optional(raw.Command, `${path}.Command`, text),
    Created: optional(raw.Created, `${path}.Created`, number),
    State: optional(raw.State, `${path}.State`, text),
    Status: optional(raw.Status, `${path}.Status`, text),
    Health: optional(raw.Health, `${path}.Health`, health),
    Ports: list(raw.Ports, `${path}.Ports`, port),
    Labels: map(raw.Labels, `${path}.Labels`, text),
    NetworkSettings: optional(raw.NetworkSettings, `${path}.NetworkSettings`, networkSettings),
    Mounts: list(raw.Mounts, `${path}.Mounts`, mount),
    SizeRw: optional(raw.SizeRw, `${path}.SizeRw`, number),
  };
}

function image(value: unknown, path: string): EngineImage {
  const raw = object(value, path);

  return {
    Id: text(raw.Id, `${path}.Id`),
    RepoTags: list(raw.RepoTags, `${path}.RepoTags`, text),
    RepoDigests: list(raw.RepoDigests, `${path}.RepoDigests`, text),
    Size: optional(raw.Size, `${path}.Size`, number),
    Created: optional(raw.Created, `${path}.Created`, number),
  };
}

function volumeUsage(value: unknown, path: string) {
  const raw = object(value, path);

  return { Size: optional(raw.Size, `${path}.Size`, number) };
}

function volume(value: unknown, path: string): EngineVolume {
  const raw = object(value, path);

  return {
    Name: text(raw.Name, `${path}.Name`),
    Driver: optional(raw.Driver, `${path}.Driver`, text),
    CreatedAt: optional(raw.CreatedAt, `${path}.CreatedAt`, text),
    Mountpoint: optional(raw.Mountpoint, `${path}.Mountpoint`, text),
    Labels: map(raw.Labels, `${path}.Labels`, text),
    UsageData: optional(raw.UsageData, `${path}.UsageData`, volumeUsage),
  };
}

function ipam(value: unknown, path: string) {
  const raw = object(value, path);

  return {
    Config: list(raw.Config, `${path}.Config`, (entry, itemPath) => {
      const item = object(entry, itemPath);

      return { Subnet: optional(item.Subnet, `${itemPath}.Subnet`, text) };
    }),
  };
}

function network(value: unknown, path: string): EngineNetwork {
  const raw = object(value, path);

  return {
    Id: text(raw.Id, `${path}.Id`),
    Name: text(raw.Name, `${path}.Name`),
    Driver: optional(raw.Driver, `${path}.Driver`, text),
    Scope: optional(raw.Scope, `${path}.Scope`, text),
    Internal: optional(raw.Internal, `${path}.Internal`, boolean),
    Created: optional(raw.Created, `${path}.Created`, text),
    IPAM: optional(raw.IPAM, `${path}.IPAM`, ipam),
  };
}

function buildCache(value: unknown, path: string): EngineBuildCache {
  const raw = object(value, path);

  return {
    ID: text(raw.ID, `${path}.ID`),
    Type: optional(raw.Type, `${path}.Type`, text),
    InUse: optional(raw.InUse, `${path}.InUse`, boolean),
    Shared: optional(raw.Shared, `${path}.Shared`, boolean),
    Size: optional(raw.Size, `${path}.Size`, number),
    CreatedAt: optional(raw.CreatedAt, `${path}.CreatedAt`, text),
    LastUsedAt: optional(raw.LastUsedAt, `${path}.LastUsedAt`, text),
  };
}

function resourceUsage(value: unknown, path: string): EngineResourceUsage {
  const raw = object(value, path);

  return {
    TotalCount: optional(raw.TotalCount, `${path}.TotalCount`, number),
    ActiveCount: optional(raw.ActiveCount, `${path}.ActiveCount`, number),
    TotalSize: optional(raw.TotalSize, `${path}.TotalSize`, number),
    Reclaimable: optional(raw.Reclaimable, `${path}.Reclaimable`, number),
  };
}

/**
 * Списки верхнего уровня сохраняют совместимость со старым нормализатором:
 * тело другой формы даёт пустую выдачу, но повреждённая запись уже не становится DTO.
 */
export function decodeEngineContainers(value: unknown): EngineContainer[] {
  return Array.isArray(value) ? list(value, 'containers', container) : [];
}

export function decodeEngineImages(value: unknown): EngineImage[] {
  return Array.isArray(value) ? list(value, 'images', image) : [];
}

export function decodeEngineNetworks(value: unknown): EngineNetwork[] {
  return Array.isArray(value) ? list(value, 'networks', network) : [];
}

export function decodeEngineVolumes(value: unknown): EngineVolume[] {
  const raw = value == null ? {} : object(value, 'volumes');

  return list(raw.Volumes, 'volumes.Volumes', volume);
}

export function decodeEngineDiskUsage(value: unknown): EngineDiskUsage | null {
  if (value == null) {
    return null;
  }

  const raw = object(value, 'df');

  return {
    ImageUsage: optional(raw.ImageUsage, 'df.ImageUsage', resourceUsage),
    ContainerUsage: optional(raw.ContainerUsage, 'df.ContainerUsage', resourceUsage),
    VolumeUsage: optional(raw.VolumeUsage, 'df.VolumeUsage', resourceUsage),
    BuildCacheUsage: optional(raw.BuildCacheUsage, 'df.BuildCacheUsage', resourceUsage),
    BuildCache: list(raw.BuildCache, 'df.BuildCache', buildCache),
    Volumes: list(raw.Volumes, 'df.Volumes', volume),
  };
}

export function decodeEngineVersion(value: unknown) {
  const raw = object(value, 'version');

  return {
    Version: optional(raw.Version, 'version.Version', text),
    ApiVersion: optional(raw.ApiVersion, 'version.ApiVersion', text),
  };
}

/**
 * Inspect извлекает только поля карточки и TTY. Env намеренно не читается:
 * секреты из ответа демона не должны попадать в результат сервиса.
 */
export function decodeEngineInspect(value: unknown) {
  const raw = object(value, 'inspect');
  const config = raw.Config == null ? {} : object(raw.Config, 'inspect.Config');
  const state = raw.State == null ? {} : object(raw.State, 'inspect.State');
  const host = raw.HostConfig == null ? {} : object(raw.HostConfig, 'inspect.HostConfig');
  const restart = host.RestartPolicy == null ? {} : object(host.RestartPolicy, 'inspect.RestartPolicy');
  const net = raw.NetworkSettings == null ? {} : object(raw.NetworkSettings, 'inspect.NetworkSettings');

  return {
    Id: optional(raw.Id, 'inspect.Id', text),
    Name: optional(raw.Name, 'inspect.Name', text),
    Path: optional(raw.Path, 'inspect.Path', text),
    Args: list(raw.Args, 'inspect.Args', text),
    Created: optional(raw.Created, 'inspect.Created', text),
    RestartCount: optional(raw.RestartCount, 'inspect.RestartCount', number),
    Config: {
      Image: optional(config.Image, 'inspect.Config.Image', text),
      Tty: optional(config.Tty, 'inspect.Config.Tty', boolean),
      WorkingDir: optional(config.WorkingDir, 'inspect.Config.WorkingDir', text),
      User: optional(config.User, 'inspect.Config.User', text),
      Labels: map(config.Labels, 'inspect.Config.Labels', text),
    },
    State: {
      StartedAt: optional(state.StartedAt, 'inspect.State.StartedAt', text),
      FinishedAt: optional(state.FinishedAt, 'inspect.State.FinishedAt', text),
      Status: optional(state.Status, 'inspect.State.Status', text),
      ExitCode: optional(state.ExitCode, 'inspect.State.ExitCode', number),
      Health: optional(state.Health, 'inspect.State.Health', health),
    },
    HostConfig: {
      RestartPolicy: {
        Name: optional(restart.Name, 'inspect.RestartPolicy.Name', text),
      },
    },
    Mounts: list(raw.Mounts, 'inspect.Mounts', mount),
    NetworkSettings: {
      Networks: map(net.Networks, 'inspect.NetworkSettings.Networks', (value, path) => {
        const item = object(value, path);

        return {
          IPAddress: optional(item.IPAddress, `${path}.IPAddress`, text),
          Gateway: optional(item.Gateway, `${path}.Gateway`, text),
        };
      }),
    },
  };
}

function cpuStats(value: unknown, path: string) {
  const raw = object(value, path);
  const usage = raw.cpu_usage == null ? {} : object(raw.cpu_usage, `${path}.cpu_usage`);

  return {
    cpu_usage: {
      total_usage: optional(usage.total_usage, `${path}.cpu_usage.total_usage`, number),
      percpu_usage: list(usage.percpu_usage, `${path}.cpu_usage.percpu_usage`, number),
    },
    system_cpu_usage: optional(raw.system_cpu_usage, `${path}.system_cpu_usage`, number),
    online_cpus: optional(raw.online_cpus, `${path}.online_cpus`, number),
  };
}

function memoryStats(value: unknown, path: string) {
  const raw = object(value, path);
  const stats = raw.stats == null ? {} : object(raw.stats, `${path}.stats`);

  return {
    usage: optional(raw.usage, `${path}.usage`, number),
    limit: optional(raw.limit, `${path}.limit`, number),
    stats: {
      inactive_file: optional(stats.inactive_file, `${path}.stats.inactive_file`, number),
      total_inactive_file: optional(stats.total_inactive_file, `${path}.stats.total_inactive_file`, number),
    },
  };
}

function blockStats(value: unknown, path: string) {
  const raw = object(value, path);

  return {
    io_service_bytes_recursive: list(raw.io_service_bytes_recursive, `${path}.io`, (value, itemPath) => {
      const item = object(value, itemPath);

      return {
        op: optional(item.op, `${itemPath}.op`, text),
        value: optional(item.value, `${itemPath}.value`, number),
      };
    }),
  };
}

export function decodeEngineStats(value: unknown): EngineStats | null {
  if (value == null) {
    return null;
  }

  const raw = object(value, 'stats');

  return {
    read: optional(raw.read, 'stats.read', text),
    cpu_stats: optional(raw.cpu_stats, 'stats.cpu_stats', cpuStats),
    precpu_stats: optional(raw.precpu_stats, 'stats.precpu_stats', cpuStats),
    memory_stats: optional(raw.memory_stats, 'stats.memory_stats', memoryStats),
    networks: map(raw.networks, 'stats.networks', (value, path) => {
      const item = object(value, path);

      return {
        rx_bytes: optional(item.rx_bytes, `${path}.rx_bytes`, number),
        tx_bytes: optional(item.tx_bytes, `${path}.tx_bytes`, number),
      };
    }),
    blkio_stats: optional(raw.blkio_stats, 'stats.blkio_stats', blockStats),
    pids_stats: optional(raw.pids_stats, 'stats.pids_stats', (value, path) => {
      const item = object(value, path);

      return { current: optional(item.current, `${path}.current`, number) };
    }),
  };
}

/**
 * Отчёт использует только количество записей удаления. Их содержимое Engine
 * меняет между видами ресурсов, поэтому оно остаётся неизвестным и не публикуется.
 */
export function decodeEnginePrune(value: unknown, deletedField: string, withSpace = true) {
  const raw = value == null ? {} : object(value, 'prune');
  const deleted = raw[deletedField];

  if (deleted != null && !Array.isArray(deleted)) {
    return invalid(`prune.${deletedField}`);
  }

  return {
    removed: deleted?.length || 0,
    freed: withSpace ? optional(raw.SpaceReclaimed, 'prune.SpaceReclaimed', number) || 0 : 0,
  };
}

export function decodeEngineExecId(value: unknown): string | undefined {
  const raw = value == null ? {} : object(value, 'exec');

  return optional(raw.Id, 'exec.Id', text);
}
