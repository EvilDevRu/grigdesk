// Контракт панели Docker общий для нормализаторов сервера и клиента.
// Типы выводятся из декодеров: форма JSON и проверка данных не расходятся.

type Decoder<Value> = (value: unknown, path: string) => Value;
type Fields = Record<string, Decoder<unknown>>;
type Decoded<Shape extends Fields> = {
  [Key in keyof Shape]: ReturnType<Shape[Key]>;
};

export class DockerContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ Docker: поле ${path} не соответствует контракту`);
    this.name = 'DockerContractError';
  }
}

/**
 * На входе сети допускается только обычный JSON-объект. После проверки его поля
 * остаются unknown, пока соответствующий декодер не подтвердит их форму.
 */
function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DockerContractError(path);
  }

  return value as Record<string, unknown>;
}

/**
 * Объект собирается только из объявленных и проверенных полей. Приведение здесь
 * связывает динамический обход ключей с mapped type, а не доверяет входящему JSON.
 */
function objectOf<Shape extends Fields>(fields: Shape): Decoder<Decoded<Shape>> {
  return (value, path) => {
    const source = record(value, path);
    const entries = Object.entries(fields).map(([key, decode]) => [
      key,
      decode(source[key], `${path}.${key}`),
    ]);

    return Object.fromEntries(entries) as Decoded<Shape>;
  };
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new DockerContractError(path);
  }

  return value;
}

function numeric(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DockerContractError(path);
  }

  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DockerContractError(path);
  }

  return value;
}

/**
 * Только перечисленные значения управляют действиями и вариантами сообщений;
 * незнакомое значение не должно незаметно включать запасную ветку обработки.
 */
function oneOf<const Values extends readonly (string | boolean)[]>(...values: Values): Decoder<Values[number]> {
  return (value, path) => {
    for (const expected of values) {
      if (value === expected) {
        return expected;
      }
    }

    throw new DockerContractError(path);
  };
}

function nullable<Value>(decode: Decoder<Value>): Decoder<Value | null> {
  return (value, path) => value === null ? null : decode(value, path);
}

function listOf<Value>(decode: Decoder<Value>): Decoder<Value[]> {
  return (value, path) => {
    if (!Array.isArray(value)) {
      throw new DockerContractError(path);
    }

    return value.map((item: unknown, index: number) => decode(item, `${path}[${index}]`));
  };
}

function mapOf<Value>(decode: Decoder<Value>): Decoder<Record<string, Value>> {
  return (value, path) => Object.fromEntries(Object.entries(record(value, path))
    .map(([key, item]) => [key, decode(item, `${path}.${key}`)]));
}

const strings = listOf(text);
const port = objectOf({
  published: numeric,
  target: numeric,
  protocol: text,
  hosts: strings,
});
const mount = objectOf({
  type: text,
  name: text,
  source: text,
  destination: text,
  rw: boolean,
});
const compose = objectOf({
  project: text,
  service: text,
  number: nullable(numeric),
  workingDir: text,
  configFiles: text,
});
const container = objectOf({
  id: text,
  shortId: text,
  name: text,
  image: text,
  imageId: text,
  command: text,
  createdAt: nullable(text),
  state: text,
  status: text,
  health: text,
  ports: listOf(port),
  networks: strings,
  mounts: listOf(mount),
  sizeRw: nullable(numeric),
  compose: nullable(compose),
});
const project = objectOf({
  project: text,
  workingDir: text,
  configFiles: text,
  containers: strings,
  running: numeric,
  total: numeric,
  ports: listOf(numeric),
});
const image = objectOf({
  id: text,
  shortId: text,
  tags: strings,
  digests: strings,
  size: numeric,
  createdAt: nullable(text),
  dangling: boolean,
  usedBy: strings,
  inUse: boolean,
});
const volume = objectOf({
  name: text,
  driver: text,
  createdAt: nullable(text),
  mountpoint: text,
  size: nullable(numeric),
  usedBy: strings,
  inUse: boolean,
  anonymous: boolean,
  compose: text,
});
const network = objectOf({
  id: text,
  shortId: text,
  name: text,
  driver: text,
  scope: text,
  internal: boolean,
  builtin: boolean,
  subnets: strings,
  containers: numeric,
  createdAt: nullable(text),
});
const counts = objectOf({
  containers: numeric,
  running: numeric,
  images: numeric,
  volumes: numeric,
  networks: numeric,
});
const overview = objectOf({
  containers: listOf(container),
  projects: listOf(project),
  images: listOf(image),
  volumes: listOf(volume),
  networks: listOf(network),
  counts,
});
const availableHealth = objectOf({
  available: oneOf(true),
  version: text,
  apiVersion: text,
  socketPath: text,
});
const unavailableHealth = objectOf({
  available: oneOf(false),
  error: text,
  message: text,
  socketPath: text,
});
const usageFields = {
  source: oneOf('daemon', 'computed'),
  containers: objectOf({
    total: numeric,
    active: numeric,
    size: numeric,
    reclaimable: numeric,
    stopped: numeric,
  }),
  images: objectOf({
    total: numeric,
    active: numeric,
    size: numeric,
    reclaimable: numeric,
    unused: numeric,
    dangling: objectOf({
      count: numeric,
      size: numeric,
    }),
  }),
  volumes: objectOf({
    total: numeric,
    active: numeric,
    size: numeric,
    reclaimable: numeric,
    unused: numeric,
  }),
  networks: objectOf({
    total: numeric,
    unused: numeric,
  }),
  buildCache: objectOf({
    total: numeric,
    size: numeric,
    reclaimable: numeric,
  }),
};
const usageSummary = objectOf(usageFields);
const usage = objectOf({
  ...usageFields,
  cached: boolean,
  computedAt: text,
});
const stats = objectOf({
  cpuPercent: numeric,
  memoryUsed: numeric,
  memoryLimit: numeric,
  memoryPercent: numeric,
  networkRx: numeric,
  networkTx: numeric,
  blockRead: numeric,
  blockWrite: numeric,
  pids: numeric,
});
const okResponse = objectOf({ ok: oneOf(true) });
const projectAction = oneOf('start', 'stop', 'restart');
const projectSuccess = objectOf({
  id: text,
  name: text,
  ok: oneOf(true),
});
const projectFailure = objectOf({
  id: text,
  name: text,
  ok: oneOf(false),
  message: text,
});

function projectResult(value: unknown, path: string) {
  const source = record(value, path);

  return source.ok === true ? projectSuccess(value, path) : projectFailure(value, path);
}

const projectResponse = objectOf({
  ok: boolean,
  project: text,
  action: projectAction,
  results: listOf(projectResult),
});
const pruneSuccess = objectOf({
  removed: numeric,
  freed: numeric,
});
const pruneFailure = objectOf({
  removed: numeric,
  freed: numeric,
  error: text,
});

function pruneResult(value: unknown, path: string): DockerPruneItem {
  const source = record(value, path);

  return source.error === undefined ? pruneSuccess(value, path) : pruneFailure(value, path);
}

const logFrame = objectOf({
  stream: oneOf('stdout', 'stderr'),
  text,
});
const logs = objectOf({
  t: oneOf('log'),
  lines: listOf(logFrame),
});
const streamEnd = objectOf({ t: oneOf('end') });
const streamError = objectOf({
  t: oneOf('error'),
  message: text,
});
const statsMessage = objectOf({
  t: oneOf('stats'),
  at: text,
  items: mapOf(stats),
});

export type DockerPort = ReturnType<typeof port>;
export type DockerMount = ReturnType<typeof mount>;
export type DockerCompose = ReturnType<typeof compose>;
export type DockerContainer = ReturnType<typeof container>;
export type DockerProject = ReturnType<typeof project>;
export type DockerImage = ReturnType<typeof image>;
export type DockerVolume = ReturnType<typeof volume>;
export type DockerNetwork = ReturnType<typeof network>;
export type DockerCounts = ReturnType<typeof counts>;
export type DockerOverview = ReturnType<typeof overview>;
export type DockerHealth = ReturnType<typeof availableHealth> | ReturnType<typeof unavailableHealth>;
export type DockerUsageSummary = ReturnType<typeof usageSummary>;
export type DockerUsage = ReturnType<typeof usage>;
export type DockerStats = ReturnType<typeof stats>;
export type DockerStatsMap = Record<string, DockerStats>;
export type DockerOkResponse = ReturnType<typeof okResponse>;
export type DockerContainerAction = 'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'unpause';
export type DockerProjectAction = ReturnType<typeof projectAction>;
export type DockerProjectActionResponse = ReturnType<typeof projectResponse>;
export type DockerProjectActionItem = ReturnType<typeof projectResult>;
export type DockerPruneTarget = 'containers' | 'images' | 'volumes' | 'networks' | 'buildCache';
export type DockerPruneItem = ReturnType<typeof pruneSuccess> | ReturnType<typeof pruneFailure>;
export type DockerPruneReport = Partial<Record<DockerPruneTarget, DockerPruneItem>>;
export interface DockerPruneResponse {
  ok: true;
  report: DockerPruneReport;
}

export type DockerActionResult<Payload extends object = Record<never, never>> =
  | ({ ok: true } & Payload)
  | {
    ok: false;
    message: string;
  };

export type DockerLogFrame = ReturnType<typeof logFrame>;
export type DockerLogMessage = ReturnType<typeof logs> | ReturnType<typeof streamEnd>
  | ReturnType<typeof streamError>;
export type DockerStatsMessage = ReturnType<typeof statsMessage> | ReturnType<typeof streamError>;
export type DockerExecMessage = ReturnType<typeof streamError>;
export type DockerExecInput =
  | {
    t: 'in';
    d: string;
  }
  | {
    t: 'resize';
    cols: number;
    rows: number;
  };
export interface DockerStatsInput {
  t: 'watch';
  ids: string[];
}

/**
 * Успешное подключение и недоступный демон имеют разные обязательные поля.
 * Проверка дискриминанта не позволяет спутать отказ с пустым успешным ответом.
 */
export function parseDockerHealth(value: unknown): DockerHealth {
  const source = record(value, 'health');

  return source.available === true
    ? availableHealth(value, 'health')
    : unavailableHealth(value, 'health');
}

export function parseDockerOverview(value: unknown): DockerOverview {
  return overview(value, 'overview');
}

export function parseDockerUsage(value: unknown): DockerUsage {
  return usage(value, 'usage');
}

export function parseDockerOkResponse(value: unknown): DockerOkResponse {
  return okResponse(value, 'action');
}

export function parseDockerProjectActionResponse(value: unknown): DockerProjectActionResponse {
  return projectResponse(value, 'projectAction');
}

/**
 * Отчёт содержит только реально обработанные цели. Неизвестную цель отклоняем,
 * чтобы интерфейс не потерял часть результата при изменении серверного контракта.
 */
export function parseDockerPruneResponse(value: unknown): DockerPruneResponse {
  const source = record(value, 'prune');
  const report = record(source.report, 'prune.report');
  const decoded: DockerPruneReport = {};
  const target = oneOf('containers', 'images', 'volumes', 'networks', 'buildCache');

  okResponse(source, 'prune');

  for (const [key, item] of Object.entries(report)) {
    const name = target(key, 'prune.report.target');

    decoded[name] = pruneResult(item, `prune.report.${name}`);
  }

  return {
    ok: true,
    report: decoded,
  };
}

/**
 * Логи, конец потока и отказ проверяются отдельно. Произвольный JSON не попадает
 * в ленту и не интерпретируется как успешное сообщение другого вида.
 */
export function parseDockerLogMessage(value: unknown): DockerLogMessage {
  const source = record(value, 'logs');

  if (source.t === 'log') {
    return logs(value, 'logs');
  }

  if (source.t === 'end') {
    return streamEnd(value, 'logs');
  }

  return streamError(value, 'logs');
}

export function parseDockerStatsMessage(value: unknown): DockerStatsMessage {
  const source = record(value, 'stats');

  return source.t === 'stats' ? statsMessage(value, 'stats') : streamError(value, 'stats');
}

export function parseDockerExecMessage(value: unknown): DockerExecMessage {
  return streamError(value, 'exec');
}
