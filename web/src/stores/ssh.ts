// Состояние раздела SSH: сохранённые серверы, живые сессии, файлы открытого каталога
// и журнал команд агента. Стор хранит только снимок — запросы, канал терминала и
// разбор отказов живут в операциях раздела (web/src/actions/ssh/).
//
// Сессия принадлежит серверу, а не вкладке: здесь лежит лишь её отражение, и закрытие
// вкладки ничего не завершает.
import { defineStore } from 'pinia';

import type {
  SshAuditEntry,
  SshConnection,
  SshFile,
  SshSession,
} from '../../../shared/plugins/ssh/sshContracts.ts';

// Признак архива приходит с сервера вместе со списком: форма по нему решает,
// можно ли заводить на проект новую связь.
export interface SshProjectOption {
  id: string;
  archivedAt?: string | null;
}

type SshTerminalStatus = 'idle' | 'connecting' | 'ready' | 'detached';
type SshFilesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SshStoreState {
  connections: SshConnection[];
  projects: SshProjectOption[];
  sessions: SshSession[];
  activeId: string;
  terminalStatus: SshTerminalStatus;
  files: SshFile[];
  filesStatus: SshFilesStatus;
  filesError: string;
  filesRevision: number;
  remotePath: string;
  audit: SshAuditEntry[];
  loading: boolean;
  projectsLoading: boolean;
  error: string;
  projectsError: string;
}

export const useSshStore = defineStore('ssh', {
  state: (): SshStoreState => ({
    connections: [],
    projects: [],
    sessions: [],
    activeId: '',
    terminalStatus: 'idle',
    files: [],
    filesStatus: 'idle',
    filesError: '',
    filesRevision: 0,
    remotePath: '.',
    audit: [],
    loading: false,
    projectsLoading: false,
    error: '',
    projectsError: '',
  }),

  getters: {
    activeSession(state): SshSession | null {
      return state.sessions.find((session) => session.id === state.activeId) || null;
    },
  },

  actions: {
    /**
     * Свежий снимок раздела целиком. Соединения, сессии и журнал приходят одним
     * заходом: показывать сессии от прошлого ответа рядом со свежими серверами
     * значило бы показывать вкладку сессии, которой уже нет.
     */
    setSnapshot(snapshot: {
      connections: SshConnection[];
      sessions: SshSession[];
      audit: SshAuditEntry[];
    }) {
      this.connections = snapshot.connections;
      this.sessions = snapshot.sessions;
      this.audit = snapshot.audit;
      this.error = '';
    },

    setAudit(audit: SshAuditEntry[]) {
      this.audit = audit;
    },

    setLoading(loading: boolean) {
      this.loading = loading;
    },

    setError(message: string) {
      this.error = message;
    },

    setProjects(projects: SshProjectOption[]) {
      this.projects = projects;
      this.projectsError = '';
    },

    setProjectsLoading(loading: boolean) {
      this.projectsLoading = loading;
    },

    setProjectsError(message: string) {
      this.projectsError = message;
    },

    /** Сохранённый сервер: правка заменяет запись на месте, новый уезжает в конец. */
    upsertConnection(connection: SshConnection) {
      const index = this.connections.findIndex((item) => item.id === connection.id);

      if (index < 0) {
        this.connections.push(connection);

        return;
      }

      this.connections[index] = connection;
    },

    /**
     * Открытая сессия. Тот же id заменяется целиком: сервер мог поднять поколение,
     * и старая запись обещала бы доступ агента, которого уже нет.
     */
    upsertSession(session: SshSession) {
      this.sessions = [
        ...this.sessions.filter((item) => item.id !== session.id),
        session,
      ];
    },

    /** Точечное обновление уже известной сессии: смена доступа агента не трогает список. */
    patchSession(id: string, patch: Partial<SshSession>) {
      const index = this.sessions.findIndex((item) => item.id === id);

      if (index >= 0) {
        this.sessions[index] = { ...this.sessions[index], ...patch } as SshSession;
      }
    },

    dropSession(id: string) {
      this.sessions = this.sessions.filter((item) => item.id !== id);
    },

    /**
     * Файловый список принадлежит выбранной сессии. Смена цели сразу инвалидирует
     * видимые файлы и ответы, которые ещё идут от прежней сессии.
     */
    setActive(id: string) {
      if (id === this.activeId) {
        return;
      }

      this.activeId = id;
      this.filesRevision += 1;
      this.remotePath = '.';
      this.files = [];
      this.filesStatus = 'idle';
      this.filesError = '';
    },

    setTerminalStatus(status: SshTerminalStatus) {
      this.terminalStatus = status;
    },

    setFiles(remotePath: string, files: SshFile[]) {
      this.remotePath = remotePath;
      this.files = files;
      this.filesStatus = 'ready';
    },

    /**
     * Каждое чтение и загрузка получают новую ревизию. Действия могут завершаться
     * в другом порядке, поэтому коммитить результат разрешено текущему запросу.
     */
    startFilesRequest() {
      this.filesRevision += 1;
      this.filesStatus = 'loading';
      this.filesError = '';

      return this.filesRevision;
    },

    setFilesError(message: string) {
      this.filesStatus = 'error';
      this.filesError = message;
    },
  },
});

export default useSshStore;
