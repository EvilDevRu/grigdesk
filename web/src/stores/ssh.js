import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { sseSubscribe } from '../composables/useSse.js';

const runtimes = new WeakMap();

function runtimeOf(store) {
  let runtime = runtimes.get(store);
  if (!runtime) {
    runtime = {
      WebSocket: globalThis.WebSocket,
      socket: null,
      generation: 0,
      terminal: null,
      off: null,
    };
    runtimes.set(store, runtime);
  }
  return runtime;
}

const useSshStoreBase = defineStore('ssh', {
  state: () => ({
    connections: [],
    sessions: [],
    activeId: '',
    files: [],
    remotePath: '.',
    audit: [],
    loading: false,
    error: '',
  }),

  actions: {
    async load() {
      this.loading = true;
      this.error = '';
      try {
        const [connections, sessions, audit] = await Promise.all([
          api.get('/api/ssh/connections'),
          api.get('/api/ssh/sessions'),
          api.get('/api/ssh/audit?limit=50'),
        ]);
        this.connections = connections?.connections || [];
        this.sessions = sessions?.sessions || [];
        this.audit = audit?.items || [];
        if (this.activeId && !this.sessions.some((item) => item.id === this.activeId)) {
          this.detach();
        }
      } catch (error) {
        this.error = error?.message || 'Не удалось загрузить SSH';
      } finally {
        this.loading = false;
      }
    },

    async saveConnection(connection) {
      const saved = connection.id
        ? await api.put(`/api/ssh/connections/${connection.id}`, connection)
        : await api.post('/api/ssh/connections', connection);
      const index = this.connections.findIndex((item) => item.id === saved.id);
      if (index < 0) this.connections.push(saved);
      else this.connections[index] = saved;
      return saved;
    },

    async probeHostKey(connectionId) {
      return api.post(`/api/ssh/connections/${connectionId}/host-key/probe`, {});
    },

    async decideHostKey(challengeId, decision) {
      return api.post(`/api/ssh/host-key/${challengeId}`, { decision });
    },

    async connect(connectionId, password) {
      const bytes = new TextEncoder().encode(String(password || ''));
      const result = await api.postBytes(`/api/ssh/connections/${connectionId}/sessions`, bytes);
      const session = result?.session;
      if (session) {
        this.sessions = [...this.sessions.filter((item) => item.id !== session.id), session];
        if (typeof api.wsUrl === 'function') this.activate(session.id);
        else this.activeId = session.id;
      }
      return result;
    },

    activate(id) {
      const sid = String(id || '');
      const runtime = runtimeOf(this);
      runtime.generation += 1;
      const generation = runtime.generation;
      runtime.socket?.close?.();
      runtime.socket = null;
      this.activeId = sid;
      if (!sid || !runtime.WebSocket) return;
      const socket = new runtime.WebSocket(api.wsUrl(`/api/ssh/sessions/${sid}/terminal`));
      runtime.socket = socket;
      socket.onmessage = (event) => {
        if (runtime.generation !== generation) return;
        const data = event?.data;
        if (data instanceof Blob) data.arrayBuffer().then((value) => runtime.terminal?.write?.(new Uint8Array(value)));
        else runtime.terminal?.write?.(data);
      };
      socket.onclose = () => {
        if (runtime.generation === generation) runtime.socket = null;
      };
    },

    bindTerminal(terminal) {
      runtimeOf(this).terminal = terminal;
    },

    sendInput(data) {
      const socket = runtimeOf(this).socket;
      if (socket?.readyState === undefined || socket.readyState === 1) {
        socket?.send?.(JSON.stringify({ t: 'in', d: String(data) }));
      }
    },

    resize(cols, rows) {
      runtimeOf(this).socket?.send?.(JSON.stringify({ t: 'resize', cols, rows }));
    },

    detach() {
      const runtime = runtimeOf(this);
      runtime.generation += 1;
      runtime.socket?.close?.();
      runtime.socket = null;
      this.activeId = '';
    },

    async closeSession(id) {
      if (this.activeId === id) this.detach();
      await api.del(`/api/ssh/sessions/${id}`);
      this.sessions = this.sessions.filter((item) => item.id !== id);
    },

    async setAgentAccess(id, allowed) {
      const result = await api.put(`/api/ssh/sessions/${id}/agent-access`, { allowed });
      const session = result?.session || result;
      const index = this.sessions.findIndex((item) => item.id === id);
      if (index >= 0 && session) this.sessions[index] = { ...this.sessions[index], ...session };
    },

    async listFiles(path = this.remotePath) {
      this.remotePath = path || '.';
      const data = await api.get(`/api/ssh/sessions/${this.activeId}/files?path=${encodeURIComponent(this.remotePath)}`);
      this.files = data?.files || [];
    },

    downloadUrl(path) {
      return api.url(`/api/ssh/sessions/${this.activeId}/files/download?path=${encodeURIComponent(path)}`);
    },

    async uploadFile(file, remotePath) {
      const form = new FormData();
      form.append('path', remotePath || file.name);
      form.append('file', file);
      await api.upload(`/api/ssh/sessions/${this.activeId}/files/upload`, form);
      await this.listFiles();
    },

    initEvents() {
      const runtime = runtimeOf(this);
      if (runtime.off) return;
      runtime.off = sseSubscribe((name) => {
        if (name === 'ssh-sessions') this.load();
        if (name === 'ssh-audit') api.get('/api/ssh/audit?limit=50')
          .then((data) => { this.audit = data?.items || []; })
          .catch(() => {});
      });
    },
  },
});

export function useSshStore(options = {}) {
  const store = useSshStoreBase();
  const runtime = runtimeOf(store);
  if (options.WebSocket) runtime.WebSocket = options.WebSocket;
  store.initEvents();
  return store;
}

export default useSshStore;
