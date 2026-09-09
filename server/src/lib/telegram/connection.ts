// Provider lifecycle account-aware Telegram.
//
// Connect/disconnect не являются Inbox activation. Connect проверяет getMe и
// связывает immutable bot.id со случайным accountRef; disconnect останавливает
// ingress, закрывает текущую activation epoch, стирает только active credential
// и переустанавливает тот же namespace offline для read-only истории.
import { AccountRuntimeManager } from '../account-runtime.js';
import * as realBotApi from './api.ts';
import { isBotTokenShape, maskToken } from './token.ts';
import {
  botIdFromIdentity,
  normalizeTelegramBotId,
  telegramBotIdentity,
} from './accountBindings.ts';

type Payload = Record<string, unknown>;

// Соседи lifecycle объявлены ровно тем, что он зовёт: сам он ни поллером, ни
// хранилищами не владеет и знает о них только их контракт.
interface CredentialsPort {
  read: () => Promise<Payload | null>;
  write: (value: Payload) => Promise<Payload>;
  clear: () => Promise<boolean>;
  publicView: () => Promise<Payload>;
}

interface BindingsPort {
  read: () => Promise<Payload>;
  selected: () => Promise<Payload | null>;
  select: (accountRef: unknown) => Promise<Payload>;
  byAccountRef: (accountRef: unknown) => Promise<Payload | null>;
  resolveOrCreate: (identity: unknown, options?: Payload) => Promise<Payload>;
  clearSelection?: () => Promise<boolean>;
}

interface RuntimeLease {
  accountRef?: string;
  context?: Payload;
  isCurrent: () => boolean;
  release: () => void;
}

interface RuntimePort {
  install: (options: Payload) => Promise<unknown> | unknown;
  acquire: (options?: Payload) => RuntimeLease;
  drain: (options?: Payload) => Promise<unknown> | unknown;
  snapshot?: () => { context?: Payload } | null;
}

interface PollerPort {
  start: (options?: Payload) => unknown;
  stop: (options?: Payload) => unknown;
}

type LogPort = {
  info?: (details: unknown, message: string) => void;
  warn?: (details: unknown, message: string) => void;
  error?: (details: unknown, message: string) => void;
};

// Менеджер аренд — ещё JavaScript, и вывод типов по его конструктору теряет
// обязательный `channel`. Форма объявлена здесь ровно тем, чем её зовёт lifecycle.
const RuntimeManager = AccountRuntimeManager as unknown as new (options: {
  channel: string;
  onDrain?: ((options: Payload) => unknown) | null;
}) => RuntimePort;

const CONNECTIONS = new Set([
  'disconnected', 'connecting', 'connected', 'disconnecting', 'switching', 'degraded',
]);

export class TelegramConnectionError extends Error {
  code: string;

  statusCode: number;

  constructor(code: string, message: string, statusCode = 400, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramConnectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string, statusCode?: number, cause?: unknown) => never = (
  code,
  message,
  statusCode = 400,
  cause = null,
) => {
  throw new TelegramConnectionError(code, message, statusCode, cause);
};

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;

function tokenOf(value: unknown): string {
  const token = String(value ?? '').trim();
  if (!isBotTokenShape(token) || token.length > 16 * 1024 || /[\0\r\n\s]/u.test(token)) {
    fail('telegram_bad_token', 'Telegram token имеет неверный формат.', 400);
  }
  return token;
}

function verifiedBot(source: unknown) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    fail('telegram_identity_invalid', 'Telegram getMe вернул неверный bot.', 502);
  }

  const value = source as Payload;

  return {
    botId: normalizeTelegramBotId(value.id, 'getMe.id'),
    username: typeof value.username === 'string' ? value.username : '',
    canReadAllGroupMessages: Boolean(value.canReadAllGroupMessages),
  };
}

function safeReason(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/u.test(value) ? value : null;
}

function botSettingsView(value: unknown, fallbackBotId: unknown = null) {
  const settings = (value && typeof value === 'object' ? value : {}) as Payload;
  const rawId = settings.botId ?? fallbackBotId;
  let botId = null;
  try { botId = rawId === null ? null : Number(normalizeTelegramBotId(rawId)); } catch { botId = null; }
  return {
    username: typeof settings.username === 'string' ? settings.username : '',
    botId,
    canReadAllGroupMessages: typeof settings.canReadAllGroupMessages === 'boolean'
      ? settings.canReadAllGroupMessages
      : null,
    connectedAt: Number.isSafeInteger(settings.connectedAtMs)
      ? settings.connectedAtMs as number
      : null,
    serviceChatId: Number.isSafeInteger(settings.serviceChatId)
      ? settings.serviceChatId as number
      : null,
  };
}

/**
 * accountContextFor({accountRef,botId,credentialLease}) возвращает immutable raw
 * context: archive/rules/botSettings/pollState/inboxState/createActivationMarker.
 */
export class TelegramConnection {
  credentials: CredentialsPort;

  bindings: BindingsPort;

  accountContextFor: (options: Payload) => Promise<Payload>;

  runtime: RuntimePort;

  poller: PollerPort | null;

  botApi: typeof realBotApi;

  enabled: () => Promise<unknown> | unknown;

  now: () => number;

  onChanged: (payload: Payload) => unknown;

  log: LogPort;

  connection: string;

  reason: string | null;

  initialized: boolean;

  queue: Promise<unknown>;

  constructor({
    credentials,
    bindings,
    accountContextFor,
    runtime = new RuntimeManager({ channel: 'telegram' }),
    poller = null,
    botApi = realBotApi,
    enabled = () => true,
    now = Date.now,
    onChanged = () => {},
    log = console,
  }: {
    credentials?: CredentialsPort;
    bindings?: BindingsPort;
    accountContextFor?: (options: Payload) => Promise<Payload>;
    runtime?: RuntimePort;
    poller?: PollerPort | null;
    botApi?: typeof realBotApi;
    enabled?: () => Promise<unknown> | unknown;
    now?: () => number;
    onChanged?: (payload: Payload) => unknown;
    log?: LogPort;
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
    this.credentials = credentials as CredentialsPort;
    this.bindings = bindings as BindingsPort;
    this.accountContextFor = accountContextFor as (options: Payload) => Promise<Payload>;
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

  attachPoller(poller: PollerPort | null): void {
    if (this.poller !== null || !poller
        || typeof poller.start !== 'function' || typeof poller.stop !== 'function') {
      fail('telegram_connection_config', 'Telegram poller уже назначен или невалиден.', 500);
    }
    this.poller = poller;
  }

  _serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);

    this.queue = result.catch(() => {});

    return result;
  }

  _setConnection(connection: string, reason: unknown = null): void {
    if (!CONNECTIONS.has(connection)) fail('telegram_connection_state', 'Unknown Telegram connection state.', 500);
    this.connection = connection;
    this.reason = safeReason(reason);
  }

  _notify(payload: Payload): void {
    try {
      const result = this.onChanged(payload);
      Promise.resolve(result).catch((error) => {
        this.log.warn?.(
          { code: errorCode(error) },
          'telegram: lifecycle commit выполнен, но SSE не отправлен',
        );
      });
    } catch (error) {
      this.log.warn?.(
        { code: errorCode(error) },
        'telegram: lifecycle commit выполнен, но SSE не отправлен',
      );
    }
  }

  async _requireEnabled(): Promise<void> {
    if (!await this.enabled()) fail('telegram_plugin_disabled', 'Плагин Telegram выключен.', 404);
  }

  async _bindingForCredentials(saved: Payload | null): Promise<Payload> {
    if (!saved) return null as unknown as Payload;
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

  async _contextFor(binding: Payload, credential: Payload | null = null): Promise<Payload> {
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

  async _install(
    binding: Payload,
    credential: Payload | null = null,
    reason = 'telegram_lifecycle',
  ): Promise<Payload> {
    const context = await this._contextFor(binding, credential);
    await this.runtime.install({ accountRef: binding.accountRef, context, reason });
    return context;
  }

  async _installSelectedOffline(reason = 'offline_selected_account'): Promise<Payload | null> {
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
  async _reconcileDurableRuntime(reason = 'telegram_lifecycle_recovery'): Promise<Payload | null> {
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
        await Promise.resolve(this.runtime.drain({ reason: 'invalid_startup_state' }))
          .catch(() => {});
        this._setConnection('degraded', errorCode(error) || 'invalid_state');
        this.log.error?.({ code: errorCode(error) }, 'telegram: startup state fail-closed');
      }
      this.initialized = true;
      return this.status();
    });
  }

  async status(): Promise<Payload> {
    let publicCredential: Payload;
    try { publicCredential = await this.credentials.publicView(); } catch (error) {
      return {
        configured: false,
        connection: 'degraded',
        reason: safeReason(errorCode(error)) || 'invalid_state',
        bot: {
          configured: false, username: '', botId: null, tokenHint: '',
          canReadAllGroupMessages: null, connectedAt: null, serviceChatId: null,
        },
      };
    }

    let settings: Payload = {};
    const snapshot = this.runtime.snapshot?.();
    const botSettings = snapshot?.context?.botSettings as { read?: () => Promise<Payload> } | undefined;

    if (botSettings?.read) {
      try { settings = await botSettings.read(); } catch (error) {
        return {
          configured: publicCredential.configured,
          connection: 'degraded',
          reason: safeReason(errorCode(error)) || 'invalid_state',
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

  _assertLeaseOwner(saved: Payload, lease: RuntimeLease): void {
    if (!lease || lease.accountRef !== saved.accountRef
        || normalizeTelegramBotId(lease.context?.botId) !== saved.botId
        || !lease.isCurrent()) {
      fail('telegram_account_changed', 'Telegram account generation изменилась.', 409);
    }
  }

  async connect({ token }: { token?: unknown } = {}) {
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
        const binding = resolved.binding as Payload;
        const candidate = {
          accountRef: binding.accountRef,
          botId: verified.botId,
          token: trustedToken,
          connectedAtMs,
        };
        const context = await this._contextFor(binding, candidate);
        const settingsStore = context.botSettings as { setBot: (value: Payload) => Promise<unknown> };

        await settingsStore.setBot({
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
        await this.bindings.select(binding.accountRef);
        await this.credentials.write(candidate);
        await this.runtime.install({
          accountRef: binding.accountRef,
          context,
          reason: 'provider_connect',
        });
        this._setConnection('connected');
        this.poller?.start();
        this._notify({
          itemRef: null,
          channel: 'telegram',
          status: 'provider_connected',
          taskId: null,
        });
        return this.status();
      } catch (error) {
        if (switchStarted) {
          // select/credential writes атомарны, но ошибка fsync может прийти уже
          // после rename. Перечитываем durable пару и не оставляем старый runtime
          // под новым selected pointer. Poller при failed connect не запускается.
          await Promise.resolve(this.poller?.stop()).catch(() => {});
          try {
            await this._reconcileDurableRuntime('connect_failed');
          } catch (recoveryError) {
            await Promise.resolve(this.runtime.drain({ reason: 'connect_recovery_failed' }))
              .catch(() => {});
            this.log.error?.(
              { code: errorCode(recoveryError) },
              'telegram: durable state после connect не удалось переустановить',
            );
          }
        }
        this._setConnection('degraded', errorCode(error) || 'provider_failure');
        this.log.warn?.(
          { token: maskToken(trustedToken), code: errorCode(error) },
          'telegram: connect failed',
        );
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
        const verified = verifiedBot(await this.botApi.getMe(String(saved.token)));
        if (verified.botId !== saved.botId) {
          fail('telegram_account_changed', 'Telegram token теперь принадлежит другому bot.', 409);
        }
        this._assertLeaseOwner(saved, lease);
        const settingsStore = lease.context?.botSettings as {
          setBot: (value: Payload) => Promise<unknown>;
        };

        await settingsStore.setBot({
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
        this._setConnection('degraded', errorCode(error) || 'provider_failure');
        throw error;
      } finally {
        lease.release();
      }
    });
  }

  async _closeActivation(context: Payload, reason: string) {
    const state = context.inboxState as {
      summary: () => Promise<{ participation: string; activationVersion: number }>;
      deactivate: (options: Payload) => Promise<unknown>;
    };
    const activation = await state.summary();

    if (activation.participation !== 'active') return activation;

    return state.deactivate({
      expectedActivationVersion: activation.activationVersion,
      endReason: reason,
      nowMs: this.now(),
      createActivationMarker: context.createActivationMarker,
    });
  }

  async _restore(binding: Payload | null, credential: Payload | null, reason: string) {
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
      let drained: Payload | null = null;
      let cleared = false;
      try {
        // stop() ждёт long poll: после него ни append, ни offset commit уже не
        // конкурируют с end marker. drain отзывает новые native/Inbox leases.
        await this.poller?.stop();
        drained = await this.runtime.drain({ reason: 'provider_disconnect' }) as Payload | null;
        if (!drained || drained.accountRef !== saved.accountRef) {
          fail('telegram_account_changed', 'Telegram runtime изменился во время disconnect.', 409);
        }
        await this._closeActivation(drained.context as Payload, 'provider_disconnect');
        await this.credentials.clear();
        cleared = true;
        await this._restore(binding, null, 'offline_after_disconnect');
        this._setConnection('disconnected');
        this._notify({
          itemRef: null,
          channel: 'telegram',
          status: 'provider_disconnected',
          taskId: null,
        });
        return this.status();
      } catch (error) {
        await this._restore(binding, cleared ? null : saved, 'disconnect_failed')
          .catch((restoreError) => {
            this.log.error?.(
              { code: errorCode(restoreError) },
              'telegram: context restore after disconnect failed',
            );
          });
        this._setConnection('degraded', errorCode(error) || 'invalid_state');
        throw error;
      }
    });
  }
}
