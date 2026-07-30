// Чат с агентами — МУЛЬТИСЕССИИ (вкладки, как в VS Code).
// Каждая сессия: своя задача (опционально), модель, усилие, история, sessionId (--resume),
// размер контекста. История хранится НА СЕРВЕРЕ (файл в .state кокпита) — общая для всех
// окон/устройств и переживает чистку браузера. Один стор питает и плавающую панель
// (ChatPanel), и страницу «Агенты» (AgentsView) — компоненты переиспользуются.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { router } from '../router.js';
import { useUiContextStore } from './ui-context.js';
import { useProvidersStore } from './providers.js';
import { notify } from '../shared/notify.js';
import { sseSubscribe } from '../composables/useSse.js';
import { mdToText } from '../shared/md.js';
import {
  applyGeneratedChatTitle,
  firstMessageTitle,
  provisionalChatTitle,
  shouldRequestChatTitle,
} from '../shared/chat-title.js';

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
    // Пусто = «ещё не выбирали»: модель нового чата возьмётся из реестра (см. defaultModelId).
    defModel: j?.defModel || '',
    defEffort: j?.defEffort || '',
    // Режим прав по умолчанию для новых чатов (пусто = как решит сервер по странице).
    defMode: j?.defMode || '',
  };
}

let persistTimer = null;
let retryTimer = null;
let retryDelay = 0;
let loadPromise = null;

// ── Что уже лежит на сервере ──────────────────────────────────────────────────
// id чата → его JSON на момент последней УСПЕШНОЙ записи. По этой карте шлём только
// изменившееся: раньше каждое сохранение тащило весь стор одним телом, и когда история
// доросла до лимита запроса, сервер стал отвечать 413 — переписка перестала сохраняться
// совсем, а клиент молча ретраил. Теперь объём запроса не зависит от размера истории.
const sentChats = new Map();
let sentMeta = '';
let saveWarned = false;

// Чат в том виде, в каком он едет на сервер: без рантайм-полей (sending/error/steps).
function slimOf(s) {
  return {
    id: s.id, taskId: s.taskId, title: s.title, model: s.model, effort: s.effort, mode: s.mode || '',
    messages: s.messages, sessionId: s.sessionId, contextTokens: s.contextTokens,
    contextIsEstimate: !!s.contextIsEstimate,
    draft: s.draft || '', unread: !!s.unread, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

// Архив сохраняем тем же узким снимком, что и активный чат, плюс момент закрытия.
// Сам объект в памяти может продолжать получать ответ агента уже после архивирования,
// но рантайм-поля (sending/error/steps) в файл истории попадать не должны.
function archivedSlimOf(s) {
  return { ...slimOf(s), closedAt: s.closedAt || s.updatedAt || s.createdAt || Date.now() };
}

// ── Страховочный снимок истории в браузере ────────────────────────────────────
// Сервер пишет историю в файлы, но между «ответ пришёл» и «PUT долетел» есть окно:
// если в него попадает рестарт сервера, последний ответ пропадает. Снимок закрывает
// именно это окно — при загрузке берём его, если он свежее серверного.
const SNAP_KEY = 'cockpit-chat-snapshot';

function writeSnapshot(payload) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(payload));
  } catch {
    // Не влезло (квота ~5МБ) — кладём укороченную версию: свежие сообщения важнее старых.
    try {
      const cut = {
        ...payload,
        sessions: (payload.sessions || []).map((s) => ({ ...s, messages: (s.messages || []).slice(-30) })),
        archived: [],
      };
      localStorage.setItem(SNAP_KEY, JSON.stringify(cut));
    } catch { /* localStorage недоступен — работаем без страховки */ }
  }
}

function readSnapshot() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || 'null'); } catch { return null; }
}

/**
 * «Возраст» состояния — самое свежее изменение среди чатов. По нему решаем,
 * кто новее: серверная копия или локальный снимок (в другом окне могли писать).
 */
function stampOf(store) {
  return Math.max(0, ...(store?.sessions || []).map((s) => s.updatedAt || 0));
}
let permOff = null; // отписка от общего SSE (подписка одна на окно)
// «Разрешать до конца сессии»: chatKey → Set(инструментов). Только в памяти —
// умирает с перезагрузкой страницы, в allowlist навсегда ничего не попадает.
const permAutoAllow = {};

export const useChatStore = defineStore('chat', {
  // pending — ВСЕ висящие спросы агентов, pid → запрос: `kind: 'perm'` (разрешение на
  // действие) либо `kind: 'question'` (вопрос по существу, AskUserQuestion). Карта, а не
  // одно поле: агенты работают в нескольких чатах сразу, и новый спрос не должен затирать
  // предыдущий — каждый висит, пока на него не ответят.
  // saveError — история не пишется на сервер (см. _saveFailed). В чате НЕ рисуется:
  // состояние общее, а плашка в открытом чате висела бы в каждом. Наружу идёт разовым
  // оповещением, текст ошибки хранится здесь.
  state: () => ({ ...pickStore(null), loaded: false, open: false, conveyorIds: [], pending: {}, saveError: null }),
  getters: {
    active: (s) => s.sessions.find((x) => x.id === s.activeId) || null,
    // Заголовок вкладки: название задачи → #номер → «Новый чат».
    tabLabel: () => (sess) => sess.title || (sess.taskId ? `#${sess.taskId}` : 'Новый чат'),
    isOnConveyor: (s) => (taskId) => !!taskId && s.conveyorIds.includes(String(taskId)),
    // Непрочитанные: агент ответил, а мы на этот чат ещё не смотрели. Считаем и архивные —
    // чат могли закрыть, пока агент думал, и ответ приехал уже в архив.
    unreadCount: (s) => s.sessions.filter((x) => x.unread).length
      + (s.archived || []).filter((x) => x.unread).length,
    // ── «Требуют вмешательства» ──
    // Агент стоит и ждёт человека: без ответа ход не двинется. Это сильнее «непрочитанного»
    // (там просто не смотрели), поэтому считается и показывается отдельно.
    waitingChats: (s) => new Set(Object.values(s.pending).map((p) => p.chatKey || '')),
    // Сколько чатов ждут меня — цифра для чипа в навигации и на кнопке чата.
    waitingCount() { return this.waitingChats.size; },
    // Спрос, адресованный конкретному чату. Запрос без chatKey (старый сервер) показываем
    // в любом открытом чате — иначе он не показался бы нигде.
    permFor: (s) => (chatKey) => Object.values(s.pending)
      .find((p) => p.kind === 'perm' && (!p.chatKey || p.chatKey === chatKey)) || null,
    questionFor: (s) => (chatKey) => Object.values(s.pending)
      .find((p) => p.kind === 'question' && (!p.chatKey || p.chatKey === chatKey)) || null,
    // Список чатов для телеграм-сайдбара: обычный режим показывает открытые чаты,
    // режим архива — только архивные. Без запроса показываем сниппет последнего
    // сообщения; с запросом фильтруем по названию и тексту переписки.
    list(s) { return (q, showArchived = false) => {
      const t = q.trim().toLowerCase();
      const waiting = this.waitingChats;
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
        } else if ((sess.draft || '').trim()) {
          // Неотправленный текст показываем вместо последнего сообщения — как в телеграме.
          snippet = sess.draft;
        } else if (msgs.length) {
          const last = msgs[msgs.length - 1];
          snippet = (last.role === 'user' ? 'Ты: ' : last.role === 'error' ? '⚠ ' : '') + last.text;
        }
        return {
          id: sess.id, title, snippet: mdToText(snippet), archived,
          draft: !t && !!(sess.draft || '').trim(),
          // Модель чата — для иконки исполнителя и подписи в строке списка.
          model: sess.model || '',
          taskId: sess.taskId, sending: !!sess.sending, unread: !!sess.unread,
          // Агент в этом чате упёрся в вопрос и стоит — строке нужен чип «ждёт ответа».
          waiting: waiting.has(sess.id),
          // В архиве важнее момент архивирования: только что убранный старый разговор
          // должен оказаться сверху, а не провалиться к дате последнего сообщения.
          ts: archived ? (sess.closedAt || sess.updatedAt || 0) : (sess.updatedAt || 0),
        };
      };
      const out = [];
      const source = showArchived ? (s.archived || []) : s.sessions;
      source.forEach((x) => {
        const h = row(x, showArchived);
        if (h) out.push(h);
      });
      // Ждущие ответа — наверх: пока не ответишь, работа в них стоит.
      out.sort((a, b) => (b.waiting - a.waiting) || (b.ts - a.ts));
      return out;
    }; },
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
          // Снимок свежее серверной копии — значит сервер не успел записать последнее
          // (например, его перезапустили сразу после ответа агента): восстанавливаем из него.
          const snap = readSnapshot();
          const restored = snap && stampOf(snap) > stampOf(j);
          if (restored) j = snap;
          if (!(j?.sessions?.length || j?.archived?.length)) {
            try {
              const ls = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
              if (ls?.sessions?.length || ls?.archived?.length) {
                j = ls;
                localStorage.removeItem(LS_KEY);
              }
            } catch { /* битый localStorage — начинаем с пустого */ }
          }
          const picked = pickStore(j);
          this._normalize(picked.sessions);
          this._normalize(picked.archived);
          Object.assign(this, picked);
          this.loaded = true;
          // Снимок оказался свежее серверной копии — немедленно возвращаем расхождение
          // на сервер. Если же стор пришёл с сервера как есть, слать нечего: запоминаем
          // слепки, чтобы дальше уезжали только реальные изменения.
          if (restored) this._persist(true);
          else this._markSent();
          // Ответы, доехавшие пока страница была закрыта/перезагружалась.
          await this._collectPending();
          // Спросы агентов, висящие прямо сейчас: после F5 их некому было показать.
          await this._loadWaiting();
          // Агенты, работающие прямо сейчас: восстанавливаем «думает…» после F5.
          try {
            const { active } = await api.get('/api/chat/active');
            for (const a of active || []) {
              const s = this._get(a.chatKey);
              // Вместе с «думает…» возвращаем и уже показанную ленту шагов текущего хода.
              if (s) { s.sending = true; s.progressTokens = a.tokens || 0; s.steps = a.steps || []; }
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
        // Ответ мог прийти после F5: применяем семантическое имя, только если человек
        // не заменил временный заголовок вручную, пока агент работал.
        if (s && p.title) {
          const provisional = provisionalChatTitle(p.userText, { hasAttachments: !!p.hadAttachments });
          applyGeneratedChatTitle(s, p.title, provisional);
        }
        if (s && !(s.messages || []).some((m) => m.pid === p.id)) {
          // Гонка last-write-wins могла затереть сам вопрос — восстанавливаем его перед ответом.
          if (p.userText && !(s.messages || []).slice(-12).some((m) => m.role === 'user' && m.text === p.userText)) {
            s.messages.push({ role: 'user', text: p.userText, pid: `${p.id}:u` });
          }
          s.messages.push({
            role: p.role || 'assistant', text: p.reply || '(пусто)', cost: p.cost ?? null, pid: p.id,
            steps: p.steps || [], model: p.model || '', actualModel: p.actualModel || '', effort: p.effort || '',
          });
          if (p.sessionId) s.sessionId = p.sessionId;
          if (typeof p.contextTokens === 'number' && p.contextTokens > 0) {
            s.contextTokens = p.contextTokens;
            s.contextIsEstimate = !!p.contextIsEstimate;
          }
          // Как и в send(): слайдер под реальный эффорт, дефолт новых чатов не трогаем.
          if (p.effort && p.effort !== s.effort) s.effort = p.effort;
          // Ответ доехал, пока мы смотрели в другое место — чат становится непрочитанным.
          if (!this._visible(p.chatKey)) s.unread = true;
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
        const slim = this.sessions.map(slimOf);
        const archivedSlim = (this.archived || []).map(archivedSlimOf);
        const payload = {
          sessions: slim, archived: archivedSlim, activeId: this.activeId,
          defModel: this.defModel, defEffort: this.defEffort, defMode: this.defMode,
        };
        // Страховочный снимок в браузере: переживает падение и перезапуск сервера.
        // Без него ответ, пришедший последним, терялся насовсем — «следующего изменения»,
        // на котором он бы сохранился, могло и не быть.
        writeSnapshot(payload);
        // Каждый чат — свой запрос, и только если он реально изменился.
        const jobs = [];
        const alive = new Set();
        const push = (c, archived) => {
          if (!c?.id) return;
          alive.add(c.id);
          const json = JSON.stringify(c);
          if (sentChats.get(c.id) === json) return;
          jobs.push(api.put('/api/chat/store/chat', { chat: c, archived })
            .then(() => { sentChats.set(c.id, json); }));
        };
        slim.forEach((c) => push(c, false));
        archivedSlim.forEach((c) => push(c, true));
        // Чат исчез из стора (удалили, вытеснили из архива) — убираем и на сервере.
        for (const id of [...sentChats.keys()]) {
          if (alive.has(id)) continue;
          jobs.push(api.del(`/api/chat/store/chat/${id}`).then(() => { sentChats.delete(id); }));
        }
        const meta = { activeId: this.activeId, defModel: this.defModel, defEffort: this.defEffort, defMode: this.defMode };
        const metaJson = JSON.stringify(meta);
        if (metaJson !== sentMeta) {
          jobs.push(api.put('/api/chat/store/meta', meta).then(() => { sentMeta = metaJson; }));
        }
        if (!jobs.length) return;
        Promise.all(jobs)
          .then(() => { retryDelay = 0; this._saveFailed(false); })
          .catch((e) => {
            // Сервер недоступен (перезапускается) — повторяем с нарастающей паузой.
            // Успевшие запросы уже отметились в sentChats, повтор их не тронет.
            retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 15000);
            clearTimeout(retryTimer);
            retryTimer = setTimeout(write, retryDelay);
            this._saveFailed(true, e?.message || '');
          });
      };
      if (flush) write();
      else persistTimer = setTimeout(write, 300);
    },
    /**
     * Стор совпал с серверным — запоминаем слепки, чтобы первое же сохранение
     * не гнало всю историю заново.
     */
    _markSent() {
      sentChats.clear();
      this.sessions.forEach((s) => sentChats.set(s.id, JSON.stringify(slimOf(s))));
      (this.archived || []).forEach((c) => sentChats.set(c.id, JSON.stringify(archivedSlimOf(c))));
      sentMeta = JSON.stringify({
        activeId: this.activeId, defModel: this.defModel, defEffort: this.defEffort, defMode: this.defMode,
      });
    },
    /**
     * История не сохраняется. Раньше клиент ретраил молча, и человек узнавал о потере
     * только после перезагрузки страницы — уже пустой. Поэтому о беде сообщаем —
     * но РОВНО ОДИН РАЗ, оповещением, пока не восстановится: постоянная плашка в чате
     * ходила за человеком по всем чатам и превращалась в шум.
     */
    _saveFailed(bad, msg = '') {
      if (!bad) { this.saveError = null; saveWarned = false; return; }
      this.saveError = msg || 'сервер не принял запись';
      if (saveWarned) return;
      saveWarned = true;
      notify('История чата не сохраняется', `${this.saveError}. Не закрывай вкладку — идут повторные попытки.`, 'chat-save-error');
    },
    _get(id) { return this.sessions.find((s) => s.id === id) || null; },

    /**
     * Чат из истории мог прийти без части полей (запись старой версии, ручная правка
     * файла, чужой источник) — дозаполняем, иначе рендер падает на первом же обращении.
     */
    _normalize(list) {
      for (const s of list || []) {
        s.messages ||= [];
        s.contextTokens ??= 0;
        s.contextIsEstimate ??= false;
        s.sending = false;
        s.error ??= null;
        s.steps ||= [];
        s.draft ??= '';
      }
      return list;
    },
    /**
     * Смотрим ли прямо сейчас именно на этот чат: вкладка ОС активна, открыт раздел
     * «Чаты» или плавающая панель, и это активный чат. Одно правило и для оповещения,
     * и для метки «непрочитано» — чтобы бейдж не спорил с уведомлением.
     */
    _visible(id) {
      return !document.hidden
        && (router.currentRoute.value.path === '/chats' || this.open)
        && this.activeId === id;
    },
    // Чат увидели — гасим метку. Зовёт открытый на экране ChatSession.
    markRead(id) {
      const s = this._get(id) || this.archived.find((x) => x.id === id);
      if (!s?.unread) return;
      s.unread = false;
      this._persist();
    },

    newSession(opts = {}) {
      const s = {
        id: uid(), taskId: opts.taskId ? String(opts.taskId) : null, title: opts.title || '',
        // Пустая модель = «по умолчанию»: конкретный id подставится из реестра при показе
        // и отправке. Фиксировать здесь нельзя — реестр к этому моменту может не загрузиться.
        model: this.defModel, effort: this.defEffort, mode: this.defMode,
        createdAt: Date.now(), updatedAt: Date.now(),
        messages: [], sessionId: null, contextTokens: 0, contextIsEstimate: false,
        sending: false, error: null, draft: '',
      };
      this.sessions.push(s);
      this.activeId = s.id;
      this._persist();
      return s.id;
    },
    // ── Всплывашка разрешений: агент просит выполнить действие (Bash/правка) ──
    // Сервер шлёт SSE `chat-permission`, ответ уходит POST'ом; `chat-permission-done`
    // (ответили в другом окне, «стоп», конец хода) закрывает всплывашку везде.
    // Таймаута у спроса нет: без ответа человека агент стоит и ждёт.
    initPerms() {
      if (permOff) return;
      // Общий EventSource вкладки (useSse) — свой открывать НЕЛЬЗЯ: лимит браузера
      // 6 соединений на хост, лишние SSE душат все fetch (см. composables/useSse.js).
      permOff = sseSubscribe((name, d) => {
        if (!d && name !== 'chat-orphan') return;
        if (name === 'chat-permission') {
          // «Разрешать до конца сессии»: инструмент уже одобрен — отвечаем сами, без всплывашки.
          if (d.chatKey && permAutoAllow[d.chatKey]?.has(d.tool)) {
            api.post(`/api/chat/permission/${d.pid}`, { allow: true }).catch(() => {});
            return;
          }
          this._addPending({ ...d, kind: 'perm' });
        } else if (name === 'chat-question') {
          // Вопрос агента (AskUserQuestion): не разрешение, а диалог с вариантами ответа.
          this._addPending({ ...d, kind: 'question' });
        } else if (name === 'chat-permission-done') {
          delete this.pending[d.pid];
        } else if (name === 'hello') {
          // Связь восстановилась (в т.ч. после рестарта сервера) — пока её не было,
          // спросы могли и появиться, и умереть: сверяем список целиком.
          if (this.loaded) this._loadWaiting();
        } else if (name === 'chat-step') {
          // Шаг хода агента (инструмент/размышление/результат) — живая лента в чате.
          const s = this._get(d.chatKey);
          if (s && d.step) (s.steps ||= []).push(d.step);
        } else if (name === 'chat-orphan') {
          // Ответ остался без адресата (то окно умерло) — подбираем в этом окне.
          this._collectPending();
        } else if (name === 'chat-progress') {
          // Живой прогресс «думает… · N ток.». Прогресс = агент точно работает:
          // восстанавливаем и sending (окно могло перезагрузиться посреди хода).
          const s = this._get(d.chatKey);
          if (s) { s.sending = true; s.progressTokens = d.tokens; }
        } else if (name === 'chat-turn-start') {
          // Со дна очереди пошёл следующий ход: снимаем «ждёт очереди» с самого раннего
          // ожидающего сообщения — теперь оно в работе, а не в списке ожидания.
          const s = this._get(d.chatKey);
          const m = (s?.messages || []).find((x) => x.queued);
          if (m) delete m.queued;
          if (s) { s.sending = true; s.steps = []; s.progressTokens = 0; }
        } else if (name === 'chat-done') {
          // Ход завершён — снять «думает…» во всех окнах (ответ доставляется
          // ожидавшему окну или через pending). Но если из этого окна ушли ещё сообщения
          // и они ждут очереди, агент продолжит работу: индикатор оставляем.
          const s = this._get(d.chatKey);
          if (s && !s.inflight) { s.sending = false; s.stopping = false; s.progressTokens = 0; }
        }
      });
    },
    /**
     * Новый спрос агента. Оповещаем, если на этот чат сейчас не смотрят: агент СТОИТ,
     * пока не ответят, — пропустить такое дороже, чем пропустить обычный ответ.
     */
    _addPending(req) {
      this.pending[req.pid] = req;
      if (this._visible(req.chatKey)) return;
      const s = this._get(req.chatKey) || this.archived.find((x) => x.id === req.chatKey);
      const who = s ? this.tabLabel(s) : 'чат';
      const what = req.kind === 'question'
        ? (req.questions?.[0]?.question || 'Агент задал вопрос')
        : `Агент просит разрешение: ${req.tool || 'действие'}`;
      notify(`Нужен твой ответ — ${who}`, what.slice(0, 120), `chat-ask-${req.chatKey || req.pid}`);
    },
    /**
     * Спросы, которые уже висели: SSE доставляет событие один раз, поэтому после F5
     * (и во втором окне) поднимаем их отдельным запросом — иначе агент ждёт ответа,
     * а показать его некому.
     */
    async _loadWaiting() {
      let waiting;
      try { ({ waiting } = await api.get('/api/chat/waiting')); }
      catch { return; /* сервер старый/недоступен — обойдёмся SSE */ }
      // Сверяемся ПОЛНОСТЬЮ, а не дозаливаем: после рестарта сервера запросы умирают
      // вместе с процессами агентов, и наши всплывашки стали бы фантомами.
      const fresh = {};
      for (const w of waiting || []) {
        fresh[w.pid] = this.pending[w.pid] || { ...w, kind: w.questions ? 'question' : 'perm' };
      }
      this.pending = fresh;
    },
    async answerPerm(pid, allow, remember = false) {
      const p = this.pending[pid];
      if (!p) return;
      delete this.pending[pid];
      if (allow && remember && p.chatKey && p.tool) {
        (permAutoAllow[p.chatKey] ||= new Set()).add(p.tool);
      }
      // План оставляем в переписке: всплывашка закроется, а решение принималось по нему —
      // потом нужно видеть, что именно утвердили (или что ушло на доработку).
      if (p.tool === 'ExitPlanMode' && p.input?.plan) {
        const s = this._get(p.chatKey);
        if (s) {
          s.messages.push({
            role: 'assistant',
            text: `**План — ${allow ? 'утверждён' : 'на доработку'}**\n\n${p.input.plan}`,
          });
          s.updatedAt = Date.now();
          this._persist();
        }
      }
      try { await api.post(`/api/chat/permission/${p.pid}`, { allow }); }
      catch { /* запрос уже протух (таймаут/другое окно) */ }
    },
    // Ответ на вопрос агента: answers = [{ header, question, selected: [метки], text }].
    // Сервер превращает их в текст, который агент читает как результат своего вопроса.
    async answerQuestion(pid, answers) {
      if (!this.pending[pid]) return;
      delete this.pending[pid];
      try { await api.post(`/api/chat/permission/${pid}`, { answers }); }
      catch { /* запрос уже снят (стоп/конец хода/другое окно) */ }
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
    /**
     * Унести активный чат в архив. keepEmpty=true используется явным действием
     * «удалить»: пользователь попросил сохранить в архиве даже пустой разговор.
     * Обычное закрытие пустой вкладки по-прежнему просто убирает её.
     */
    _archiveSession(id, keepEmpty = false) {
      const i = this.sessions.findIndex((s) => s.id === id);
      if (i < 0) return false;
      const [s] = this.sessions.splice(i, 1);
      // Черновик — тоже содержимое: закрытие вкладки не должно молча его терять.
      if (keepEmpty || s.messages?.length || (s.draft || '').trim()) {
        delete s.archived;
        s.closedAt = Date.now();
        this.archived.unshift(s);
      }
      if (this.activeId === id) this.activeId = this.sessions[Math.max(0, i - 1)]?.id || null;
      if (!this.sessions.length) this.newSession();
      this._persist();
      return true;
    },
    closeSession(id) { this._archiveSession(id); },
    // Вернуть чат из архива в открытые вкладки.
    restoreArchived(id) {
      const i = this.archived.findIndex((s) => s.id === id);
      if (i < 0) return;
      const [a] = this.archived.splice(i, 1);
      delete a.archived;
      delete a.closedAt;
      a.sending ??= false;
      a.error ??= null;
      this.sessions.push(a);
      this.activeId = a.id;
      this._persist();
    },
    setActive(id) { if (this._get(id)) { this.activeId = id; this._persist(); } },
    setTitle(id, title) { const s = this._get(id); if (!s) return; s.title = title; this._persist(); },
    // Выбор чата из сайдбара: открытый — активируем, архивный — восстанавливаем.
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
    // Двухступенчатое удаление: активный чат сначала уходит в архив; только повторное
    // удаление из архива стирает его безвозвратно (и серверный файл — через _persist).
    deleteChat(id) {
      if (this._get(id)) return this._archiveSession(id, true) ? 'archived' : null;
      const j = this.archived.findIndex((x) => x.id === id);
      if (j < 0) return null;
      this.archived.splice(j, 1);
      this._persist();
      return 'deleted';
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
    /**
     * Режим прав чата (вручную / авто / план …). Запоминаем и как дефолт новых чатов —
     * выбор режима обычно про привычку работы, а не про конкретный разговор.
     */
    setMode(id, m) { const s = this._get(id); if (!s) return; s.mode = m; this.defMode = m; this._persist(); },
    setModel(id, m) { const s = this._get(id); if (!s) return; s.model = m; this.defModel = m; this._persist(); },
    /**
     * Черновик неотправленного сообщения. Живёт в чате (и на сервере), поэтому
     * переключение чатов и перезагрузка страницы его не теряют — как в телеграме.
     * updatedAt НЕ трогаем: набор текста не должен поднимать чат в списке.
     */
    setDraft(id, text) {
      const s = this._get(id);
      if (!s || (s.draft || '') === text) return;
      s.draft = text;
      this._persist();
    },
    setEffort(id, e) { const s = this._get(id); if (!s) return; s.effort = e; this.defEffort = e; this._persist(); },
    clearChat(id) { const s = this._get(id); if (!s) return; s.messages = []; s.error = null; this._persist(); },
    resetContext(id) {
      const s = this._get(id);
      if (!s) return;
      s.sessionId = null;
      s.contextTokens = 0;
      s.contextIsEstimate = false;
      this._persist();
    },

    /**
     * Стоп работающего (или зависшего) агента: сервер убивает процесс CLI, ход
     * возвращается как обычный ответ «⏹ Ход остановлен» с уже показанной лентой.
     * Флаг sending снимет сам ответ запроса send(), поэтому здесь его не трогаем.
     */
    async stop(id) {
      const s = this._get(id);
      if (!s?.sending) return;
      s.stopping = true;
      try { await api.post('/api/chat/stop', { chatKey: id }); } catch { /* ход мог уже кончиться */ }
    },

    async send(id, text, attachments = []) {
      const s = this._get(id); if (!s) return;
      if (!text.trim() && !attachments.length) return;
      // Cockpit просит семантическое имя только в первом ходе безымянного чата.
      // Пока агент работает, мгновенно показываем локальный запасной вариант.
      const requestTitle = shouldRequestChatTitle(s);
      const autoTitle = firstMessageTitle(s, text, attachments);
      if (autoTitle) s.title = autoTitle;
      // Писать во время хода МОЖНО: человек готовит следующее сообщение, пока агент работает.
      // Сервер выстроит ходы в очередь (см. modules/chat: два CLI на одну сессию не живут),
      // а здесь помечаем сообщение «ждёт очереди», чтобы было видно — оно принято, но ещё не в работе.
      const queued = !!s.sending;
      // Вложения в истории — только ссылки на серверные файлы (file/name/url/mime).
      const atts = attachments.map((a) => ({ file: a.file, name: a.name, url: a.url, mime: a.mime }));
      s.messages.push({ role: 'user', text, ...(atts.length ? { attachments: atts } : {}), ...(queued ? { queued: true } : {}) });
      // Счётчик незакрытых отправок: «думает…» гасим, только когда закончилась ПОСЛЕДНЯЯ,
      // иначе ответ первого хода снимал бы индикатор у ещё работающего второго.
      s.inflight = (s.inflight || 0) + 1;
      s.sending = true; s.error = null;
      if (!queued) { s.progressTokens = 0; s.steps = []; } // лента предыдущего хода уже уехала в своё сообщение
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
        // Модель: сохранённый алиас резолвим в конкретную (что показано в селекте, то и считает),
        // пустое значение — модель по умолчанию из реестра.
        const provStore = useProvidersStore();
        const resolvedModel = provStore.modelOf(s.model);
        const effortLevels = resolvedModel.model?.efforts || [];
        // Пока реестр не сообщил уровни или старый выбор исчез из свежего каталога,
        // явный effort не отправляем: CLI применит собственный актуальный дефолт.
        const requestEffort = effortLevels.includes(s.effort) ? s.effort : '';
        const r = await api.post(url, {
          message: text, model: resolvedModel.id, effort: requestEffort, mode: s.mode || '',
          sessionId: s.sessionId, context, chatKey: id, requestTitle,
          ...(atts.length ? { attachments: atts.map((a) => ({ file: a.file, name: a.name })) } : {}),
        });
        // Сервер вырезал служебный маркер из ответа и вернул готовое трёхсловное имя.
        // Ручное переименование, сделанное во время хода, не перетираем.
        if (requestTitle) applyGeneratedChatTitle(s, r.title, autoTitle);
        // Пустой id не затираем: у оборванного хода («стоп», лимит) его может не быть,
        // а прежняя сессия жива — иначе следующий вопрос уйдёт без --resume и агент
        // не вспомнит ничего из разговора.
        if (r.sessionId) s.sessionId = r.sessionId;
        if (typeof r.contextTokens === 'number' && r.contextTokens > 0) {
          s.contextTokens = r.contextTokens;
          s.contextIsEstimate = !!r.contextIsEstimate;
        }
        // Лента хода переезжает в сообщение (серверная копия полнее: SSE мог что-то не донести),
        // actualModel/effort — чем CLI отработал на самом деле (алиасы он резолвит сам).
        s.messages.push({
          role: 'assistant', text: r.reply || '(пусто)', cost: r.cost,
          steps: (r.steps?.length ? r.steps : s.steps) || [],
          model: r.model || s.model, actualModel: r.actualModel || '',
          effort: Object.hasOwn(r, 'effort') ? (r.effort || '') : requestEffort,
        });
        // Сервер мог подменить эффорт (модель не тянет выбранный уровень) — подтягиваем
        // слайдер под реальность, чтобы UI не врал. Пишем в сессию напрямую, НЕ через
        // setEffort: вынужденный откат не должен становиться дефолтом для новых чатов.
        if (r.effort && r.effort !== s.effort) s.effort = r.effort;
        s.steps = [];
        // Пользователь не смотрит на этот чат (другая вкладка ОС, другой раздел с закрытой
        // панелью или другой активный чат) — метка «непрочитано» и оповещение.
        if (!this._visible(id)) {
          s.unread = true;
          notify(`Агент ответил — ${this.tabLabel(s)}`, (r.reply || '').slice(0, 120), `chat-${id}`);
        }
      } catch (e) {
        s.error = e.message;
        s.messages.push({ role: 'error', text: e.message });
      } finally {
        s.inflight = Math.max(0, (s.inflight || 1) - 1);
        // Ещё есть незакрытые отправки этого чата — ход продолжается, «думает…» не снимаем.
        if (!s.inflight) { s.sending = false; s.stopping = false; s.progressTokens = 0; }
        s.updatedAt = Date.now(); this._persist();
      }
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
