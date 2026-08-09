// Native control-plane Telegram: provider lifecycle, account-scoped archive/rules,
// service chat и безопасный разворот t.me-ссылок. Общая очередь, decisions, B24 и
// worker принадлежат module-inbox и здесь намеренно отсутствуют.
import fp from 'fastify-plugin';

import * as realBotApi from '../../lib/telegram/api.js';
import { normalizeTelegramBotId } from '../../lib/telegram/account-bindings.js';
import { scrubToken } from '../../lib/telegram/api.js';
import { buildDiscussion } from '../../lib/telegram/discussion.js';
import { isBotTokenShape, maskToken } from '../../lib/telegram/token.js';
import { parseTelegramLinks } from '../../lib/telegram/links.js';
import { resolveText } from '../../lib/telegram/resolve.js';

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
  telegram_failed: 'Операция Telegram временно не выполнена.',
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactBody(value, keys) {
  const body = value ?? {};
  if (!isPlainObject(body)) return null;
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

function publicFailure(reply, error, token = '') {
  const explicitCode = typeof error?.code === 'string'
    && Object.hasOwn(PUBLIC_MESSAGES, error.code)
    ? error.code
    : null;
  let code = explicitCode || 'telegram_failed';
  let status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (explicitCode === null) {
    if (error?.kind === 'transport') {
      code = 'telegram_unreachable';
      status = 502;
    } else if (error?.kind === 'telegram') {
      code = 'telegram_rejected';
      status = 400;
    } else {
      code = 'telegram_failed';
    }
  }
  if (status < 400 || status > 599) status = 500;
  const safeProviderWhy = scrubToken(error?.message || '', token);
  const message = code === 'telegram_unreachable' && safeProviderWhy
    ? `${PUBLIC_MESSAGES[code]} ${safeProviderWhy}`
    : PUBLIC_MESSAGES[code];
  return reply.code(status).send({ error: code, message });
}

async function telegramModule(fastify, opts) {
  const {
    connection,
    poller = null,
    botApi = realBotApi,
    listProjects = async () => [],
  } = opts;
  if (!connection || typeof connection.status !== 'function'
      || typeof connection.connect !== 'function'
      || typeof connection.recheck !== 'function'
      || typeof connection.disconnect !== 'function'
      || typeof connection.acquireLease !== 'function') {
    throw new Error('module-telegram: account-aware connection обязателен');
  }
  if (!botApi || typeof botApi.callBotApi !== 'function' || typeof listProjects !== 'function') {
    throw new Error('module-telegram: botApi/listProjects имеют неверный contract');
  }

  const enabled = () => fastify.pluginEnabled('telegram');
  const gate = (reply) => (enabled() ? null : reply.code(404).send({
    error: 'plugin_disabled',
    message: 'Плагин «Телеграм» выключен.',
  }));
  const changed = (status) => {
    try {
      const result = fastify.sse?.broadcast?.('inbox-changed', {
        itemRef: null, channel: 'telegram', status, taskId: null,
      });
      Promise.resolve(result).catch(() => {});
    } catch { /* durable mutation уже завершена */ }
  };

  const run = (operation) => async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (gate(reply)) return reply;
    try {
      return await operation(request, reply);
    } catch (error) {
      request.log?.error?.({ code: error?.code }, 'telegram: native operation failed');
      return publicFailure(reply, error);
    }
  };

  async function providerConnected() {
    const state = await connection.status();
    return state.connection === 'connected' && state.configured === true;
  }

  async function acquire() {
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

  async function acquireWritable(reply) {
    try {
      return await acquire();
    } catch (error) {
      if (error?.code === 'account_draining') throw accountChanged();
      if (error?.code !== 'channel_disconnected') throw error;
      reply.code(409).send({
        error: 'telegram_not_connected',
        message: PUBLIC_MESSAGES.telegram_not_connected,
      });
      return null;
    }
  }

  async function checked(lease, operation) {
    if (!lease.isCurrent()) throw accountChanged();
    const result = await operation(lease.context);
    if (!lease.isCurrent()) throw accountChanged();
    return result;
  }

  const privacyHint = (bot) => (bot.canReadAllGroupMessages
    ? ''
    : 'В группах бот сейчас видит только сообщения, адресованные ему. Чтобы он читал '
      + 'обсуждение целиком, выключи режим приватности: @BotFather → /setprivacy → бот → Disable.');

  async function viewFromLease(lease, knownStatus = null) {
    const status = knownStatus || await checked(lease, () => connection.status());
    let statusBotId = null;
    try { statusBotId = normalizeTelegramBotId(status.bot?.botId); } catch { /* no selected owner */ }
    if (statusBotId === null) {
      return {
        ...status.bot,
        serviceChatTitle: '',
        privacyHint: status.bot?.configured ? privacyHint(status.bot) : '',
      };
    }
    if (statusBotId !== normalizeTelegramBotId(lease.context.botId)) throw accountChanged();
    const settings = await checked(lease, (context) => context.botSettings.read());
    let serviceChatTitle = '';
    if (settings.serviceChatId) {
      const chats = await checked(lease, (context) => context.archive.chats());
      serviceChatTitle = chats.find((chat) => chat.id === settings.serviceChatId)?.title || '';
    }
    const bot = {
      ...status.bot,
      serviceChatId: settings.serviceChatId,
      serviceChatTitle,
    };
    return { ...bot, privacyHint: bot.configured ? privacyHint(bot) : '' };
  }

  async function viewSnapshot() {
    let lease;
    try {
      lease = await acquire();
      const status = await checked(lease, () => connection.status());
      return { status, bot: await viewFromLease(lease, status) };
    } catch (error) {
      if (error?.code !== 'channel_disconnected') throw error;
      const status = await connection.status();
      const bot = {
        ...status.bot,
        serviceChatTitle: '',
        privacyHint: status.bot?.configured ? privacyHint(status.bot) : '',
      };
      return { status, bot };
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
    const chatId = Number(request.params?.chatId);
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
      const rules = await checked(lease, (context) => context.rules.read());
      const projects = await listProjects();
      if (!lease.isCurrent()) throw accountChanged();
      return { rules, projects };
    } finally { await lease.release(); }
  }));

  fastify.put('/api/telegram/rules', run(async (request, reply) => {
    const body = exactBody(request.body, ['botId', 'rules']);
    let expectedBotId = null;
    try { expectedBotId = normalizeTelegramBotId(body?.botId); } catch { /* invalid client CAS */ }
    if (!body || expectedBotId === null) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Ожидались ровно canonical botId и rules.',
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
      let liveBotId = null;
      try { liveBotId = normalizeTelegramBotId(provider.bot?.botId); } catch { /* stale projection */ }
      if (liveBotId !== expectedBotId) throw accountChanged();
      const projects = await listProjects();
      if (!lease.isCurrent()) throw accountChanged();
      const rules = await checked(lease, (context) => context.rules.write(body.rules, { projects }));
      changed('rules');
      return { ok: true, rules };
    } catch (error) {
      if (!error?.code && error instanceof Error) {
        error.code = 'telegram_rules_invalid';
        error.statusCode = 400;
      }
      throw error;
    } finally { await lease.release(); }
  }));

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
      request.log?.warn?.({ token: maskToken(token), code: error?.code }, 'telegram: connect rejected');
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
      let liveBotId = null;
      try { liveBotId = normalizeTelegramBotId(provider.bot?.botId); } catch { /* stale projection */ }
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

  async function discussionOf(text, { project = null, limits } = {}) {
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
        const call = credential ? async (method, body) => {
          if (!lease.isCurrent() || !await providerConnected()) throw accountChanged();
          const value = await (context.botApi || botApi).callBotApi(credential.token, method, body);
          if (!lease.isCurrent() || !await providerConnected()) throw accountChanged();
          return value;
        } : null;
        return resolveText(source, {
          archive: context.archive,
          rules,
          project,
          call,
          serviceChatId: settings.serviceChatId,
          log: fastify.log,
        });
      });
      return buildDiscussion(result, limits || {});
    } finally { await lease.release(); }
  }

  fastify.decorate('telegramDiscussion', async (text, options = {}) => {
    if (!enabled()) return EMPTY();
    try { return await discussionOf(text, options); } catch (error) {
      fastify.log.warn({ code: error?.code }, 'telegram: разворот ссылок не удался');
      return EMPTY();
    }
  });

  fastify.post('/api/telegram/expand', run(async (request, reply) => {
    const body = exactBody(request.body, ['text']) || exactBody(request.body, ['project', 'text']);
    if (!body) return reply.code(400).send({ error: 'invalid_request', message: 'Ожидались text и необязательный project.' });
    return discussionOf(body.text, { project: body.project });
  }));
}

export default fp(telegramModule, { name: 'module-telegram' });
