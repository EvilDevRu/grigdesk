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
// Мутации (фаза 3) добавляют три своих правила: подтверждение вторым тапом с TTL,
// «индекс в callback_data — не источник истины» (снимок списка живёт на сервере и
// сверяется перед inject) и предпросмотр /task.
import {
  STATUS_PAGE_SIZE,
  cbData,
  clipText,
  collapseLine,
  confirmKeyboard,
  gateRejectKeyboard,
  htmlToPlainText,
  planPageCard,
  planPageKeyboard,
  planPages,
  parseCallback,
  permissionKeyboard,
  questionKeyboard,
  resolvedCard,
  statusListCard,
  statusListKeyboard,
  taskNodesKeyboard,
  taskNodesPage,
  taskStatusCard,
  taskStatusKeyboard,
} from './format.js';
import { PultSendQueue } from './send-queue.js';

/** Потолок одного сообщения Bot API — 4096; берём с запасом под свои префиксы. */
const MESSAGE_LIMIT = 4_000;
/** Потолок текста answerCallbackQuery — 200 символов. */
const ANSWER_LIMIT = 190;
/** TTL ожиданий (реплай-пояснение, подтверждение вторым тапом, предпросмотр /task). */
const WAIT_TTL_MS = 10 * 60_000;
const PLAN_VIEW_MAX = 32;

const HELP_TEXT = [
  'Пульт кокпита. Сам присылает карточки, когда работа стоит на тебе:',
  '⏳ ворота ждут решения · ❓ вопрос агента · 🔐 запрос разрешения · 🛑 конвейер встал · 💤 ход молчит.',
  '',
  'Команды:',
  '/status — задачи конвейера: названия, текущие узлы и прогресс',
  '/status <id> — подробная карточка одной задачи',
  '/task Заголовок⏎описание — поставить задачу B24 (создаётся после предпросмотра)',
  '/launch <id> — запустить прогон маршрутом из опубликованного каталога',
  '/timer <id> start|pause|stop — таймер задачи B24',
  '/complete <id> · /renew <id> — завершить/возобновить задачу B24',
  '/stop — остановить ход агента в чате (список кнопками)',
  '/help — эта подсказка',
  '',
  'Всё, что стоит времени или денег, переспрашивается вторым тапом.',
  'План можно открыть из карточки задачи. Дифы, произвольные файлы и деньги — только в кокпите.',
].join('\n');

function commandOf(text) {
  const match = String(text ?? '').trim().match(/^\/([a-z_]+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/iu);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

const taskIdOf = (args) => (String(args ?? '').trim().match(/^(\d{1,19})\b/u)?.[1] || '');

export class TelegramPultActions {
  constructor({
    isEnabled,
    callApi = null,
    summary = null,
    forget = () => {},
    queue = new PultSendQueue(),
    now = Date.now,
    log = console,
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
    this.isEnabled = isEnabled;
    this.callApi = callApi;
    this.summary = summary;
    this.forget = forget;
    this.queue = queue;
    this.now = now;
    this.log = log;

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
  async _owner(source, lease) {
    let settings;
    try {
      settings = await lease.context.botSettings.read();
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: настройки нечитаемы, вход игнорируется');
      return null;
    }
    if (settings.pultConfirmedAtMs == null) return null;
    if (source?.chatType !== 'private') return null;
    if (source?.chatId !== settings.pultChatId) return null;
    if (source?.from?.id !== settings.pultUserId) return null;
    return settings;
  }

  async _bot(lease, method, body) {
    const token = lease.context.credentials?.token || '';
    if (!token) throw Object.assign(new Error('нет token'), { code: 'not_connected' });
    return this.queue.push(() => lease.context.botApi.callBotApi(token, method, body, {
      timeoutMs: 15_000,
    }));
  }

  /** Ответ владельцу: очередь, plain text, «тихая» ссылка. Ошибка — warn, не throw. */
  async _send(lease, chatId, text, keyboard = null) {
    try {
      return await this._bot(lease, 'sendMessage', {
        chat_id: chatId,
        text: clipText(text, MESSAGE_LIMIT),
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: ответ не доставлен (best effort)');
      return null;
    }
  }

  /** Правка карточки. Клавиатура обязана приходить явно: без неё кнопки снимаются. */
  async _edit(lease, chatId, messageId, text, keyboard = []) {
    try {
      await this._bot(lease, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: clipText(text, MESSAGE_LIMIT),
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: карточка не отредактировалась (best effort)');
    }
  }

  /** answerCallbackQuery обязателен на каждый принятый callback — иначе «часики». */
  async _answer(lease, callback, text = '') {
    try {
      await this._bot(lease, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        ...(text ? { text: clipText(collapseLine(text), ANSWER_LIMIT) } : {}),
      });
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: answerCallbackQuery не доставлен');
    }
  }

  async _api(method, url, payload) {
    if (!this.callApi) {
      return { statusCode: 503, body: { error: 'pult_not_wired', message: 'ручки кокпита не подключены' } };
    }
    return this.callApi(method, url, payload);
  }

  /** Человеческий текст отказа ручки: message сильнее кода, код сильнее пустоты. */
  static failText(res) {
    return String(res?.body?.message || res?.body?.error || `ошибка ${res?.statusCode || '?'}`);
  }

  _remember(map, key, value) {
    map.set(key, { ...value, expiresAtMs: this.now() + WAIT_TTL_MS });
  }

  /** Достать ожидание с проверкой TTL; протухшее — забыть и вернуть null. */
  _take(map, key) {
    const value = map.get(key);
    if (!value) return null;
    map.delete(key);
    if (value.expiresAtMs <= this.now()) return null;
    return value;
  }

  _peek(map, key) {
    const value = map.get(key);
    if (!value) return null;
    if (value.expiresAtMs <= this.now()) {
      map.delete(key);
      return null;
    }
    return value;
  }

  // ------------------------------------------------------------------- приём

  /** Хук поллера: onMessage(msg, type, lease). Никогда не бросает. */
  async onMessage(msg, type, lease) {
    try {
      if (type !== 'message') return; // правки и сервисные события командами не считаются
      if (!await this.isEnabled()) return;
      const settings = await this._owner(msg, lease);
      if (!settings) return;
      if (msg.replyToMessageId && await this._reply(msg, lease)) return;
      await this._command(msg, lease);
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: приём сообщения сорвался');
    }
  }

  /** Хук поллера: onCallback(callback, lease). Никогда не бросает. */
  async onCallback(callback, lease) {
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
        ownerKey: `${lease.accountRef}:${settings.pultConfirmedAtMs}:${settings.pultChatId}`,
      };
      switch (action.kind) {
        case 'gate': await this._gate(ctx, action); break;
        case 'question': await this._question(ctx, action); break;
        case 'question-free': await this._questionFree(ctx, action); break;
        case 'permission': await this._permission(ctx, action); break;
        case 'status-list': await this._statusList(ctx, action); break;
        case 'status-task': await this._statusTask(ctx, action); break;
        case 'status-nodes': await this._statusNodes(ctx, action); break;
        case 'plan-open': await this._planOpen(ctx, action); break;
        case 'plan-page': await this._planPage(ctx, action); break;
        case 'resume': await this._resume(ctx, action); break;
        case 'sandbox-retry': await this._sandboxRetry(ctx, action); break;
        case 'launch': await this._launch(ctx, action); break;
        case 'stop': await this._stop(ctx, action); break;
        case 'task-create': await this._taskCreate(ctx, action); break;
        case 'dismiss': await this._dismiss(ctx); break;
        default: await this._answer(lease, callback, 'Кнопка устарела или неизвестна.');
      }
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: обработка нажатия сорвалась');
    }
  }

  // ------------------------------------------------------------ решения (ф. 2)

  async _gate({ lease, callback, chatId }, { taskId, gateKey, decision, withComment }) {
    const subject = `#${taskId}`;
    if (decision === 'reject' && withComment) {
      // Двухшаговое отклонение: ждём реплай с «что доработать» на ЭТУ карточку.
      this._remember(this.replyWaits, callback.messageId, { kind: 'gate-reject', taskId, gateKey, chatId });
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
    const res = await this._api('POST', `/api/tasks/${taskId}/gate/${gateKey.toLowerCase()}/${decision}`, {});
    if (res.statusCode < 400) {
      let note = decision === 'approve' ? 'принято, прогон продолжен' : 'отклонено без пояснения';
      // Пойманная в UI грабля: решение записано, а прогон не поехал. Молчать нельзя.
      if (res.body?.resumed === false) {
        note += `. Но прогон не поехал: ${res.body?.resumeError || 'причина в кокпите'}`;
      }
      await this._answer(lease, callback, decision === 'approve' ? 'Принято' : 'Отклонено');
      await this._edit(lease, chatId, callback.messageId, resolvedCard({ subject, note }));
    } else {
      // CAS/terminal: называем фактическое состояние, карточку гасим — свежую
      // пришлёт следующий обход вотчера по реальному месту маршрута.
      const why = TelegramPultActions.failText(res);
      await this._answer(lease, callback, why);
      await this._edit(lease, chatId, callback.messageId, `⚠ ${subject}: ${why}`);
    }
    this.forget(`wait:${taskId}`);
  }

  /** Живой вопрос ищем в /api/chat/waiting: снимков вариантов не держим. */
  async _waitingItem(pid) {
    const res = await this._api('GET', '/api/chat/waiting');
    if (res.statusCode >= 400) return null;
    return (res.body?.waiting || []).find((item) => String(item?.pid) === pid) || null;
  }

  async _question({ lease, callback, chatId }, { pid, index }) {
    const item = await this._waitingItem(pid);
    const first = item?.questions?.[0];
    const option = first?.options?.[index];
    if (!item || !first || !option) {
      await this._answer(lease, callback, 'Этот вопрос уже закрыт.');
      await this._edit(lease, chatId, callback.messageId, resolvedCard({ subject: 'чат', note: 'вопрос уже закрыт' }));
      this.forget(`q:${pid}`);
      return;
    }
    const res = await this._api('POST', `/api/chat/permission/${pid}`, {
      answers: [{ header: first.header || '', question: first.question || '', selected: [option.label] }],
    });
    if (res.statusCode < 400) {
      await this._answer(lease, callback, 'Ответ отправлен.');
      await this._edit(lease, chatId, callback.messageId, resolvedCard({
        subject: 'чат', note: `ответ отправлен: ${collapseLine(option.label)}`,
      }));
    } else {
      await this._answer(lease, callback, TelegramPultActions.failText(res));
    }
    this.forget(`q:${pid}`);
  }

  async _questionFree({ lease, callback, chatId }, { pid }) {
    const item = await this._waitingItem(pid);
    if (!item) {
      await this._answer(lease, callback, 'Этот вопрос уже закрыт.');
      return;
    }
    this._remember(this.replyWaits, callback.messageId, { kind: 'question-text', pid, chatId });
    await this._answer(lease, callback, 'Ответь реплаем на это сообщение.');
    const first = item.questions?.[0] || {};
    await this._edit(
      lease, chatId, callback.messageId,
      `❓ чат, вопрос агента\n${collapseLine(first.question || '…')}\n`
      + 'Ответь РЕПЛАЕМ на это сообщение — текст уедет агенту дословно. Или выбери вариант:',
      questionKeyboard(pid, first.options || []),
    );
  }

  async _permission({ lease, callback, chatId }, { pid, action }) {
    const subject = 'чат';
    if (action === 'deny-comment') {
      if (!await this._waitingItem(pid)) {
        await this._answer(lease, callback, 'Этот запрос уже закрыт.');
        return;
      }
      this._remember(this.replyWaits, callback.messageId, { kind: 'perm-deny', pid, chatId });
      await this._answer(lease, callback, 'Ответь реплаем — пояснение агенту.');
      await this._edit(
        lease, chatId, callback.messageId,
        '🔐 чат, отказ с пояснением.\nОтветь РЕПЛАЕМ на это сообщение — пояснение уедет агенту. Или реши кнопкой:',
        permissionKeyboard(pid),
      );
      return;
    }
    const allow = action === 'allow';
    const res = await this._api('POST', `/api/chat/permission/${pid}`, { allow });
    if (res.statusCode < 400) {
      await this._answer(lease, callback, allow ? 'Разрешено.' : 'Отклонено.');
      await this._edit(lease, chatId, callback.messageId, resolvedCard({
        subject, note: allow ? 'разрешено' : 'отклонено',
      }));
    } else if (res.statusCode === 404) {
      await this._answer(lease, callback, 'Этот запрос уже закрыт.');
      await this._edit(lease, chatId, callback.messageId, resolvedCard({ subject, note: 'запрос уже закрыт' }));
    } else {
      await this._answer(lease, callback, TelegramPultActions.failText(res));
    }
    this.forget(`perm:${pid}`);
  }

  // ------------------------------------------------------------ реплаи (ф. 2)

  /** Реплай владельца на карточку-ожидание. true — реплай обработан. */
  async _reply(msg, lease) {
    const wait = this._take(this.replyWaits, msg.replyToMessageId);
    if (!wait) return false;
    const text = String(msg.text || '').trim();
    if (!text) {
      await this._send(lease, msg.chatId, 'Пустой реплай не уехал. Нажми кнопку на карточке ещё раз.');
      return true;
    }
    if (wait.kind === 'gate-reject') {
      const res = await this._api(
        'POST',
        `/api/tasks/${wait.taskId}/gate/${wait.gateKey.toLowerCase()}/reject`,
        { comment: text },
      );
      if (res.statusCode < 400) {
        let note = 'отклонено, замечание уехало агенту';
        if (res.body?.resumed === false) {
          note += `. Но прогон не поехал: ${res.body?.resumeError || 'причина в кокпите'}`;
        }
        await this._edit(lease, wait.chatId, msg.replyToMessageId, resolvedCard({ subject: `#${wait.taskId}`, note }));
        this.forget(`wait:${wait.taskId}`);
      } else {
        // Например gate_rejected «нельзя доставить»: возврат ведёт не к агенту.
        await this._send(lease, msg.chatId, `⚠ #${wait.taskId}: ${TelegramPultActions.failText(res)}`);
      }
      return true;
    }
    if (wait.kind === 'question-text') {
      const res = await this._api('POST', `/api/chat/permission/${wait.pid}`, { answers: [{ text }] });
      await (res.statusCode < 400
        ? this._edit(lease, wait.chatId, msg.replyToMessageId, resolvedCard({ subject: 'чат', note: 'свой ответ уехал агенту' }))
        : this._send(lease, msg.chatId, `⚠ ${TelegramPultActions.failText(res)}`));
      this.forget(`q:${wait.pid}`);
      return true;
    }
    if (wait.kind === 'perm-deny') {
      const res = await this._api('POST', `/api/chat/permission/${wait.pid}`, { allow: false, comment: text });
      await (res.statusCode < 400
        ? this._edit(lease, wait.chatId, msg.replyToMessageId, resolvedCard({ subject: 'чат', note: 'отклонено, пояснение уехало агенту' }))
        : this._send(lease, msg.chatId, `⚠ ${TelegramPultActions.failText(res)}`));
      this.forget(`perm:${wait.pid}`);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ мутации (ф. 3)

  /** Подтверждение вторым тапом: ask-шаг правит карточку в вопрос [Да] [Отмена]. */
  async _confirmAsk({ lease, callback, chatId }, key, question, yesData) {
    this._remember(this.confirms, key, { messageId: callback.messageId });
    await this._answer(lease, callback);
    await this._edit(lease, chatId, callback.messageId, question, confirmKeyboard(yesData));
  }

  /** Второй тап: подтверждение живо? Протухло — честное «запрос устарел», без inject. */
  async _confirmTake({ lease, callback, chatId }, key) {
    const confirm = this._take(this.confirms, key);
    if (confirm) return confirm;
    await this._answer(lease, callback, 'Запрос устарел — нажми кнопку на свежей карточке ещё раз.');
    await this._edit(lease, chatId, callback.messageId, 'Запрос устарел. Вызови /status и попробуй снова.');
    return null;
  }

  async _resume(ctx, { taskId, step }) {
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
    if (res.statusCode < 400) {
      const note = res.body?.outcome === 'already_running' ? 'уже идёт' : 'прогон продолжен';
      await this._answer(ctx.lease, ctx.callback, note);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, resolvedCard({ subject: `#${taskId}`, note }));
      this.forget(`stall:${taskId}`);
    } else {
      // Типизированные отказы движка (runner_preflight_unavailable, коды 73/75/78)
      // приходят словами в message — их и показываем, не глотая.
      const why = TelegramPultActions.failText(res);
      await this._answer(ctx.lease, ctx.callback, why);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⚠ #${taskId}: прогон не поехал: ${why}`);
    }
  }

  async _sandboxRetry(ctx, { taskId, step }) {
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
    if (res.statusCode < 400) {
      await this._answer(ctx.lease, ctx.callback, 'Стенд пересобирается.');
      await this._edit(
        ctx.lease, ctx.chatId, ctx.callback.messageId,
        resolvedCard({ subject: `#${taskId}`, note: 'остатки снесены, прогон продолжен' }) + down,
      );
      this.forget(`stall:${taskId}`);
    } else {
      const why = TelegramPultActions.failText(res);
      await this._answer(ctx.lease, ctx.callback, why);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⚠ #${taskId}: ${why}${down}`);
    }
  }

  async _launch(ctx, { taskId, index, step }) {
    if (step === 'no') { await this._dismiss(ctx); return; }
    const snapshot = this._peek(this.confirms, `l:${taskId}`);
    if (!snapshot || !Array.isArray(snapshot.routes) || !snapshot.routes[index]) {
      await this._answer(ctx.lease, ctx.callback, 'Список устарел — открой заново: /launch ' + taskId);
      return;
    }
    const route = snapshot.routes[index];
    if (step === 'ask') {
      // Тот же снимок остаётся источником истины и на втором шаге; TTL обновляем.
      this._remember(this.confirms, `l:${taskId}`, snapshot);
      await this._answer(ctx.lease, ctx.callback);
      await this._edit(
        ctx.lease, ctx.chatId, ctx.callback.messageId,
        `Запустить #${taskId} маршрутом ${route}? Стенд поднимется за ~20–25 минут.`,
        confirmKeyboard(cbData.launchYes(taskId, index)),
      );
      return;
    }
    this.confirms.delete(`l:${taskId}`);
    // Индекс — не источник истины: перед запуском каталог перечитывается и снимок
    // сверяется по hash и маршруту. Разъехалось — отказ, а не запуск не того.
    const live = await this._api('GET', `/api/tasks/${taskId}/launch-options`);
    const fresh = live.statusCode < 400 ? live.body : null;
    if (!fresh || fresh.error || fresh.catalogHash !== snapshot.catalogHash
        || fresh.routes?.[index] !== route) {
      await this._answer(ctx.lease, ctx.callback, 'Каталог изменился — открой список заново.');
      await this._edit(
        ctx.lease, ctx.chatId, ctx.callback.messageId,
        `⚠ #${taskId}: каталог маршрутов изменился — открой список заново: /launch ${taskId}`,
      );
      return;
    }
    const b24 = await this._api('GET', `/api/b24/task/${taskId}`);
    if (b24.statusCode >= 400) {
      await this._answer(ctx.lease, ctx.callback, 'Задача B24 не прочиталась.');
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⚠ #${taskId}: ${TelegramPultActions.failText(b24)}`);
      return;
    }
    const title = String(b24.body?.title || '').trim();
    const description = htmlToPlainText(b24.body?.description) || title;
    const res = await this._api('POST', `/api/tasks/${taskId}/launch`, {
      profile: snapshot.profile,
      route,
      title,
      description,
      acceptanceCriteria: [],
    });
    if (res.statusCode < 400) {
      const note = res.body?.outcome === 'already_running'
        ? 'уже идёт на конвейере'
        : `запущено маршрутом ${route}, стенд поднимется за ~20–25 минут`;
      await this._answer(ctx.lease, ctx.callback, 'Запущено.');
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, resolvedCard({ subject: `#${taskId}`, note }));
    } else {
      const why = TelegramPultActions.failText(res);
      await this._answer(ctx.lease, ctx.callback, why);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⚠ #${taskId}: запуск не прошёл: ${why}`);
    }
  }

  async _stop(ctx, { index, step }) {
    if (step === 'no') { await this._dismiss(ctx); return; }
    const snapshot = this._peek(this.confirms, 'st');
    const run = snapshot?.runs?.[index];
    if (!run) {
      await this._answer(ctx.lease, ctx.callback, 'Список устарел — открой заново: /stop');
      return;
    }
    if (step === 'ask') {
      this._remember(this.confirms, 'st', snapshot);
      await this._answer(ctx.lease, ctx.callback);
      await this._edit(
        ctx.lease, ctx.chatId, ctx.callback.messageId,
        `Остановить ход агента (${run.label})? Сессия сохранится, изменения не откатываются.`,
        confirmKeyboard(cbData.stopYes(index)),
      );
      return;
    }
    this.confirms.delete('st');
    // Снимок сверяется с живым списком: индекс не должен убить другой ход.
    const live = await this._api('GET', '/api/chat/active');
    const alive = (live.body?.active || []).some((a) => a.chatKey === run.chatKey);
    if (live.statusCode >= 400 || !alive) {
      await this._answer(ctx.lease, ctx.callback, 'Этот ход уже завершился.');
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `Ход (${run.label}) уже завершился сам.`);
      return;
    }
    const res = await this._api('POST', '/api/chat/stop', { chatKey: run.chatKey });
    if (res.statusCode < 400) {
      await this._answer(ctx.lease, ctx.callback, 'Остановлен.');
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⏹ Ход агента (${run.label}) остановлен.`);
    } else {
      await this._answer(ctx.lease, ctx.callback, TelegramPultActions.failText(res));
    }
  }

  async _taskCreate(ctx, { confirmed }) {
    const draft = this._take(this.confirms, 'tk');
    if (!confirmed) {
      await this._answer(ctx.lease, ctx.callback, 'Отменено.');
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, 'Отменено — задача не создана.');
      return;
    }
    if (!draft) {
      await this._answer(ctx.lease, ctx.callback, 'Черновик устарел — отправь /task заново.');
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, 'Черновик устарел. Отправь /task заново.');
      return;
    }
    const res = await this._api('POST', '/api/b24/tasks', {
      title: draft.title,
      description: draft.description,
      priority: 1,
    });
    if (res.statusCode < 400 && res.body?.id) {
      await this._answer(ctx.lease, ctx.callback, `Задача #${res.body.id} создана.`);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `✓ Задача #${res.body.id} создана: «${clipText(draft.title, 100)}»`);
    } else {
      const why = TelegramPultActions.failText(res);
      await this._answer(ctx.lease, ctx.callback, why);
      await this._edit(ctx.lease, ctx.chatId, ctx.callback.messageId, `⚠ Задача не создана: ${why}\nОтправь /task заново.`);
    }
  }

  /** «Отмена» на любой карточке подтверждения. */
  async _dismiss({ lease, callback, chatId }) {
    for (const [key, value] of this.confirms) {
      if (value.messageId === callback.messageId) this.confirms.delete(key);
    }
    await this._answer(lease, callback, 'Отменено.');
    await this._edit(lease, chatId, callback.messageId, 'Отменено.');
  }

  // -------------------------------------------------------- просмотр конвейера

  async _statusSnapshot() {
    if (!this.summary) return null;
    return this.summary();
  }

  static _statusTasks(snapshot) {
    return Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  }

  static _statusPage(snapshot, requestedPage) {
    const tasks = TelegramPultActions._statusTasks(snapshot);
    const totalPages = Math.max(1, Math.ceil(tasks.length / STATUS_PAGE_SIZE));
    const page = Math.max(0, Math.min(totalPages - 1, Number(requestedPage) || 0));
    const from = page * STATUS_PAGE_SIZE;
    return { tasks, pageTasks: tasks.slice(from, from + STATUS_PAGE_SIZE), page, totalPages };
  }

  static _statusTask(snapshot, taskId) {
    return TelegramPultActions._statusTasks(snapshot)
      .find((task) => String(task?.task) === String(taskId)) || null;
  }

  static _chatWaiting(snapshot) {
    return Array.isArray(snapshot?.chat) ? snapshot.chat.length : 0;
  }

  _statusListPayload(snapshot, requestedPage) {
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

  async _commandStatus(msg, lease, taskId = '') {
    let snapshot;
    try {
      snapshot = await this._statusSnapshot();
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: подробный /status не собрался');
      await this._send(lease, msg.chatId, 'Статус сейчас не собрался — попробуй ещё раз или загляни в кокпит.');
      return;
    }
    // Совместимость с внешним/старым summary-провайдером: строка всё ещё честно
    // показывается, но production передаёт структурированный снимок вотчера.
    if (typeof snapshot === 'string') {
      await this._send(lease, msg.chatId, snapshot);
      return;
    }
    if (!snapshot || typeof snapshot !== 'object') {
      await this._send(lease, msg.chatId, 'Статус пока не собран — попробуй ещё раз через несколько секунд.');
      return;
    }
    if (taskId) {
      const task = TelegramPultActions._statusTask(snapshot, taskId);
      if (!task) {
        await this._send(lease, msg.chatId, `#${taskId} сейчас нет на конвейере.`);
        return;
      }
      await this._send(lease, msg.chatId, taskStatusCard(task), taskStatusKeyboard(taskId, 0));
      return;
    }
    const payload = this._statusListPayload(snapshot, 0);
    await this._send(lease, msg.chatId, payload.text, payload.keyboard);
  }

  async _statusList({ lease, callback, chatId }, { page }) {
    await this._answer(lease, callback);
    let snapshot;
    try { snapshot = await this._statusSnapshot(); } catch { snapshot = null; }
    if (!snapshot || typeof snapshot === 'string') {
      await this._edit(lease, chatId, callback.messageId, typeof snapshot === 'string'
        ? snapshot
        : 'Статус сейчас не собрался — попробуй /status ещё раз.');
      return;
    }
    const payload = this._statusListPayload(snapshot, page);
    await this._edit(lease, chatId, callback.messageId, payload.text, payload.keyboard);
  }

  async _statusTask({ lease, callback, chatId }, { taskId, page }) {
    await this._answer(lease, callback);
    let snapshot;
    try { snapshot = await this._statusSnapshot(); } catch { snapshot = null; }
    const task = TelegramPultActions._statusTask(snapshot, taskId);
    if (!task) {
      await this._edit(
        lease, chatId, callback.messageId,
        `#${taskId} уже ушла с конвейера.`,
        [[{ text: '← К списку', callback_data: cbData.statusList(page) }]],
      );
      return;
    }
    await this._edit(
      lease, chatId, callback.messageId,
      taskStatusCard(task),
      taskStatusKeyboard(taskId, page),
    );
  }

  async _statusNodes({ lease, callback, chatId }, { taskId, page, nodePage = 0 }) {
    await this._answer(lease, callback);
    let snapshot;
    try { snapshot = await this._statusSnapshot(); } catch { snapshot = null; }
    const task = TelegramPultActions._statusTask(snapshot, taskId);
    if (!task) {
      await this._edit(
        lease, chatId, callback.messageId,
        `#${taskId} уже ушла с конвейера.`,
        [[{ text: '← К списку', callback_data: cbData.statusList(page) }]],
      );
      return;
    }
    const nodes = taskNodesPage(task, nodePage);
    await this._edit(
      lease, chatId, callback.messageId,
      nodes.text,
      taskNodesKeyboard(taskId, page, nodes.page, nodes.totalPages),
    );
  }

  async _readPlan(taskId) {
    const res = await this._api('GET', `/api/tasks/${taskId}/doc/plan`);
    if (res.statusCode >= 400) return { error: TelegramPultActions.failText(res), pages: [] };
    return { error: '', pages: planPages(res.body?.text) };
  }

  _planViewKey(ownerKey, messageId) {
    return `${ownerKey}:${messageId}`;
  }

  _rememberPlan(ownerKey, messageId, value) {
    const now = this.now();
    for (const [key, view] of this.planViews) {
      if (view.expiresAtMs <= now) this.planViews.delete(key);
    }
    this._remember(this.planViews, this._planViewKey(ownerKey, messageId), value);
    if (this.planViews.size <= PLAN_VIEW_MAX) return;
    const oldest = [...this.planViews.entries()]
      .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs)
      .slice(0, this.planViews.size - PLAN_VIEW_MAX);
    for (const [key] of oldest) this.planViews.delete(key);
  }

  async _planOpen({ lease, callback, chatId, ownerKey }, { taskId }) {
    await this._answer(lease, callback);
    let plan;
    try { plan = await this._readPlan(taskId); } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: план не прочитался');
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
    const sent = await this._send(
      lease, chatId, card.text,
      planPageKeyboard(taskId, card.page, card.totalPages),
    );
    const messageId = Number(sent?.message_id);
    if (Number.isSafeInteger(messageId) && messageId > 0) {
      this._rememberPlan(ownerKey, messageId, { taskId, pages: plan.pages });
    }
  }

  async _planPage({ lease, callback, chatId, ownerKey }, { taskId, page }) {
    await this._answer(lease, callback);
    const key = this._planViewKey(ownerKey, callback.messageId);
    const view = this._peek(this.planViews, key);
    if (!view || view.taskId !== taskId || !Array.isArray(view.pages) || !view.pages.length) {
      await this._edit(
        lease, chatId, callback.messageId,
        `📄 #${taskId}: просмотр плана устарел. Открой план заново из карточки задачи.`,
      );
      return;
    }
    // Листание продлевает жизнь того же неизменного снимка: страницы не прыгают,
    // даже если агент одновременно переписал plan.md.
    this._rememberPlan(ownerKey, callback.messageId, { taskId, pages: view.pages });
    const card = planPageCard({ taskId, pages: view.pages, page });
    await this._edit(
      lease, chatId, callback.messageId, card.text,
      planPageKeyboard(taskId, card.page, card.totalPages),
    );
  }

  // ------------------------------------------------------------------ команды

  async _command(msg, lease) {
    const command = commandOf(msg.text);
    const name = command?.name;
    if (name === 'help' || name === 'start') {
      await this._send(lease, msg.chatId, HELP_TEXT);
      return;
    }
    if (name === 'status') {
      await this._commandStatus(msg, lease, taskIdOf(command.args));
      return;
    }
    if (name === 'task') { await this._commandTask(msg, lease, command.args); return; }
    if (name === 'launch') { await this._commandLaunch(msg, lease, command.args); return; }
    if (name === 'timer') { await this._commandTimer(msg, lease, command.args); return; }
    if (name === 'complete' || name === 'renew') {
      await this._commandB24Simple(msg, lease, name, command.args);
      return;
    }
    if (name === 'stop') { await this._commandStop(msg, lease); return; }
    // Незнакомый текст вне ожидания реплая — короткая подсказка (только владельцу).
    await this._send(lease, msg.chatId, 'Не понял. Команды пульта: /help');
  }

  /** /task: первая строка — заголовок, остальное — описание; создание после предпросмотра. */
  async _commandTask(msg, lease, args) {
    const [firstLine, ...rest] = String(args || '').split('\n');
    const title = collapseLine(firstLine);
    const description = rest.join('\n').trim();
    if (!title) {
      await this._send(lease, msg.chatId, 'Так: /task Заголовок⏎описание (описание — со второй строки).');
      return;
    }
    const preview = [
      `📝 Задача B24: «${clipText(title, 200)}»`,
      description ? clipText(description, 800) : '(без описания)',
      'Создать?',
    ].join('\n');
    const sent = await this._send(lease, msg.chatId, preview, [[
      { text: 'Создать', callback_data: cbData.taskCreate() },
      { text: 'Отмена', callback_data: cbData.taskCancel() },
    ]]);
    if (sent) this._remember(this.confirms, 'tk', { title, description, messageId: sent.message_id });
  }

  /** /launch <id>: маршруты — только из опубликованного каталога, снимок на сервере. */
  async _commandLaunch(msg, lease, args) {
    const taskId = taskIdOf(args);
    if (!taskId) {
      await this._send(lease, msg.chatId, 'Так: /launch <номер задачи>');
      return;
    }
    const res = await this._api('GET', `/api/tasks/${taskId}/launch-options`);
    const body = res.statusCode < 400 ? res.body : null;
    if (!body || body.error) {
      await this._send(lease, msg.chatId, `⚠ #${taskId}: ${TelegramPultActions.failText(res) === 'undefined' ? 'запуск недоступен' : (body?.message || TelegramPultActions.failText(res))}`);
      return;
    }
    if (body.onConveyor) {
      await this._send(lease, msg.chatId, `#${taskId} уже на конвейере${body.running ? ' и идёт' : ''} — продолжить можно с карточки затыка или из кокпита.`);
      return;
    }
    const routes = Array.isArray(body.routes) ? body.routes : [];
    if (!routes.length) {
      await this._send(lease, msg.chatId, `⚠ #${taskId}: каталог маршрутов не опубликован — публикует человек из «Маршрутов».`);
      return;
    }
    const keyboard = routes.map((route, index) => ([{
      text: route === body.defaultRoute ? `${route} (по умолчанию)` : route,
      callback_data: cbData.launchPick(taskId, index),
    }]));
    keyboard.push([{ text: 'Отмена', callback_data: cbData.dismiss() }]);
    const sent = await this._send(
      lease, msg.chatId,
      `🚀 #${taskId}: каким маршрутом? (профиль ${body.profile})`,
      keyboard,
    );
    if (sent) {
      this._remember(this.confirms, `l:${taskId}`, {
        routes, catalogHash: body.catalogHash, profile: body.profile, messageId: sent.message_id,
      });
    }
  }

  async _commandTimer(msg, lease, args) {
    const taskId = taskIdOf(args);
    const action = String(args || '').trim().split(/\s+/u)[1] || '';
    if (!taskId || !['start', 'pause', 'stop'].includes(action)) {
      await this._send(lease, msg.chatId, 'Так: /timer <номер> start|pause|stop');
      return;
    }
    const res = await this._api('POST', `/api/b24/task/${taskId}/timer/${action}`, {});
    await this._send(lease, msg.chatId, res.statusCode < 400
      ? `✓ #${taskId}: таймер — ${action}`
      : `⚠ #${taskId}: ${TelegramPultActions.failText(res)}`);
  }

  async _commandB24Simple(msg, lease, name, args) {
    const taskId = taskIdOf(args);
    if (!taskId) {
      await this._send(lease, msg.chatId, `Так: /${name} <номер задачи>`);
      return;
    }
    const res = await this._api('POST', `/api/b24/task/${taskId}/${name}`, {});
    await this._send(lease, msg.chatId, res.statusCode < 400
      ? `✓ #${taskId}: ${name === 'complete' ? 'завершена' : 'возобновлена'}`
      : `⚠ #${taskId}: ${TelegramPultActions.failText(res)}`);
  }

  /** /stop: только ходы агентов ЧАТОВ. Этапы конвейера пульт не глушит — как кокпит. */
  async _commandStop(msg, lease) {
    const res = await this._api('GET', '/api/chat/active');
    const active = res.statusCode < 400 && Array.isArray(res.body?.active) ? res.body.active : [];
    if (!active.length) {
      await this._send(lease, msg.chatId, 'Сейчас ни один агент в чатах не идёт.');
      return;
    }
    const runs = active.map((run) => ({
      chatKey: String(run.chatKey || ''),
      label: `${String(run.chatKey || '').slice(0, 12)}… · ${Number(run.tokens) || 0} ток.`,
    }));
    const keyboard = runs.slice(0, 10).map((run, index) => ([{
      text: `⏹ ${run.label}`,
      callback_data: cbData.stopPick(index),
    }]));
    keyboard.push([{ text: 'Отмена', callback_data: cbData.dismiss() }]);
    const sent = await this._send(lease, msg.chatId, 'Какой ход остановить?', keyboard);
    if (sent) this._remember(this.confirms, 'st', { runs, messageId: sent.message_id });
  }
}

export default TelegramPultActions;
