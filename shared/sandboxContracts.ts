// Контракт раздела «Песочницы»: нормализованные стенды, задания и журнал кокпита.
// Типы выводятся из декодеров, поэтому форма ответа и её проверка при получении
// JSON имеют один источник. Тем же декодером сервер читает собственный журнал
// подъёмов: повреждённая запись обязана отбрасываться, а не становиться состоянием.

import { contractDecoders } from './contractDecoders.ts';

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
  text,
} = contractDecoders((path) => {
  throw new SandboxContractError(path);
});

const sandboxRepo = objectOf({
  name: text,
  path: text,
  branch: text,
});

// Задание и запись журнала — одна форма: журнал добавляет к ней только то, что
// наружу не отдаётся. Общие поля объявлены один раз, иначе новое поле задания
// молча терялось бы на проводе или в журнале.
const jobFields = {
  task: text,
  profile: nullable(text),
  action: oneOf('up', 'down'),
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
  repos: listOf(sandboxRepo),
  standAlive: nullable(boolean),
  removable: boolean,
  removableReason: nullable(oneOf('pipeline_owned', 'job_running', 'unknown_owner')),
  updatedAt: nullable(text),
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

// Журнал кокпита — то же задание плюс то, что наружу не отдаётся: identity процесса
// подъёма и путь его вывода. Runtime identifiers остаются на сервере.
const sandboxJournalRecord = objectOf({
  ...jobFields,
  pid: nullable(numeric),
  starttime: nullable(text),
  cmdline: nullable(text),
  log: text,
});

export type SandboxRepo = ReturnType<typeof sandboxRepo>;
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
