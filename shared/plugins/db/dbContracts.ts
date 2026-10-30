// Контракт надзорного раздела баз данных. Здесь встречаются две разные вещи, и
// смешивать их нельзя: описание того, куда открыт доступ (профили, сессии, движки,
// журнал) — это данные GrigDesk, а строки ответа — данные чужой базы.
//
// Строки не описываются формой намеренно. Их содержимое произвольно и недоверенно:
// сервер уже снял с них управляющие последовательности и ограничил объём, а раздел
// показывает их текстом. Придумать им схему значило бы обещать то, чего нет.

import { contractDecoders } from '../../lib/contractDecoders.ts';
import type { Decoder } from '../../lib/contractDecoders.ts';

export class DbContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ баз данных: поле ${path}`);
    this.name = 'DbContractError';
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
  record,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new DbContractError(path);
});

/**
 * Значение из чужой базы. Форму ему здесь не назначают — это данные, а не контракт:
 * колонка может оказаться числом, строкой, датой или вложенным объектом, и раздел
 * рисует её как текст, не полагаясь на тип.
 */
const cellValue: Decoder<unknown> = (value) => value;

// Роль подключения решает, что вообще разрешено: чтение или запись. Значение по
// умолчанию тут опасно, поэтому набор закрыт.
const profileRole = oneOf('read', 'write');
const profileVia = oneOf('direct', 'ssh');

const dbProfile = objectOf({
  id: text,
  projectId: text,
  label: text,
  role: profileRole,
  engine: text,
  host: text,
  port: wholeNumber,
  user: text,
  database: text,
  prod: boolean,
  via: profileVia,
});

// Движок объявляет себя сам, и его возможности читает только сервер: раздел берёт
// отсюда идентификатор и название для списка.
const dbEngine = objectOf({
  id: text,
  label: text,
  capabilities: optional(record),
});

const dbSession = objectOf({
  id: text,
  profileId: text,
  projectId: text,
  label: text,
  role: profileRole,
  engine: text,
  prod: boolean,
  via: profileVia,
  agentAllowed: boolean,
  generation: wholeNumber,
  readOnlyActive: boolean,
  openedAt: text,
});

/**
 * Ограниченный ответ базы. Показанное и настоящее разведены нарочно: при обрыве
 * запроса полного счёта не существует вовсе, и подставлять вместо него показанное
 * значило бы выдать кусок за весь результат.
 */
const dbResult = objectOf({
  rows: listOf(cellValue),
  shownRows: wholeNumber,
  totalRows: nullable(wholeNumber),
  shownBytes: wholeNumber,
  totalBytes: nullable(wholeNumber),
  truncated: boolean,
  untrusted: boolean,
  notice: optional(text),
});

const failedResult = objectOf({
  ok: oneOf(false),
  error: text,
  message: optional(text),
});

const queryState = oneOf('checking', 'waiting', 'running', 'done', 'denied', 'error', 'cancelled');

/**
 * Результат запроса приходит одной из двух форм: ограниченный ответ базы или отказ с
 * машинным кодом. Различать их обязательно — «ноль строк» и «запрос не выполнился»
 * выглядят на экране одинаково, а значат противоположное.
 */
function queryResult(value: unknown, path: string): DbResult | DbFailedResult | null {
  if (value === null || value === undefined) {
    return null;
  }

  return record(value, path).ok === false
    ? failedResult(value, path)
    : dbResult(value, path);
}

const dbQuery = objectOf({
  id: text,
  sessionId: text,
  actor: oneOf('human', 'agent'),
  text,
  queryClass: optional(text),
  tables: optional(listOf(text)),
  state: queryState,
  error: optional(text),
  startedAt: text,
  finishedAt: optional(text),
  result: queryResult,
});

// Запись журнала. Поля появляются по мере того, как о них становится известно:
// отклонённый запрос не имеет ни строк, ни объёма, и нули вместо них лгали бы.
const auditEntry = objectOf({
  at: text,
  projectId: optional(text),
  sessionId: optional(text),
  profileId: optional(text),
  actor: optional(oneOf('human', 'agent')),
  query: optional(text),
  queryClass: optional(text),
  tables: optional(listOf(text)),
  decision: optional(text),
  outcome: optional(text),
  durationMs: optional(numeric),
  rows: optional(numeric),
  bytes: optional(numeric),
  truncated: optional(boolean),
  error: optional(text),
});

const engineList = objectOf({ engines: listOf(dbEngine) });
const profileList = objectOf({ profiles: listOf(dbProfile) });
const sessionList = objectOf({ sessions: listOf(dbSession) });
const sessionOpened = objectOf({ session: dbSession });
const queryList = objectOf({ queries: listOf(dbQuery) });
const queryStarted = objectOf({ queryId: text });
const schemaAnswer = objectOf({ schema: dbResult });
const auditPage = objectOf({
  items: listOf(auditEntry),
  nextCursor: optional(wholeNumber),
  skippedRecords: optional(wholeNumber),
});
const acknowledgement = objectOf({ ok: boolean });
// Архивный проект новому профилю не предлагается, но у заведённых он читается:
// признак архива приходит с сервера, а не додумывается формой.
const projectList = objectOf({
  projects: listOf(objectOf({ id: text, archivedAt: optional(text) })),
});

export type DbProfile = ReturnType<typeof dbProfile>;
export type DbEngine = ReturnType<typeof dbEngine>;
export type DbSession = ReturnType<typeof dbSession>;
export type DbResult = ReturnType<typeof dbResult>;
export type DbFailedResult = ReturnType<typeof failedResult>;
export type DbQuery = ReturnType<typeof dbQuery>;
export type DbAuditEntry = ReturnType<typeof auditEntry>;
export type DbAuditPage = ReturnType<typeof auditPage>;
export type DbProject = ReturnType<typeof projectList>['projects'][number];

export interface DbAccess {
  session: DbSession | null;
  error: string | null;
}

// Отмена запроса отвечает способом, которым его удалось снять: отдельной командой
// или закрытием соединения. Второе означает, что сессии больше нет.
export interface DbCancelOutcome {
  ok: boolean;
  method: string | null;
  error: string | null;
}

export interface DbProfileInput {
  id?: string;
  projectId: string;
  label: string;
  role: string;
  engine: string;
  host: string;
  port: number;
  user: string;
  database: string;
  prod: boolean;
  via: string;
}

export function parseDbEngines(value: unknown): DbEngine[] {
  return engineList(value, 'dbEngines').engines;
}

export function parseDbProfiles(value: unknown): DbProfile[] {
  return profileList(value, 'dbProfiles').profiles;
}

export function parseDbProfile(value: unknown): DbProfile {
  return dbProfile(value, 'dbProfile');
}

export function parseDbSessions(value: unknown): DbSession[] {
  return sessionList(value, 'dbSessions').sessions;
}

export function parseDbSessionOpened(value: unknown): DbSession {
  return sessionOpened(value, 'dbSessionOpened').session;
}

export function parseDbQueries(value: unknown): DbQuery[] {
  return queryList(value, 'dbQueries').queries;
}

export function parseDbQueryStarted(value: unknown): string {
  return queryStarted(value, 'dbQueryStarted').queryId;
}

export function parseDbSchema(value: unknown): DbResult {
  return schemaAnswer(value, 'dbSchema').schema;
}

export function parseDbAuditPage(value: unknown): DbAuditPage {
  return auditPage(value, 'dbAuditPage');
}

export function parseDbAcknowledgement(value: unknown): boolean {
  return acknowledgement(value, 'dbAcknowledgement').ok;
}

export function parseDbProjects(value: unknown): DbProject[] {
  return projectList(value, 'dbProjects').projects;
}

/**
 * Смена доступа агента отвечает одной ручкой на два исхода: живая сессия приходит
 * целиком, а потерянная — машинным кодом отказа. Раздел обязан их различать, иначе
 * строка отказа встала бы в список сессий на месте живой записи.
 */
export function parseDbAccess(value: unknown): DbAccess {
  const source = record(value, 'dbAccess');

  if (source.ok === false) {
    return { session: null, error: text(source.error, 'dbAccess.error') };
  }

  return { session: dbSession(value, 'dbAccess'), error: null };
}

/**
 * Исход отмены. Способ важен человеку: снятое вместе с соединением означает, что
 * сессию придётся открывать заново, а не просто повторить запрос.
 */
export function parseDbCancel(value: unknown): DbCancelOutcome {
  const source = record(value, 'dbCancel');

  if (source.ok === true) {
    return {
      ok: true,
      method: source.method === undefined ? null : text(source.method, 'dbCancel.method'),
      error: null,
    };
  }

  return {
    ok: false,
    method: null,
    error: source.error === undefined ? null : text(source.error, 'dbCancel.error'),
  };
}
