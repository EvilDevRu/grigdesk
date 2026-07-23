// Чат с агентами — МУЛЬТИСЕССИИ (вкладки, как в VS Code).
// Каждая сессия: своя задача (опционально), модель, усилие, история, sessionId (--resume),
// размер контекста. Всё персистится (переживает перезагрузку). Один стор питает и
// плавающую панель (ChatPanel), и страницу «Агенты» (AgentsView) — компоненты переиспользуются.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

const EFFORTS = ['low', 'medium', 'high', 'max'];
// Оценочное окно контекста модели — для индикатора заполнения.
export const CONTEXT_WINDOW = 200000;
const LS_KEY = 'cockpit-chat-v2';

function uid() { return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`; }

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      sessions: Array.isArray(j.sessions) ? j.sessions : [],
      activeId: j.activeId || null,
      defModel: j.defModel || 'opus',
      defEffort: j.defEffort || 'high',
    };
  } catch { return { sessions: [], activeId: null, defModel: 'opus', defEffort: 'high' }; }
}

export const useChatStore = defineStore('chat', {
  state: () => ({ ...load(), open: false, conveyorIds: [] }),
  getters: {
    active: (s) => s.sessions.find((x) => x.id === s.activeId) || null,
    // Заголовок вкладки: название задачи → #номер → «Новый чат».
    tabLabel: () => (sess) => sess.title || (sess.taskId ? `#${sess.taskId}` : 'Новый чат'),
    isOnConveyor: (s) => (taskId) => !!taskId && s.conveyorIds.includes(String(taskId)),
  },
  actions: {
    _persist() {
      const slim = this.sessions.map((s) => ({
        id: s.id, taskId: s.taskId, title: s.title, model: s.model, effort: s.effort,
        messages: s.messages, sessionId: s.sessionId, contextTokens: s.contextTokens,
      }));
      localStorage.setItem(LS_KEY, JSON.stringify({
        sessions: slim, activeId: this.activeId, defModel: this.defModel, defEffort: this.defEffort,
      }));
    },
    _get(id) { return this.sessions.find((s) => s.id === id) || null; },

    newSession(opts = {}) {
      const s = {
        id: uid(), taskId: opts.taskId ? String(opts.taskId) : null, title: opts.title || '',
        model: this.defModel, effort: this.defEffort,
        messages: [], sessionId: null, contextTokens: 0, sending: false, error: null,
      };
      this.sessions.push(s);
      this.activeId = s.id;
      this._persist();
      return s.id;
    },
    ensure() {
      // sending/error могли не сохраниться — восстанавливаем поля.
      this.sessions.forEach((s) => { if (s.sending === undefined) s.sending = false; if (s.error === undefined) s.error = null; });
      if (!this.sessions.length) this.newSession();
      else if (!this._get(this.activeId)) this.activeId = this.sessions[0].id;
    },
    closeSession(id) {
      const i = this.sessions.findIndex((s) => s.id === id);
      if (i < 0) return;
      this.sessions.splice(i, 1);
      if (this.activeId === id) this.activeId = this.sessions[Math.max(0, i - 1)]?.id || null;
      if (!this.sessions.length) this.newSession();
      this._persist();
    },
    setActive(id) { if (this._get(id)) { this.activeId = id; this._persist(); } },

    // Плавающая панель.
    toggle() { this.ensure(); this.open = !this.open; },
    close() { this.open = false; },
    openFor(taskId, title) {
      this.ensure();
      if (taskId) {
        const ex = this.sessions.find((s) => s.taskId === String(taskId));
        if (ex) this.activeId = ex.id;
        else this.newSession({ taskId, title });
      }
      this.open = true;
      this._persist();
    },

    setTask(id, taskId, title) {
      const s = this._get(id); if (!s) return;
      s.taskId = taskId ? String(taskId) : null;
      s.title = title || '';
      this._persist();
    },
    setModel(id, m) { const s = this._get(id); if (!s) return; s.model = m; this.defModel = m; this._persist(); },
    setEffort(id, e) { const s = this._get(id); if (!s) return; s.effort = e; this.defEffort = e; this._persist(); },
    cycleEffort(id) { const s = this._get(id); if (!s) return; this.setEffort(id, EFFORTS[(EFFORTS.indexOf(s.effort) + 1) % EFFORTS.length]); },
    clearChat(id) { const s = this._get(id); if (!s) return; s.messages = []; s.error = null; this._persist(); },
    resetContext(id) { const s = this._get(id); if (!s) return; s.sessionId = null; s.contextTokens = 0; this._persist(); },

    async send(id, text) {
      const s = this._get(id); if (!s) return;
      if (!text.trim() || s.sending) return;
      s.messages.push({ role: 'user', text });
      s.sending = true; s.error = null;
      try {
        const url = s.taskId ? `/api/tasks/${s.taskId}/chat` : '/api/chat';
        const r = await api.post(url, { message: text, model: s.model, effort: s.effort, sessionId: s.sessionId });
        s.sessionId = r.sessionId;
        if (typeof r.contextTokens === 'number' && r.contextTokens > 0) s.contextTokens = r.contextTokens;
        s.messages.push({ role: 'assistant', text: r.reply || '(пусто)', cost: r.cost });
      } catch (e) {
        s.error = e.message;
        s.messages.push({ role: 'error', text: e.message });
      } finally { s.sending = false; this._persist(); }
    },

    // Список номеров задач, уже находящихся на конвейере (для защиты «На конвейер»).
    async loadConveyor() {
      try {
        const { tasks } = await api.get('/api/tasks');
        this.conveyorIds = (tasks || []).map((t) => String(t.task));
      } catch { /* нет данных фабрики */ }
    },
  },
});
