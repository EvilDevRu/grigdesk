// Вотчер телеграм-пульта: следит, что работа СТОИТ на человеке, и приносит это
// карточками в личку владельца.
//
// Правило «что требует человека» НЕ копируется: сервер импортирует те же модули,
// что чип навигации и вотчер оповещений браузера, — путь ведёт в web/, потому что
// правило одно на всех (копий уже было две, и они расходились; см. gotchas).
// Оба файла — чистые ESM без Vue-зависимостей, Node импортирует их напрямую.
//
// Данные — те же ручки кокпита через inject (`callApi`): /api/tasks (затыки,
// молчание, порог), /api/tasks/:id/graph (ворота), /api/chat/waiting (вопросы и
// разрешения; после рестарта сервера pendingPerms умирают вместе с процессами
// агентов — этот же обход закрывает карточки-фантомы).
//
// Оповещение — только на переходе «не ждала → ждёт». Первый снимок после
// старта/включения — silent (правило notify-watch), state и message_id карточек
// переживают рестарт в pult-state.json.
import { waitingReason } from '../../../../../web/src/shared/pipeline-wait.js';
import { silenceReason } from '../../../../../web/src/shared/agent-activity.js';
import {
  clipText,
  collapseLine,
  gateCard,
  gateKeyboard,
  permissionCard,
  permissionKeyboard,
  questionCard,
  questionKeyboard,
  resolvedCard,
  silenceCard,
  stallCard,
  stallKeyboard,
} from './format.js';
import { PultSendQueue } from './send-queue.js';

const CALL_TIMEOUT_MS = 15_000;
// Меняем при несовместимой разметке карточек: существующее сообщение best-effort
// обновится после рестарта, не дожидаясь, пока повод исчезнет и возникнет снова.
const CARD_UI_VERSION = 2;

/** Telegram считает правку тем же текстом/кнопками ошибкой, но миграция уже выполнена. */
const isUnchangedEdit = (error) => /message is not modified/iu.test(String(error?.message || ''));

/** Превью запроса разрешения: команда сильнее пути, путь сильнее описания. */
export function permissionPreview(input) {
  if (!input || typeof input !== 'object') return '';
  for (const field of ['command', 'file_path', 'description', 'plan']) {
    if (typeof input[field] === 'string' && input[field].trim()) return input[field];
  }
  try { return JSON.stringify(input); } catch { return ''; }
}

export class TelegramPultWatch {
  constructor({
    acquireLease,
    isEnabled,
    callApi,
    stateStoreFor,
    queue = new PultSendQueue(),
    subscribe = null,
    now = Date.now,
    log = console,
    debounceMs = 3_000,
    chatDebounceMs = 500,
    intervalMs = 120_000,
  } = {}) {
    if (typeof acquireLease !== 'function' || typeof isEnabled !== 'function'
        || typeof callApi !== 'function' || typeof stateStoreFor !== 'function'
        || typeof now !== 'function') {
      throw new TypeError('TelegramPultWatch: acquireLease/isEnabled/callApi/stateStoreFor/now обязательны.');
    }
    this.acquireLease = acquireLease;
    this.isEnabled = isEnabled;
    this.callApi = callApi;
    this.stateStoreFor = stateStoreFor;
    this.queue = queue;
    this.subscribe = subscribe;
    this.now = now;
    this.log = log;
    this.debounceMs = debounceMs;
    this.chatDebounceMs = chatDebounceMs;
    this.intervalMs = intervalMs;

    this._ownerKey = null;
    this._store = null;
    this._state = null;
    this._persisted = '';
    this._summary = null;
    this._inflight = null;
    this._again = false;
    this._timer = null;
    this._interval = null;
    this._unsubscribe = null;
    this._stopped = false;
  }

  start() {
    if (this._interval) return;
    this._stopped = false;
    this._unsubscribe = this.subscribe?.((event) => this._onBus(event)) || null;
    // Страховочный интервал — как 120 с в web: SSE можно пропустить, обход нельзя.
    this._interval = setInterval(() => { void this.check(); }, this.intervalMs);
    this._interval.unref?.();
    void this.check();
  }

  async stop() {
    this._stopped = true;
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    try { this._unsubscribe?.(); } catch { /* подписки может уже не быть */ }
    this._unsubscribe = null;
    if (this._inflight) await this._inflight.catch(() => {});
  }

  _onBus(event) {
    // Событиям чата — короткая пауза (карточка вопроса должна прийти сразу),
    // state-change дебаунсится сильнее: файлы фабрики меняются пачками.
    if (event === 'state-change') this._schedule(this.debounceMs);
    else if (['chat-question', 'chat-permission', 'chat-permission-done'].includes(event)) {
      this._schedule(this.chatDebounceMs);
    }
  }

  _schedule(delayMs) {
    if (this._timer || this._stopped) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.check();
    }, delayMs);
    this._timer.unref?.();
  }

  /**
   * Забыть карточку БЕЗ правки сообщения: действие пульта уже отредактировало её
   * само (точным итогом вроде «принято, прогон продолжен»), и общий «✓ решено»
   * следующего обхода затёр бы более конкретный текст.
   */
  forget(key) {
    if (!this._state?.cards || !(key in this._state.cards)) return;
    delete this._state.cards[key];
    void this._persistState();
  }

  async _persistState() {
    if (!this._store || !this._state) return;
    const snapshot = JSON.stringify(this._state.cards);
    if (snapshot === this._persisted) return;
    this._persisted = snapshot;
    try {
      await this._store.write(this._state);
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: state не записался');
    }
  }

  /** Обходы сериализованы; вызов во время обхода дозаказывает ещё один круг. */
  check() {
    if (this._inflight) {
      this._again = true;
      return this._inflight;
    }
    this._inflight = (async () => {
      try {
        do {
          this._again = false;
          await this._checkOnce();
        } while (this._again && !this._stopped);
      } catch (error) {
        this.log.warn?.({ code: error?.code }, `telegram-pult: обход сорвался: ${error?.message || 'unknown'}`);
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  async _checkOnce() {
    if (!await this.isEnabled()) return;
    let lease;
    try {
      lease = this.acquireLease();
    } catch (error) {
      if (['channel_disconnected', 'account_draining'].includes(error?.code)) return;
      throw error;
    }
    try {
      if (!lease.isCurrent()) return;
      let settings;
      try {
        settings = await lease.context.botSettings.read();
      } catch (error) {
        this.log.warn?.({ code: error?.code }, 'telegram-pult: настройки нечитаемы, обход пропущен');
        return;
      }
      // Пульт не подтверждён — не ходим даже в API кокпита: выключенный пульт
      // не должен создавать фоновых обходов.
      if (settings.pultConfirmedAtMs == null || settings.pultChatId == null) {
        this._ownerKey = null;
        return;
      }
      const token = lease.context.credentials?.token || '';
      if (!token) return;

      const ownerKey = `${lease.accountRef}:${settings.pultChatId}:${settings.pultConfirmedAtMs}`;
      let silentSnapshot = false;
      if (this._ownerKey !== ownerKey) {
        // Первый снимок после старта процесса или включения пульта: state
        // заполняется, карточки не шлются — иначе каждый рестарт «оповещал» бы
        // о давно ждущих задачах (правило notify-watch).
        this._ownerKey = ownerKey;
        this._store = this.stateStoreFor(lease);
        const loaded = await this._store.read();
        // message_id уникален только внутри конкретного чата. Состояние прежней
        // привязки нельзя применять к новому владельцу даже при совпавшем номере
        // сообщения: неизвестные legacy-карточки тоже безопасно забываем.
        const sameOwner = Object.values(loaded.cards)
          .every((card) => card.ownerKey === ownerKey);
        this._state = sameOwner ? loaded : { cards: {} };
        // При смене owner persisted оставляем от загруженного состояния, чтобы
        // пустой/новый снимок гарантированно перезаписал старые message_id.
        this._persisted = JSON.stringify(loaded.cards);
        silentSnapshot = true;
      }

      const desired = await this._desired();
      if (!lease.isCurrent()) return;

      const chatId = settings.pultChatId;
      const cards = this._state.cards;
      const next = {};

      for (const [key, want] of desired) {
        const have = cards[key];
        if (have) {
          if (!have.messageId || have.uiVersion === CARD_UI_VERSION) {
            next[key] = {
              ...have,
              kind: want.kind,
              subject: want.subject,
              ownerKey,
              uiVersion: CARD_UI_VERSION,
            };
            continue;
          }
          try {
            await this.queue.push(() => lease.context.botApi.callBotApi(token, 'editMessageText', {
              chat_id: chatId,
              message_id: have.messageId,
              text: want.text,
              link_preview_options: { is_disabled: true },
              reply_markup: { inline_keyboard: want.keyboard || [] },
            }, { timeoutMs: CALL_TIMEOUT_MS }));
            next[key] = {
              ...have,
              kind: want.kind,
              subject: want.subject,
              ownerKey,
              uiVersion: CARD_UI_VERSION,
            };
          } catch (error) {
            if (isUnchangedEdit(error)) {
              next[key] = {
                ...have,
                kind: want.kind,
                subject: want.subject,
                ownerKey,
                uiVersion: CARD_UI_VERSION,
              };
              continue;
            }
            // Версию не повышаем: следующий обход ещё раз попробует обновить
            // старую карточку с прежними кнопками.
            next[key] = have;
            this.log.warn?.({ code: error?.code }, 'telegram-pult: старая карточка не обновилась');
          }
          continue;
        }
        if (silentSnapshot) {
          next[key] = {
            messageId: null,
            kind: want.kind,
            subject: want.subject,
            at: this.now(),
            ownerKey,
            uiVersion: CARD_UI_VERSION,
          };
          continue;
        }
        try {
          const sent = await this.queue.push(() => lease.context.botApi.callBotApi(token, 'sendMessage', {
            chat_id: chatId,
            text: want.text,
            link_preview_options: { is_disabled: true },
            ...(want.keyboard ? { reply_markup: { inline_keyboard: want.keyboard } } : {}),
          }, { timeoutMs: CALL_TIMEOUT_MS }));
          const messageId = Number(sent?.message_id);
          next[key] = {
            messageId: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null,
            kind: want.kind,
            subject: want.subject,
            at: this.now(),
            ownerKey,
            uiVersion: CARD_UI_VERSION,
          };
        } catch (error) {
          // Best effort, at most once: не записываем как отправленное — карточка
          // уйдёт следующим обходом. Авторетрая внутри обхода нет намеренно.
          this.log.warn?.({ code: error?.code }, 'telegram-pult: карточка не отправилась, повторит следующий обход');
        }
      }

      // Повод ушёл: карточка гаснет в «✓ решено» по сохранённому message_id.
      for (const [key, card] of Object.entries(cards)) {
        if (desired.has(key)) continue;
        if (!card.messageId) continue; // silent-карточка: сообщений не было, забыть достаточно
        try {
          await this.queue.push(() => lease.context.botApi.callBotApi(token, 'editMessageText', {
            chat_id: chatId,
            message_id: card.messageId,
            text: resolvedCard({ subject: card.subject || 'карточка' }),
            reply_markup: { inline_keyboard: [] },
          }, { timeoutMs: CALL_TIMEOUT_MS }));
        } catch (error) {
          // Уборка — косметика: кнопки на старом сообщении всё равно безопасны (CAS).
          this.log.warn?.({ code: error?.code }, 'telegram-pult: карточка не погасилась (best effort)');
        }
      }

      this._state = { cards: next };
      await this._persistState();
    } finally {
      await lease?.release?.();
    }
  }

  /** Что сейчас требует человека. Тем же правилом считается и /status. */
  async _desired() {
    const desired = new Map();
    const summary = { tasks: [], waiting: [], stalled: [], silent: [], chat: [], running: [] };

    const tasksBody = await this._api('GET', '/api/tasks');
    const tasks = Array.isArray(tasksBody?.tasks) ? tasksBody.tasks : [];
    const silenceWindow = Math.max(0, Number(tasksBody?.silenceWindow) || 0);
    for (const t of tasks) {
      const id = String(t.task);
      const title = clipText(collapseLine(t.title), 160);
      const subject = `#${id}${title ? ` — ${title}` : ''}`;
      const taskSummary = {
        task: id,
        title,
        daemonAlive: Boolean(t.daemonAlive),
        stall: t.stall || null,
        quiet: null,
        graph: null,
      };
      summary.tasks.push(taskSummary);
      if (t.daemonAlive) summary.running.push({ task: id });
      if (t.stall) {
        const stage = t.stall.stage || '';
        summary.stalled.push({ task: id, title: t.stall.title || 'конвейер встал' });
        desired.set(`stall:${id}`, {
          kind: 'stall',
          subject,
          text: stallCard({ subject, stage, reason: t.stall.title || 'конвейер встал' }),
          keyboard: this._keyboard(() => stallKeyboard(id, stage)),
        });
      }
      const quiet = silenceReason(t, silenceWindow);
      taskSummary.quiet = quiet;
      if (quiet) {
        summary.silent.push({ task: id, text: quiet.text });
        desired.set(`silence:${id}:${quiet.stage}`, {
          kind: 'silence',
          subject,
          text: silenceCard({ subject, text: quiet.text }),
          keyboard: null, // кнопки нет намеренно: зависшие ходы кокпит не глушит
        });
      }
      let graph = null;
      try { graph = await this._api('GET', `/api/tasks/${id}/graph`); } catch { continue; }
      taskSummary.graph = graph;
      const wait = waitingReason(graph);
      if (!wait) continue;
      summary.waiting.push({ task: id, text: wait.text });
      const gateKey = graph?.keys?.[wait.node] || String(wait.node || '').toUpperCase();
      desired.set(`wait:${id}`, {
        kind: 'gate',
        subject,
        text: gateCard({ subject, reason: wait.text }),
        keyboard: this._keyboard(() => gateKeyboard(id, gateKey)),
      });
    }

    try {
      const waitingBody = await this._api('GET', '/api/chat/waiting');
      for (const item of Array.isArray(waitingBody?.waiting) ? waitingBody.waiting : []) {
        const pid = String(item?.pid || '');
        if (!pid) continue;
        if (Array.isArray(item.questions)) {
          const first = item.questions[0] || {};
          const note = [
            item.questions.length > 1
              ? `Вопросов несколько (${item.questions.length}) — остальные в кокпите.`
              : '',
            first.multiSelect
              ? 'Мультивыбор: кнопка отвечает одним вариантом, полный набор — в кокпите.'
              : '',
          ].filter(Boolean).join(' ');
          summary.chat.push({ pid, text: first.question || 'вопрос агента' });
          desired.set(`q:${pid}`, {
            kind: 'question',
            subject: 'чат',
            text: questionCard({ subject: 'чат', question: first.question || '…', note }),
            keyboard: this._keyboard(() => questionKeyboard(pid, first.options || [])),
          });
        } else {
          summary.chat.push({ pid, text: item.tool || 'разрешение' });
          desired.set(`perm:${pid}`, {
            kind: 'perm',
            subject: 'чат',
            text: permissionCard({
              subject: 'чат',
              tool: item.tool || 'Действие агента',
              preview: permissionPreview(item.input),
            }),
            keyboard: this._keyboard(() => permissionKeyboard(pid)),
          });
        }
      }
    } catch (error) {
      // Чат недоступен — конвейерные карточки не страдают; фантомы догоним позже.
      this.log.warn?.({ code: error?.code }, 'telegram-pult: /api/chat/waiting недоступен');
    }

    this._summary = summary;
    return desired;
  }

  /** Кнопки — best effort: не влезли в 64 байта → карточка без кнопок, не падение. */
  _keyboard(build) {
    try { return build(); } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: кнопки не собрались, карточка без них');
      return null;
    }
  }

  async _api(method, url, payload) {
    const res = await this.callApi(method, url, payload);
    if (!res || res.statusCode >= 400) {
      throw Object.assign(new Error(`pult callApi ${method} ${url}: ${res?.statusCode}`), {
        code: 'pult_api_failed',
        statusCode: res?.statusCode,
      });
    }
    return res.body;
  }

  /** Сводка /status: тот же снимок, что чип «Конвейер», поимённо. */
  async statusSummary() {
    await this.check();
    const s = this._summary;
    if (!s) return 'Сводка пока не собрана — попробуй через минуту.';
    const lines = [];
    if (s.waiting.length) {
      lines.push(`⏳ ждут твоего решения: ${s.waiting.length}`);
      lines.push(...s.waiting.map((w) => `#${w.task}: ${w.text}`));
    }
    if (s.stalled.length) {
      lines.push(`🛑 встали: ${s.stalled.length}`);
      lines.push(...s.stalled.map((x) => `#${x.task}: ${x.title}`));
    }
    if (s.silent.length) {
      lines.push(`💤 молчат: ${s.silent.length}`);
      lines.push(...s.silent.map((x) => `#${x.task}: ${x.text}`));
    }
    if (s.chat.length) {
      lines.push(`💬 в чатах ждут ответа: ${s.chat.length}`);
    }
    if (s.running.length) {
      const attention = new Set([...s.waiting, ...s.stalled, ...s.silent].map((x) => x.task));
      const running = s.running.filter((x) => !attention.has(x.task));
      if (running.length) {
        lines.push(`🔵 в работе: ${running.length}`);
        lines.push(...running.map((x) => `#${x.task}`));
      }
    }
    if (!lines.length) return 'Всё спокойно: никто не ждёт, ничего не встало и не молчит.';
    return lines.join('\n');
  }

  /** Живой структурированный снимок для интерактивного `/status`. */
  async statusSnapshot() {
    await this.check();
    return this._summary;
  }
}

export default TelegramPultWatch;
