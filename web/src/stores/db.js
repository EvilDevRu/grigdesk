import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { sseSubscribe } from '../composables/useSse.js';

const runtimes = new WeakMap();

function runtimeOf(store) {
  let runtime = runtimes.get(store);
  if (!runtime) {
    runtime = { off: null };
    runtimes.set(store, runtime);
  }
  return runtime;
}

// Нажатие «Прервать» обязано что-то ответить: часть команд снять нельзя вовсе,
// а часть снимается только вместе с соединением — и тогда сессии больше нет.
function cancelNotice(result) {
  if (result?.ok === true) {
    return result.method === 'connection'
      ? 'Запрос снят вместе с соединением — сессия закрыта, откройте её заново.'
      : '';
  }
  return {
    cancel_not_supported: 'Команда уже выполняется на сервере и прервать её нечем — дождитесь ответа.',
    cancel_failed: 'Прервать запрос не удалось.',
    not_found: 'Запрос уже завершился.',
  }[result?.error] || 'Прервать запрос не удалось.';
}

const useDbStoreBase = defineStore('db', {
  state: () => ({
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
    async load() {
      this.loading = true;
      this.error = '';
      try {
        const [engines, profiles, sessions, queries, audit] = await Promise.all([
          api.get('/api/db/engines'),
          api.get('/api/db/profiles'),
          api.get('/api/db/sessions'),
          api.get('/api/db/queries'),
          api.get('/api/db/audit'),
        ]);
        this.engines = engines?.engines || [];
        this.profiles = profiles?.profiles || [];
        this.sessions = sessions?.sessions || [];
        this.queries = queries?.queries || [];
        this.audit = audit?.items || [];
      } catch (error) {
        this.error = error?.message || 'Не удалось загрузить базы';
      } finally {
        this.loading = false;
      }
    },

    async loadProjects() {
      this.projectsLoading = true;
      this.projectsError = '';

      try {
        const result = await api.get('/api/projects');
        this.projects = result?.projects || [];
      } catch (error) {
        this.projectsError = error?.message || 'Не удалось загрузить проекты';
      } finally {
        this.projectsLoading = false;
      }
    },

    async saveProfile(profile) {
      const saved = profile.id
        ? await api.put(`/api/db/profiles/${profile.id}`, profile)
        : await api.post('/api/db/profiles', profile);
      await this.load();
      return saved;
    },

    async deleteProfile(id) {
      await api.del(`/api/db/profiles/${id}`);
      this.profiles = this.profiles.filter((item) => item.id !== id);
    },

    async openSession(profileId, password, { sshSessionId = '' } = {}) {
      const bytes = new TextEncoder().encode(String(password || ''));
      const options = sshSessionId
        ? { headers: { 'x-cockpit-ssh-session-id': sshSessionId } }
        : undefined;
      let result;
      try {
        result = await api.postBytes(`/api/db/profiles/${profileId}/sessions`, bytes, options);
      } finally {
        bytes.fill(0);
      }
      if (result?.session) {
        this.sessions = [...this.sessions.filter((item) => item.id !== result.session.id), result.session];
      }
      return result;
    },

    async loadSshSessions() {
      const result = await api.get('/api/ssh/sessions');
      this.sshSessions = result?.sessions || [];
      return this.sshSessions;
    },

    async closeSession(id) {
      await api.del(`/api/db/sessions/${id}`);
      this.sessions = this.sessions.filter((item) => item.id !== id);
      delete this.schemas[id];
    },

    async setAgentAccess(id, allowed) {
      const result = await api.put(`/api/db/sessions/${id}/agent-access`, { allowed });
      const session = result?.session || result;
      const index = this.sessions.findIndex((item) => item.id === id);
      if (index >= 0 && session) this.sessions[index] = { ...this.sessions[index], ...session };
      return result;
    },

    async loadSchema(id) {
      const schema = await api.get(`/api/db/sessions/${id}/schema`);
      this.schemas[id] = schema;
      return schema;
    },

    async runQuery(id, query, parameters = []) {
      const result = await api.post(`/api/db/sessions/${id}/query`, {
        text: query,
        params: parameters,
      });
      await this.refreshQueries();
      return result;
    },

    async cancelQuery(id) {
      const result = await api.post(`/api/db/queries/${id}/cancel`, {});
      this.cancelNotice = cancelNotice(result);
      await this.refreshQueries();
      return result;
    },

    async refreshQueries() {
      const data = await api.get('/api/db/queries');
      this.queries = data?.queries || [];
    },

    async refreshAudit() {
      const data = await api.get('/api/db/audit');
      this.audit = data?.items || [];
    },

    initEvents() {
      const runtime = runtimeOf(this);
      if (runtime.off) return;
      runtime.off = sseSubscribe((name) => {
        if (name === 'db-sessions') this.load();
        if (name === 'db-queries') this.refreshQueries().catch(() => {});
        if (name === 'db-audit') this.refreshAudit().catch(() => {});
      });
    },
  },
});

export function useDbStore() {
  const store = useDbStoreBase();
  store.initEvents();
  return store;
}

export default useDbStore;
