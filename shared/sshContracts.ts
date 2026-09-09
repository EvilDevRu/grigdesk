// Контракт раздела SSH. Здесь сходятся два разных источника: описание соединения и
// сессии собирает сам сервер, а журнал команд агента и список файлов приходят с чужой
// машины. Ключ хоста и решение по нему — рубеж доверия: подменённый статус означал бы
// пароль root, отданный тому, кто первым ответил на адрес, поэтому перечисления здесь
// закрыты, а не «строка на всякий случай».

import { contractDecoders } from './contractDecoders.ts';

export class SshContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ SSH: поле ${path}`);
    this.name = 'SshContractError';
  }
}

const {
  boolean,
  listOf,
  numeric,
  objectOf,
  oneOf,
  optional,
  record,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new SshContractError(path);
});

const sshConnection = objectOf({
  id: text,
  projectId: text,
  label: text,
  role: text,
  host: text,
  port: wholeNumber,
  user: text,
});

// Сессией владеет сервер, а не вкладка: `generation` растёт на каждой смене доступа
// агента и на потере соединения, и по нему решение человека сверяется с реальностью.
const sshSession = objectOf({
  id: text,
  connectionId: text,
  projectId: text,
  label: text,
  role: text,
  host: text,
  port: wholeNumber,
  user: text,
  agentAllowed: boolean,
  generation: wholeNumber,
  openedAt: text,
});

const hostKeyCurrent = objectOf({
  host: text,
  port: wholeNumber,
  algorithm: text,
  fingerprint: text,
});

const hostKeyTrusted = objectOf({
  host: text,
  port: wholeNumber,
  algorithm: text,
  fingerprint: text,
  trustedAt: optional(text),
});

// Три состояния ключа хоста и три требования к человеку. `changed` — не «новый сервер»,
// а замена ключа у известного адреса, и разрешение на неё отдельное.
const hostKeyCheck = objectOf({
  status: oneOf('trusted', 'unknown', 'changed'),
  decision: oneOf('accepted', 'trust_required', 'replace_required'),
  challengeId: optional(text),
  previous: optional(hostKeyTrusted),
  current: hostKeyCurrent,
});

const hostKeyDecision = objectOf({
  ok: boolean,
  hostKey: hostKeyTrusted,
});

// Ограниченный вывод команды: журнал хранит его вместе со счётом байт, потому что
// показанный кусок и настоящий размер — разные вещи, и человек должен видеть обрезку.
const auditOutput = objectOf({
  text,
  shownBytes: wholeNumber,
  totalBytes: wholeNumber,
  truncated: boolean,
  notice: text,
});

/**
 * Запись журнала. Поля, кроме времени, необязательны намеренно: сервер пишет только
 * то, что знает о конкретном решении, а отказ до запуска команды не имеет ни кода
 * возврата, ни вывода.
 */
const auditEntry = objectOf({
  at: text,
  projectId: optional(text),
  connectionId: optional(text),
  sessionId: optional(text),
  label: optional(text),
  role: optional(text),
  host: optional(text),
  user: optional(text),
  command: optional(text),
  decision: optional(oneOf('allow', 'deny')),
  comment: optional(text),
  result: optional(text),
  exitCode: optional(numeric),
  signal: optional(text),
  output: optional(auditOutput),
});

const sshFile = objectOf({
  name: text,
  type: oneOf('directory', 'file'),
  size: wholeNumber,
  mtime: numeric,
});

const connectionList = objectOf({ connections: listOf(sshConnection) });
const sessionList = objectOf({ sessions: listOf(sshSession) });
const sessionOpened = objectOf({ session: sshSession });
const fileList = objectOf({ files: listOf(sshFile) });
const auditPage = objectOf({
  items: listOf(auditEntry),
  nextCursor: optional(wholeNumber),
});
const acknowledgement = objectOf({ ok: boolean });
const projectList = objectOf({ projects: listOf(objectOf({ id: text })) });

export type SshConnection = ReturnType<typeof sshConnection>;
export type SshSession = ReturnType<typeof sshSession>;
export type SshHostKeyCheck = ReturnType<typeof hostKeyCheck>;
export type SshHostKeyDecision = ReturnType<typeof hostKeyDecision>;
export type SshAuditEntry = ReturnType<typeof auditEntry>;
export type SshFile = ReturnType<typeof sshFile>;
export type SshAuditPage = ReturnType<typeof auditPage>;
export type SshProject = ReturnType<typeof projectList>['projects'][number];

export interface SshAccess {
  session: SshSession | null;
  error: string | null;
}

export interface SshConnectionInput {
  id?: string;
  projectId: string;
  label: string;
  role: string;
  host: string;
  port: number;
  user: string;
}

export function parseSshConnections(value: unknown): SshConnection[] {
  return connectionList(value, 'sshConnections').connections;
}

export function parseSshConnection(value: unknown): SshConnection {
  return sshConnection(value, 'sshConnection');
}

export function parseSshSessions(value: unknown): SshSession[] {
  return sessionList(value, 'sshSessions').sessions;
}

export function parseSshSessionOpened(value: unknown): SshSession {
  return sessionOpened(value, 'sshSessionOpened').session;
}

export function parseSshHostKeyCheck(value: unknown): SshHostKeyCheck {
  return hostKeyCheck(value, 'sshHostKeyCheck');
}

export function parseSshHostKeyDecision(value: unknown): SshHostKeyDecision {
  return hostKeyDecision(value, 'sshHostKeyDecision');
}

export function parseSshAuditPage(value: unknown): SshAuditPage {
  return auditPage(value, 'sshAuditPage');
}

export function parseSshFiles(value: unknown): SshFile[] {
  return fileList(value, 'sshFiles').files;
}

export function parseSshAcknowledgement(value: unknown): boolean {
  return acknowledgement(value, 'sshAcknowledgement').ok;
}

export function parseSshProjects(value: unknown): SshProject[] {
  return projectList(value, 'sshProjects').projects;
}

/**
 * Смена доступа агента отвечает одной ручкой на два разных исхода: живая сессия
 * возвращается целиком, а потерянная — машинным кодом отказа. Раздел обязан их
 * различать, иначе строка отказа въехала бы в список сессий на месте живой записи.
 */
export function parseSshAccess(value: unknown): SshAccess {
  const source = record(value, 'sshAccess');

  if (source.ok === false) {
    return { session: null, error: text(source.error, 'sshAccess.error') };
  }

  return { session: sshSession(value, 'sshAccess'), error: null };
}
