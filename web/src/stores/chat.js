// Чат с агентом по задаче (claude -p в worktree). Глобальный — доступен с любой страницы.
// Контекст держится через sessionId (--resume). Модель и эффорт переключаются, запоминаются.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

export const useChatStore = defineStore('chat', {
  state: () => ({
    open: false,
    taskId: null,
    model: localStorage.getItem('cockpit-chat-model') || 'sonnet',
    effort: localStorage.getItem('cockpit-chat-effort') || 'medium',
    messages: [],     // [{ role: 'user'|'assistant'|'error', text, cost? }]
    sessionId: null,
    sending: false,
    error: null,
  }),
  actions: {
    openFor(taskId) { this.open = true; if (taskId) this.setTask(String(taskId)); },
    toggle() { this.open = !this.open; },
    close() { this.open = false; },
    setTask(id) {
      const s = String(id);
      if (s !== this.taskId) { this.taskId = s; this.messages = []; this.sessionId = null; this.error = null; }
    },
    setModel(m) { this.model = m; localStorage.setItem('cockpit-chat-model', m); },
    setEffort(e) { this.effort = e; localStorage.setItem('cockpit-chat-effort', e); },
    reset() { this.messages = []; this.sessionId = null; this.error = null; },
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
      } finally { this.sending = false; }
    },
  },
});
