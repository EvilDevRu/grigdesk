// Чат с агентом по задаче (claude -p в worktree). Глобальный — доступен с любой страницы.
// История и sessionId персистятся по задаче (переживают перезагрузку). Контекст — через --resume.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

const EFFORTS = ['low', 'medium', 'high', 'max'];

export const useChatStore = defineStore('chat', {
  state: () => ({
    open: false,
    taskId: null,
    model: localStorage.getItem('cockpit-chat-model') || 'opus',
    effort: localStorage.getItem('cockpit-chat-effort') || 'high',
    messages: [],
    sessionId: null,
    sending: false,
    error: null,
  }),
  actions: {
    _key() { return `cockpit-chat-${this.taskId}`; },
    _persist() { if (this.taskId) localStorage.setItem(this._key(), JSON.stringify({ messages: this.messages, sessionId: this.sessionId })); },
    _restore() {
      try { const j = JSON.parse(localStorage.getItem(this._key()) || '{}'); this.messages = j.messages || []; this.sessionId = j.sessionId || null; }
      catch { this.messages = []; this.sessionId = null; }
    },
    openFor(taskId) { this.open = true; if (taskId) this.setTask(taskId); },
    toggle() { this.open = !this.open; },
    close() { this.open = false; },
    setTask(id) {
      const s = String(id);
      if (s !== this.taskId) { this.taskId = s; this._restore(); this.error = null; }
    },
    setModel(m) { this.model = m; localStorage.setItem('cockpit-chat-model', m); },
    setEffort(e) { this.effort = e; localStorage.setItem('cockpit-chat-effort', e); },
    cycleEffort() { const i = EFFORTS.indexOf(this.effort); this.setEffort(EFFORTS[(i + 1) % EFFORTS.length]); },
    clearChat() { this.messages = []; this.error = null; this._persist(); },      // очистить видимую переписку
    resetContext() { this.sessionId = null; this._persist(); },                   // забыть контекст (новый claude-сеанс)
    async send(text) {
      if (!this.taskId) { this.error = 'Выберите задачу'; return; }
      if (!text.trim() || this.sending) return;
      this.messages.push({ role: 'user', text });
      this.sending = true; this.error = null;
      try {
        const r = await api.post(`/api/tasks/${this.taskId}/chat`, {
          message: text, model: this.model, effort: this.effort, sessionId: this.sessionId,
        });
        this.sessionId = r.sessionId;
        this.messages.push({ role: 'assistant', text: r.reply || '(пусто)', cost: r.cost });
      } catch (e) {
        this.error = e.message;
        this.messages.push({ role: 'error', text: e.message });
      } finally { this.sending = false; this._persist(); }
    },
  },
});
