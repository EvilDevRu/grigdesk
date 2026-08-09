// Provider lifecycle account-aware Telegram.
//
// Connect/disconnect не являются Inbox activation. Connect проверяет getMe и
// связывает immutable bot.id со случайным accountRef; disconnect останавливает
// ingress, закрывает текущую activation epoch, стирает только active credential
// и переустанавливает тот же namespace offline для read-only истории.
import { AccountRuntimeManager } from '../account-runtime.js';
import * as realBotApi from './api.js';
import { isBotTokenShape, maskToken } from './token.js';
import {
  botIdFromIdentity,
  normalizeTelegramBotId,
  telegramBotIdentity,
} from './account-bindings.js';

const CONNECTIONS = new Set([
  'disconnected', 'connecting', 'connected', 'disconnecting', 'switching', 'degraded',
]);

export class TelegramConnectionError extends Error {
  constructor(code, message, statusCode = 400, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramConnectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode = 400, cause = null) => {
  throw new TelegramConnectionError(code, message, statusCode, cause);
};

function tokenOf(value) {
  const token = String(value ?? '').trim();
  if (!isBotTokenShape(token) || token.length > 16 * 1024 || /[\0\r\n\s]/u.test(token)) {
    fail('telegram_bad_token', 'Telegram token имеет неверный формат.', 400);
  }
  return token;
}

function verifiedBot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('telegram_identity_invalid', 'Telegram getMe вернул неверный bot.', 502);
  }
  return {
    botId: normalizeTelegramBotId(value.id, 'getMe.id'),
    username: typeof value.username === 'string' ? value.username : '',
    canReadAllGroupMessages: Boolean(value.canReadAllGroupMessages),
  };
}

function safeReason(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/u.test(value) ? value : null;
}

function botSettingsView(value, fallbackBotId = null) {
  const settings = value && typeof value === 'object' ? value : {};
  const rawId = settings.botId ?? fallbackBotId;
  let botId = null;
  try { botId = rawId === null ? null : Number(normalizeTelegramBotId(rawId)); } catch { botId = null; }
  return {
    username: typeof settings.username === 'string' ? settings.username : '',
    botId,
    canReadAllGroupMessages: typeof settings.canReadAllGroupMessages === 'boolean'
      ? settings.canReadAllGroupMessages
      : null,
    connectedAt: Number.isSafeInteger(settings.connectedAtMs) ? settings.connectedAtMs : null,
    serviceChatId: Number.isSafeInteger(settings.serviceChatId) ? settings.serviceChatId : null,
  };
}

/**
 * accountContextFor({accountRef,botId,credentialLease}) возвращает immutable raw
 * context: archive/rules/botSettings/pollState/inboxState/createActivationMarker.
 */
export class TelegramConnection {
  constructor({
    credentials,
    bindings,
    accountContextFor,
    runtime = new AccountRuntimeManager({ channel: 'telegram' }),
    poller = null,
    botApi = realBotApi,
    enabled = () => true,
    now = Date.now,
    onChanged = () => {},
    log = console,
  } = {}) {
    if (!credentials || typeof credentials.read !== 'function'
        || typeof credentials.write !== 'function' || typeof credentials.clear !== 'function'
        || !bindings || typeof bindings.read !== 'function'
        || typeof bindings.selected !== 'function' || typeof bindings.select !== 'function'
        || typeof bindings.byAccountRef !== 'function'
        || typeof bindings.resolveOrCreate !== 'function'
        || typeof accountContextFor !== 'function') {
      fail('telegram_connection_config', 'TelegramConnection требует stores/context factory.', 500);
    }
    if (!runtime || typeof runtime.install !== 'function' || typeof runtime.acquire !== 'function'
        || typeof runtime.drain !== 'function') {
      fail('telegram_connection_config', 'TelegramConnection требует account runtime.', 500);
    }
    if (poller !== null && (typeof poller.start !== 'function' || typeof poller.stop !== 'function')) {
      fail('telegram_connection_config', 'TelegramConnection получил неверный poller.', 500);
    }
    if (!botApi || typeof botApi.getMe !== 'function' || typeof enabled !== 'function'
        || typeof now !== 'function'
        || typeof onChanged !== 'function') {
      fail('telegram_connection_config', 'TelegramConnection получил неверные callbacks.', 500);
    }
    this.credentials = credentials;
    this.bindings = bindings;
    this.accountContextFor = accountContextFor;
    this.runtime = runtime;
    this.poller = poller;
    this.botApi = botApi;
    this.enabled = enabled;
    this.now = now;
    this.onChanged = onChanged;
    this.log = log;
    this.connection = 'disconnected';
    this.reason = null;
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  attachPoller(poller) {
    if (this.poller !== null || !poller
        || typeof poller.start !== 'function' || typeof poller.stop !== 'function') {
      fail('telegram_connection_config', 'Telegram poller уже назначен или невалиден.', 500);
    }
    this.poller = poller;
  }

  _serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  _setConnection(connection, reason = null) {
    if (!CONNECTIONS.has(connection)) fail('telegram_connection_state', 'Unknown Telegram connection state.', 500);
    this.connection = connection;
    this.reason = safeReason(reason);
  }

  _notify(payload) {
    try {
      const result = this.onChanged(payload);
      Promise.resolve(result).catch((error) => {
        this.log.warn?.({ code: error?.code }, 'telegram: lifecycle commit выполнен, но SSE не отправлен');
      });
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram: lifecycle commit выполнен, но SSE не отправлен');
    }
  }

  async _requireEnabled() {
    if (!await this.enabled()) fail('telegram_plugin_disabled', 'Плагин Telegram выключен.', 404);
  }

  async _bindingForCredentials(saved) {
    if (!saved) return null;
    const binding = await this.bindings.byAccountRef(saved.accountRef);
    if (!binding || botIdFromIdentity(binding.providerIdentity) !== saved.botId) {
      fail('telegram_binding_invalid', 'Telegram credential не совпадает с account binding.', 503);
    }
    const selected = await this.bindings.selected();
    if (!selected || selected.accountRef !== binding.accountRef) {
      fail('telegram_binding_invalid', 'Активный Telegram credential не совпадает с selected account.', 503);
    }
    return binding;
  }

  async _contextFor(binding, credential = null) {
    const botId = botIdFromIdentity(binding.providerIdentity);
    const credentialLease = credential === null ? null : Object.freeze({
      accountRef: credential.accountRef,
      botId: credential.botId,
      token: credential.token,
    });
    const context = await this.accountContextFor({
      accountRef: binding.accountRef,
      botId,
      credentialLease,
    });
    if (!context || typeof context !== 'object'
        || !context.archive || !context.rules || !context.botSettings
        || !context.pollState || !context.inboxState
        || typeof context.createActivationMarker !== 'function') {
      fail('telegram_connection_config', 'Telegram account context incomplete.', 500);
    }
    return context;
  }

  async _install(binding, credential = null, reason = 'telegram_lifecycle') {
    const context = await this._contextFor(binding, credential);
    await this.runtime.install({ accountRef: binding.accountRef, context, reason });
    return context;
  }

  async _installSelectedOffline(reason = 'offline_selected_account') {
    const selected = await this.bindings.selected();
    if (!selected) {
      await this.runtime.drain({ reason: 'no_selected_account' });
      return null;
    }
    return this._install(selected, null, reason);
  }

  /**
   * После любой неоднозначной durable publication runtime разрешается заново
   * только из disk truth. Это не rollback: selected/settings/credential могли
   * уже пережить crash, поэтому догадка о «предыдущем» owner была бы опаснее.
   */
  async _reconcileDurableRuntime(reason = 'telegram_lifecycle_recovery') {
    const saved = await this.credentials.read();
    if (saved) {
      const binding = await this._bindingForCredentials(saved);
      return this._install(binding, saved, reason);
    }
    return this._installSelectedOffline(reason);
  }

  async initialize() {
    return this._serialize(async () => {
      if (this.initialized) return this.status();
      try {
        const saved = await this.credentials.read();
        if (saved) {
          const binding = await this._bindingForCredentials(saved);
          await this._install(binding, saved, 'startup');
          this._setConnection('connected');
        } else {
          await this._installSelectedOffline();
          this._setConnection('disconnected');
        }
      } catch (error) {
        await this.runtime.drain({ reason: 'invalid_startup_state' }).catch(() => {});
        this._setConnection('degraded', error?.code || 'invalid_state');
        this.log.error?.({ code: error?.code }, 'telegram: startup state fail-closed');
      }
      this.initialized = true;
      return this.status();
    });
  }

  async status() {
    let publicCredential;
    try { publicCredential = await this.credentials.publicView(); } catch (error) {
      return {
        configured: false,
        connection: 'degraded',
        reason: safeReason(error?.code) || 'invalid_state',
        bot: {
          configured: false, username: '', botId: null, tokenHint: '',
          canReadAllGroupMessages: null, connectedAt: null, serviceChatId: null,
        },
      };
    }

    let settings = {};
    const snapshot = this.runtime.snapshot();
    if (snapshot?.context?.botSettings?.read) {
      try { settings = await snapshot.context.botSettings.read(); } catch (error) {
        return {
          configured: publicCredential.configured,
          connection: 'degraded',
          reason: safeReason(error?.code) || 'invalid_state',
          bot: {
            configured: publicCredential.configured,
            ...botSettingsView({}, publicCredential.botId),
            tokenHint: publicCredential.tokenHint || '',
          },
        };
      }
    }
    return {
      configured: publicCredential.configured,
      connection: this.connection,
      reason: this.reason,
      bot: {
        configured: publicCredential.configured,
        ...botSettingsView(settings, publicCredential.botId),
        tokenHint: publicCredential.tokenHint || '',
      },
    };
  }

  /** Offline selected namespace тоже выдаёт lease для read-only Inbox/native GET. */
  acquireLease() {
    return this.runtime.acquire();
  }

  _assertLeaseOwner(saved, lease) {
    if (!lease || lease.accountRef !== saved.accountRef
        || normalizeTelegramBotId(lease.context?.botId) !== saved.botId
        || !lease.isCurrent()) {
      fail('telegram_account_changed', 'Telegram account generation изменилась.', 409);
    }
  }

  async connect({ token } = {}) {
    const trustedToken = tokenOf(token);
    await this._requireEnabled();
    return this._serialize(async () => {
      await this._requireEnabled();
      const existing = await this.credentials.read();
      if (existing) fail('telegram_already_configured', 'Telegram bot уже подключён.', 409);
      const registry = await this.bindings.read();

      this._setConnection(registry.selectedAccountRef ? 'switching' : 'connecting');
      let switchStarted = false;
      let verified;
      try {
        verified = verifiedBot(await this.botApi.getMe(trustedToken));
        // Binding можно безопасно оставить orphan и reuse после crash, но current
        // pointer публикуется только после owner metadata.
        const resolved = await this.bindings.resolveOrCreate(
          telegramBotIdentity(verified.botId),
          { select: false },
        );
        const connectedAtMs = this.now();
        if (!Number.isSafeInteger(connectedAtMs) || connectedAtMs <= 0) {
          fail('telegram_connection_state', 'Connection clock вернул неверное время.', 500);
        }
        const candidate = {
          accountRef: resolved.binding.accountRef,
          botId: verified.botId,
          token: trustedToken,
          connectedAtMs,
        };
        const context = await this._contextFor(resolved.binding, candidate);
        await context.botSettings.setBot({
          username: verified.username,
          canReadAllGroupMessages: verified.canReadAllGroupMessages,
          connectedAtMs,
        });

        // Нельзя менять selected, пока старый poller/leases ещё способны
        // публиковать результат. stop ждёт long poll, drain немедленно запрещает
        // новые leases и ждёт уже выданные; только затем меняется disk truth.
        await this.poller?.stop();
        switchStarted = true;
        await this.runtime.drain({ reason: 'provider_switch' });
        await this.bindings.select(resolved.binding.accountRef);
        await this.credentials.write(candidate);
        await this.runtime.install({
          accountRef: resolved.binding.accountRef,
          context,
          reason: 'provider_connect',
        });
        this._setConnection('connected');
        this.poller?.start();
        this._notify({ itemRef: null, channel: 'telegram', status: 'provider_connected', taskId: null });
        return this.status();
      } catch (error) {
        if (switchStarted) {
          // select/credential writes атомарны, но ошибка fsync может прийти уже
          // после rename. Перечитываем durable пару и не оставляем старый runtime
          // под новым selected pointer. Poller при failed connect не запускается.
          await this.poller?.stop().catch(() => {});
          try {
            await this._reconcileDurableRuntime('connect_failed');
          } catch (recoveryError) {
            await this.runtime.drain({ reason: 'connect_recovery_failed' }).catch(() => {});
            this.log.error?.(
              { code: recoveryError?.code },
              'telegram: durable state после connect не удалось переустановить',
            );
          }
        }
        this._setConnection('degraded', error?.code || 'provider_failure');
        this.log.warn?.({ token: maskToken(trustedToken), code: error?.code }, 'telegram: connect failed');
        throw error;
      }
    });
  }

  async recheck() {
    await this._requireEnabled();
    return this._serialize(async () => {
      await this._requireEnabled();
      const saved = await this.credentials.read();
      if (!saved) fail('telegram_not_connected', 'Telegram bot ещё не подключён.', 409);
      const lease = this.runtime.acquire();
      try {
        this._assertLeaseOwner(saved, lease);
        const verified = verifiedBot(await this.botApi.getMe(saved.token));
        if (verified.botId !== saved.botId) {
          fail('telegram_account_changed', 'Telegram token теперь принадлежит другому bot.', 409);
        }
        this._assertLeaseOwner(saved, lease);
        await lease.context.botSettings.setBot({
          username: verified.username,
          canReadAllGroupMessages: verified.canReadAllGroupMessages,
          connectedAtMs: saved.connectedAtMs,
        });
        this._assertLeaseOwner(saved, lease);
        await this.credentials.write({
          accountRef: saved.accountRef,
          botId: saved.botId,
          token: saved.token,
          connectedAtMs: saved.connectedAtMs,
        });
        this._assertLeaseOwner(saved, lease);
        this._setConnection('connected');
        this.poller?.start();
        return this.status();
      } catch (error) {
        this._setConnection('degraded', error?.code || 'provider_failure');
        throw error;
      } finally {
        lease.release();
      }
    });
  }

  async _closeActivation(context, reason) {
    const activation = await context.inboxState.summary();
    if (activation.participation !== 'active') return activation;
    return context.inboxState.deactivate({
      expectedActivationVersion: activation.activationVersion,
      endReason: reason,
      nowMs: this.now(),
      createActivationMarker: context.createActivationMarker,
    });
  }

  async _restore(binding, credential, reason) {
    if (!binding) return this._installSelectedOffline(reason);
    return this._install(binding, credential, reason);
  }

  async disconnect() {
    await this._requireEnabled();
    return this._serialize(async () => {
      await this._requireEnabled();
      const saved = await this.credentials.read();
      if (!saved) {
        await this.poller?.stop();
        await this._installSelectedOffline('idempotent_disconnect');
        this._setConnection('disconnected');
        return this.status();
      }
      const binding = await this._bindingForCredentials(saved);
      this._setConnection('disconnecting');
      let drained = null;
      let cleared = false;
      try {
        // stop() ждёт long poll: после него ни append, ни offset commit уже не
        // конкурируют с end marker. drain отзывает новые native/Inbox leases.
        await this.poller?.stop();
        drained = await this.runtime.drain({ reason: 'provider_disconnect' });
        if (!drained || drained.accountRef !== saved.accountRef) {
          fail('telegram_account_changed', 'Telegram runtime изменился во время disconnect.', 409);
        }
        await this._closeActivation(drained.context, 'provider_disconnect');
        await this.credentials.clear();
        cleared = true;
        await this._restore(binding, null, 'offline_after_disconnect');
        this._setConnection('disconnected');
        this._notify({ itemRef: null, channel: 'telegram', status: 'provider_disconnected', taskId: null });
        return this.status();
      } catch (error) {
        await this._restore(binding, cleared ? null : saved, 'disconnect_failed').catch((restoreError) => {
          this.log.error?.({ code: restoreError?.code }, 'telegram: context restore after disconnect failed');
        });
        this._setConnection('degraded', error?.code || 'invalid_state');
        throw error;
      }
    });
  }
}
