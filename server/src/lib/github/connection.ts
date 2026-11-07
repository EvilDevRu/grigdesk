// Provider lifecycle GitHub Issues. Он отдельно от Inbox capability: credentials,
// remote hook и reconciliation не переходят в общий data-plane contract.
import { randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';

import { errorCode } from '../../../../shared/lib/errors.ts';

import { AccountRuntimeManager } from '../accountRuntime.ts';
import {
  createRepositoryHook,
  deleteRepositoryHook,
  getRepository,
  getRepositoryHook,
  listRepositoryHooks,
  pingRepositoryHook,
  updateRepositoryHook,
} from './api.ts';
import {
  githubIssueSemanticKey,
} from './archiveStore.ts';
import {
  normalizeGitHubRepositoryId,
  repositoryIdFromIdentity,
} from './accountBindings.ts';
import { githubActivationMarker } from './activation.ts';
import { normalizeOpenedIssue } from './normalize.ts';
import { runGitHubReconciliation } from './reconciler.ts';
import {
  parseVerifiedGitHubWebhook,
  validateGitHubWebhookHeaders,
  validateOpenedIssuePayload,
} from './webhook.ts';
import type { WebhookHeaders } from './webhook.ts';

const CONNECTIONS = new Set([
  'disconnected', 'connecting', 'connected', 'disconnecting', 'degraded',
]);
const NAME_PART_RE = /^(?!\.)(?!.*\.\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/u;

// Менеджер аренд остаётся JavaScript, и его объявленная форма опций уже разошлась
// с настоящей. Приведение стоит в одном месте, а не в каждом вызове.
type RuntimeOptions = ConstructorParameters<typeof AccountRuntimeManager>[0];

const defaultRuntime = (): RuntimePort => new AccountRuntimeManager(
  { channel: 'github' } as unknown as RuntimeOptions,
) as unknown as RuntimePort;
const RECONCILE_INTERVAL_MS = 5 * 60_000;

export class GitHubConnectionError extends Error {
  code: string;

  statusCode: number;

  constructor(code: string, message: string, statusCode = 400, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitHubConnectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

type Payload = Record<string, unknown>;

// Соседи подключения остаются JavaScript, поэтому здесь объявлено ровно то, чем
// пользуется lifecycle. Это не описание их целиком, а список того, на что он вправе
// рассчитывать: лишний метод в порту означал бы новую связь без её обсуждения.
type ApiCall = (...args: unknown[]) => Promise<unknown>;

interface CredentialsPort {
  read: () => Promise<Payload | null>;
  write: (value: unknown) => Promise<Payload>;
  update: (patch: unknown) => Promise<Payload>;
  clear: (options?: { cleanupComplete?: boolean }) => Promise<boolean>;
  publicView: () => Promise<Payload>;
}

interface BindingsPort {
  selected: () => Promise<Payload | null>;
  select: (accountRef: unknown) => Promise<Payload>;
  byAccountRef: (accountRef: unknown) => Promise<Payload | null>;
  resolveOrCreate: (identity: unknown, options?: { select?: boolean }) => Promise<Payload>;
}

interface RuntimePort {
  install: (input: Payload) => Promise<unknown>;
  acquire: () => AccountLease;
  drain: (input: Payload) => Promise<Payload | null>;
}

interface LogPort {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

// Публичный статус подключения: ровно то, что видит браузер. Ни токена, ни секрета
// webhook, ни внутреннего accountRef здесь нет и быть не может.
export interface GitHubConnectionStatus {
  configured: boolean;
  state: string | null;
  repositoryId: string | null;
  fullName: string | null;
  connectedAt: number | null;
  connection: string;
  reason: string | null;
  cleanupPending: boolean;
}

// Аренда namespace: пока она текущая, операции вправе писать в архив аккаунта.
export interface AccountLease {
  accountRef: string;
  context: Payload;
  isCurrent: () => boolean;
  release: () => void;
}

export interface GitHubConnectionOptions {
  credentials?: CredentialsPort;
  bindings?: BindingsPort;
  accountContextFor?: unknown;
  webhookBaseUrl?: string;
  runtime?: RuntimePort;
  api?: Payload;
  reconcile?: unknown;
  enabled?: unknown;
  randomBytes?: unknown;
  now?: unknown;
  onChanged?: unknown;
  log?: LogPort;
  reconcileIntervalMs?: number;
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string, statusCode?: number, cause?: unknown) => never = (
  code,
  message,
  statusCode = 400,
  cause = null,
) => {
  throw new GitHubConnectionError(code, message, statusCode, cause);
};

function failureMessage(error: unknown): string {
  const message = error !== null && typeof error === 'object'
    ? (error as { message?: unknown }).message
    : undefined;

  return typeof message === 'string' ? message : '';
}

function repoPart(value: unknown, where: string): string {
  const text = String(value ?? '').trim();
  if (!NAME_PART_RE.test(text)) fail('github_repository_invalid', `${where} GitHub некорректен.`);
  return text;
}

function tokenOf(value: unknown): string {
  const token = String(value ?? '').trim();
  if (token.length < 20 || token.length > 16 * 1024 || /[\0\r\n\s]/u.test(token)) {
    fail('github_token_invalid', 'GitHub PAT имеет неверный формат.');
  }
  return token;
}

function fullNameParts(value: unknown): { owner: string; repo: string } {
  if (typeof value !== 'string') {
    fail('github_credentials_invalid', 'В connection нет repository full_name.', 500);
  }
  const parts = value.split('/');
  if (parts.length !== 2) fail('github_credentials_invalid', 'Repository full_name повреждён.', 500);

  return { owner: repoPart(parts[0], 'owner'), repo: repoPart(parts[1], 'repository') };
}

function callbackBase(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value ?? '')); } catch {
    fail('github_callback_unconfigured', 'HTTPS callback GitHub не настроен.', 409);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('github_callback_invalid', 'GitHub callback должен быть HTTPS без credentials/query/fragment.', 409);
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (!url.pathname) fail('github_callback_invalid', 'GitHub callback path не задан.', 409);
  return url.toString().replace(/\/$/u, '');
}

function callbackUrl(base: unknown, ingressRef: string): string {
  return `${callbackBase(base)}/${encodeURIComponent(ingressRef)}`;
}

function opaque(randomBytes: (size: number) => unknown, bytes: number): string {
  const value = randomBytes(bytes) as Uint8Array;
  if (!(value instanceof Uint8Array) || value.byteLength < bytes) {
    fail('github_random_failed', 'Генератор GitHub secret вернул недостаточно байтов.', 500);
  }
  return Buffer.from(value).toString('base64url');
}

function hookIdOf(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) fail('github_hook_invalid', 'GitHub hook id некорректен.', 502);
  return text;
}

function assertIssuesOnlyHook(source: unknown): Payload {
  const hook = (source ?? {}) as Payload;
  if (!source || !Array.isArray(hook.events)
      || hook.events.length !== 1 || hook.events[0] !== 'issues') {
    fail('github_hook_changed', 'GitHub hook подписан не только на exact issues event.', 409);
  }

  return hook;
}

function assertManagedHook(
  source: unknown,
  { hookId, callback, active }: { hookId: string; callback: unknown; active: boolean },
): Payload {
  const hook = assertIssuesOnlyHook(source);
  const config = (hook.config ?? {}) as Payload;
  if (hookIdOf(hook.id) !== hookId
      || config.url !== callback
      || config.content_type !== 'json'
      || String(config.insecure_ssl) !== '0'
      || hook.active !== active) {
    fail('github_hook_changed', 'GitHub hook не подтвердил exact managed contract.', 409);
  }

  return hook;
}

function verifiedRepository(source: unknown): { repositoryId: string; fullName: string } {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    fail('github_repository_invalid', 'GitHub вернул неверный repository.', 502);
  }
  const raw = source as Payload;
  const repositoryId = normalizeGitHubRepositoryId(raw.id, 'repository.id');
  const fullName = String(raw.full_name ?? '');
  fullNameParts(fullName);
  if (raw.has_issues !== true) {
    fail('github_issues_disabled', 'В выбранном repository выключены Issues.', 409);
  }
  return { repositoryId, fullName };
}

function headerValue(source: unknown, name: string): string {
  const headers = (source ?? {}) as Payload;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.length === 1 ? String(raw[0]) : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function safeReason(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/u.test(value) ? value : null;
}

function sameSecret(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `accountContextFor({accountRef,repositoryId,repositoryFullName})` создаёт stores
 * одного immutable owner: archive/rules/inboxState/ingressState.
 */
export class GitHubConnection {
  credentials: CredentialsPort;

  bindings: BindingsPort;

  accountContextFor: (request: Payload) => Promise<Payload>;

  webhookBaseUrl: string | undefined;

  runtime: RuntimePort;

  api: Record<string, ApiCall>;

  reconcile: unknown;

  enabled: () => unknown;

  randomBytes: (size: number) => unknown;

  now: () => number;

  onChanged: (event: Payload) => void;

  log: LogPort;

  reconcileIntervalMs: number;

  connection: string;

  reason: string | null;

  initialized: boolean;

  queue: Promise<unknown>;

  timer: ReturnType<typeof setTimeout> | null;

  running: boolean;

  constructor({
    credentials,
    bindings,
    accountContextFor,
    webhookBaseUrl,
    runtime = defaultRuntime(),
    api = {},
    reconcile = runGitHubReconciliation,
    enabled = () => true,
    randomBytes = cryptoRandomBytes,
    now = Date.now,
    onChanged = () => {},
    log = console as unknown as LogPort,
    reconcileIntervalMs = RECONCILE_INTERVAL_MS,
  }: GitHubConnectionOptions = {}) {
    if (!credentials || typeof credentials.read !== 'function'
        || !bindings || typeof bindings.selected !== 'function'
        || typeof accountContextFor !== 'function') {
      fail('github_connection_config', 'GitHubConnection требует credentials/bindings/context factory.', 500);
    }
    if (!runtime || typeof runtime.install !== 'function' || typeof runtime.acquire !== 'function') {
      fail('github_connection_config', 'GitHubConnection требует account runtime.', 500);
    }
    if (typeof reconcile !== 'function' || typeof enabled !== 'function'
        || typeof randomBytes !== 'function'
        || typeof now !== 'function' || typeof onChanged !== 'function') {
      fail('github_connection_config', 'GitHubConnection получил неверные callbacks.', 500);
    }
    if (!Number.isSafeInteger(reconcileIntervalMs) || reconcileIntervalMs < 10_000) {
      fail('github_connection_config', 'GitHub reconciliation interval слишком мал.', 500);
    }
    this.credentials = credentials as CredentialsPort;
    this.bindings = bindings as BindingsPort;
    this.accountContextFor = accountContextFor as (request: Payload) => Promise<Payload>;
    this.webhookBaseUrl = webhookBaseUrl;
    this.runtime = runtime;
    this.api = {
      getRepository: (api.getRepository || getRepository) as ApiCall,
      listRepositoryHooks: (api.listRepositoryHooks || listRepositoryHooks) as ApiCall,
      getRepositoryHook: (api.getRepositoryHook || getRepositoryHook) as ApiCall,
      createRepositoryHook: (api.createRepositoryHook || createRepositoryHook) as ApiCall,
      updateRepositoryHook: (api.updateRepositoryHook || updateRepositoryHook) as ApiCall,
      pingRepositoryHook: (api.pingRepositoryHook || pingRepositoryHook) as ApiCall,
      deleteRepositoryHook: (api.deleteRepositoryHook || deleteRepositoryHook) as ApiCall,
    };
    this.reconcile = reconcile;
    this.enabled = enabled as () => unknown;
    this.randomBytes = randomBytes as (size: number) => unknown;
    this.now = now as () => number;
    this.onChanged = onChanged as (event: Payload) => void;
    this.log = log;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.connection = 'disconnected';
    this.reason = null;
    this.initialized = false;
    this.queue = Promise.resolve();
    this.timer = null;
    this.running = false;
  }

  _serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  _setConnection(connection: string, reason: unknown = null): void {
    if (!CONNECTIONS.has(connection)) fail('github_connection_state', 'Unknown connection state.', 500);
    this.connection = connection;
    this.reason = safeReason(reason);
  }

  async _pluginEnabled() {
    return Boolean(await this.enabled());
  }

  async _requirePluginEnabled() {
    if (!await this._pluginEnabled()) {
      fail('github_plugin_disabled', 'Плагин GitHub Issues выключен.', 404);
    }
  }

  async _bindingForCredentials(saved: Payload | null) {
    if (!saved?.accountRef || !saved?.repositoryId) return null;
    const binding = await this.bindings.byAccountRef(saved.accountRef);
    if (!binding || repositoryIdFromIdentity(binding.providerIdentity) !== saved.repositoryId) {
      fail('github_binding_invalid', 'GitHub credentials не совпадают с immutable account binding.', 503);
    }
    return binding;
  }

  async _contextFor(binding: Payload, repositoryFullName = ''): Promise<Payload> {
    const context = await this.accountContextFor({
      accountRef: binding.accountRef,
      repositoryId: repositoryIdFromIdentity(binding.providerIdentity),
      repositoryFullName,
    });
    if (!context || typeof context !== 'object'
        || !context.archive || !context.rules || !context.inboxState || !context.ingressState) {
      fail('github_connection_config', 'GitHub account context incomplete.', 500);
    }
    return context;
  }

  async _install(
    binding: Payload,
    repositoryFullName = '',
    reason = 'github_lifecycle',
  ): Promise<Payload> {
    const context = await this._contextFor(binding, repositoryFullName);
    await this.runtime.install({ accountRef: binding.accountRef, context, reason });
    return context;
  }

  async _installSelectedOffline() {
    const selected = await this.bindings.selected();
    if (!selected) {
      await this.runtime.drain({ reason: 'no_selected_account' });
      return null;
    }
    return this._install(selected, '', 'offline_selected_account');
  }

  async initialize() {
    return this._serialize(async () => {
      if (this.initialized) return this.status();
      try {
        const saved = await this.credentials.read();
        const binding = await this._bindingForCredentials(saved);
        if (binding) await this._install(binding, String(saved?.fullName || ''), 'startup');
        else await this._installSelectedOffline();
        if (saved?.state === 'connected') this._setConnection('connected');
        else if (saved?.state === 'pending') this._setConnection('connecting');
        else if (saved?.state === 'cleanup_pending') {
          this._setConnection('degraded', 'remote_cleanup_pending');
        } else this._setConnection('disconnected');
      } catch (err) {
        this._setConnection('degraded', errorCode(err) || 'invalid_state');
        this.log.error?.(
          { code: errorCode(err) },
          'github: startup state fail-closed',
        );
      }
      this.initialized = true;
      return this.status();
    });
  }

  async status(): Promise<GitHubConnectionStatus> {
    let view: Payload;
    try { view = await this.credentials.publicView(); } catch (err) {
      return {
        configured: false,
        state: null,
        repositoryId: null,
        fullName: null,
        connectedAt: null,
        connection: 'degraded',
        reason: safeReason(errorCode(err)) || 'invalid_state',
        cleanupPending: false,
      };
    }
    return {
      configured: view.configured as boolean,
      state: view.state as string | null,
      repositoryId: view.repositoryId as string | null,
      fullName: view.fullName as string | null,
      connectedAt: view.connectedAt as number | null,
      connection: this.connection,
      reason: this.reason,
      cleanupPending: view.state === 'cleanup_pending',
    };
  }

  /** Data-plane lease; доступен и disconnected для старой read-only projection. */
  acquireInboxLease(): AccountLease {
    return this.runtime.acquire();
  }

  async _matchingHook(
    token: unknown,
    owner: string,
    repo: string,
    callback: unknown,
  ): Promise<Payload | null> {
    const hooks = await this.api.listRepositoryHooks?.(
      token,
      owner,
      repo,
      { page: 1, perPage: 100 },
    );
    if (!Array.isArray(hooks)) {
      fail('github_hooks_invalid', 'GitHub вернул неверный список hooks.', 502);
    }
    if (hooks.length === 100) {
      fail('github_hooks_truncated', 'У repository слишком много hooks для безопасной exact-проверки.', 409);
    }
    const matches = (hooks as Payload[])
      .filter((hook) => ((hook?.config ?? {}) as Payload).url === callback);
    if (matches.length > 1) {
      fail('github_hook_ambiguous', 'Для callback найдено несколько GitHub hooks.', 409);
    }
    return matches[0] || null;
  }

  _assertLeaseOwner(saved: Payload, lease: AccountLease): void {
    if (!lease || lease.accountRef !== saved.accountRef
        || lease.context?.repositoryId !== saved.repositoryId
        || !lease.isCurrent()) {
      fail('github_account_changed', 'GitHub account generation изменилась.', 409);
    }
  }

  async _runReconciliation(
    saved: Payload,
    context: Payload,
    isCurrent: () => boolean | Promise<boolean> = () => true,
  ): Promise<Payload> {
    const assertCurrent = async () => {
      if (!await isCurrent()) {
        fail('github_account_changed', 'GitHub generation изменилась во время reconciliation.', 409);
      }
    };
    const { owner, repo } = fullNameParts(saved.fullName);
    const guardedArchive = Object.freeze({
      head: async (...args: unknown[]) => {
        await assertCurrent();
        const archive = context.archive as Payload;
        const result = await (archive.head as (...rest: unknown[]) => unknown)(...args);

        await assertCurrent();

        return result;
      },
      append: async (...args: unknown[]) => {
        await assertCurrent();
        const archive = context.archive as Payload;
        const result = await (archive.append as (...rest: unknown[]) => unknown)(...args);

        await assertCurrent();

        return result;
      },
    });
    await assertCurrent();
    const ingressState = context.ingressState as Payload;
    const transport = await (ingressState.read as () => Promise<Payload>)
      .call(ingressState);
    await assertCurrent();
    const result = await (this.reconcile as (input: unknown) => Promise<Payload>)({
      token: saved.token,
      owner,
      repo,
      repositoryId: saved.repositoryId,
      accountRef: saved.accountRef,
      archive: guardedArchive,
      boundary: transport.boundary,
    });
    await assertCurrent();
    await (ingressState.record as (input: unknown) => Promise<unknown>)
      .call(ingressState, result);
    await assertCurrent();
    if (result.degraded) {
      this._setConnection('degraded', result.degraded);
      fail(String(result.degraded), 'GitHub reconciliation не достигла безопасной boundary.', 503);
    }
    return result;
  }

  async connect(
    { owner, repo, token }: { owner?: unknown; repo?: unknown; token?: unknown } = {},
  ): Promise<GitHubConnectionStatus> {
    const trustedOwner = repoPart(owner, 'owner');
    const trustedRepo = repoPart(repo, 'repository');
    const trustedToken = tokenOf(token);
    return this._serialize(async () => {
      let pending = await this.credentials.read();
      if (pending && pending.state !== 'pending') {
        fail(
          pending.state === 'cleanup_pending' ? 'github_cleanup_pending' : 'github_already_configured',
          pending.state === 'cleanup_pending'
            ? 'Сначала завершите очистку прежнего GitHub hook.'
            : 'GitHub repository уже подключается или подключён; сначала отключите его.',
          409,
        );
      }
      this._setConnection('connecting');
      if (pending) {
        if (!sameSecret(pending.token, trustedToken)) {
          fail('github_pending_mismatch', 'Pending GitHub connection создана с другим PAT.', 409);
        }
      } else {
        const base = callbackBase(this.webhookBaseUrl);
        const ingressRef = opaque(this.randomBytes, 24);
        pending = await this.credentials.write({
          state: 'pending',
          token: trustedToken,
          secret: opaque(this.randomBytes, 32),
          ingressRef,
          callbackUrl: callbackUrl(base, ingressRef),
          hookId: null,
          generation: 1,
          accountRef: null,
          repositoryId: null,
          fullName: null,
          connectedAt: null,
        });
      }

      try {
        const repository = verifiedRepository(
          await this.api.getRepository?.(trustedToken, trustedOwner, trustedRepo),
        );
        let binding: Payload;
        if (pending.accountRef !== null) {
          if (pending.repositoryId !== repository.repositoryId) {
            fail('github_pending_mismatch', 'Pending GitHub connection принадлежит другому repository.', 409);
          }
          binding = await this._bindingForCredentials(pending) as Payload;
        } else {
          const resolved = await this.bindings.resolveOrCreate([
            1, 'github.com', 'repository', repository.repositoryId,
          ], { select: false });

          binding = resolved.binding as Payload;
        }

        // WAL до первого remote side effect. verified_no_hook позволяет после
        // crash exact-list callback и продолжить либо безопасно disconnect.
        pending = await this.credentials.update({
          state: 'pending',
          hookId: pending.hookId,
          accountRef: binding.accountRef,
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          connectedAt: null,
        });
        // Metadata должна стать durable раньше selected pointer. Иначе crash
        // между binding create и account metadata оставит startup без читаемого
        // offline owner. Сам immutable binding можно безопасно reuse при resume.
        const context = await this._contextFor(binding, repository.fullName);
        await this.bindings.select(binding.accountRef);
        await this.runtime.install({ accountRef: binding.accountRef, context, reason: 'connect' });
        const currentName = fullNameParts(repository.fullName);
        const callback = pending.callbackUrl;
        let hook = await this._matchingHook(
          trustedToken,
          currentName.owner,
          currentName.repo,
          callback,
        );
        if (pending.hookId !== null) {
          if (!hook || hookIdOf(hook.id) !== pending.hookId) {
            fail('github_hook_changed', 'Сохранённый GitHub hook не совпадает с exact callback.', 409);
          }
        } else if (!hook) {
          hook = await this.api.createRepositoryHook?.(
            trustedToken,
            currentName.owner,
            currentName.repo,
            { url: callback, secret: pending.secret, active: false },
          ) as Payload;
        }
        const managed = assertIssuesOnlyHook(hook);
        const hookId = hookIdOf(managed.id);
        hook = assertManagedHook(await this.api.updateRepositoryHook?.(
          trustedToken,
          currentName.owner,
          currentName.repo,
          hookId,
          { active: false, url: callback, secret: pending.secret },
        ), { hookId, callback, active: false });
        pending = await this.credentials.update({
          state: 'pending',
          hookId,
          accountRef: binding.accountRef,
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          connectedAt: null,
        });
        const lease = this.runtime.acquire();
        try {
          this._assertLeaseOwner(pending, lease);
          await this._runReconciliation(pending, context, () => lease.isCurrent());
          this._assertLeaseOwner(pending, lease);
          assertManagedHook(await this.api.updateRepositoryHook?.(
            trustedToken,
            currentName.owner,
            currentName.repo,
            hookId,
            { active: true, url: callback, secret: pending.secret },
          ), { hookId, callback, active: true });
          this._assertLeaseOwner(pending, lease);
          await this.api.pingRepositoryHook?.(
            trustedToken,
            currentName.owner,
            currentName.repo,
            hookId,
          );
          this._assertLeaseOwner(pending, lease);
        } finally {
          lease.release();
        }
        // Подключение подтвердит только signed ping на public ingress.
        this._setConnection('connecting');
        return this.status();
      } catch (err) {
        this._setConnection('degraded', errorCode(err) || 'provider_failure');
        throw err;
      }
    });
  }

  async _closeActivation(context: Payload, reason: string) {
    const inboxState = context.inboxState as Payload;
    const archive = context.archive as Payload;
    const summary = inboxState.summary as () => Promise<Payload>;
    const activation = await summary.call(inboxState);

    if (activation.participation !== 'active') return activation;

    const deactivate = inboxState.deactivate as (input: Payload) => Promise<Payload>;

    return deactivate.call(inboxState, {
      expectedActivationVersion: activation.activationVersion,
      endReason: reason,
      nowMs: this.now(),
      createActivationMarker: async ({ nowMs }: { nowMs: number }) => githubActivationMarker({
        afterSeq: await (archive.head as () => Promise<number>).call(archive),
        nowMs,
      }),
    });
  }

  async _restoreOffline(drained: Payload | null, reason: string): Promise<Payload | null> {
    const selected = await this.bindings.selected();
    if (!selected) {
      await this.runtime.drain({ reason: 'no_selected_account' });
      return null;
    }
    if (drained?.context && drained.accountRef === selected.accountRef) {
      await this.runtime.install({
        accountRef: drained.accountRef,
        context: drained.context,
        reason,
      });
      return drained.context as Payload;
    }

    return this._install(selected, '', reason);
  }

  async _offlineRecord(
    cleanup: Payload | null,
    drained: Payload | null,
  ): Promise<Payload | null> {
    if (cleanup?.accountRef && cleanup?.repositoryId) {
      if (drained?.accountRef === cleanup.accountRef && drained.context) return drained;

      const binding = await this._bindingForCredentials(cleanup) as Payload;
      const context = await this._contextFor(binding, String(cleanup.fullName || ''));

      return { accountRef: binding.accountRef, context };
    }

    return drained;
  }

  async _cleanupRemoteHook(saved: Payload | null) {
    if (!saved?.token || !saved?.fullName) return { deleted: false, missing: true };
    const { owner, repo } = fullNameParts(saved.fullName);
    let hookId = saved.hookId as string | null;
    if (hookId === null) {
      const hook = await this._matchingHook(saved.token, owner, repo, saved.callbackUrl);

      if (!hook) return { deleted: false, missing: true };
      hookId = hookIdOf(hook.id);
    }

    return this.api.deleteRepositoryHook?.(saved.token, owner, repo, hookId);
  }

  async disconnect(): Promise<GitHubConnectionStatus> {
    return this._serialize(async () => {
      const saved = await this.credentials.read();
      if (!saved) {
        this._setConnection('disconnected');
        await this._installSelectedOffline();
        return this.status();
      }
      this._setConnection('disconnecting');
      const cleanup = saved.state === 'cleanup_pending'
        ? saved
        : await this.credentials.update({ state: 'cleanup_pending' });
      let drained: Payload | null = null;
      let offline: Payload | null = null;
      let credentialsCleared = false;
      try {
        // cleanup_pending сначала отзывает public ingress. drain немедленно запрещает
        // новые account leases и ждёт уже начатые операции; marker закрывается только
        // после этого, поэтому поздний append не перескочит end boundary.
        drained = await this.runtime.drain({ reason: 'provider_disconnect' });
        offline = await this._offlineRecord(cleanup, drained);
        if (offline?.context && cleanup.accountRef === offline.accountRef) {
          await this._closeActivation(offline.context as Payload, 'provider_disconnect');
        }
        await this._cleanupRemoteHook(cleanup);
        await this.credentials.clear({ cleanupComplete: true });
        credentialsCleared = true;
        await this._restoreOffline(offline, 'offline_after_disconnect');
        this._setConnection('disconnected');
        return this.status();
      } catch (err) {
        await this._restoreOffline(offline || drained, 'cleanup_pending_offline')
          .catch((restoreError: unknown) => {
            this.log.error?.(
              { code: errorCode(restoreError) },
              'github: offline context restore failed',
            );
          });
        if (credentialsCleared) {
          this._setConnection('degraded', 'invalid_state');
          throw new GitHubConnectionError(
            'github_offline_context_failed',
            'Remote GitHub hook удалён, но offline account context не восстановлен.',
            503,
            err,
          );
        }
        this._setConnection('degraded', 'remote_cleanup_pending');
        throw new GitHubConnectionError(
          'github_cleanup_pending',
          'Локальный ingress выключен, но удалить remote GitHub hook не удалось. Повторите отключение.',
          503,
          err,
        );
      }
    });
  }

  async forceForget(
    { confirmOrphanHook = false }: { confirmOrphanHook?: boolean } = {},
  ): Promise<GitHubConnectionStatus> {
    if (confirmOrphanHook !== true) {
      fail('github_force_forget_confirmation', 'Нужно явно подтвердить возможный orphan GitHub hook.', 400);
    }
    return this._serialize(async () => {
      const saved = await this.credentials.read();
      if (!saved) return this.status();
      if (saved.state !== 'cleanup_pending') {
        await this.credentials.update({ state: 'cleanup_pending' });
      }
      const cleanup = await this.credentials.read();
      let drained: Payload | null = null;
      let offline: Payload | null = null;
      try {
        drained = await this.runtime.drain({ reason: 'provider_force_forget' });
        offline = await this._offlineRecord(cleanup, drained);
        if (offline?.context && cleanup?.accountRef === offline.accountRef) {
          await this._closeActivation(offline.context as Payload, 'provider_force_forget');
        }
        await this.credentials.clear({ cleanupComplete: true });
        await this._restoreOffline(offline, 'offline_after_force_forget');
        this._setConnection('disconnected', 'orphan_hook_possible');
        return this.status();
      } catch (err) {
        await this._restoreOffline(offline || drained, 'force_forget_failed_offline').catch(() => {});
        this._setConnection('degraded', errorCode(err) || 'invalid_state');
        throw err;
      }
    });
  }

  async recheck(): Promise<GitHubConnectionStatus> {
    return this._serialize(async () => {
      const saved = await this.credentials.read();
      if (!saved?.accountRef || !saved?.repositoryId || !saved?.hookId || !saved?.fullName) {
        fail('github_not_connected', 'GitHub repository ещё не подключён.', 409);
      }
      if (saved.state === 'cleanup_pending') {
        fail('github_cleanup_pending', 'Сначала завершите cleanup GitHub hook.', 409);
      }
      const { owner, repo } = fullNameParts(saved.fullName);
      const repository = verifiedRepository(
        await this.api.getRepository?.(saved.token, owner, repo),
      );
      if (repository.repositoryId !== saved.repositoryId) {
        fail('github_account_changed', 'GitHub repository identity изменилась.', 409);
      }
      const hook = await this.api.getRepositoryHook?.(saved.token, owner, repo, saved.hookId);
      const expectedCallback = saved.callbackUrl;

      assertManagedHook(hook, {
        hookId: String(saved.hookId),
        callback: expectedCallback,
        active: true,
      });
      const lease = this.runtime.acquire();
      try {
        this._assertLeaseOwner(saved, lease);
        await this._runReconciliation(saved, lease.context, () => lease.isCurrent());
        this._assertLeaseOwner(saved, lease);
        if (saved.state === 'connected') this._setConnection('connected');
        await this.api.pingRepositoryHook?.(saved.token, owner, repo, saved.hookId);
        this._assertLeaseOwner(saved, lease);
      } finally {
        lease.release();
      }
      return this.status();
    });
  }

  async _acceptPing(saved: Payload, payload: unknown, lease: AccountLease) {
    const repository = ((payload as Payload)?.repository ?? {}) as Payload;
    const repositoryId = normalizeGitHubRepositoryId(repository.id, 'ping.repository.id');
    if (repositoryId !== saved.repositoryId) {
      fail('github_repository_mismatch', 'GitHub ping относится к другому repository.', 410);
    }
    await this._requirePluginEnabled();
    this._assertLeaseOwner(saved, lease);
    if (saved.state === 'pending') {
      await this.credentials.update({ state: 'connected', connectedAt: this.now() });
    }
    await this._requirePluginEnabled();
    this._assertLeaseOwner(saved, lease);
    this._setConnection('connected');
    return { accepted: true, kind: 'ping', inserted: false };
  }

  async handleWebhook(ingressRef: string, rawBody: unknown, headers: WebhookHeaders) {
    return this._serialize(async () => {
      await this._requirePluginEnabled();
      const saved = await this.credentials.read();
      if (!saved || saved.ingressRef !== ingressRef || !saved.hookId
          || !saved.repositoryId || !saved.accountRef
          || saved.state === 'cleanup_pending') {
        fail('github_ingress_gone', 'GitHub ingress больше не действует.', 410);
      }
      const parsed = parseVerifiedGitHubWebhook(rawBody, {
        headers,
        secret: saved.secret,
      });
      const event = headerValue(headers, 'x-github-event');
      validateGitHubWebhookHeaders(headers, {
        expectedEvent: event,
        expectedHookId: saved.hookId,
        expectedRepositoryId: saved.repositoryId,
      });
      if (event === 'ping') {
        const lease = this.runtime.acquire();
        try {
          return await this._acceptPing(saved, parsed.payload, lease);
        } finally {
          lease.release();
        }
      }
      if (event !== 'issues') return { accepted: true, kind: 'ignored', inserted: false };
      if ((parsed.payload as Payload)?.action !== 'opened') {
        return { accepted: true, kind: 'ignored', inserted: false };
      }
      if (saved.state !== 'connected' || this.connection !== 'connected') {
        fail('github_ingress_not_ready', 'GitHub channel ещё не подтвердил подключение.', 503);
      }
      const issue = validateOpenedIssuePayload(parsed.payload, {
        expectedRepositoryId: saved.repositoryId,
      });
      const normalized = normalizeOpenedIssue(parsed.payload, {
        accountRef: saved.accountRef,
        expectedRepositoryId: saved.repositoryId,
      });
      const lease = this.runtime.acquire();
      try {
        await this._requirePluginEnabled();
        if (lease.accountRef !== saved.accountRef
            || lease.context.repositoryId !== saved.repositoryId
            || !lease.isCurrent()) {
          fail('github_account_changed', 'GitHub generation изменилась до archive append.', 409);
        }
        const archive = lease.context.archive as Payload;
        const result = await (archive.append as (input: unknown) => Promise<Payload>)({
          transport: { kind: 'webhook', id: headerValue(headers, 'x-github-delivery').toLowerCase() },
          repositoryId: saved.repositoryId,
          issueId: issue.issueId,
          semanticKey: githubIssueSemanticKey(saved.repositoryId, issue.issueId),
          occurredAt: normalized.occurredAt,
          snapshot: (parsed.payload as Payload).issue,
        });
        await this._requirePluginEnabled();
        if (!lease.isCurrent()) fail('github_account_changed', 'GitHub generation изменилась после append.', 409);
        if (result.inserted) {
          try {
            this.onChanged({ itemRef: null, channel: 'github', status: 'new', taskId: null });
          } catch (err) {
            this.log.warn?.(
              { err: failureMessage(err) },
              'github: archive записан, SSE не отправлен',
            );
          }
        }
        return { accepted: true, kind: 'issues.opened', inserted: result.inserted };
      } finally {
        lease.release();
      }
    });
  }

  async tick() {
    return this._serialize(async () => {
      if (!await this._pluginEnabled()) {
        return { ran: false, reason: 'plugin_disabled' };
      }
      const saved = await this.credentials.read();
      if (saved?.state !== 'connected' || this.connection === 'disconnecting') {
        return { ran: false, reason: 'not_connected' };
      }
      const lease = this.runtime.acquire();
      try {
        this._assertLeaseOwner(saved, lease);
        const result = await this._runReconciliation(saved, lease.context, async () => {
          if (!lease.isCurrent()) return false;
          await this._requirePluginEnabled();

          return lease.isCurrent();
        });
        this._assertLeaseOwner(saved, lease);
        this._setConnection('connected');
        if (((result.diagnostics ?? {}) as Payload).appended as number > 0) {
          this.onChanged({ itemRef: null, channel: 'github', status: 'new', taskId: null });
        }
        return { ran: true, result };
      } finally {
        lease.release();
      }
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); } catch (err) {
        this.log.error?.(
          { code: errorCode(err) },
          'github: reconciliation tick failed',
        );
      }
      if (!this.running) return;
      this.timer = setTimeout(loop, this.reconcileIntervalMs);
      this.timer.unref?.();
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
