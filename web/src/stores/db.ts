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
  DbEngineMetadata,
  DbProfile,
  DbQuery,
  DbResult,
  DbSession,
} from '../../../shared/plugins/db/dbContracts.ts';
import type { SshSession } from '../../../shared/plugins/ssh/sshContracts.ts';

// Признак архива приходит с сервера вместе со списком: форма по нему решает,
// можно ли заводить на проект новый профиль базы.
export interface DbProjectOption {
  id: string;
  archivedAt?: string | null;
}

export interface DbStoreState {
  engines: DbEngine[];
  engineErrors: DbEngineMetadata['errors'];
  engineInstalls: DbEngineMetadata['installs'];
  installHealth: DbEngineMetadata['installHealth'];
  projects: DbProjectOption[];
  profiles: DbProfile[];
  sessions: DbSession[];
  sshSessions: SshSession[];
  queries: DbQuery[];
  audit: DbAuditEntry[];
  auditError: string;
  auditSkippedRecords: number;
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
    engineErrors: [],
    engineInstalls: {},
    installHealth: null,
    projects: [],
    profiles: [],
    sessions: [],
    sshSessions: [],
    queries: [],
    audit: [],
    auditError: '',
    auditSkippedRecords: 0,
    schemas: {},
    loading: false,
    projectsLoading: false,
    error: '',
    projectsError: '',
    cancelNotice: '',
  }),

  actions: {
    /**
     * Движки, профили, сессии и запросы заменяются согласованным снимком.
     * Журнал может сохранять последний прочитанный ответ при отдельной ошибке аудита,
     * которая не должна скрывать действующие подключения.
     */
    setSnapshot(snapshot: {
      engines: DbEngine[];
      engineErrors?: DbStoreState['engineErrors'];
      engineInstalls?: DbStoreState['engineInstalls'];
      installHealth?: DbStoreState['installHealth'];
      profiles: DbProfile[];
      sessions: DbSession[];
      queries: DbQuery[];
      audit: DbAuditEntry[];
      auditSkippedRecords?: number;
    }) {
      this.engines = snapshot.engines;
      this.engineErrors = snapshot.engineErrors ?? [];
      this.engineInstalls = snapshot.engineInstalls ?? {};
      this.installHealth = snapshot.installHealth ?? null;
      this.profiles = snapshot.profiles;
      this.sessions = snapshot.sessions;
      this.queries = snapshot.queries;
      this.audit = snapshot.audit;
      this.auditSkippedRecords = snapshot.auditSkippedRecords ?? 0;
      this.auditError = '';
      this.error = '';
    },

    setQueries(queries: DbQuery[]) {
      this.queries = queries;
    },

    setAudit(audit: DbAuditEntry[], skippedRecords = 0) {
      this.audit = audit;
      this.auditSkippedRecords = skippedRecords;
      this.auditError = '';
    },

    setAuditError(message: string) {
      this.auditError = message;
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
