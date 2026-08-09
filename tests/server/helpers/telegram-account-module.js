// Test adapter for module-telegram's account-aware dependency boundary.
// Native archive/rules fixtures remain real; lifecycle/runtime internals are
// exercised separately by telegram-connection/account-runtime tests.
import { maskToken } from '../../../server/src/lib/telegram/token.js';

const ACCOUNT_REF = 'acc_telegram_module_fixture_0001';

// Синхронный memory-double для HTTP-тестов module-telegram. Durable strict
// credential отдельно покрыт telegram-account-credentials.test.js.
export class TelegramModuleCredentials {
  constructor() {
    this.value = null;
  }

  read() {
    return this.value ? structuredClone(this.value) : null;
  }

  has() {
    return this.value !== null;
  }

  write({ token, bot = {}, connectedAt, serviceChatId = null } = {}) {
    this.value = {
      token: String(token || ''),
      botId: (bot.id ?? Number(String(token || '').split(':', 1)[0])) || null,
      username: String(bot.username || ''),
      canReadAllGroupMessages: bot.canReadAllGroupMessages ?? null,
      connectedAt: Number(connectedAt) || Date.now(),
      serviceChatId: Number(serviceChatId) || null,
    };
    return this.publicView();
  }

  clear() {
    this.value = null;
  }

  publicView() {
    const value = this.read();
    return value ? {
      configured: true,
      username: value.username,
      botId: value.botId,
      tokenHint: maskToken(value.token),
      canReadAllGroupMessages: value.canReadAllGroupMessages,
      connectedAt: value.connectedAt,
      serviceChatId: value.serviceChatId,
    } : {
      configured: false,
      username: '',
      botId: null,
      tokenHint: '',
      canReadAllGroupMessages: null,
      connectedAt: null,
      serviceChatId: null,
    };
  }
}

function coded(code, message, statusCode = 409, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...extra });
}

export function telegramModuleConnection({
  creds,
  archive,
  rules,
  botApi,
  poller = null,
  initiallyConnected = creds?.has?.() === true,
} = {}) {
  if (!archive || !rules || !botApi || typeof botApi.getMe !== 'function') {
    throw new TypeError('telegramModuleConnection требует archive/rules/botApi.getMe.');
  }
  let connection = initiallyConnected ? 'connected' : 'disconnected';
  let generation = 1;
  let username = creds?.read?.()?.username || '';
  let botId = creds?.read?.()?.botId || null;
  let canReadAllGroupMessages = creds?.read?.()?.canReadAllGroupMessages ?? null;
  let connectedAt = creds?.read?.()?.connectedAt || null;
  let serviceChatId = creds?.read?.()?.serviceChatId || null;

  const saved = () => creds?.read?.() || null;
  const botView = () => ({
    configured: connection === 'connected' && saved() !== null,
    username,
    botId,
    tokenHint: connection === 'connected' ? maskToken(saved()?.token || '') : '',
    canReadAllGroupMessages,
    connectedAt,
    serviceChatId,
  });
  const context = () => ({
    botId: botId === null ? '' : String(botId),
    archive,
    rules,
    botSettings: {
      read: async () => ({
        botId,
        username,
        canReadAllGroupMessages,
        connectedAtMs: connectedAt,
        serviceChatId,
      }),
      setBot: async (next) => {
        username = next.username;
        canReadAllGroupMessages = next.canReadAllGroupMessages;
        connectedAt = next.connectedAtMs;
      },
      setServiceChatId: async (next) => { serviceChatId = next; },
    },
    pollState: { read: async () => null, write: async () => {} },
    inboxState: {},
    credentials: connection === 'connected' && saved()
      ? Object.freeze({ botId: String(botId), token: saved().token })
      : null,
    botApi,
    createActivationMarker: async () => ({ schema: 1, afterSeq: 0, afterOccurredAt: 0 }),
  });

  return {
    async status() {
      return { configured: botView().configured, connection, reason: null, bot: botView() };
    },
    async connect({ token } = {}) {
      if (connection === 'connected' && saved()) {
        throw coded('telegram_already_configured', 'already configured');
      }
      let me;
      try { me = await botApi.getMe(token); } catch (error) { throw error; }
      botId = Number(me.id);
      username = String(me.username || '');
      canReadAllGroupMessages = Boolean(me.canReadAllGroupMessages);
      connectedAt = Date.now();
      creds?.write?.({ token, bot: me, connectedAt, serviceChatId });
      connection = 'connected';
      generation += 1;
      poller?.start?.();
      return this.status();
    },
    async recheck() {
      const current = saved();
      if (!current || connection !== 'connected') {
        throw coded('telegram_not_connected', 'not connected');
      }
      const me = await botApi.getMe(current.token);
      if (Number(me.id) !== Number(botId)) {
        throw coded('telegram_account_changed', 'identity changed');
      }
      username = String(me.username || '');
      canReadAllGroupMessages = Boolean(me.canReadAllGroupMessages);
      creds?.write?.({ token: current.token, bot: me, connectedAt, serviceChatId });
      poller?.start?.();
      return this.status();
    },
    async disconnect() {
      await poller?.stop?.();
      creds?.clear?.();
      connection = 'disconnected';
      generation += 1;
      return this.status();
    },
    acquireLease() {
      const ownGeneration = generation;
      return {
        accountRef: ACCOUNT_REF,
        generation: ownGeneration,
        context: context(),
        isCurrent: () => ownGeneration === generation,
        release() {},
      };
    },
  };
}

export default telegramModuleConnection;
