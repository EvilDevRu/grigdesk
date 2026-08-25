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
import { createHash } from 'node:crypto';
import { waitingReason } from '../../../../../web/src/shared/pipeline-wait.js';
import { silenceReason } from '../../../../../web/src/shared/agent-activity.js';
import {
  chatSubject,
  clipText,
  collapseLine,
  finishedCard,
  gateCard,
  gateKeyboard,
  liveCard,
  liveKeyboard,
  liveSignature,
  permissionCard,
  permissionKeyboard,
  questionCard,
  questionKeyboard,
  silenceCard,
  stallCard,
  stallKeyboard,
} from './format.js';
import { PultSendQueue } from './send-queue.js';
import { encodePultOwnerKey, pultOwnerKeyMatches } from './state-store.js';

const CALL_TIMEOUT_MS = 15_000;
// Меняем при несовместимой разметке карточек: существующее сообщение best-effort
// обновится после рестарта, не дожидаясь, пока повод исчезнет и возникнет снова.
export const CARD_UI_VERSION = 4;

/**
 * Исходы, о которых будить не надо. `human-rewind` человек сделал сам, `recovered`
 * означает лишь, что маршрут поехал новой попыткой — её карточка придёт своим ходом.
 * Доехавший маршрут и закрытая попытка, наоборот, звонят: их и ждут с телефона.
 */
const QUIET_RESULTS = new Set(['recovered', 'human-rewind']);

/** Отпечаток текста карточки: хранить в state весь текст дорого, сравнить надо точно. */
const textHash = (text) => createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);

/** Telegram считает правку тем же текстом/кнопками ошибкой, но миграция уже выполнена. */
const isUnchangedEdit = (error) => /message is not modified/iu.test(String(error?.message || ''));

/** Сообщения уже нет в чате (удалил человек): удалять нечего, ключ забывается. */
const isMissingMessage = (error) => /not found/iu.test(String(error?.message || ''));

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
    liveEditMinMs = 60_000,
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
    // Живая карточка правится сразу на смене узла/статуса, а тикающие минуты
    // молчания — не чаще этого интервала: иначе каждое `state-change` идущего
    // прогона превращалось бы в editMessageText и выбирало лимит Bot API.
    this.liveEditMinMs = liveEditMinMs;

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
   * Забыть карточку БЕЗ удаления сообщения: действие пульта уже удалило её само
   * (итог человек увидел всплывашкой или эфемерным «✓ …»), и повторное удаление
   * следующего обхода было бы лишним вызовом.
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
      // Merge-запись: screen/sent действий пульта это не трогает.
      await this._store.write({ cards: this._state.cards });
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

      const ownerKey = encodePultOwnerKey(
        lease.accountRef,
        settings.pultConfirmedAtMs,
        settings.pultChatId,
      );
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
        const sameOwner = Object.values(loaded.cards).every((card) => pultOwnerKeyMatches(
          card.ownerKey,
          lease.accountRef,
          settings.pultConfirmedAtMs,
          settings.pultChatId,
        ));
        this._state = sameOwner ? loaded : {
          cards: {}, screen: null, sent: [], turns: loaded.turns || [],
        };
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
        // Живая карточка доехавшего прогона в исход НЕ правится: рядом уходит
        // done: с тем же итогом, а сама live удаляется отдельным проходом ниже —
        // в истории остаётся ровно одно сообщение о результате прогона.
        if (have && want.live === true && desired.has(`done:${key.slice(5)}`)) {
          next[key] = have;
          continue;
        }
        const meta = {
          kind: want.kind,
          subject: want.subject,
          ownerKey,
          uiVersion: CARD_UI_VERSION,
          sticky: want.sticky === true,
          sig: want.sig ?? null,
          hash: textHash(want.text),
          ...(want.replyAction ? { replyAction: want.replyAction } : {}),
        };
        if (have) {
          // Править нечего у silent-карточки (сообщения не было). Иначе поводов два:
          // миграция разметки после обновления кокпита и живая карточка, чьё
          // содержимое реально изменилось.
          const stale = have.hash !== meta.hash;
          const cooled = !have.editedAt || (this.now() - have.editedAt) >= this.liveEditMinMs;
          const shouldEdit = Boolean(have.messageId) && (
            have.uiVersion !== CARD_UI_VERSION
            || (want.live === true && stale && (have.sig !== meta.sig || cooled))
          );
          if (!shouldEdit) {
            // Хэш и подпись сохраняем прежними: содержимое на экране не менялось,
            // и переписать их значило бы соврать следующему обходу про остывание.
            next[key] = { ...have, ...meta, sig: have.sig ?? meta.sig, hash: have.hash ?? meta.hash };
            continue;
          }
          try {
            await this.queue.push(() => lease.context.botApi.callBotApi(token, 'editMessageText', {
              chat_id: chatId,
              message_id: have.messageId,
              text: want.text,
              link_preview_options: { is_disabled: true },
              reply_markup: { inline_keyboard: want.keyboard || [] },
            }, { timeoutMs: CALL_TIMEOUT_MS }), { priority: 'background' });
            next[key] = { ...have, ...meta, editedAt: this.now() };
          } catch (error) {
            if (isUnchangedEdit(error)) {
              // Текст на экране и так этот: правка не нужна, состояние актуально.
              next[key] = { ...have, ...meta, editedAt: this.now() };
              continue;
            }
            // Версию и хэш не повышаем: следующий обход ещё раз попробует обновить
            // старую карточку с прежними кнопками.
            next[key] = have;
            this.log.warn?.({ code: error?.code }, 'telegram-pult: карточка не обновилась');
          }
          continue;
        }
        if (silentSnapshot) {
          next[key] = { messageId: null, at: this.now(), ...meta };
          continue;
        }
        try {
          const sent = await this.queue.push(() => lease.context.botApi.callBotApi(token, 'sendMessage', {
            chat_id: chatId,
            text: want.text,
            link_preview_options: { is_disabled: true },
            // Живая карточка и служебный исход не будят телефон: звонить имеет
            // право только то, что действительно стоит на человеке.
            ...(want.silent === true ? { disable_notification: true } : {}),
            ...(want.keyboard ? { reply_markup: { inline_keyboard: want.keyboard } } : {}),
          }, { timeoutMs: CALL_TIMEOUT_MS }), { priority: 'background' });
          const messageId = Number(sent?.message_id);
          next[key] = {
            messageId: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null,
            at: this.now(),
            editedAt: this.now(),
            ...meta,
          };
        } catch (error) {
          // Best effort, at most once: не записываем как отправленное — карточка
          // уйдёт следующим обходом. Авторетрая внутри обхода нет намеренно.
          this.log.warn?.({ code: error?.code }, 'telegram-pult: карточка не отправилась, повторит следующий обход');
        }
      }

      // Повод ушёл: карточка удаляется из чата по сохранённому message_id.
      for (const [key, card] of Object.entries(cards)) {
        if (desired.has(key)) continue;
        if (!card.messageId) continue; // silent-карточка: сообщений не было, забыть достаточно
        // Липкая карточка — единственная запись об исходе прогона: удалить её
        // значило бы стереть, чем всё кончилось. Уход из desired для неё значит
        // лишь «задачу заархивировали» — ключ забывается, сообщение остаётся.
        if (card.sticky) continue;
        try {
          await this.queue.push(() => lease.context.botApi.callBotApi(token, 'deleteMessage', {
            chat_id: chatId,
            message_id: card.messageId,
          }, { timeoutMs: CALL_TIMEOUT_MS }), { priority: 'background' });
        } catch (error) {
          if (isMissingMessage(error)) continue; // человек уже удалил сам — забыть достаточно
          // Не удалилось — не записываем как успех: карточка остаётся в state
          // и удаление повторится следующим обходом. Обход это не роняет.
          next[key] = card;
          this.log.warn?.({ code: error?.code }, 'telegram-pult: карточка не удалилась, повторит следующий обход');
        }
      }

      // Прогон доехал: done: ушёл отдельным сообщением, и живая карточка рядом —
      // дубль того же итога. Удаляем её, но ТОЛЬКО когда done: реально отправлен.
      for (const [key, card] of Object.entries(next)) {
        if (!key.startsWith('done:')) continue;
        const liveKey = `live:${key.slice(5)}`;
        const live = next[liveKey];
        if (!live?.messageId) continue;
        if (!card.messageId) {
          // done: не отправлен — прогон доехал, пока сервер лежал, и первый
          // снимок был silent. Живое сообщение тогда единственная запись об
          // исходе: правим её в итог, иначе она навсегда осталась бы
          // замороженной на «прогон идёт», а исхода человек не увидел бы нигде.
          // kind 'done' — отметка, что правка уже сделана: без неё каждый
          // следующий обход слал бы ту же правку заново.
          if (live.kind === 'done') continue;
          const want = desired.get(key);
          if (!want) continue;
          try {
            await this.queue.push(() => lease.context.botApi.callBotApi(token, 'editMessageText', {
              chat_id: chatId,
              message_id: live.messageId,
              text: want.text,
              link_preview_options: { is_disabled: true },
              reply_markup: { inline_keyboard: [] },
            }, { timeoutMs: CALL_TIMEOUT_MS }), { priority: 'background' });
            next[liveKey] = { ...live, kind: 'done', sig: null, hash: textHash(want.text), editedAt: this.now() };
          } catch (error) {
            if (isUnchangedEdit(error)) {
              next[liveKey] = { ...live, kind: 'done', sig: null, hash: textHash(want.text), editedAt: this.now() };
              continue;
            }
            if (isMissingMessage(error)) {
              // Сообщения уже нет: исход человек убрал сам, повторять нечего.
              next[liveKey] = { ...live, messageId: null };
              continue;
            }
            // Прочий отказ не роняет обход: live остаётся, правка повторится
            // следующим обходом.
            this.log.warn?.({ code: error?.code }, 'telegram-pult: живая карточка не обновилась до исхода, повторит следующий обход');
          }
          continue;
        }
        try {
          await this.queue.push(() => lease.context.botApi.callBotApi(token, 'deleteMessage', {
            chat_id: chatId,
            message_id: live.messageId,
          }, { timeoutMs: CALL_TIMEOUT_MS }), { priority: 'background' });
          // Надгробие: messageId null — повторной отправки и правки не будет.
          next[liveKey] = { ...live, messageId: null };
        } catch (error) {
          if (isMissingMessage(error)) {
            next[liveKey] = { ...live, messageId: null };
            continue;
          }
          // Прочий отказ: live остаётся нетронутым, удаление повторит следующий обход.
          this.log.warn?.({ code: error?.code }, 'telegram-pult: живая карточка не удалилась, повторит следующий обход');
        }
      }

      this._state = { ...this._state, cards: next };
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
      const attempt = String(t.attempt || '');
      const terminal = String(t.result || '').trim();
      const taskSummary = {
        task: id,
        title,
        daemonAlive: Boolean(t.daemonAlive),
        attempt,
        result: terminal,
        stall: t.stall || null,
        // Сырой замер молчания нужен карточке целиком: из него считается и «агент
        // пишет», и «нет событий N мин», а `quiet` — только перешагнутый порог.
        silence: t.silence || null,
        quiet: null,
        graph: null,
      };
      summary.tasks.push(taskSummary);
      if (t.daemonAlive) summary.running.push({ task: id });
      taskSummary.quiet = silenceReason(t, silenceWindow);

      let graph = null;
      try { graph = await this._api('GET', `/api/tasks/${id}/graph`); } catch {
        // Граф недоступен — карточка так и скажет; терять из-за этого задачу
        // целиком нельзя, иначе прогон молча пропадает с пульта.
      }
      taskSummary.graph = graph;

      // Живая карточка прогона: одно сообщение на попытку, которое вотчер держит
      // актуальным правкой. Ключ включает attempt — новый прогон той же задачи
      // получает свою карточку, а не переписывает историю прошлого.
      if (attempt) {
        desired.set(`live:${id}:${attempt}`, {
          kind: 'live',
          subject,
          live: true,
          silent: true,
          sticky: true,
          sig: liveSignature(taskSummary),
          text: liveCard(taskSummary),
          keyboard: terminal ? null : this._keyboard(() => liveKeyboard(id)),
        });
        // Исход прогона — отдельное сообщение: правка живой карточки push не даёт,
        // а «доехало или упало» с телефона ждут именно звонком.
        if (terminal) {
          desired.set(`done:${id}:${attempt}`, {
            kind: 'done',
            subject,
            sticky: true,
            silent: QUIET_RESULTS.has(terminal),
            text: finishedCard(taskSummary),
            keyboard: null,
          });
        }
      }

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
      if (taskSummary.quiet) {
        summary.silent.push({ task: id, text: taskSummary.quiet.text });
        desired.set(`silence:${id}:${taskSummary.quiet.stage}`, {
          kind: 'silence',
          subject,
          text: silenceCard({ subject, text: taskSummary.quiet.text }),
          keyboard: null, // кнопки нет намеренно: зависшие ходы кокпит не глушит
        });
      }
      const wait = graph ? waitingReason(graph) : null;
      if (!wait) continue;
      summary.waiting.push({ task: id, text: wait.text });
      const gateKey = graph?.keys?.[wait.node] || String(wait.node || '').toUpperCase();
      desired.set(`wait:${id}`, {
        kind: 'gate',
        subject,
        replyAction: { kind: 'gate-reject', taskId: id, gateKey },
        text: gateCard({ subject, reason: wait.text }),
        keyboard: this._keyboard(() => gateKeyboard(id, gateKey)),
      });
    }

    try {
      const waitingBody = await this._api('GET', '/api/chat/waiting');
      for (const item of Array.isArray(waitingBody?.waiting) ? waitingBody.waiting : []) {
        const pid = String(item?.pid || '');
        if (!pid) continue;
        // Кто спрашивает: имя разговора приходит вместе с ожиданием. Без него карточка
        // сообщает вопрос, на который нечем ответить, — чатов у человека несколько.
        const subject = chatSubject(item);
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
            subject,
            replyAction: { kind: 'question-text', pid },
            text: questionCard({
              subject,
              header: first.header || '',
              question: first.question || '…',
              options: first.options || [],
              note,
            }),
            keyboard: this._keyboard(() => questionKeyboard(pid, first.options || [])),
          });
        } else {
          summary.chat.push({ pid, text: item.tool || 'разрешение' });
          desired.set(`perm:${pid}`, {
            kind: 'perm',
            subject,
            replyAction: { kind: 'perm-deny', pid },
            text: permissionCard({
              subject,
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
