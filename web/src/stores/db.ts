// Состояние надзорного раздела баз: движки, профили подключений, живые сессии,
// лента запросов, схемы и журнал. Стор хранит только снимок — запросы, подписка на
// события и разбор отказов живут в операциях раздела (web/src/actions/db/).
//
// Сессия принадлежит серверу: здесь лежит её отражение, и закрытие вкладки ничего
// не завершает. Пароля в состоянии нет и быть не может — он уезжает и стирается.
import { defineStore } from 'pinia';

import type {
  DbAuditEntry,
  DbEngine,
  DbProfile,
  DbQuery,
  DbResult,
  DbSession,
} from '../../../shared/dbContracts.ts';
import type { SshSession } from '../../../shared/sshContracts.ts';

export interface DbProjectOption {
  id: string;
}

export interface DbStoreState {
  engines: DbEngine[];
  projects: DbProjectOption[];
  profiles: DbProfile[];
  sessions: DbSession[];
  sshSessions: SshSession[];
  queries: DbQuery[];
  audit: DbAuditEntry[];
  schemas: Record<string, DbResult>;
  loading: boolean;
  projectsLoading: boolean;
  error: string;
  projectsError: string;
  cancelNotice: string;
}

export const useDbStore = defineStore('db', {
  state: (): DbStoreState => ({
    engines: [],
    projects: [],
    profiles: [],
    sessions: [],
    sshSessions: [],
    queries: [],
    audit: [],
    schemas: {},
    loading: false,
    projectsLoading: false,
    error: '',
    projectsError: '',
    cancelNotice: '',
  }),

  actions: {
    /**
     * Свежий снимок раздела целиком. Движки, профили, сессии, запросы и журнал
     * приходят одним заходом: показывать сессии от прошлого ответа рядом со
     * свежими профилями значило бы обещать вкладку, которой уже нет.
     */
    setSnapshot(snapshot: {
      engines: DbEngine[];
      profiles: DbProfile[];
      sessions: DbSession[];
      queries: DbQuery[];
      audit: DbAuditEntry[];
    }) {
      this.engines = snapshot.engines;
      this.profiles = snapshot.profiles;
      this.sessions = snapshot.sessions;
      this.queries = snapshot.queries;
      this.audit = snapshot.audit;
      this.error = '';
    },

    setQueries(queries: DbQuery[]) {
      this.queries = queries;
    },

    setAudit(audit: DbAuditEntry[]) {
      this.audit = audit;
    },

    setProfiles(profiles: DbProfile[]) {
      this.profiles = profiles;
    },

    setLoading(loading: boolean) {
      this.loading = loading;
    },

    setError(message: string) {
      this.error = message;
    },

    setProjects(projects: DbProjectOption[]) {
      this.projects = projects;
      this.projectsError = '';
    },

    setProjectsLoading(loading: boolean) {
      this.projectsLoading = loading;
    },

    setProjectsError(message: string) {
      this.projectsError = message;
    },

    setSshSessions(sessions: SshSession[]) {
      this.sshSessions = sessions;
    },

    setCancelNotice(notice: string) {
      this.cancelNotice = notice;
    },

    /**
     * Открытая сессия. Тот же id заменяется целиком: сервер мог поднять поколение,
     * и старая запись обещала бы доступ агента, которого уже нет.
     */
    upsertSession(session: DbSession) {
      this.sessions = [
        ...this.sessions.filter((item) => item.id !== session.id),
        session,
      ];
    },

    /** Точечное обновление известной сессии: смена доступа агента не трогает список. */
    patchSession(id: string, patch: Partial<DbSession>) {
      const index = this.sessions.findIndex((item) => item.id === id);

      if (index >= 0) {
        this.sessions[index] = { ...this.sessions[index], ...patch } as DbSession;
      }
    },

    /** Закрытая сессия уходит вместе со своей схемой: она относилась именно к ней. */
    dropSession(id: string) {
      this.sessions = this.sessions.filter((item) => item.id !== id);
      delete this.schemas[id];
    },

    dropProfile(id: string) {
      this.profiles = this.profiles.filter((item) => item.id !== id);
    },

    setSchema(id: string, schema: DbResult) {
      this.schemas[id] = schema;
    },
  },
});

export default useDbStore;
