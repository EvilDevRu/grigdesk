// Native control-plane Telegram: provider lifecycle, account-scoped archive/rules,
// service chat, пульт и безопасный разворот t.me-ссылок. Общая очередь, decisions,
// B24 и worker принадлежат module-inbox и здесь намеренно отсутствуют.
import { randomInt } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import * as realBotApi from '../../lib/telegram/api.ts';
import { normalizeTelegramBotId } from '../../lib/telegram/accountBindings.ts';
import { scrubToken } from '../../lib/telegram/api.ts';
import { buildDiscussion } from '../../lib/telegram/discussion.ts';
import { isBotTokenShape, maskToken } from '../../lib/telegram/token.ts';
import { parseTelegramLinks } from '../../lib/telegram/links.ts';
import { resolveText } from '../../lib/telegram/resolve.ts';
import { pultReplyKeyboard } from '../../lib/telegram/pult/format.ts';

type Payload = Record<string, unknown>;

// Аренда одного аккаунта: пока она жива, поколение не меняется под руками
// запроса, и результат старого поколения не уедет в хранилища нового.
// Хранилища одного аккаунта в том виде, в каком их зовут маршруты. Токен сюда
// не выходит: за него отвечает lifecycle, а модуль работает уже через аренду.
interface LeaseContext extends Payload {
  botId?: unknown;
  botSettings: {
    read: () => Promise<Payload>;
    setServiceChatId: (id: unknown) => Promise<Payload>;
    setPult: (options: Payload) => Promise<Payload>;
  };
  archive: {
    chats: () => Promise<Payload[]>;
    topics: (chatId: number) => Promise<Payload[]>;
    branch?: (...args: unknown[]) => Promise<unknown>;
    chatIdOf?: (username: unknown) => Promise<number | null>;
    append?: (msg: unknown) => Promise<unknown>;
  };
  rules: {
    read: () => Promise<unknown[]>;
    readPolicySnapshot: () => Promise<Payload>;
    writeHumanCas: (rules: unknown, options: Payload) => Promise<Payload>;
    setAgentSearch: (options: Payload) => Promise<Payload>;
  };
  botApi?: {
    callBotApi: (token: string, method: string, body?: Payload, opts?: Payload) => Promise<Payload>;
  };
  credentials?: { token?: string } | null;
}

interface TelegramLease {
  accountRef?: string;
  context: LeaseContext;
  isCurrent: () => boolean;
  release: () => Promise<unknown> | unknown;
}

// Lifecycle подключения приходит из приложения; модуль знает о нём ровно то,
// что зовёт сам, и не владеет ни токеном, ни поллером.
export interface TelegramStatus extends Payload {
  connection?: string;
  configured?: boolean;
  reason?: string | null;
  bot?: Payload;
}

export interface TelegramConnectionPort {
  status: () => Promise<TelegramStatus>;
  connect: (options: Payload) => Promise<unknown>;
  recheck: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  acquireLease: () => TelegramLease;
}

export interface TelegramModuleOptions {
  connection?: TelegramConnectionPort;
  poller?: { status?: () => Payload } | null;
  botApi?: typeof realBotApi;
  listProjects?: () => Promise<unknown>;
  // Список для ФОРМЫ: в новом правиле архивный проект не предлагается. Проверка уже
  // сохранённых правил идёт по полному списку (`listProjects`) — архив их не рвёт.
  listActiveProjects?: () => Promise<unknown>;
  now?: () => number;
}

type ResolveArchive = NonNullable<Parameters<typeof resolveText>[1]>['archive'];

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;

const EMPTY = () => ({ links: [], text: '', quotes: 0, truncated: false });

const PUBLIC_MESSAGES = Object.freeze({
  telegram_bad_token: 'Это не похоже на token Telegram bot.',
  telegram_already_configured: 'Telegram bot уже подключён; сначала отключите его.',
  telegram_not_connected: 'Telegram bot ещё не подключён.',
  telegram_account_changed: 'Подключённый Telegram bot изменился во время операции.',
  telegram_binding_invalid: 'Привязка Telegram bot повреждена.',
  telegram_credentials_invalid: 'Telegram credential повреждён.',
  telegram_credentials_unsafe: 'Telegram credential нельзя безопасно прочитать.',
  telegram_identity_invalid: 'Telegram вернул неверную identity bot.',
  telegram_unreachable: 'До Telegram сейчас не достучаться.',
  telegram_rejected: 'Telegram отклонил token или операцию.',
  telegram_rules_invalid: 'Правила Telegram не соответствуют контракту.',
  telegram_rules_stale: 'Правила Telegram уже изменились. Перечитайте их перед сохранением.',
  telegram_failed: 'Операция Telegram временно не выполнена.',
});

function exactBody(value: unknown, keys: string[]): Payload | null {
  const body = value ?? {};
  if (!isPlainRecord(body)) return null;
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
    ? body
    : null;
}

function accountChanged() {
  return Object.assign(new Error('Telegram account generation changed.'), {
    code: 'telegram_account_changed',
    statusCode: 409,
  });
}

function publicFailure(reply: FastifyReply, error: unknown, token = '') {
  const failure = error as {
    code?: unknown;
    statusCode?: unknown;
    kind?: unknown;
    message?: unknown;
  } | null;
  const explicitCode = typeof failure?.code === 'string'
    && Object.hasOwn(PUBLIC_MESSAGES, failure.code)
    ? failure.code
    : null;
  let code = explicitCode || 'telegram_failed';
  let status = Number.isInteger(failure?.statusCode) ? Number(failure?.statusCode) : 500;

  if (explicitCode === null) {
    if (failure?.kind === 'transport') {
      code = 'telegram_unreachable';
      status = 502;
    } else if (failure?.kind === 'telegram') {
      code = 'telegram_rejected';
      status = 400;
    } else {
      code = 'telegram_failed';
    }
  }
  if (status < 400 || status > 599) status = 500;
  const safeProviderWhy = scrubToken(failure?.message || '', token);
  const messages = PUBLIC_MESSAGES as Record<string, string>;
  const message = code === 'telegram_unreachable' && safeProviderWhy
    ? `${messages[code]} ${safeProviderWhy}`
    : messages[code];
  return reply.code(status).send({ error: code, message });
}

async function telegramModule(
  fastify: FastifyInstance,
  opts: TelegramModuleOptions,
): Promise<void> {
  // `connection` проверяется прямо ниже: без него модуль не поднимается вовсе,
  // поэтому дальше он читается как обязательный.
  const {
    connection,
    poller = null,
    botApi = realBotApi,
    listProjects = async () => [],
    listActiveProjects = listProjects,
    now = Date.now,
  } = opts as TelegramModuleOptions & { connection: TelegramConnectionPort };
  if (!connection || typeof connection.status !== 'function'
      || typeof connection.connect !== 'function'
      || typeof connection.recheck !== 'function'
      || typeof connection.disconnect !== 'function'
      || typeof connection.acquireLease !== 'function') {
    throw new Error('module-telegram: account-aware connection обязателен');
  }
  if (!botApi || typeof botApi.callBotApi !== 'function' || typeof listProjects !== 'function'
      || typeof now !== 'function') {
    throw new Error('module-telegram: botApi/listProjects/now имеют неверный contract');
  }

  const enabled = () => fastify.pluginEnabled('telegram');
  const gate = (reply: FastifyReply) => (enabled() ? null : reply.code(404).send({
    error: 'plugin_disabled',
    message: 'Плагин «Телеграм» выключен.',
  }));
  const changed = (status: string) => {
    try {
      const result = fastify.sse?.broadcast?.('inbox-changed', {
        itemRef: null, channel: 'telegram', status, taskId: null,
      });
      Promise.resolve(result).catch(() => {});
    } catch { /* durable mutation уже завершена */ }
  };

  const run = <Params = unknown>(
    operation: (request: FastifyRequest & { params: Params }, reply: FastifyReply) => unknown,
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (gate(reply)) return reply;

    try {
      return await operation(request as FastifyRequest & { params: Params }, reply);
    } catch (error) {
      request.log?.error?.({ code: errorCode(error) }, 'telegram: native operation failed');

      return publicFailure(reply, error);
    }
  };

  async function providerConnected(): Promise<boolean> {
    const state = await connection.status();
    return state.connection === 'connected' && state.configured === true;
  }

  async function acquire(): Promise<TelegramLease> {
    const lease = connection.acquireLease();
    if (!lease?.context || typeof lease.isCurrent !== 'function' || typeof lease.release !== 'function') {
      await lease?.release?.();
      throw Object.assign(new Error('Invalid Telegram account lease.'), {
        code: 'telegram_failed', statusCode: 500,
      });
    }
    if (!lease.isCurrent()) {
      await lease.release();
      throw accountChanged();
    }
    return lease;
  }

  async function acquireWritable(reply: FastifyReply): Promise<TelegramLease | null> {
    try {
      return await acquire();
    } catch (error) {
      if (errorCode(error) === 'account_draining') throw accountChanged();
      if (errorCode(error) !== 'channel_disconnected') throw error;
      reply.code(409).send({
        error: 'telegram_not_connected',
        message: PUBLIC_MESSAGES.telegram_not_connected,
      });
      return null;
    }
  }

  async function checked<Result>(
    lease: TelegramLease,
    operation: (context: LeaseContext) => Promise<Result> | Result,
  ): Promise<Result> {
    if (!lease.isCurrent()) throw accountChanged();
    const result = await operation(lease.context);
    if (!lease.isCurrent()) throw accountChanged();
    return result;
  }

  /**
   * Общий каркас нативной мутации формы: exact-тело с botId, живой lease и
   * трёхсторонний CAS (тело ↔ lease ↔ live connection) — правило service-chat.
   */
  async function withCasLease(
    request: FastifyRequest,
    reply: FastifyReply,
    keys: string[],
    operation: (context: {
      lease: TelegramLease;
      body: Payload;
      reply: FastifyReply;
    }) => Promise<unknown>,
  ) {
    const body = exactBody(request.body, keys);
    let expectedBotId = null;
    try { expectedBotId = normalizeTelegramBotId(body?.botId); } catch { /* invalid client CAS */ }
    if (!body || expectedBotId === null) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: `Ожидались ровно canonical ${keys.join(', ')}.`,
      });
    }
    const lease = await acquireWritable(reply);
    if (!lease) return reply;
    try {
      const provider = await connection.status();
      if (!lease.isCurrent()) throw accountChanged();
      if (provider.connection !== 'connected' || provider.configured !== true) {
        return reply.code(409).send({
          error: 'telegram_not_connected',
          message: PUBLIC_MESSAGES.telegram_not_connected,
        });
      }
      if (normalizeTelegramBotId(lease.context.botId) !== expectedBotId) throw accountChanged();

      let liveBotId: string | null = null;

      try {
        liveBotId = normalizeTelegramBotId((provider.bot as Payload | undefined)?.botId);
      } catch { /* stale projection */ }
      if (liveBotId !== expectedBotId) throw accountChanged();
      return await operation({ lease, body, reply });
    } finally { await lease.release(); }
  }

  // Transport аренды. Обычно он приходит вместе с ней; общий клиент остаётся
  // запасным путём для контекста, собранного до появления собственного transport.
  const callWithLease = (
    context: LeaseContext,
    token: string,
    method: string,
    body?: Payload,
    opts?: Payload,
  ) => (context.botApi || botApi).callBotApi(token, method, body, opts);

  const privacyHint = (bot: Payload) => (bot.canReadAllGroupMessages
    ? ''
    : 'В группах бот сейчас видит только сообщения, адресованные ему. Чтобы он читал '
      + 'обсуждение целиком, выключи режим приватности: @BotFather → /setprivacy → бот → Disable.');

  async function viewFromLease(lease: TelegramLease, knownStatus: TelegramStatus | null = null) {
    const status = knownStatus || await checked(lease, () => connection.status());
    const statusBot = (status.bot || {}) as Payload;
    let statusBotId: string | null = null;

    try { statusBotId = normalizeTelegramBotId(statusBot.botId); } catch { /* no selected owner */ }
    if (statusBotId === null) {
      return {
        ...statusBot,
        serviceChatTitle: '',
        privacyHint: statusBot.configured ? privacyHint(statusBot) : '',
      } as Payload;
    }
    if (statusBotId !== normalizeTelegramBotId(lease.context.botId)) throw accountChanged();

    const settings = await checked(lease, (context) => context.botSettings.read());
    let serviceChatTitle = '';

    if (settings.serviceChatId) {
      const chats = await checked(lease, (context) => context.archive.chats());

      serviceChatTitle = String(
        chats.find((chat) => chat.id === settings.serviceChatId)?.title || '',
      );
    }
    const bot: Payload = {
      ...statusBot,
      serviceChatId: settings.serviceChatId,
      serviceChatTitle,
    };
    return { ...bot, privacyHint: bot.configured ? privacyHint(bot as Payload) : '' };
  }

  // ------------------------------------------------------------------- пульт
  //
  // Владелец пульта — личка, подтверждённая 6-значным кодом (§5.1 плана пульта).
  // Ожидающий код живёт только в памяти процесса: рестарт посреди подключения
  // просто требует нового запроса, секрет на диск не попадает.
  const PULT_CODE_TTL_MS = 10 * 60_000;
  const PULT_CODE_ATTEMPTS = 5;
  /** accountRef → { botId, chatId, code, expiresAtMs, attempts } */
  const pultPending = new Map();
  /** accountRef → последний использованный код: disable честно называет его погашенным. */
  const pultLastCode = new Map();

  // Команды и постоянная клавиатура пульта существуют только в личке владельца:
  // бот обслуживает ещё и Входящие, поэтому всё ставится со scope конкретного
  // чата, без default-scope — посторонние команды пульта видеть не должны.
  const PULT_COMMANDS = Object.freeze([
    { command: 'start', description: 'Открыть пульт' },
    { command: 'status', description: 'Сводка конвейера' },
    { command: 'help', description: 'Что умеет пульт' },
    { command: 'clean', description: 'Убрать сообщения пульта' },
  ]);
  const emptyPult = () => ({
    configured: false, confirmed: false, pending: false, chatTitle: '', chatHint: '',
  });

  function pultPendingAlive(lease: TelegramLease) {
    const pending = pultPending.get(String(lease.accountRef));

    if (!pending) return null;

    let owner: string | null = null;

    try { owner = normalizeTelegramBotId(lease.context.botId); } catch { /* нет владельца */ }
    if (pending.botId !== owner || pending.expiresAtMs <= now()) {
      pultPending.delete(String(lease.accountRef));
      return null;
    }
    return pending;
  }

  /** Публичная проекция: сырой chat id наружу не уходит — маска и заголовок. */
  async function pultViewFromLease(lease: TelegramLease) {
    let settings: Payload;

    try { settings = await checked(lease, (context) => context.botSettings.read()); } catch {
      return emptyPult();
    }
    const pending = pultPendingAlive(lease);
    const shownChat = settings.pultChatId ?? pending?.chatId ?? null;
    let chatTitle = '';

    if (shownChat !== null) {
      const chats = await checked(lease, (context) => context.archive.chats());

      chatTitle = String(chats.find((chat) => chat.id === shownChat)?.title || '');
    }
    return {
      configured: settings.pultChatId != null,
      confirmed: settings.pultConfirmedAtMs != null,
      pending: pending !== null,
      chatTitle,
      chatHint: shownChat !== null ? `…${String(shownChat).slice(-4)}` : '',
    };
  }

  async function viewSnapshot() {
    let lease: TelegramLease | undefined;

    try {
      lease = await acquire();
      const status = await checked(lease, () => connection.status());
      return {
        status,
        bot: await viewFromLease(lease, status),
        pult: await pultViewFromLease(lease),
      };
    } catch (error) {
      if (errorCode(error) !== 'channel_disconnected') throw error;

      const status = await connection.status();
      const statusBot = (status.bot || {}) as Payload;
      const bot = {
        ...statusBot,
        serviceChatTitle: '',
        privacyHint: statusBot.configured ? privacyHint(statusBot) : '',
      };

      return { status, bot, pult: emptyPult() };
    } finally {
      await lease?.release?.();
    }
  }

  async function view() {
    return (await viewSnapshot()).bot;
  }

  fastify.get('/api/telegram/status', run(async () => {
    const snapshot = await viewSnapshot();
    return {
      bot: snapshot.bot,
      pult: snapshot.pult,
      poll: poller?.status?.() ?? null,
      connection: snapshot.status.connection,
      reason: snapshot.status.reason,
    };
  }));

  // Account-scoped native archive остаётся читаемым offline. Ответ старой
  // generation отбрасывается целиком перед публикацией.
  fastify.get('/api/telegram/chats', run(async () => {
    const lease = await acquire();
    try { return { chats: await checked(lease, (context) => context.archive.chats()) }; }
    finally { await lease.release(); }
  }));

  fastify.get('/api/telegram/chats/:chatId/topics', run(async (request, reply) => {
    const chatId = Number((request.params as { chatId?: unknown })?.chatId);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      return reply.code(400).send({ error: 'bad_chat_id', message: 'У чата неверный id.' });
    }
    const lease = await acquire();
    try {
      const topics = await checked(lease, (context) => context.archive.topics(chatId));
      return { topics };
    } finally { await lease.release(); }
  }));

  fastify.get('/api/telegram/rules', run(async () => {
    const lease = await acquire();
    try {
      const snapshot = await checked(lease, (context) => context.rules.readPolicySnapshot());
      const projects = await listActiveProjects();
      if (!lease.isCurrent()) throw accountChanged();
      return { ...snapshot, projects };
    } finally { await lease.release(); }
  }));

  fastify.put('/api/telegram/rules', run(async (request, reply) => {
    const body = exactBody(request.body, ['botId', 'policyFingerprint', 'rules']);
    let expectedBotId = null;
    try { expectedBotId = normalizeTelegramBotId(body?.botId); } catch { /* invalid client CAS */ }
    if (!body || expectedBotId === null) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Ожидались ровно canonical botId, policyFingerprint и rules.',
      });
    }
    const lease = await acquireWritable(reply);
    if (!lease) return reply;
    try {
      // botId — только optimistic CAS для формы. Владелец записи всегда
      // определяется immutable lease, поэтому старый UI не пишет в нового bot.
      const provider = await connection.status();
      if (!lease.isCurrent()) throw accountChanged();
      if (provider.connection !== 'connected' || provider.configured !== true) {
        return reply.code(409).send({
          error: 'telegram_not_connected',
          message: PUBLIC_MESSAGES.telegram_not_connected,
        });
      }
      if (normalizeTelegramBotId(lease.context.botId) !== expectedBotId) throw accountChanged();

      let liveBotId: string | null = null;

      try {
        liveBotId = normalizeTelegramBotId((provider.bot as Payload | undefined)?.botId);
      } catch { /* stale projection */ }
      if (liveBotId !== expectedBotId) throw accountChanged();
      const projects = await listProjects();
      if (!lease.isCurrent()) throw accountChanged();
      const snapshot = await checked(lease, (context) => context.rules.writeHumanCas(body.rules, {
        expectedPolicyFingerprint: body.policyFingerprint,
        projects,
      }));
      changed('rules');
      return { ok: true, ...snapshot };
    } catch (error) {
      if (!errorCode(error) && error instanceof Error) {
        Object.assign(error, { code: 'telegram_rules_invalid', statusCode: 400 });
      }
      throw error;
    } finally { await lease.release(); }
  }));

  fastify.put('/api/telegram/rules/agent-search', run(async (request, reply) => (
    withCasLease(
      request,
      reply,
      ['botId', 'enabled', 'expectedPolicyFingerprint', 'rule'],
      async ({ lease, body }) => {
        const snapshot = await checked(lease, (context) => context.rules.setAgentSearch({
          rule: body.rule,
          enabled: body.enabled,
          expectedPolicyFingerprint: body.expectedPolicyFingerprint,
        }));
        changed('rules-agent-search');
        return { ok: true, ...snapshot };
      },
    )
  )));

  fastify.post('/api/telegram/connect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (gate(reply)) return reply;
    const body = exactBody(request.body, ['token']);
    const token = String(body?.token ?? '').trim();
    if (!body || !isBotTokenShape(token)) {
      return reply.code(400).send({
        error: 'telegram_bad_token',
        message: 'Это не похоже на token bot: вставьте целую строку из @BotFather.',
      });
    }
    try {
      await connection.connect({ token });
      fastify.log.info({ token: maskToken(token) }, 'telegram: bot account подключён');
      return { ok: true, bot: await view(), poll: poller?.status?.() ?? null };
    } catch (error) {
      request.log?.warn?.(
        { token: maskToken(token), code: errorCode(error) },
        'telegram: connect rejected',
      );
      return publicFailure(reply, error, token);
    }
  });

  fastify.post('/api/telegram/recheck', run(async (request, reply) => {
    if (!exactBody(request.body, [])) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Тело recheck должно быть пустым.' });
    }
    await connection.recheck();
    return { ok: true, bot: await view(), poll: poller?.status?.() ?? null };
  }));

  fastify.post('/api/telegram/disconnect', run(async (request, reply) => {
    if (!exactBody(request.body, [])) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Тело disconnect должно быть пустым.' });
    }
    await connection.disconnect();
    return { ok: true, bot: await view(), poll: poller?.status?.() ?? null };
  }));

  fastify.post('/api/telegram/service-chat', run(async (request, reply) => {
    const body = exactBody(request.body, ['botId', 'chatId']);
    let expectedBotId = null;
    try { expectedBotId = normalizeTelegramBotId(body?.botId); } catch { /* invalid client CAS */ }
    if (!body || expectedBotId === null) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Ожидались ровно canonical botId и chatId.',
      });
    }
    const lease = await acquireWritable(reply);
    if (!lease) return reply;
    try {
      const provider = await connection.status();
      if (!lease.isCurrent()) throw accountChanged();
      if (provider.connection !== 'connected' || provider.configured !== true) {
        return reply.code(409).send({
          error: 'telegram_not_connected',
          message: PUBLIC_MESSAGES.telegram_not_connected,
        });
      }
      if (normalizeTelegramBotId(lease.context.botId) !== expectedBotId) throw accountChanged();

      let liveBotId: string | null = null;

      try {
        liveBotId = normalizeTelegramBotId((provider.bot as Payload | undefined)?.botId);
      } catch { /* stale projection */ }
      if (liveBotId !== expectedBotId) throw accountChanged();
      const wanted = body.chatId;
      if (wanted === null || wanted === '') {
        await checked(lease, (context) => context.botSettings.setServiceChatId(null));
        return { ok: true, bot: await viewFromLease(lease) };
      }
      const id = Number(wanted);
      const chats = await checked(lease, (context) => context.archive.chats());
      const chat = chats.find((candidate) => candidate.id === id);
      if (!Number.isSafeInteger(id) || id <= 0 || !chat || chat.type !== 'private') {
        return reply.code(400).send({
          error: 'bad_service_chat',
          message: 'Служебным может быть только уже услышанная личка с ботом.',
        });
      }
      await checked(lease, (context) => context.botSettings.setServiceChatId(id));
      return { ok: true, bot: await viewFromLease(lease) };
    } finally { await lease.release(); }
  }));

  // Запрос кода: проверка «бот слышал эту личку» → отправка кода в неё.
  // Порядок жёсткий, как у connect: непроверенное не сохраняется — pending
  // появляется только ПОСЛЕ успешной отправки.
  fastify.post('/api/telegram/pult', run(async (request, reply) => (
    withCasLease(request, reply, ['botId', 'chatId'], async ({ lease, body }) => {
      const id = Number(body.chatId);
      const chats = await checked(lease, (context) => context.archive.chats());
      const chat = Number.isSafeInteger(id) ? chats.find((candidate) => candidate.id === id) : null;
      if (!chat) {
        return reply.code(400).send({
          error: 'pult_chat_unknown',
          message: 'Эта личка боту не знакома: сначала напиши боту что-нибудь (хотя бы /start).',
        });
      }
      if (chat.type !== 'private' || id <= 0) {
        return reply.code(400).send({
          error: 'pult_not_private',
          message: 'Пультом может быть только личка: в группе карточки увидят все участники.',
        });
      }
      const token = lease.context.credentials?.token || '';
      if (!token) {
        return reply.code(409).send({
          error: 'telegram_not_connected',
          message: PUBLIC_MESSAGES.telegram_not_connected,
        });
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await checked(lease, (context) => callWithLease(context, token, 'sendMessage', {
        chat_id: id,
        text: `Код пульта GrigDesk: ${code}\nВведи его в карточке «Пульт». Код действует 10 минут; `
          + 'если запрашивал не ты — не вводи его и проверь, кто открыл GrigDesk.',
      }, { timeoutMs: 15_000 }));
      pultPending.set(String(lease.accountRef), {
        botId: normalizeTelegramBotId(lease.context.botId),
        chatId: id,
        code,
        expiresAtMs: now() + PULT_CODE_TTL_MS,
        attempts: 0,
      });
      return { ok: true, pult: await pultViewFromLease(lease) };
    })
  )));

  fastify.post('/api/telegram/pult/confirm', run(async (request, reply) => (
    withCasLease(request, reply, ['botId', 'code'], async ({ lease, body }) => {
      const pending = pultPendingAlive(lease);
      if (!pending) {
        return reply.code(400).send({
          error: 'pult_code_expired',
          message: 'Код не действует — запроси новый в карточке «Пульт».',
        });
      }
      if (String(body.code ?? '').trim() !== pending.code) {
        pending.attempts += 1;
        // Пятая неверная попытка аннулирует код: перебор из авторизованного UI
        // бессмысленен, но дешёвый предохранитель не обязан это обсуждать.
        if (pending.attempts >= PULT_CODE_ATTEMPTS) pultPending.delete(lease.accountRef);
        return reply.code(400).send({ error: 'pult_code_mismatch', message: 'Код не совпал.' });
      }
      pultPending.delete(lease.accountRef);
      // Личка: chat.id и есть id собеседника, поэтому владелец — та же цифра.
      await checked(lease, (context) => context.botSettings.setPult({
        chatId: pending.chatId,
        userId: pending.chatId,
        confirmedAtMs: now(),
      }));
      // Доступ уже записан durable — теперь команды и постоянная клавиатура,
      // и только в этой личке: scope chat, default-scope не трогаем.
      const confirmToken = lease.context.credentials?.token || '';
      await checked(lease, (context) => callWithLease(context, confirmToken, 'setMyCommands', {
        scope: { type: 'chat', chat_id: pending.chatId },
        commands: PULT_COMMANDS,
      }, { timeoutMs: 15_000 }));
      await checked(lease, (context) => callWithLease(context, confirmToken, 'sendMessage', {
        chat_id: pending.chatId,
        text: 'Пульт включён. Разделы всегда под рукой на клавиатуре внизу; /help — что умеет пульт.',
        reply_markup: pultReplyKeyboard(),
      }, { timeoutMs: 15_000 }));
      pultLastCode.set(String(lease.accountRef), pending.code);
      return { ok: true, pult: await pultViewFromLease(lease) };
    })
  )));

  fastify.post('/api/telegram/pult/disable', run(async (request, reply) => (
    withCasLease(request, reply, ['botId'], async ({ lease }) => {
      pultPending.delete(String(lease.accountRef));

      const settings = await checked(lease, (context) => context.botSettings.read());
      // Выбор чата остаётся в namespace бота (правило служебного чата), гаснет
      // только подтверждение: повторное включение требует нового кода.
      await checked(lease, (context) => context.botSettings.setPult({
        chatId: settings.pultChatId ?? null,
        userId: settings.pultUserId ?? null,
        confirmedAtMs: null,
      }));
      // Доступ уже закрыт локально — теперь чистка в Bot API тем же scope чата.
      // Личка сохранена в namespace бота, поэтому повторный disable безопасно
      // повторяет очистку; без настроенной лички чистить нечего.
      if (settings.pultChatId != null) {
        const disableToken = lease.context.credentials?.token || '';
        await checked(lease, (context) => callWithLease(context, disableToken, 'deleteMyCommands', {
          scope: { type: 'chat', chat_id: settings.pultChatId },
        }, { timeoutMs: 15_000 }));
        const lastCode = pultLastCode.get(String(lease.accountRef));

        await checked(lease, (context) => callWithLease(context, disableToken, 'sendMessage', {
          chat_id: settings.pultChatId,
          text: 'Пульт выключен, клавиатура убрана.'
            + `${lastCode ? ` Код ${lastCode} погашен.` : ''}`
            + ' Для нового включения запроси код в GrigDesk.',
          reply_markup: { remove_keyboard: true },
        }, { timeoutMs: 15_000 }));
      }
      return { ok: true, pult: await pultViewFromLease(lease) };
    })
  )));

  async function discussionOf(text: unknown, { project = null, limits }: {
    project?: string | null;
    limits?: Payload;
  } = {}) {
    const source = String(text ?? '');
    if (!parseTelegramLinks(source).length) return EMPTY();
    const lease = await acquire();
    try {
      const result = await checked(lease, async (context) => {
        const [rules, settings] = await Promise.all([
          context.rules.read(),
          context.botSettings.read(),
        ]);
        const credential = context.credentials;
        const call = credential
          ? async (method: string, body: Payload) => {
            if (!lease.isCurrent() || !await providerConnected()) throw accountChanged();

            const value = await callWithLease(context, String(credential.token), method, body);

            if (!lease.isCurrent() || !await providerConnected()) throw accountChanged();

            return value;
          }
          : null;

        return resolveText(source, {
          archive: context.archive as unknown as ResolveArchive,
          rules,
          project,
          call,
          serviceChatId: settings.serviceChatId as number | string | null,
          log: fastify.log,
        });
      });
      return buildDiscussion(result, limits || {});
    } finally { await lease.release(); }
  }

  fastify.decorate('telegramDiscussion', async (text: unknown, options: Payload = {}) => {
    if (!enabled()) return EMPTY();

    try {
      return await discussionOf(text, options);
    } catch (error) {
      fastify.log.warn({ code: errorCode(error) }, 'telegram: разворот ссылок не удался');

      return EMPTY();
    }
  });

  fastify.post('/api/telegram/expand', run(async (request, reply) => {
    const body = exactBody(request.body, ['text']) || exactBody(request.body, ['project', 'text']);
    if (!body) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Ожидались text и необязательный project.',
      });
    }

    return discussionOf(body.text, { project: body.project as string | null });
  }));
}

export default fp(telegramModule, { name: 'module-telegram' });
