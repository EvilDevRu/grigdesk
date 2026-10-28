// Контракт раздела «Песочницы»: нормализованные стенды, задания и журнал GrigDesk.
// Типы выводятся из декодеров, поэтому форма ответа и её проверка при получении
// JSON имеют один источник. Тем же декодером сервер читает собственный журнал
// подъёмов: повреждённая запись обязана отбрасываться, а не становиться состоянием.

import { contractDecoders } from '../../lib/contractDecoders.ts';

/**
 * Форма номера стенда. Общая для обеих сторон: HTTP не доверяет телу запроса,
 * библиотека — вызывающему, а форма подъёма обязана отклонять ровно то же, что
 * отклонит сервер, иначе человек получает отказ уже после подтверждения.
 */
export const SANDBOX_TASK_RE = /^[1-9][0-9]{0,18}$/;

export class SandboxContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ раздела «Песочницы»: поле ${path}`);
    this.name = 'SandboxContractError';
  }
}

const {
  boolean,
  listOf,
  nullable,
  numeric,
  objectOf,
  oneOf,
  optional,
  text,
} = contractDecoders((path) => {
  throw new SandboxContractError(path);
});

const sandboxRepo = objectOf({
  name: text,
  path: text,
  branch: text,
});

/**
 * Форма идентификатора действия профиля и ключа его аргумента: они подставляются в
 * путь маршрута и в имя файла журнала, поэтому обе стороны сверяют одну и ту же
 * форму до того, как что-то запустится.
 */
export const SANDBOX_ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// Аргумент действия — то, что человек вводит перед запуском: номер проекта, имя.
// Тип закрыт перечислением: по нему карточка выбирает поле, а сервер — проверку.
const sandboxActionArg = objectOf({
  key: text,
  label: text,
  type: oneOf('number', 'text'),
  required: boolean,
  hint: optional(text),
});

// Действие профиля над поднятым стендом: прогон, который профиль объявил рядом со
// своими up.sh/down.sh. Карточка знает о нём ровно столько, чтобы спросить аргументы
// и подтвердить запуск; что именно делает скрипт, объясняет описание профиля.
const sandboxActionDecl = objectOf({
  id: text,
  label: text,
  description: text,
  args: listOf(sandboxActionArg),
  confirm: nullable(text),
});

// Задание и запись журнала — одна форма: журнал добавляет к ней только то, что
// наружу не отдаётся. Общие поля объявлены один раз, иначе новое поле задания
// молча терялось бы на проводе или в журнале.
const jobFields = {
  task: text,
  profile: nullable(text),
  // `run` — действие профиля: его id и подпись едут рядом, старые записи журнала и
  // сохранённые fixtures их не знают, поэтому оба поля необязательны.
  action: oneOf('up', 'down', 'run'),
  actionId: optional(text),
  actionLabel: optional(text),
  state: oneOf('running', 'done', 'failed'),
  index: numeric,
  total: numeric,
  label: text,
  message: text,
  startedAt: text,
  finishedAt: nullable(text),
};

const sandboxJob = objectOf(jobFields);

// Причина, по которой стенд не сносится из раздела, считается на сервере: клиенту
// нечем её угадать, а угаданная разошлась бы с настоящим отказом ручки.
const sandboxEntry = objectOf({
  task: text,
  profile: nullable(text),
  owner: oneOf('manual', 'pipeline'),
  slot: nullable(numeric),
  fePort: nullable(numeric),
  apiPort: nullable(numeric),
  serviceHost: optional(text),
  repos: listOf(sandboxRepo),
  standAlive: nullable(boolean),
  // Новые признаки необязательны на проводе: старый сервер и сохранённые fixtures
  // продолжают читаться, а null означает, что отдельной проверки ещё не было.
  feAlive: optional(boolean),
  profileBinding: optional(oneOf('verified', 'inferred')),
  removable: boolean,
  removableReason: nullable(oneOf('pipeline_owned', 'job_running', 'unknown_owner')),
  updatedAt: nullable(text),
  // Действия профиля этого стенда; старый сервер поля не знает — тогда их просто нет.
  actions: optional(listOf(sandboxActionDecl)),
});

const sandboxProfile = objectOf({
  id: text,
  canRaise: boolean,
  reason: nullable(text),
});

const sandboxOverview = objectOf({
  profiles: listOf(sandboxProfile),
  sandboxes: listOf(sandboxEntry),
  jobs: listOf(sandboxJob),
  manualRange: objectOf({
    from: numeric,
    to: numeric,
  }),
});

const sandboxAction = objectOf({
  task: text,
  job: sandboxJob,
});

// Вывод задания стенда: хвост журнала процесса, обрезанный сервером до разумного
// размера, и признак обрезки — чтобы карточка честно сказала «показано не всё».
const sandboxJobLog = objectOf({
  task: text,
  action: oneOf('up', 'down', 'run'),
  state: oneOf('running', 'done', 'failed'),
  text,
  truncated: boolean,
});

// Журнал GrigDesk — то же задание плюс то, что наружу не отдаётся: identity процесса
// подъёма и путь его вывода. Runtime identifiers остаются на сервере.
const sandboxJournalRecord = objectOf({
  ...jobFields,
  pid: nullable(numeric),
  starttime: nullable(text),
  cmdline: nullable(text),
  log: text,
});

export type SandboxRepo = ReturnType<typeof sandboxRepo>;
export type SandboxActionArg = ReturnType<typeof sandboxActionArg>;
export type SandboxActionDecl = ReturnType<typeof sandboxActionDecl>;
export type SandboxJobLog = ReturnType<typeof sandboxJobLog>;
export type SandboxJob = ReturnType<typeof sandboxJob>;
export type SandboxEntry = ReturnType<typeof sandboxEntry>;
export type SandboxProfile = ReturnType<typeof sandboxProfile>;
export type SandboxOverview = ReturnType<typeof sandboxOverview>;
export type SandboxActionResponse = ReturnType<typeof sandboxAction>;
export type SandboxJournalRecord = ReturnType<typeof sandboxJournalRecord>;

export function parseSandboxOverview(value: unknown): SandboxOverview {
  return sandboxOverview(value, 'overview');
}

export function parseSandboxAction(value: unknown): SandboxActionResponse {
  return sandboxAction(value, 'action');
}

export function parseSandboxJob(value: unknown): SandboxJob {
  return sandboxJob(value, 'job');
}

export function parseSandboxJobLog(value: unknown): SandboxJobLog {
  return sandboxJobLog(value, 'log');
}

/**
 * Объявление действия профиля читается из его манифеста тем же декодером, что и
 * ответ сервера: кривой манифест отбрасывается на сервере, а не доезжает до карточки.
 */
export function parseSandboxActionDecl(value: unknown, path = 'action'): SandboxActionDecl {
  return sandboxActionDecl(value, path);
}

export function parseSandboxJournalRecord(value: unknown): SandboxJournalRecord {
  return sandboxJournalRecord(value, 'journal');
}

/**
 * Проекция журнальной записи в публичное задание: identity процесса и путь журнала
 * остаются на сервере, наружу уходит только то, что показывает карточка стенда.
 */
export function toSandboxJob(source: SandboxJournalRecord): SandboxJob {
  const {
    pid, starttime, cmdline, log, ...job
  } = source;

  return job;
}
