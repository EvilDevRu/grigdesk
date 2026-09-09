import { api } from './api-client.js';
import {
  parseSshAccess,
  parseSshAcknowledgement,
  parseSshAuditPage,
  parseSshConnection,
  parseSshConnections,
  parseSshFiles,
  parseSshHostKeyCheck,
  parseSshHostKeyDecision,
  parseSshProjects,
  parseSshSessionOpened,
  parseSshSessions,
} from '../../../shared/sshContracts.ts';
import type { SshConnectionInput } from '../../../shared/sshContracts.ts';

const AUDIT_LIMIT = 50;

function connectionPath(id: string, suffix = ''): string {
  return `/api/ssh/connections/${encodeURIComponent(id)}${suffix}`;
}

function sessionPath(id: string, suffix = ''): string {
  return `/api/ssh/sessions/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Единственная граница сети раздела SSH. Проверка здесь не формальность: по ответу
 * probe человек решает, доверять ли ключу сервера, а по списку сессий — кому открыт
 * доступ агента. Непроверенная форма превратила бы «ключ изменился» в пустое место.
 */
export const sshApi = {
  async connections() {
    const value: unknown = await api.get('/api/ssh/connections');

    return parseSshConnections(value);
  },

  async projects() {
    const value: unknown = await api.get('/api/projects');

    return parseSshProjects(value);
  },

  async sessions() {
    const value: unknown = await api.get('/api/ssh/sessions');

    return parseSshSessions(value);
  },

  async audit() {
    const value: unknown = await api.get(`/api/ssh/audit?limit=${AUDIT_LIMIT}`);

    return parseSshAuditPage(value);
  },

  async saveConnection(connection: SshConnectionInput) {
    const value: unknown = connection.id
      ? await api.put(connectionPath(connection.id), connection)
      : await api.post('/api/ssh/connections', connection);

    return parseSshConnection(value);
  },

  async probeHostKey(connectionId: string) {
    const value: unknown = await api.post(connectionPath(connectionId, '/host-key/probe'), {});

    return parseSshHostKeyCheck(value);
  },

  async decideHostKey(challengeId: string, decision: 'trust' | 'replace') {
    const path = `/api/ssh/host-key/${encodeURIComponent(challengeId)}`;
    const value: unknown = await api.post(path, { decision });

    return parseSshHostKeyDecision(value);
  },

  /**
   * Пароль уезжает сырыми байтами отдельным типом тела. JSON-сериализация оставила бы
   * его в строке, а строка переживает и повторную отправку, и лог транспорта.
   */
  async openSession(connectionId: string, password: string) {
    const bytes = new TextEncoder().encode(String(password || ''));
    const value: unknown = await api.postBytes(connectionPath(connectionId, '/sessions'), bytes);

    return parseSshSessionOpened(value);
  },

  async setAgentAccess(sessionId: string, allowed: boolean) {
    const value: unknown = await api.put(sessionPath(sessionId, '/agent-access'), { allowed });

    return parseSshAccess(value);
  },

  async closeSession(sessionId: string) {
    const value: unknown = await api.del(sessionPath(sessionId));

    return parseSshAcknowledgement(value);
  },

  async files(sessionId: string, remotePath: string) {
    const query = `?path=${encodeURIComponent(remotePath)}`;
    const value: unknown = await api.get(sessionPath(sessionId, `/files${query}`));

    return parseSshFiles(value);
  },

  downloadUrl(sessionId: string, remotePath: string): string {
    const query = `?path=${encodeURIComponent(remotePath)}`;

    return api.url(sessionPath(sessionId, `/files/download${query}`));
  },

  /**
   * Загрузка файла на сервер. Путь едет отдельным полем формы: имя файла на машине
   * человека и место на сервере — разные вещи, и совпадать они не обязаны.
   */
  async uploadFile(sessionId: string, file: File, remotePath: string) {
    const form = new FormData();

    form.append('path', remotePath || file.name);
    form.append('file', file);

    const value: unknown = await api.upload(sessionPath(sessionId, '/files/upload'), form);

    return parseSshAcknowledgement(value);
  },

  terminalUrl(sessionId: string): string {
    return api.wsUrl(sessionPath(sessionId, '/terminal'));
  },

  hasTerminalUrl(): boolean {
    return typeof api.wsUrl === 'function';
  },
};

/**
 * Текст отказа для человека. Сервер SSH отвечает машинным кодом, а обрыв сети приходит
 * без тела вовсе — тогда остаётся сообщение самой ошибки транспорта.
 */
export function sshErrorMessage(error: unknown, fallback: string): string {
  const message = error !== null && typeof error === 'object'
    ? (error as { message?: unknown }).message
    : undefined;

  return typeof message === 'string' && message ? message : fallback;
}
