// Чат с агентами — МУЛЬТИСЕССИИ (вкладки, как в VS Code).
// Каждая сессия: своя задача (опционально), модель, усилие, история, sessionId (--resume),
// размер контекста. История хранится НА СЕРВЕРЕ (файл в .state кокпита) — общая для всех
// окон/устройств и переживает чистку браузера. Один стор питает и плавающую панель
// (ChatPanel), и страницу «Агенты» (AgentsView) — компоненты переиспользуются.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { router } from '../router.js';
import { useUiContextStore } from './ui-context.js';
import { notify } from '../shared/notify.js';

const EFFORTS = ['low', 'medium', 'high', 'max'];
// Оценочное окно контекста модели — для индикатора заполнения.
export const CONTEXT_WINDOW = 200000;
// Старое браузерное хранилище — остаётся только как источник одноразовой миграции.
const LS_KEY = 'cockpit-chat-v2';

function uid() { return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`; }

function pickStore(j) {
  return {
    sessions: Array.isArray(j?.sessions) ? j.sessions : [],
    archived: Array.isArray(j?.archived) ? j.archived : [],
    activeId: j?.activeId || null,
    defModel: j?.defModel || 'opus',
    defEffort: j?.defEffort || 'high',
  };
}

let persistTimer = null;
let loadPromise = null;
let permEs = null; // SSE-подписка на запросы разрешений (одна на окно)
// «Разрешать до конца сессии»: chatKey → Set(инструментов). Только в памяти —
// умирает с перезагрузкой страницы, в allowlist навсегда ничего не попадает.
const permAutoAllow = {};

export const useChatStore = defineStore('chat', {
  state: () => ({ ...pickStore(null), loaded: false, open: false, conveyorIds: [], permReq: null }),
  getters: {
    active: (s) => s.sessions.find((x) => x.id === s.activeId) || null,
    // Заголовок вкладки: название задачи → #номер → «Новый чат».
    tabLabel: () => (sess) => sess.title || (sess.taskId ? `#${sess.taskId}` : 'Новый чат'),
    isOnConveyor: (s) => (taskId) => !!taskId && s.conveyorIds.includes(String(taskId)),
    // Единый список чатов для телеграм-сайдбара: открытые + архив, свежие сверху.
    // Без запроса — все чаты со сниппетом последнего сообщения; с запросом — фильтр
    // по названию и тексту сообщений (сниппет — фрагмент совпадения).
    list: (s) => (q) => {
      const t = q.trim().toLowerCase();
      const row = (sess, archived) => {
        const title = sess.title || (sess.taskId ? `#${sess.taskId}` : 'Новый чат');
        const msgs = sess.messages || [];
        let snippet = '';
        if (t) {
          const m = msgs.find((x) => (x.text || '').toLowerCase().includes(t));
          if (!title.toLowerCase().includes(t) && !m) return null;
          if (m) {
            const i = m.text.toLowerCase().indexOf(t);
            snippet = (i > 24 ? '…' : '') + m.text.slice(Math.max(0, i - 24), i + 72);
          }
        } else if (msgs.length) {
          const last = msgs[msgs.length - 1];
          snippet = (last.role === 'user' ? 'Ты: ' : last.role === 'error' ? '⚠ ' : '') + last.text;
        }
        return {
          id: sess.id, title, snippet: snippet.replace(/\s+/g, ' '), archived,
          taskId: sess.taskId, sending: !!sess.sending, ts: sess.updatedAt || sess.closedAt || 0,
        };
      };
      const out = [];
      s.sessions.forEach((x) => { const h = row(x, false); if (h) out.push(h); });
      (s.archived || []).forEach((x) => { const h = row(x, true); if (h) out.push(h); });
      out.sort((a, b) => b.ts - a.ts);
      return out;
    },
  },
  actions: {
    // Загрузка истории с сервера (однократно). Если серверный файл пуст, а в localStorage
    // осталась история со старой схемы хранения — мигрируем её и чистим браузер.
    async _load() {
      if (this.loaded) return;
      if (!loadPromise) {
        loadPromise = (async () => {
          let j = null;
          try { j = await api.get('/api/chat/store'); } catch { j = null; }
          if (!(j?.sessions?.length || j?.archived?.length)) {
            try {
              const ls = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
              if (ls?.sessions?.length || ls?.archived?.length) {
                j = ls;
                localStorage.removeItem(LS_KEY);
              }
            } catch { /* битый localStorage — начинаем с пустого */ }
          }
          Object.assign(this, pickStore(j));
          this.loaded = true;
          if (j) this._persist();
          // Ответы, доехавшие пока страница была закрыта/перезагружалась.
          await this._collectPending();
          // Агенты, работающие прямо сейчас: восстанавливаем «думает…» после F5.
          try {
            const { active } = await api.get('/api/chat/active');
            for (const a of active || []) {
              const s = this._get(a.chatKey);
              if (s) { s.sending = true; s.progressTokens = a.tokens || 0; }
            }
          } catch { /* сервер старый/недоступен */ }
        })();
      }
      await loadPromise;
    },
    // Недоставленные ответы (chats/pending на сервере): раскладываем по чатам,
    // dedup по pid в сообщении, подтверждаем удалением.
    async _collectPending() {
      let j = null;
      try { j = await api.get('/api/chat/pending'); } catch { return; }
      if (!j?.pending?.length) return;
      for (const p of j.pending) {
        const s = this._get(p.chatKey) || this.archived.find((x) => x.id === p.chatKey);
        if (s && !(s.messages || []).some((m) => m.pid === p.id)) {
          // Гонка last-write-wins могла затереть сам вопрос — восстанавливаем его перед ответом.
          if (p.userText && !(s.messages || []).slice(-12).some((m) => m.role === 'user' && m.text === p.userText)) {
            s.messages.push({ role: 'user', text: p.userText, pid: `${p.id}:u` });
          }
          s.messages.push({ role: p.role || 'assistant', text: p.reply || '(пусто)', cost: p.cost ?? null, pid: p.id });
          if (p.sessionId) s.sessionId = p.sessionId;
          if (typeof p.contextTokens === 'number' && p.contextTokens > 0) s.contextTokens = p.contextTokens;
          s.sending = false;
          s.updatedAt = p.at || Date.now();
        }
        api.del(`/api/chat/pending/${p.id}`).catch(() => { /* подберём в следующий раз */ });
      }
      this._persist();
    },
    // Сохранение на сервер с дебаунсом — вызовы дискретные, но склеиваем всплески.
    // flush=true — писать немедленно (критичные моменты: только что добавленное
    // сообщение пользователя не должно потеряться из-за гонки окон/перезагрузки).
    _persist(flush = false) {
      clearTimeout(persistTimer);
      const write = () => {
        const slim = this.sessions.map((s) => ({
          id: s.id, taskId: s.taskId, title: s.title, model: s.model, effort: s.effort,
          messages: s.messages, sessionId: s.sessionId, contextTokens: s.contextTokens,
          createdAt: s.createdAt, updatedAt: s.updatedAt,
        }));
        api.put('/api/chat/store', {
          sessions: slim, archived: this.archived, activeId: this.activeId, defModel: this.defModel, defEffort: this.defEffort,
        }).catch(() => { /* сервер недоступен — сохранится при следующем изменении */ });
      };
      if (flush) write();
      else persistTimer = setTimeout(write, 300);
    },
    _get(id) { return this.sessions.find((s) => s.id === id) || null; },

    newSession(opts = {}) {
      const s = {
        id: uid(), taskId: opts.taskId ? String(opts.taskId) : null, title: opts.title || '',
        model: this.defModel, effort: this.defEffort, createdAt: Date.now(), updatedAt: Date.now(),
        messages: [], sessionId: null, contextTokens: 0, sending: false, error: null,
      };
      this.sessions.push(s);
      this.activeId = s.id;
      this._persist();
      return s.id;
    },
    // ── Всплывашка разрешений: агент просит выполнить действие (Bash/правка) ──
    // Сервер шлёт SSE `chat-permission`, ответ уходит POST'ом; `chat-permission-done`
    // (в т.ч. из другого окна или по таймауту) закрывает всплывашку везде.
    initPerms() {
      if (permEs) return;
      permEs = new EventSource(api.eventsUrl());
      permEs.addEventListener('chat-permission', (e) => {
        try {
          const d = JSON.parse(e.data);
          // «Разрешать до конца сессии»: инструмент уже одобрен — отвечаем сами, без всплывашки.
          if (d.chatKey && permAutoAllow[d.chatKey]?.has(d.tool)) {
            api.post(`/api/chat/permission/${d.pid}`, { allow: true }).catch(() => {});
            return;
          }
          this.permReq = d;
        } catch { /* битое событие */ }
      });
      permEs.addEventListener('chat-permission-done', (e) => {
        try {
          const d = JSON.parse(e.data);
          if (this.permReq?.pid === d.pid) this.permReq = null;
        } catch { /* битое событие */ }
      });
      // Ответ остался без адресата (то окно умерло) — подбираем в этом окне.
      permEs.addEventListener('chat-orphan', () => { this._collectPending(); });
      // Живой прогресс «думает… · N ток.». Прогресс = агент точно работает:
      // восстанавливаем и sending (окно могло перезагрузиться посреди хода).
      permEs.addEventListener('chat-progress', (e) => {
        try {
          const d = JSON.parse(e.data);
          const s = this._get(d.chatKey);
          if (s) { s.sending = true; s.progressTokens = d.tokens; }
        } catch { /* битое событие */ }
      });
      // Ход завершён — снять «думает…» во всех окнах (ответ доставляется
      // ожидавшему окну или через pending).
      permEs.addEventListener('chat-done', (e) => {
        try {
          const d = JSON.parse(e.data);
          const s = this._get(d.chatKey);
          if (s) { s.sending = false; s.progressTokens = 0; }
        } catch { /* битое событие */ }
      });
    },
    async answerPerm(allow, remember = false) {
      const p = this.permReq;
      if (!p) return;
      this.permReq = null;
      if (allow && remember && p.chatKey && p.tool) {
        (permAutoAllow[p.chatKey] ||= new Set()).add(p.tool);
      }
      try { await api.post(`/api/chat/permission/${p.pid}`, { allow }); }
      catch { /* запрос уже протух (таймаут/другое окно) */ }
    },

    async ensure() {
      await this._load();
      this.initPerms();
      // sending/error не персистятся — восстанавливаем поля.
      this.sessions.forEach((s) => { if (s.sending === undefined) s.sending = false; if (s.error === undefined) s.error = null; });
      // Миграция: алиаса «fable» в CLI нет — только полный ID.
      this.sessions.forEach((s) => { if (s.model === 'fable') s.model = 'claude-fable-5'; });
      if (this.defModel === 'fable') this.defModel = 'claude-fable-5';
      if (!this.sessions.length) this.newSession();
      else if (!this._get(this.activeId)) this.activeId = this.sessions[0].id;
    },
    closeSession(id) {
      const i = this.sessions.findIndex((s) => s.id === id);
      if (i < 0) return;
      const [s] = this.sessions.splice(i, 1);
      // Чат с историей не удаляем, а уносим в архив — поиск его найдёт, можно восстановить.
      if (s.messages?.length) {
        this.archived.unshift({
          id: s.id, taskId: s.taskId, title: s.title, model: s.model, effort: s.effort,
          messages: s.messages, sessionId: s.sessionId, contextTokens: s.contextTokens,
          createdAt: s.createdAt, closedAt: Date.now(),
        });
        if (this.archived.length > 50) this.archived.length = 50;
      }
      if (this.activeId === id) this.activeId = this.sessions[Math.max(0, i - 1)]?.id || null;
      if (!this.sessions.length) this.newSession();
      this._persist();
    },
    // Вернуть чат из архива в открытые вкладки.
    restoreArchived(id) {
      const i = this.archived.findIndex((s) => s.id === id);
      if (i < 0) return;
      const [a] = this.archived.splice(i, 1);
      a.sending = false; a.error = null;
      this.sessions.push(a);
      this.activeId = a.id;
      this._persist();
    },
    setActive(id) { if (this._get(id)) { this.activeId = id; this._persist(); } },
    setTitle(id, title) { const s = this._get(id); if (!s) return; s.title = title; this._persist(); },
    // Выбор чата из сайдбара: открытый — активируем, архивный — прозрачно восстанавливаем.
    selectChat(id) {
      if (this._get(id)) { this.activeId = id; this._persist(); return; }
      this.restoreArchived(id);
    },
    // Переименование из сайдбара — работает и для открытых, и для архивных.
    renameChat(id, title) {
      const s = this._get(id) || this.archived.find((x) => x.id === id);
      if (!s) return;
      s.title = title;
      this._persist();
    },
    // Безвозвратное удаление чата (открытого или архивного).
    deleteChat(id) {
      const i = this.sessions.findIndex((x) => x.id === id);
      if (i >= 0) {
        this.sessions.splice(i, 1);
        if (this.activeId === id) this.activeId = this.sessions[0]?.id || null;
        if (!this.sessions.length) this.newSession();
      } else {
        const j = this.archived.findIndex((x) => x.id === id);
        if (j >= 0) this.archived.splice(j, 1);
      }
      this._persist();
    },

    // Плавающая панель.
    async toggle() { await this.ensure(); this.open = !this.open; },
    close() { this.open = false; },
    async openFor(taskId, title) {
      await this.ensure();
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

    async send(id, text, attachments = []) {
      const s = this._get(id); if (!s) return;
      if ((!text.trim() && !attachments.length) || s.sending) return;
      // Вложения в истории — только ссылки на серверные файлы (file/name/url/mime).
      const atts = attachments.map((a) => ({ file: a.file, name: a.name, url: a.url, mime: a.mime }));
      s.messages.push({ role: 'user', text, ...(atts.length ? { attachments: atts } : {}) });
      s.sending = true; s.error = null; s.progressTokens = 0;
      s.updatedAt = Date.now();
      this._persist(true); // немедленно: вопрос не должен потеряться при F5/гонке окон
      try {
        const url = s.taskId ? `/api/tasks/${s.taskId}/chat` : '/api/chat';
        // Снимок UI-контекста: страница + детали от неё (агент понимает «поправь здесь»).
        const route = router.currentRoute.value;
        const ui = useUiContextStore();
        const context = {
          page: route.meta?.title || '',
          path: route.path,
          ...(Object.keys(ui.extra).length ? { details: JSON.parse(JSON.stringify(ui.extra)) } : {}),
        };
        const r = await api.post(url, {
          message: text, model: s.model, effort: s.effort, sessionId: s.sessionId, context, chatKey: id,
          ...(atts.length ? { attachments: atts.map((a) => ({ file: a.file, name: a.name })) } : {}),
        });
        s.sessionId = r.sessionId;
        if (typeof r.contextTokens === 'number' && r.contextTokens > 0) s.contextTokens = r.contextTokens;
        s.messages.push({ role: 'assistant', text: r.reply || '(пусто)', cost: r.cost });
        // Оповещение, если пользователь не смотрит на этот чат (другая вкладка ОС,
        // другой раздел с закрытой панелью или другой активный чат).
        const chatVisible = !document.hidden
          && (router.currentRoute.value.path === '/chats' || this.open)
          && this.activeId === id;
        if (!chatVisible) notify(`Агент ответил — ${this.tabLabel(s)}`, (r.reply || '').slice(0, 120), `chat-${id}`);
      } catch (e) {
        s.error = e.message;
        s.messages.push({ role: 'error', text: e.message });
      } finally { s.sending = false; s.progressTokens = 0; s.updatedAt = Date.now(); this._persist(); }
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
