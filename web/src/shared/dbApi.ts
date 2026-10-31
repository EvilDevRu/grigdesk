import { decodeInstallInfo } from './pluginInstallApi.ts';

import { api } from './apiClient.ts';
import {
  parseDbAccess,
  parseDbAcknowledgement,
  parseDbAuditPage,
  parseDbCancel,
  parseDbEngines,
  parseDbEngineSnapshot,
  parseDbProfile,
  parseDbProfiles,
  parseDbProjects,
  parseDbQueries,
  parseDbQueryStarted,
  parseDbSchema,
  parseDbSessionOpened,
  parseDbSessions,
} from '../../../shared/plugins/db/dbContracts.ts';
import type { DbProfileInput } from '../../../shared/plugins/db/dbContracts.ts';
import { parseSshSessions } from '../../../shared/plugins/ssh/sshContracts.ts';

function profilePath(id: string, suffix = ''): string {
  return `/api/db/profiles/${encodeURIComponent(id)}${suffix}`;
}

function sessionPath(id: string, suffix = ''): string {
  return `/api/db/sessions/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Единственная граница сети надзорного раздела баз. Проверка здесь не формальность:
 * по списку сессий человек видит, кому открыт доступ агента, а по состоянию запроса —
 * идёт он ещё или уже снят. Непроверенная форма превратила бы это в пустое место.
 */
export const dbApi = {
  async engines() {
    const value: unknown = await api.get('/api/db/engines');

    return parseDbEngines(value);
  },

  async engineSnapshot() {
    const snapshot = parseDbEngineSnapshot(await api.get('/api/db/engines'));
    const installs = Object.fromEntries(Object.entries(snapshot.installs).map(([id, value]) => [
      id, value === null ? null : decodeInstallInfo(value),
    ]));

    return { ...snapshot, installs };
  },

  async profiles() {
    const value: unknown = await api.get('/api/db/profiles');

    return parseDbProfiles(value);
  },

  async projects() {
    const value: unknown = await api.get('/api/projects');

    return parseDbProjects(value);
  },

  async sessions() {
    const value: unknown = await api.get('/api/db/sessions');

    return parseDbSessions(value);
  },

  /**
   * Открытые SSH-сессии нужны профилю, идущему через туннель. Список принадлежит
   * разделу SSH, поэтому и проверяется его контрактом: у формы один владелец.
   */
  async sshSessions() {
    const value: unknown = await api.get('/api/ssh/sessions');

    return parseSshSessions(value);
  },

  async queries() {
    const value: unknown = await api.get('/api/db/queries');

    return parseDbQueries(value);
  },

  async audit() {
    const value: unknown = await api.get('/api/db/audit');

    return parseDbAuditPage(value);
  },

  async saveProfile(profile: DbProfileInput) {
    const value: unknown = profile.id
      ? await api.put(profilePath(profile.id), profile)
      : await api.post('/api/db/profiles', profile);

    return parseDbProfile(value);
  },

  async deleteProfile(id: string) {
    const value: unknown = await api.del(profilePath(id));

    return parseDbAcknowledgement(value);
  },

  /**
   * Вход паролем. Пароль уезжает сырыми байтами и стирается из памяти сразу после
   * отправки; профиль через туннель дополнительно называет свою SSH-сессию, и её
   * выбирает человек, а не сервер.
   */
  async openSession(profileId: string, password: string, sshSessionId = '') {
    const bytes = new TextEncoder().encode(String(password || ''));
    const options = sshSessionId
      ? { headers: { 'x-grigdesk-ssh-session-id': sshSessionId } }
      : undefined;

    try {
      const value: unknown = await api.postBytes(
        profilePath(profileId, '/sessions'),
        bytes,
        options,
      );

      return parseDbSessionOpened(value);
    } finally {
      bytes.fill(0);
    }
  },

  async closeSession(id: string) {
    const value: unknown = await api.del(sessionPath(id));

    return parseDbAcknowledgement(value);
  },

  async setAgentAccess(id: string, allowed: boolean) {
    const value: unknown = await api.put(sessionPath(id, '/agent-access'), { allowed });

    return parseDbAccess(value);
  },

  async schema(id: string) {
    const value: unknown = await api.get(sessionPath(id, '/schema'));

    return parseDbSchema(value);
  },

  /**
   * Запуск запроса отвечает только его идентификатором: сам ответ базы приходит
   * позже живой лентой, а запрос может идти минутами.
   */
  async runQuery(id: string, text: string, params: unknown[] = []) {
    const value: unknown = await api.post(sessionPath(id, '/query'), { text, params });

    return parseDbQueryStarted(value);
  },

  async cancelQuery(id: string) {
    const path = `/api/db/queries/${encodeURIComponent(id)}/cancel`;
    const value: unknown = await api.post(path, {});

    return parseDbCancel(value);
  },
};
