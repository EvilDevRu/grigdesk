// Приём телеграм-пульта: owner-гейт, команды владельца, нажатия кнопок и реплаи.
//
// Правило безопасности одно и оно проверяется на КАЖДОМ входящем (§5.1 плана):
// пульт подтверждён И личка та И пользователь тот. Всё остальное — молчаливый
// ноль исходящих: бот не отвечает и не подтверждает, что пульт существует
// (не оракул). Плагин выключен — то же молчание: «не ходить в сеть вовсе».
//
// Действия транслируются в те же HTTP-ручки, что жмёт браузер (через inject):
// пульт — ещё одно окно кокпита, второй копии валидации и CAS здесь нет. Ошибки
// ручек переводятся в человеческий текст в одном месте — тут.
//
// Пульт смотрит, разблокирует и поручает работу общему companion-ассистенту.
// Постановка задач принадлежит «Входящим», запуск прогона и деньги — кокпиту.
//
// Личка не копит мусор (t91001): вся навигация живёт в ОДНОМ сообщении-экране
// (запись screen в pult-state.json) и правится на месте, решённые карточки
// удаляются (итог — всплывашкой answerCallbackQuery, а на реплай-ветках, где
// callback нет, — эфемерным сообщением «✓ …»), накопленное сносит /clean.
import {
  STATUS_PAGE_SIZE,
  agentCard,
  agentKeyboard,
  cbData,
  chatSubject,
  clipText,
  collapseLine,
  confirmKeyboard,
  gateRejectKeyboard,
  helpKeyboard,
  homeCard,
  homeKeyboard,
  planPageCard,
  planPageKeyboard,
  planPages,
  parseCallback,
  permissionKeyboard,
  pultReplyAction,
  pultReplyKeyboard,
  questionKeyboard,
  statusListCard,
  statusListKeyboard,
  taskNodesKeyboard,
  taskNodesPage,
  taskStatusCard,
  taskStatusKeyboard,
  tasksCard,
  tasksKeyboard,
} from './format.ts';
import { TelegramPultAssistant } from './assistant.ts';
import { encodePultOwnerKey, pultOwnerKeyMatches } from './stateStore.ts';
import { PultSendQueue } from './sendQueue.ts';
import type { PultCallback } from './format.ts';

/** Потолок одного сообщения Bot API — 4096; берём с запасом под свои префиксы. */
type Payload = Record<string, unknown>;

interface ApiResponse {
  statusCode?: number;
  body?: Payload;
}

// Аренда аккаунта: пока она жива, владелец пульта и его токен не меняются.
interface ActionsLease {
  accountRef?: string;
  context: {
    botSettings: { read: () => Promise<Payload> };
    botApi: {
      callBotApi: (token: string, method: string, body?: Payload, opts?: Payload)
        => Promise<unknown>;
    };
    credentials?: { token?: string } | null;
  };
  isCurrent?: () => boolean;
  release?: () => unknown;
}

interface PultStateStorePort {
  read: () => Promise<{ screen: Payload | null; sent: Payload[]; turns: unknown[] } & Payload>;
  write: (patch: Payload) => Promise<unknown>;
}

// Общий контекст одного нажатия: чья аренда, какая кнопка и в какой личке.
interface ActionContext {
  lease: ActionsLease;
  callback: Payload;
  chatId: unknown;
  ownerKey?: string;
}

type LogPort = {
  info?: (details: unknown, message: string) => void;
  warn?: (details: unknown, message: string) => void;
  error?: (details: unknown, message: string) => void;
};

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;
const errorText = (err: unknown) => String((err as { message?: unknown } | null)?.message || '');

const MESSAGE_LIMIT = 4_000;
/** Потолок текста answerCallbackQuery — 200 символов. */
const ANSWER_LIMIT = 190;
/** TTL ожиданий (реплай-пояснение, подтверждение вторым тапом, снимок плана). */
const WAIT_TTL_MS = 10 * 60_000;
const PLAN_VIEW_MAX = 32;
/** Бот удаляет свои сообщения только моложе 48 часов; запас — на часы и задержки. */
const DELETE_WINDOW_MS = 48 * 3_600_000 - 5 * 60_000;
/** deleteMessages принимает до 100 message_id за вызов. */
const DELETE_BATCH_SIZE = 100;

const HELP_TEXT = [
  'Пульт кокпита смотрит, разблокирует и поручает, но не заменяет полный кокпит.',
  '',
  'Сам присылает:',
  '🔵 живую карточку прогона — обновляется на месте, пока маршрут идёт;',
  '✅ исход прогона, когда маршрут доехал или попытку закрыли;',
  '⏳ ворота ждут решения · ❓ вопрос агента · 🔐 запрос разрешения · 🛑 конвейер встал · 💤 ход молчит.',
  '',
  'Команды:',
  '/status — задачи конвейера: названия, текущие узлы и прогресс',
  '/status <id> — подробная карточка одной задачи',
  '/clean — убрать из лички служебные сообщения пульта',
  '/help — эта подсказка',
  '',
  'Решения — кнопками на карточках; решённая карточка удаляется, итог виден всплывашкой.',
  'Навигация (список, задача, узлы, план) живёт в одном сообщении-экране — закрывается кнопкой «✕ Закрыть».',
  'Свободный текст и голос — обычный auto-ход ассистента в общем разговоре «Компаньон».',
  'Постановка задач живёт во «Входящих», запуск прогонов, дифы и деньги — только в кокпите.',
].join('\n');

function commandOf(text: unknown): { name: string; args: string } | null {
  const match = String(text ?? '').trim()
    .match(/^\/([a-z_]+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/iu);

  if (!match) return null;

  return { name: String(match[1]).toLowerCase(), args: (match[2] ?? '').trim() };
}

const taskIdOf = (args: unknown) => (
  String(args ?? '').trim().match(/^(\d{1,19})\b/u)?.[1] || ''
);

/** Сообщения уже нет в чате (удалил человек): удалять нечего, это успех. */
const isMissingMessage = (error: unknown) => /not found/iu.test(errorText(error));

export class TelegramPultActions {
  isEnabled: () => Promise<unknown> | unknown;

  callApi: ((method: string, url: string, payload?: unknown) => Promise<ApiResponse>) | null;

  summary: (() => Promise<unknown>) | null;

  forget: (key: string) => void;

  stateStoreFor: ((lease: ActionsLease) => PultStateStorePort) | null;

  queue: PultSendQueue;

  now: () => number;

  log: LogPort;

  assistant: TelegramPultAssistant | null;

  replyWaits: Map<string, Payload>;

  confirms: Map<string, Payload>;

  planViews: Map<string, Payload>;

  constructor({
    isEnabled,
    callApi = null,
    summary = null,
    forget = () => {},
    stateStoreFor = null,
    acquireLease = null,
    subscribe = null,
    speechRuntime = null,
    readSpeechPrefs = () => ({}),
    readCompactWindow = () => 0,
    readPollStatus = () => null,
    queue = new PultSendQueue(),
    now = Date.now,
    log = console,
  }: {
    isEnabled?: () => Promise<unknown> | unknown;
    callApi?: ((method: string, url: string, payload?: unknown) => Promise<ApiResponse>) | null;
    summary?: (() => Promise<unknown>) | null;
    forget?: (key: string) => void;
    stateStoreFor?: ((lease: ActionsLease) => PultStateStorePort) | null;
    acquireLease?: (() => ActionsLease) | null;
    subscribe?: unknown;
    speechRuntime?: unknown;
    readSpeechPrefs?: () => Promise<unknown> | unknown;
    readCompactWindow?: () => Promise<unknown> | unknown;
    readPollStatus?: () => Payload | null;
    queue?: PultSendQueue;
    now?: () => number;
    log?: LogPort;
  } = {}) {
    if (typeof isEnabled !== 'function' || typeof now !== 'function') {
      throw new TypeError('TelegramPultActions: isEnabled/now обязательны.');
    }
    if (callApi !== null && typeof callApi !== 'function') {
      throw new TypeError('TelegramPultActions: callApi должен быть функцией.');
    }
    if (summary !== null && typeof summary !== 'function') {
      throw new TypeError('TelegramPultActions: summary должен быть функцией.');
    }
    if (stateStoreFor !== null && typeof stateStoreFor !== 'function') {
      throw new TypeError('TelegramPultActions: stateStoreFor должен быть функцией.');
    }
    this.isEnabled = isEnabled as () => Promise<unknown> | unknown;
    this.callApi = callApi;
    this.summary = summary;
    this.forget = forget;
    // Та же фабрика, что у вотчера: экран навигации и реестр служебных ответов
    // живут в pult-state.json рядом с карточками вотчера (merge-запись).
    this.stateStoreFor = stateStoreFor;
    this.queue = queue;
    this.now = now;
    this.log = log;
    this.assistant = callApi && stateStoreFor && acquireLease
      ? new TelegramPultAssistant({
        callApi: callApi as never,
        stateStoreFor: stateStoreFor as never,
        acquireLease: acquireLease as never,
        subscribe: subscribe as never,
        speechRuntime,
        readSpeechPrefs,
        readCompactWindow,
        readPollStatus,
        queue: queue as never,
        now,
        log,
      })
      : null;

    /** Ожидание реплая: messageId карточки → { kind, expiresAtMs, ... }. */
    this.replyWaits = new Map();
    /** Подтверждения и снимки списков: свой ключ формы → { expiresAtMs, messageId, ... }. */
    this.confirms = new Map();
    /** Открытые планы: owner+message_id → неизменный снимок страниц на 10 минут. */
    this.planViews = new Map();
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Владелец ли это. Читает настройки ЖИВЬЁМ из lease на каждый входящий:
   * disable или смена аккаунта действуют немедленно, без рестарта.
   */
  async _owner(source: Payload, lease: ActionsLease): Promise<Payload | null> {
    let settings;
    try {
      settings = await lease.context.botSettings.read();
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: настройки нечитаемы, вход игнорируется');
      return null;
    }
    if (settings.pultConfirmedAtMs == null) return null;
    if (source?.chatType !== 'private') return null;
    if (source?.chatId !== settings.pultChatId) return null;
    if ((source?.from as Payload | undefined)?.id !== settings.pultUserId) return null;
    return settings;
  }

  /** Каноничный ключ владельца для экрана и реестра: accountRef:confirmedAtMs:chatId. */
  _ownerKey(lease: ActionsLease, settings: Payload): string {
    return encodePultOwnerKey(lease.accountRef, settings.pultConfirmedAtMs, settings.pultChatId);
  }

  /** State пульта в точке использования; не подключён — экран и /clean молча деградируют. */
  _store(lease: ActionsLease): PultStateStorePort | null {
    if (!this.stateStoreFor) return null;
    try {
      return this.stateStoreFor(lease);
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: state пульта недоступен');
      return null;
    }
  }

  async _bot(lease: ActionsLease, method: string, body: Payload): Promise<Payload | null> {
    const token = lease.context.credentials?.token || '';
    if (!token) throw Object.assign(new Error('нет token'), { code: 'not_connected' });
    return this.queue.push(() => lease.context.botApi.callBotApi(token, method, body, {
      timeoutMs: 15_000,
    }), { priority: 'interactive' }) as Promise<Payload | null>;
  }

  /** Служебный ответ уезжает в реестр sent: следующий /clean его снесёт. */
  async _registerSent(lease: ActionsLease, sent: Payload | null): Promise<void> {
    const store = this._store(lease);
    const messageId = Number(sent?.message_id);
    if (!store || !Number.isSafeInteger(messageId) || messageId <= 0) return;
    try {
      const state = await store.read();
      await store.write({ sent: [...state.sent, { messageId, at: this.now() }] });
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: реестр служебных сообщений не записался');
    }
  }

  /**
   * Ответ владельцу: очередь, plain text, «тихая» ссылка. Ошибка — warn, не throw.
   * Эфемерные ответы (по умолчанию все) регистрируются в sent для /clean;
   * экран навигации в реестр не дублируется — он учтён своей записью screen.
   */
  async _send(
    lease: ActionsLease,
    chatId: unknown,
    text: string,
    keyboard: unknown[] | null = null,
    { ephemeral = true }: { ephemeral?: boolean } = {},
  ): Promise<Payload | null> {
    try {
      const sent = await this._bot(lease, 'sendMessage', {
        chat_id: chatId,
        text: clipText(text, MESSAGE_LIMIT),
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      if (ephemeral) await this._registerSent(lease, sent);

      return sent;
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: ответ не доставлен (best effort)');
      return null;
    }
  }

  /** ReplyKeyboardMarkup передаётся целиком, не как inline_keyboard. */
  async _sendReplyKeyboard(
    lease: ActionsLease,
    chatId: unknown,
    text: string,
  ): Promise<Payload | null> {
    try {
      const sent = await this._bot(lease, 'sendMessage', {
        chat_id: chatId,
        text: clipText(text, MESSAGE_LIMIT),
        link_preview_options: { is_disabled: true },
        reply_markup: pultReplyKeyboard(),
      });
      await this._registerSent(lease, sent);
      return sent;
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: постоянная клавиатура не доставлена');
      return null;
    }
  }

  /** Правка карточки. Клавиатура обязана приходить явно: без неё кнопки снимаются. */
  async _edit(
    lease: ActionsLease,
    chatId: unknown,
    messageId: unknown,
    text: string,
    keyboard: unknown[] = [],
  ): Promise<void> {
    try {
      await this._bot(lease, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: clipText(text, MESSAGE_LIMIT),
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: карточка не отредактировалась (best effort)');
    }
  }

  /**
   * Удаление сообщения — best effort, как всё в пульте: отказ Telegram логируется
   * и НЕ роняет ни обработку нажатия, ни обход вотчера. «Уже удалено» — успех.
   */
  async _delete(lease: ActionsLease, chatId: unknown, messageId: unknown): Promise<boolean> {
    try {
      await this._bot(lease, 'deleteMessage', { chat_id: chatId, message_id: messageId });
      return true;
    } catch (error) {
      if (isMissingMessage(error)) return true;
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: сообщение не удалилось (best effort)');
      return false;
    }
  }

  /** answerCallbackQuery обязателен на каждый принятый callback — иначе «часики». */
  async _answer(lease: ActionsLease, callback: Payload, text = ''): Promise<void> {
    try {
      await this._bot(lease, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        ...(text ? { text: clipText(collapseLine(text), ANSWER_LIMIT) } : {}),
      });
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: answerCallbackQuery не доставлен');
    }
  }

  /**
   * Единственный экран навигации пульта: правится на месте, второго сообщения не
   * создаётся. Сохранённый экран удалён человеком или не правится — молча создаём
   * новый и запоминаем его id вместо старого, без ошибки в чат. Чужой экран
   * (другой ownerKey) не трогаем: message_id имеет смысл только у своей лички.
   * Возвращает message_id экрана (им ключуются снимки плана) или null.
   */
  async _screenShow(
    lease: ActionsLease,
    chatId: unknown,
    ownerKey: string,
    text: string,
    keyboard: unknown[] | null = null,
  ): Promise<number | null> {
    const store = this._store(lease);
    if (store) {
      let screen: Payload | null = null;

      try {
        screen = (await store.read()).screen;
      } catch (error) {
        this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: экран не прочитался, показываю новый');
      }
      if (screen && screen.ownerKey === ownerKey) {
        try {
          await this._bot(lease, 'editMessageText', {
            chat_id: chatId,
            message_id: screen.messageId,
            text: clipText(text, MESSAGE_LIMIT),
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: keyboard || [] },
          });
          return Number(screen.messageId);
        } catch {
          // Любой отказ правки — молча создаём новый экран ниже.
        }
      }
    }
    const sent = await this._send(lease, chatId, text, keyboard, { ephemeral: false });
    const messageId = Number(sent?.message_id);
    if (store && Number.isSafeInteger(messageId) && messageId > 0) {
      try {
        await store.write({ screen: { messageId, at: this.now(), ownerKey } });
      } catch (error) {
        this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: экран не запомнился');
      }
      return messageId;
    }
    return null;
  }

  /** Кнопка «✕ Закрыть»: экран удаляется из чата и забывается. */
  async _screenClose({ lease, callback, chatId }: ActionContext): Promise<void> {
    const removed = await this._delete(lease, chatId, callback.messageId);
    if (!removed) {
      // Сообщение старше 48 часов Telegram удалить не даёт — это не «ошибка в чат»,
      // а короткая всплывашка с причиной; запись в state остаётся.
      await this._answer(lease, callback, 'Не вышло удалить: Telegram разрешает это только в первые 48 часов.');
      return;
    }
    await this._answer(lease, callback, 'Экран закрыт.');
    const store = this._store(lease);
    if (!store) return;
    try {
      const state = await store.read();
      if (state.screen?.messageId === callback.messageId) await store.write({ screen: null });
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: экран не забыт в state');
    }
  }

  async _api(method: string, url: string, payload?: unknown): Promise<ApiResponse> {
    if (!this.callApi) {
      return { statusCode: 503, body: { error: 'pult_not_wired', message: 'ручки кокпита не подключены' } };
    }
    return this.callApi(method, url, payload);
  }

  /** Человеческий текст отказа ручки: message сильнее кода, код сильнее пустоты. */
  static failText(res: ApiResponse | null): string {
    return String(res?.body?.message || res?.body?.error || `ошибка ${res?.statusCode || '?'}`);
  }

  _remember(map: Map<string, Payload>, key: string, value: Payload): void {
    map.set(key, { ...value, expiresAtMs: this.now() + WAIT_TTL_MS });
  }

  /** Достать ожидание с проверкой TTL; протухшее — забыть и вернуть null. */
  _take(map: Map<string, Payload>, key: string): Payload | null {
    const value = map.get(key);

    if (!value) return null;
    map.delete(key);
    if (Number(value.expiresAtMs) <= this.now()) return null;

    return value;
  }

  _peek(map: Map<string, Payload>, key: string): Payload | null {
    const value = map.get(key);

    if (!value) return null;
    if (Number(value.expiresAtMs) <= this.now()) {
      map.delete(key);

      return null;
    }

    return value;
  }

  // ------------------------------------------------------------------- приём

  /** Хук поллера: onMessage(msg, type, lease). Никогда не бросает. */
  async onMessage(msg: Payload, type: string, lease: ActionsLease): Promise<void> {
    try {
      if (type !== 'message') return; // правки и сервисные события командами не считаются
      if (!await this.isEnabled()) return;
      const settings = await this._owner(msg, lease);
      if (!settings) return;
      if (msg.replyToMessageId && await this._reply(msg, lease, settings)) return;
      const navigation = pultReplyAction(msg.text);
      if (navigation) {
        await this._replyButton(msg, lease, settings, navigation);
        return;
      }
      if (String(msg.text || '').trimStart().startsWith('/')) {
        await this._command(msg, lease, settings);
        return;
      }
      if (Array.isArray(msg.media) && msg.media.some((item) => item?.kind === 'voice')) {
        if (this.assistant) await this.assistant.acceptVoice({ media: msg.media, lease: lease as never, settings });
        else await this._send(lease, msg.chatId, 'Чат с ассистентом пока не подключён. Используй /help.');
        return;
      }
      if (String(msg.text || '').trim()) {
        if (this.assistant) await this.assistant.acceptText({ text: msg.text, lease: lease as never, settings });
        else await this._send(lease, msg.chatId, 'Не понял. Команды пульта: /help');
      }
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: приём сообщения сорвался');
    }
  }

  /** Хук поллера: onCallback(callback, lease). Никогда не бросает. */
  async onCallback(callback: Payload, lease: ActionsLease): Promise<void> {
    try {
      if (!await this.isEnabled()) return;
      const settings = await this._owner(callback, lease);
      if (!settings) return; // чужие нажатия молча в ноль — как и сообщения
      const action = parseCallback(callback.data);
      if (!action) {
        await this._answer(lease, callback, 'Кнопка устарела или неизвестна.');
        return;
      }
      const ctx = {
        lease,
        callback,
        chatId: settings.pultChatId,
        ownerKey: this._ownerKey(lease, settings),
      };
      switch (action.kind) {
        case 'gate': await this._gate(ctx, action); break;
        case 'question': await this._question(ctx, action); break;
        case 'question-free': await this._questionFree(ctx, action); break;
        case 'permission': await this._permission(ctx, action); break;
        case 'status-list': await this._statusList(ctx, action); break;
        case 'status-task': await this._statusTask(ctx, action); break;
        case 'status-nodes': await this._statusNodes(ctx, action); break;
        case 'status-nodes-new': await this._statusNodesNew(ctx, action); break;
        case 'plan-open': await this._planOpen(ctx, action); break;
        case 'plan-page': await this._planPage(ctx, action); break;
        case 'resume': await this._resume(ctx, action); break;
        case 'sandbox-retry': await this._sandboxRetry(ctx, action); break;
        case 'screen-close': await this._screenClose(ctx); break;
        case 'nav-home':
          await this._answer(lease, callback);
          await this._screenShow(lease, ctx.chatId, ctx.ownerKey, homeCard(), homeKeyboard());
          break;
        case 'agent-compact': {
          const result = this.assistant
            ? await this.assistant.compact({ lease: lease as never, settings })
            : { ok: false, text: 'Чат с ассистентом не подключён.' };
          await this._answer(lease, callback, result.text);
          break;
        }
        case 'agent-reset': {
          const result = this.assistant
            ? await this.assistant.reset({ lease: lease as never, settings })
            : { ok: false, text: 'Чат с ассистентом не подключён.' };
          await this._answer(lease, callback, result.text);
          break;
        }
        case 'turn-stop': {
          const stopped = this.assistant && await this.assistant.handleStop({
            turnId: action.turnId, callback, lease: lease as never, settings,
          });
          if (stopped) await this._answer(lease, callback, 'Останавливаю ход.');
          break;
        }
        case 'dismiss': await this._dismiss(ctx); break;
        default: await this._answer(lease, callback, 'Кнопка устарела или неизвестна.');
      }
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: обработка нажатия сорвалась');
    }
  }

  async start(): Promise<void> {
    await this.assistant?.reconcile();
  }

  stop(): void {
    this.assistant?.stop();
  }

  // ------------------------------------------------------------ решения (ф. 2)

  async _gate(
    { lease, callback, chatId }: ActionContext,
    { taskId, gateKey, decision, withComment }: PultCallback,
  ): Promise<void> {
    const subject = `#${taskId}`;
    if (decision === 'reject' && withComment) {
      // Двухшаговое отклонение: ждём реплай с «что доработать» на ЭТУ карточку.
      this._remember(this.replyWaits, String(callback.messageId), {
        kind: 'gate-reject', taskId, gateKey, chatId,
      });
      await this._answer(lease, callback, 'Ответь реплаем — что доработать.');
      await this._edit(
        lease, chatId, callback.messageId,
        `⏳ ${subject}: отклонение ворот ${gateKey}.\n`
        + 'Ответь РЕПЛАЕМ на это сообщение — что доработать (уедет агенту дословно). '
        + 'Или реши кнопкой:',
        gateRejectKeyboard(taskId, gateKey),
      );
      return;
    }
    const gate = String(gateKey).toLowerCase();
    const res = await this._api('POST', `/api/tasks/${taskId}/gate/${gate}/${decision}`, {});

    if (Number(res.statusCode) < 400) {
      // Пойманная в UI грабля: решение записано, а прогон не поехал. По смыслу это
      // отказ: причину человек обязан прочитать, поэтому карточка остаётся текстом.
      if (res.body?.resumed === false) {
        const why = `решение записано, но прогон не поехал: ${res.body?.resumeError || 'причина в кокпите'}`;
        await this._answer(lease, callback, why);
        await this._edit(lease, chatId, callback.messageId, `⚠ ${subject}: ${why}`);
      } else {
        // Решено: итог — всплывашкой, сама карточка удаляется из чата.
        await this._answer(lease, callback, decision === 'approve' ? 'Принято.' : 'Отклонено.');
        await this._delete(lease, chatId, callback.messageId);
      }
    } else {
      // CAS/terminal: называем фактическое состояние, карточку гасим — свежую
      // пришлёт следующий обход вотчера по реальному месту маршрута.
      const why = TelegramPultActions.failText(res);
      await this._answer(lease, callback, why);
      await this._edit(lease, chatId, callback.messageId, `⚠ ${subject}: ${why}`);
    }
    this.forget(`wait:${String(taskId)}`);
  }

  /** Живой вопрос ищем в /api/chat/waiting: снимков вариантов не держим. */
  async _waitingItem(pid: unknown): Promise<Payload | null> {
    const res = await this._api('GET', '/api/chat/waiting');
    if (Number(res.statusCode) >= 400) return null;
    const waiting = (res.body?.waiting || []) as Payload[];

    return waiting.find((item) => (
      item?.origin !== 'ssh' && String(item?.pid) === String(pid)
    )) || null;
  }

  /** Старую/подделанную кнопку MCP не превращаем в обход browser-only формы. */
  async _cockpitOnly({ lease, callback, chatId }: ActionContext, item: Payload): Promise<void> {
    const subject = chatSubject(item);
    await this._answer(lease, callback, 'Заверши это действие в Cockpit.');
    await this._edit(
      lease,
      chatId,
      callback.messageId,
      `🔔 ${subject} — требуется действие\nЗаверши в Cockpit.`,
    );
  }

  async _question(
    { lease, callback, chatId }: ActionContext,
    { pid, index }: PultCallback,
  ): Promise<void> {
    const item = await this._waitingItem(pid);
    if (item?.structured === true) {
      await this._cockpitOnly({ lease, callback, chatId, ownerKey: '' }, item);
      return;
    }
    const first = (item?.questions as Payload[] | undefined)?.[0];
    const option = (first?.options as Payload[] | undefined)?.[Number(index)];
    if (!item || !first || !option) {
      // Повод уже ушёл — карточка удаляется наравне с решёнными.
      await this._answer(lease, callback, 'Этот вопрос уже закрыт.');
      await this._delete(lease, chatId, callback.messageId);
      this.forget(`q:${String(pid)}`);
      return;
    }
    const res = await this._api('POST', `/api/chat/permission/${pid}`, {
      answers: [{ header: first.header || '', question: first.question || '', selected: [option.label] }],
    });
    if (Number(res.statusCode) < 400) {
      await this._answer(lease, callback, 'Ответ отправлен.');
      await this._delete(lease, chatId, callback.messageId);
    } else {
      await this._answer(lease, callback, TelegramPultActions.failText(res));
    }
    this.forget(`q:${String(pid)}`);
  }

  async _questionFree(
    { lease, callback, chatId }: ActionContext,
    { pid }: PultCallback,
  ): Promise<void> {
    const item = await this._waitingItem(pid);
    if (!item) {
      await this._answer(lease, callback, 'Этот вопрос уже закрыт.');
      return;
    }
    if (item.structured === true) {
      await this._cockpitOnly({ lease, callback, chatId, ownerKey: '' }, item);
      return;
    }
    const subject = chatSubject(item);
    this._remember(this.replyWaits, String(callback.messageId), {
      kind: 'question-text', pid, chatId, subject,
    });
    await this._answer(lease, callback, 'Ответь реплаем на это сообщение.');
    const first = ((item.questions as Payload[] | undefined)?.[0] || {}) as Payload;
    await this._edit(
      lease, chatId, callback.messageId,
      `❓ ${subject} — вопрос агента\n${collapseLine(first.question || '…')}\n`
      + 'Ответь РЕПЛАЕМ на это сообщение — текст уедет агенту дословно. Или выбери вариант:',
      questionKeyboard(pid, (first.options || []) as Payload[]),
    );
  }

  async _permission(
    { lease, callback, chatId }: ActionContext,
    { pid, action }: PultCallback,
  ): Promise<void> {
    const snapshot = await this._api('GET', '/api/chat/waiting');
    const waiting = (snapshot.body?.waiting || []) as Payload[];
    const found = Number(snapshot.statusCode) < 400
      ? waiting.find((item) => String(item?.pid) === String(pid))
      : { pid };
    // Новый сервер даёт авторитетный snapshot: SSH в Telegram не показываем и
    // не отправляем ни в generic, ни в SSH endpoint. Fallback нужен только для
    // rolling update со старым сервером, где waiting мог быть недоступен и SSH
    // origin ещё не существовал.
    const pending = found?.origin === 'ssh' ? null : found;
    if (!pending) {
      await this._answer(lease, callback, 'Этот запрос уже закрыт.');
      await this._delete(lease, chatId, callback.messageId);
      this.forget(`perm:${String(pid)}`);
      return;
    }
    if ((pending.input as Payload | undefined)?.kind === 'external_url') {
      await this._cockpitOnly({ lease, callback, chatId, ownerKey: '' }, pending as Payload);
      return;
    }
    if (action === 'deny-comment') {
      const denySubject = chatSubject(pending);
      this._remember(this.replyWaits, String(callback.messageId), {
        kind: 'perm-deny', pid, chatId, subject: denySubject,
      });
      await this._answer(lease, callback, 'Ответь реплаем — пояснение агенту.');
      await this._edit(
        lease, chatId, callback.messageId,
        `🔐 ${denySubject} — отказ с пояснением.\nОтветь РЕПЛАЕМ на это сообщение — пояснение уедет агенту. Или реши кнопкой:`,
        permissionKeyboard(pid),
      );
      return;
    }
    const allow = action === 'allow';
    const res = await this._api('POST', `/api/chat/permission/${pid}`, { allow });
    if (Number(res.statusCode) < 400) {
      await this._answer(lease, callback, allow ? 'Разрешено.' : 'Отклонено.');
      await this._delete(lease, chatId, callback.messageId);
    } else if (Number(res.statusCode) === 404) {
      // Повод уже ушёл — карточка удаляется наравне с решёнными.
      await this._answer(lease, callback, 'Этот запрос уже закрыт.');
      await this._delete(lease, chatId, callback.messageId);
    } else {
      await this._answer(lease, callback, TelegramPultActions.failText(res));
    }
    this.forget(`perm:${String(pid)}`);
  }

  // ------------------------------------------------------------ реплаи (ф. 2)

  /**
   * Реплай владельца на карточку-ожидание. true — реплай обработан.
   * callback_query здесь НЕТ, поэтому всплывашка невозможна: итог успеха уходит
   * эфемерным сообщением «✓ …» (его сносит /clean), а карточка удаляется.
   */
  async _reply(msg: Payload, lease: ActionsLease, settings: Payload): Promise<boolean> {
    let wait: Payload | null = this._take(this.replyWaits, String(msg.replyToMessageId));
    if (!wait) {
      const context = lease.context as Payload;
      const credentials = context.credentials as Payload | undefined;
      const botId = Number(context.botId ?? credentials?.botId);
      // Реплай на собственное сообщение владельца — обычный текст ассистенту.
      // Fail-closed нужен только для карточки, автором которой был exact текущий бот.
      if (!Number.isSafeInteger(botId) || Number(msg.replyToFromId) !== botId) return false;
      const store = this._store(lease);
      if (!store) {
        await this._send(lease, msg.chatId, 'Карточка устарела. Открой свежую карточку и повтори решение.');
        return true;
      }
      let state;
      try {
        state = await store.read();
      } catch (error) {
        this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: durable-маршрут реплая не прочитался');
        await this._send(lease, msg.chatId, 'Карточка сейчас не читается. Открой свежую карточку и повтори решение.');
        return true;
      }
      const card = Object.values(state.cards || {}).find((candidate) => (
        candidate?.messageId === msg.replyToMessageId
        && pultOwnerKeyMatches(
          candidate.ownerKey,
          lease.accountRef,
          settings.pultConfirmedAtMs,
          settings.pultChatId,
        )
      ));
      if (!card?.replyAction) {
        await this._send(lease, msg.chatId, 'Карточка устарела. Открой свежую карточку и повтори решение.');
        return true;
      }
      wait = {
        ...card.replyAction,
        chatId: settings.pultChatId,
        subject: card.subject || 'ассистент',
      };
    }
    const text = String(msg.text || '').trim();
    if (!text) {
      await this._send(lease, msg.chatId, 'Пустой реплай не уехал. Нажми кнопку на карточке ещё раз.');
      return true;
    }
    const pending = wait as Payload;

    if (pending.kind === 'gate-reject') {
      const gate = String(pending.gateKey).toLowerCase();
      const res = await this._api(
        'POST',
        `/api/tasks/${pending.taskId}/gate/${gate}/reject`,
        { comment: text },
      );
      if (Number(res.statusCode) < 400) {
        if (res.body?.resumed === false) {
          // Решение записано, но прогон не поехал — причину надо прочитать:
          // карточка остаётся текстом, как при отказе ручки.
          await this._edit(
            lease, pending.chatId, msg.replyToMessageId,
            `⚠ #${pending.taskId}: отклонено, но прогон не поехал: ${res.body?.resumeError || 'причина в кокпите'}`,
          );
        } else {
          await this._delete(lease, pending.chatId, msg.replyToMessageId);
          await this._send(lease, msg.chatId, `✓ #${pending.taskId}: отклонено, замечание уехало агенту`);
        }
        this.forget(`wait:${pending.taskId}`);
      } else {
        // Например gate_rejected «нельзя доставить»: возврат ведёт не к агенту.
        await this._send(lease, msg.chatId, `⚠ #${pending.taskId}: ${TelegramPultActions.failText(res)}`);
      }
      return true;
    }
    if (pending.kind === 'question-text') {
      const res = await this._api('POST', `/api/chat/permission/${pending.pid}`, { answers: [{ text }] });
      if (Number(res.statusCode) < 400) {
        await this._delete(lease, pending.chatId, msg.replyToMessageId);
        await this._send(lease, msg.chatId, `✓ ${pending.subject || 'чат'}: свой ответ уехал агенту`);
      } else {
        await this._send(lease, msg.chatId, `⚠ ${TelegramPultActions.failText(res)}`);
      }
      this.forget(`q:${pending.pid}`);
      return true;
    }
    if (pending.kind === 'perm-deny') {
      const res = await this._api('POST', `/api/chat/permission/${pending.pid}`, { allow: false, comment: text });
      if (Number(res.statusCode) < 400) {
        await this._delete(lease, pending.chatId, msg.replyToMessageId);
        await this._send(lease, msg.chatId, `✓ ${pending.subject || 'чат'}: отклонено, пояснение уехало агенту`);
      } else {
        await this._send(lease, msg.chatId, `⚠ ${TelegramPultActions.failText(res)}`);
      }
      this.forget(`perm:${pending.pid}`);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ мутации (ф. 3)

  /** Подтверждение вторым тапом: ask-шаг правит карточку в вопрос [Да] [Отмена]. */
  async _confirmAsk(
    { lease, callback, chatId }: ActionContext,
    key: string,
    question: string,
    yesData: string,
  ): Promise<void> {
    this._remember(this.confirms, key, { messageId: callback.messageId });
    await this._answer(lease, callback);
    await this._edit(lease, chatId, callback.messageId, question, confirmKeyboard(yesData));
  }

  /** Второй тап: подтверждение живо? Протухло — честное «запрос устарел», без inject. */
  async _confirmTake(
    { lease, callback, chatId }: ActionContext,
    key: string,
  ): Promise<Payload | null> {
    const confirm = this._take(this.confirms, key);
    if (confirm) return confirm;
    await this._answer(lease, callback, 'Запрос устарел — нажми кнопку на свежей карточке ещё раз.');
    await this._edit(lease, chatId, callback.messageId, 'Запрос устарел. Вызови /status и попробуй снова.');
    return null;
  }

  async _resume(ctx: ActionContext, { taskId, step }: PultCallback): Promise<void> {
    if (step === 'no') { await this._dismiss(ctx); return; }
    if (step === 'ask') {
      await this._confirmAsk(
        ctx, `r:${taskId}`,
        `Точно продолжить #${taskId}? Прогон продолжится той же попыткой.`,
        cbData.resumeYes(taskId),
      );
      return;
    }
    if (!await this._confirmTake(ctx, `r:${taskId}`)) return;
    const res = await this._api('POST', `/api/tasks/${taskId}/resume`, {});
    if (Number(res.statusCode) < 400) {
      const note = res.body?.outcome === 'already_running' ? 'уже идёт' : 'прогон продолжен';
      await this._answer(ctx.lease, ctx.callback, note);
      await this._delete(ctx.lease, ctx.chatId, ctx.callback.messageId);
      this.forget(`stall:${String(taskId)}`);
    } else {
      // Типизированные отказы движка (runner_preflight_unavailable, коды 73/75/78)
      // приходят словами в message — их и показываем, не глотая.
      const why = TelegramPultActions.failText(res);
      await this._answer(ctx.lease, ctx.callback, why);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⚠ #${taskId}: прогон не поехал: ${why}`);
    }
  }

  async _sandboxRetry(ctx: ActionContext, { taskId, step }: PultCallback): Promise<void> {
    if (step === 'no') { await this._dismiss(ctx); return; }
    if (step === 'ask') {
      await this._confirmAsk(
        ctx, `sb:${taskId}`,
        `Точно снести остатки песочницы #${taskId} и продолжить? Подъём займёт ~20–25 минут.`,
        cbData.sandboxRetryYes(taskId),
      );
      return;
    }
    if (!await this._confirmTake(ctx, `sb:${taskId}`)) return;
    const res = await this._api('POST', `/api/tasks/${taskId}/sandbox/retry`, {});
    const down = res.body?.downOutput ? `\nСнос: ${collapseLine(res.body.downOutput)}` : '';
    if (Number(res.statusCode) < 400) {
      await this._answer(ctx.lease, ctx.callback, `✓ #${taskId}: остатки снесены, прогон продолжен${down}`);
      await this._delete(ctx.lease, ctx.chatId, ctx.callback.messageId);
      this.forget(`stall:${String(taskId)}`);
    } else {
      const why = TelegramPultActions.failText(res);
      await this._answer(ctx.lease, ctx.callback, why);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⚠ #${taskId}: ${why}${down}`);
    }
  }

  /** «Отмена» на любой карточке подтверждения: всплывашка + удаление карточки. */
  async _dismiss({ lease, callback, chatId }: ActionContext): Promise<void> {
    for (const [key, value] of this.confirms) {
      if (value.messageId === callback.messageId) this.confirms.delete(key);
    }
    await this._answer(lease, callback, 'Отменено.');
    await this._delete(lease, chatId, callback.messageId);
  }

  // -------------------------------------------------------- просмотр конвейера

  async _statusSnapshot(): Promise<Payload | null> {
    if (!this.summary) return null;

    return await this.summary() as Payload | null;
  }

  static _statusTasks(snapshot: Payload | null): Payload[] {
    return Array.isArray(snapshot?.tasks) ? snapshot.tasks as Payload[] : [];
  }

  static _statusPage(snapshot: Payload | null, requestedPage: unknown) {
    const tasks = TelegramPultActions._statusTasks(snapshot);
    const totalPages = Math.max(1, Math.ceil(tasks.length / STATUS_PAGE_SIZE));
    const page = Math.max(0, Math.min(totalPages - 1, Number(requestedPage) || 0));
    const from = page * STATUS_PAGE_SIZE;
    return { tasks, pageTasks: tasks.slice(from, from + STATUS_PAGE_SIZE), page, totalPages };
  }

  static _statusTask(snapshot: Payload | null, taskId: unknown): Payload | null {
    return TelegramPultActions._statusTasks(snapshot)
      .find((task) => String(task?.task) === String(taskId)) || null;
  }

  static _chatWaiting(snapshot: Payload | null): number {
    return Array.isArray(snapshot?.chat) ? snapshot.chat.length : 0;
  }

  _statusListPayload(snapshot: Payload, requestedPage: unknown) {
    const page = TelegramPultActions._statusPage(snapshot, requestedPage);
    return {
      text: statusListCard({
        tasks: page.pageTasks,
        totalTasks: page.tasks.length,
        page: page.page,
        totalPages: page.totalPages,
        chatWaiting: TelegramPultActions._chatWaiting(snapshot),
      }),
      keyboard: statusListKeyboard(page.pageTasks, page.page, page.totalPages),
      ...page,
    };
  }

  async _commandStatus(
    msg: Payload,
    lease: ActionsLease,
    settings: Payload,
    taskId = '',
  ): Promise<void> {
    const ownerKey = this._ownerKey(lease, settings);
    let snapshot;
    try {
      snapshot = await this._statusSnapshot();
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: подробный /status не собрался');
      await this._screenShow(lease, msg.chatId, ownerKey, 'Статус сейчас не собрался — попробуй ещё раз или загляни в кокпит.');
      return;
    }
    // Совместимость с внешним/старым summary-провайдером: строка всё ещё честно
    // показывается, но production передаёт структурированный снимок вотчера.
    if (typeof snapshot === 'string') {
      await this._screenShow(lease, msg.chatId, ownerKey, snapshot);
      return;
    }
    if (!snapshot || typeof snapshot !== 'object') {
      await this._screenShow(lease, msg.chatId, ownerKey, 'Статус пока не собран — попробуй ещё раз через несколько секунд.');
      return;
    }
    if (taskId) {
      const task = TelegramPultActions._statusTask(snapshot, taskId);
      if (!task) {
        await this._screenShow(lease, msg.chatId, ownerKey, `#${taskId} сейчас нет на конвейере.`);
        return;
      }
      await this._screenShow(lease, msg.chatId, ownerKey, taskStatusCard(task), taskStatusKeyboard(taskId, 0));
      return;
    }
    const payload = this._statusListPayload(snapshot, 0);
    await this._screenShow(lease, msg.chatId, ownerKey, payload.text, payload.keyboard);
  }

  async _statusList(
    { lease, callback, chatId, ownerKey }: ActionContext,
    { page }: PultCallback,
  ): Promise<void> {
    await this._answer(lease, callback);
    let snapshot;
    try { snapshot = await this._statusSnapshot(); } catch { snapshot = null; }
    if (!snapshot || typeof snapshot === 'string') {
      await this._screenShow(lease, chatId, String(ownerKey), typeof snapshot === 'string'
        ? snapshot
        : 'Статус сейчас не собрался — попробуй /status ещё раз.');
      return;
    }
    const payload = this._statusListPayload(snapshot, page);
    await this._screenShow(lease, chatId, String(ownerKey), payload.text, payload.keyboard);
  }

  async _statusTask(
    { lease, callback, chatId, ownerKey }: ActionContext,
    { taskId, page }: PultCallback,
  ): Promise<void> {
    await this._answer(lease, callback);
    let snapshot;
    try { snapshot = await this._statusSnapshot(); } catch { snapshot = null; }
    const task = TelegramPultActions._statusTask(snapshot, taskId);
    if (!task) {
      await this._screenShow(
        lease, chatId, String(ownerKey),
        `#${taskId} уже ушла с конвейера.`,
        [[{ text: '← К списку', callback_data: cbData.statusList(page) }]],
      );
      return;
    }
    await this._screenShow(
      lease, chatId, String(ownerKey),
      taskStatusCard(task),
      taskStatusKeyboard(taskId, page),
    );
  }

  async _statusNodes(
    { lease, callback, chatId, ownerKey }: ActionContext,
    { taskId, page, nodePage = 0 }: PultCallback,
  ): Promise<void> {
    await this._answer(lease, callback);
    let snapshot;
    try { snapshot = await this._statusSnapshot(); } catch { snapshot = null; }
    const task = TelegramPultActions._statusTask(snapshot, taskId);
    if (!task) {
      await this._screenShow(
        lease, chatId, String(ownerKey),
        `#${taskId} уже ушла с конвейера.`,
        [[{ text: '← К списку', callback_data: cbData.statusList(page) }]],
      );
      return;
    }
    const nodes = taskNodesPage(task, nodePage);
    await this._screenShow(
      lease, chatId, String(ownerKey),
      nodes.text,
      taskNodesKeyboard(taskId, page, nodes.page, nodes.totalPages),
    );
  }

  /**
   * Узлы из ЖИВОЙ карточки — на экране навигации. Нажатие пришло с живой карточки,
   * но правится сохранённый экран: сама карточка принадлежит вотчеру, а экран —
   * отдельная запись в state, и вотчер его не переписывает.
   */
  async _statusNodesNew(
    { lease, callback, chatId, ownerKey }: ActionContext,
    { taskId }: PultCallback,
  ): Promise<void> {
    await this._answer(lease, callback);
    let snapshot;
    try { snapshot = await this._statusSnapshot(); } catch { snapshot = null; }
    const task = TelegramPultActions._statusTask(snapshot, taskId);
    if (!task) {
      await this._screenShow(lease, chatId, String(ownerKey), `#${taskId} уже ушла с конвейера.`);
      return;
    }
    const nodes = taskNodesPage(task, 0);
    await this._screenShow(
      lease, chatId, String(ownerKey),
      nodes.text,
      taskNodesKeyboard(taskId, 0, nodes.page, nodes.totalPages),
    );
  }

  async _readPlan(taskId: unknown): Promise<{ error: string; pages: string[] }> {
    const res = await this._api('GET', `/api/tasks/${taskId}/doc/plan`);

    if (Number(res.statusCode) >= 400) {
      return { error: TelegramPultActions.failText(res), pages: [] };
    }

    return { error: '', pages: planPages(res.body?.text) };
  }

  _planViewKey(ownerKey: string, messageId: unknown): string {
    return `${ownerKey}:${messageId}`;
  }

  _rememberPlan(ownerKey: string, messageId: unknown, value: Payload): void {
    const now = this.now();
    for (const [key, view] of this.planViews) {
      if (Number(view.expiresAtMs) <= now) this.planViews.delete(key);
    }
    this._remember(this.planViews, this._planViewKey(String(ownerKey), messageId), value);
    if (this.planViews.size <= PLAN_VIEW_MAX) return;
    const oldest = [...this.planViews.entries()]
      .sort((a, b) => Number(a[1].expiresAtMs) - Number(b[1].expiresAtMs))
      .slice(0, this.planViews.size - PLAN_VIEW_MAX);
    for (const [key] of oldest) this.planViews.delete(key);
  }

  async _planOpen(
    { lease, callback, chatId, ownerKey }: ActionContext,
    { taskId }: PultCallback,
  ): Promise<void> {
    await this._answer(lease, callback);
    let plan: { error: string; pages: string[] };

    try { plan = await this._readPlan(taskId); } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: план не прочитался');
      await this._send(lease, chatId, `⚠ #${taskId}: план сейчас не прочитался.`);
      return;
    }
    if (plan.error) {
      await this._send(lease, chatId, `⚠ #${taskId}: план не прочитался: ${plan.error}`);
      return;
    }
    if (!plan.pages.length) {
      await this._send(lease, chatId, `📄 #${taskId}: план ещё не создан.`);
      return;
    }
    const card = planPageCard({ taskId, pages: plan.pages, page: 0 });
    const screenId = await this._screenShow(
      lease, chatId, String(ownerKey), card.text,
      planPageKeyboard(taskId, card.page, card.totalPages),
    );
    // Снимок страниц ключуется messageId экрана: листание приходит нажатиями с
    // него же. Пересозданный экран даёт новый id — старые снимки протухают по TTL.
    if (screenId) this._rememberPlan(String(ownerKey), screenId, { taskId, pages: plan.pages });
  }

  async _planPage(
    { lease, callback, chatId, ownerKey }: ActionContext,
    { taskId, page }: PultCallback,
  ): Promise<void> {
    await this._answer(lease, callback);
    const key = this._planViewKey(String(ownerKey), callback.messageId);
    const view = this._peek(this.planViews, key);
    if (!view || view.taskId !== taskId || !Array.isArray(view.pages) || !view.pages.length) {
      await this._screenShow(
        lease, chatId, String(ownerKey),
        `📄 #${taskId}: просмотр плана устарел. Открой план заново из карточки задачи.`,
      );
      return;
    }
    // Листание продлевает жизнь того же неизменного снимка: страницы не прыгают,
    // даже если агент одновременно переписал plan.md.
    this._rememberPlan(String(ownerKey), callback.messageId, { taskId, pages: view.pages });
    const card = planPageCard({ taskId, pages: view.pages, page });

    await this._screenShow(
      lease, chatId, String(ownerKey), card.text,
      planPageKeyboard(taskId, card.page, card.totalPages),
    );
  }

  // ------------------------------------------------------------------ команды

  async _replyButton(
    msg: Payload,
    lease: ActionsLease,
    settings: Payload,
    action: string,
  ): Promise<void> {
    const ownerKey = this._ownerKey(lease, settings);
    if (action === 'pipeline') {
      await this._commandStatus(msg, lease, settings);
      return;
    }
    if (action === 'agent') {
      await this._screenShow(lease, msg.chatId, ownerKey, agentCard(), agentKeyboard());
      return;
    }
    if (action === 'tasks') {
      await this._screenShow(lease, msg.chatId, ownerKey, tasksCard(), tasksKeyboard());
      return;
    }
    await this._screenShow(lease, msg.chatId, ownerKey, homeCard(), homeKeyboard());
  }

  /**
   * /clean: убирает из лички всё, что пульт наследил, — экран, не-sticky карточки
   * поводов и служебные ответы. Липкие карточки прогонов (live:/done:) не трогаем:
   * исход прогона — единственная запись о результате. Удаление пакетное
   * (deleteMessages до 100 id); сообщения старше 48 часов Telegram удалить не
   * даёт — они не пытаются и честно идут в «не удалось».
   */
  async _commandClean(msg: Payload, lease: ActionsLease, settings: Payload): Promise<void> {
    const chatId = msg.chatId;
    const store = this._store(lease);
    if (!store) {
      await this._send(lease, chatId, 'Уборка недоступна: состояние пульта не подключено.');
      return;
    }
    let state;
    try {
      state = await store.read();
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: state нечитаем, уборка отменена');
      await this._send(lease, chatId, 'Уборка сейчас не собралась — попробуй ещё раз.');
      return;
    }
    const ownerKey = this._ownerKey(lease, settings);
    // messageId → когда отправлено и чья это карточка (или служебный ответ).
    const candidates = new Map<number, { at: unknown; cardKey: string | null }>();

    if (state.screen && state.screen.ownerKey === ownerKey) {
      candidates.set(Number(state.screen.messageId), {
        at: state.screen.at,
        cardKey: null,
      });
    }
    for (const [key, value] of Object.entries((state.cards || {}) as Payload)) {
      const card = value as Payload;

      if (card.sticky || !card.messageId) continue;
      candidates.set(Number(card.messageId), { at: card.at, cardKey: key });
    }
    for (const entry of state.sent) {
      if (!candidates.has(Number(entry.messageId))) {
        candidates.set(Number(entry.messageId), { at: entry.at, cardKey: null });
      }
    }
    const nowMs = this.now();
    let deleted = 0;
    let failed = 0;
    const fresh: [number, { at: unknown; cardKey: string | null }][] = [];

    for (const [messageId, info] of candidates) {
      if (nowMs - Number(info.at) > DELETE_WINDOW_MS) failed += 1;
      else fresh.push([messageId, info]);
    }

    const removedCardKeys: string[] = [];
    for (let from = 0; from < fresh.length; from += DELETE_BATCH_SIZE) {
      const batch = fresh.slice(from, from + DELETE_BATCH_SIZE);
      const ids = batch.map(([messageId]) => messageId);
      try {
        await this._bot(lease, 'deleteMessages', { chat_id: chatId, message_ids: ids });
        deleted += ids.length;
        for (const [, info] of batch) if (info.cardKey) removedCardKeys.push(info.cardKey);
      } catch (error) {
        // Отказал вызов целиком (сеть, лимит) — обходим ЭТОТ пакет поштучно:
        // что удаляется, удаляется; каждый отказ идёт в «не удалось».
        this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: пакетное удаление не прошло, обхожу поштучно');
        for (const [messageId, info] of batch) {
          if (await this._delete(lease, chatId, messageId)) {
            deleted += 1;
            if (info.cardKey) removedCardKeys.push(info.cardKey);
          } else {
            failed += 1;
          }
        }
      }
    }
    // Убранное забываем: карточки — по ключу (живой повод перевыпустит свежую
    // карточку следующим обходом вотчера), экран и реестр — целиком. Записи,
    // которые не удалось удалить (старше 48 часов), тоже стираем из state:
    // мусор в файле не копим, повторно Telegram о них уже не спросит.
    try {
      const cards = { ...(state.cards as Payload) };
      for (const key of removedCardKeys) delete cards[key];
      await store.write({ cards, screen: null, sent: [] });
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: state после уборки не записался');
    }
    for (const key of removedCardKeys) this.forget(key);
    // Сам ответ /clean — тоже эфемерный: регистрируется в sent и сносится следующей уборкой.
    await this._send(lease, chatId, `Уборка: удалено ${deleted}, не удалось ${failed}.`);
  }

  async _command(msg: Payload, lease: ActionsLease, settings: Payload): Promise<void> {
    const command = commandOf(msg.text);
    const name = command?.name;
    if (name === 'start') {
      await this._screenShow(lease, msg.chatId, this._ownerKey(lease, settings), homeCard(), homeKeyboard());
      await this._sendReplyKeyboard(lease, msg.chatId, 'Клавиатура пульта снова раскрыта.');
      return;
    }
    if (name === 'help') {
      await this._screenShow(
        lease,
        msg.chatId,
        this._ownerKey(lease, settings),
        HELP_TEXT,
        helpKeyboard(),
      );
      return;
    }
    if (name === 'status') {
      await this._commandStatus(msg, lease, settings, taskIdOf(command?.args));
      return;
    }
    if (name === 'clean') {
      await this._commandClean(msg, lease, settings);
      return;
    }
    // Незнакомый текст вне ожидания реплая — короткая подсказка (только владельцу).
    await this._send(lease, msg.chatId, 'Не понял. Команды пульта: /help');
  }
}

export default TelegramPultActions;
