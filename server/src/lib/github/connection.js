// Provider lifecycle GitHub Issues. Он отдельно от Inbox capability: credentials,
// remote hook и reconciliation не переходят в общий data-plane contract.
import { randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';

import { AccountRuntimeManager } from '../account-runtime.js';
import {
  createRepositoryHook,
  deleteRepositoryHook,
  getRepository,
  getRepositoryHook,
  listRepositoryHooks,
  pingRepositoryHook,
  updateRepositoryHook,
} from './api.js';
import {
  githubIssueSemanticKey,
} from './archive-store.js';
import {
  normalizeGitHubRepositoryId,
  repositoryIdFromIdentity,
} from './account-bindings.js';
import { githubActivationMarker } from './activation.js';
import { normalizeOpenedIssue } from './normalize.js';
import { runGitHubReconciliation } from './reconciler.js';
import {
  parseVerifiedGitHubWebhook,
  validateGitHubWebhookHeaders,
  validateOpenedIssuePayload,
} from './webhook.js';

const CONNECTIONS = new Set([
  'disconnected', 'connecting', 'connected', 'disconnecting', 'degraded',
]);
const NAME_PART_RE = /^(?!\.)(?!.*\.\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/u;
const RECONCILE_INTERVAL_MS = 5 * 60_000;

export class GitHubConnectionError extends Error {
  constructor(code, message, statusCode = 400, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitHubConnectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode = 400, cause = null) => {
  throw new GitHubConnectionError(code, message, statusCode, cause);
};

function repoPart(value, where) {
  const text = String(value ?? '').trim();
  if (!NAME_PART_RE.test(text)) fail('github_repository_invalid', `${where} GitHub некорректен.`);
  return text;
}

function tokenOf(value) {
  const token = String(value ?? '').trim();
  if (token.length < 20 || token.length > 16 * 1024 || /[\0\r\n\s]/u.test(token)) {
    fail('github_token_invalid', 'GitHub PAT имеет неверный формат.');
  }
  return token;
}

function fullNameParts(value) {
  if (typeof value !== 'string') fail('github_credentials_invalid', 'В connection нет repository full_name.', 500);
  const parts = value.split('/');
  if (parts.length !== 2) fail('github_credentials_invalid', 'Repository full_name повреждён.', 500);
  return { owner: repoPart(parts[0], 'owner'), repo: repoPart(parts[1], 'repository') };
}

function callbackBase(value) {
  let url;
  try { url = new URL(value); } catch {
    fail('github_callback_unconfigured', 'HTTPS callback GitHub не настроен.', 409);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('github_callback_invalid', 'GitHub callback должен быть HTTPS без credentials/query/fragment.', 409);
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (!url.pathname) fail('github_callback_invalid', 'GitHub callback path не задан.', 409);
  return url.toString().replace(/\/$/u, '');
}

function callbackUrl(base, ingressRef) {
  return `${callbackBase(base)}/${encodeURIComponent(ingressRef)}`;
}

function opaque(randomBytes, bytes) {
  const value = randomBytes(bytes);
  if (!(value instanceof Uint8Array) || value.byteLength < bytes) {
    fail('github_random_failed', 'Генератор GitHub secret вернул недостаточно байтов.', 500);
  }
  return Buffer.from(value).toString('base64url');
}

function hookIdOf(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) fail('github_hook_invalid', 'GitHub hook id некорректен.', 502);
  return text;
}

function assertIssuesOnlyHook(hook) {
  if (!hook || !Array.isArray(hook.events)
      || hook.events.length !== 1 || hook.events[0] !== 'issues') {
    fail('github_hook_changed', 'GitHub hook подписан не только на exact issues event.', 409);
  }
  return hook;
}

function assertManagedHook(hook, { hookId, callback, active }) {
  assertIssuesOnlyHook(hook);
  if (hookIdOf(hook.id) !== hookId
      || hook?.config?.url !== callback
      || hook?.config?.content_type !== 'json'
      || String(hook?.config?.insecure_ssl) !== '0'
      || hook.active !== active) {
    fail('github_hook_changed', 'GitHub hook не подтвердил exact managed contract.', 409);
  }
  return hook;
}

function verifiedRepository(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('github_repository_invalid', 'GitHub вернул неверный repository.', 502);
  }
  const repositoryId = normalizeGitHubRepositoryId(raw.id, 'repository.id');
  const fullName = String(raw.full_name ?? '');
  fullNameParts(fullName);
  if (raw.has_issues !== true) {
    fail('github_issues_disabled', 'В выбранном repository выключены Issues.', 409);
  }
  return { repositoryId, fullName };
}

function headerValue(headers, name) {
  const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.length === 1 ? String(raw[0]) : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function safeReason(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/u.test(value) ? value : null;
}

function sameSecret(left, right) {
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
  constructor({
    credentials,
    bindings,
    accountContextFor,
    webhookBaseUrl,
    runtime = new AccountRuntimeManager({ channel: 'github' }),
    api = {},
    reconcile = runGitHubReconciliation,
    enabled = () => true,
    randomBytes = cryptoRandomBytes,
    now = Date.now,
    onChanged = () => {},
    log = console,
    reconcileIntervalMs = RECONCILE_INTERVAL_MS,
  } = {}) {
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
    this.credentials = credentials;
    this.bindings = bindings;
    this.accountContextFor = accountContextFor;
    this.webhookBaseUrl = webhookBaseUrl;
    this.runtime = runtime;
    this.api = {
      getRepository: api.getRepository || getRepository,
      listRepositoryHooks: api.listRepositoryHooks || listRepositoryHooks,
      getRepositoryHook: api.getRepositoryHook || getRepositoryHook,
      createRepositoryHook: api.createRepositoryHook || createRepositoryHook,
      updateRepositoryHook: api.updateRepositoryHook || updateRepositoryHook,
      pingRepositoryHook: api.pingRepositoryHook || pingRepositoryHook,
      deleteRepositoryHook: api.deleteRepositoryHook || deleteRepositoryHook,
    };
    this.reconcile = reconcile;
    this.enabled = enabled;
    this.randomBytes = randomBytes;
    this.now = now;
    this.onChanged = onChanged;
    this.log = log;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.connection = 'disconnected';
    this.reason = null;
    this.initialized = false;
    this.queue = Promise.resolve();
    this.timer = null;
    this.running = false;
  }

  _serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  _setConnection(connection, reason = null) {
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

  async _bindingForCredentials(saved) {
    if (!saved?.accountRef || !saved?.repositoryId) return null;
    const binding = await this.bindings.byAccountRef(saved.accountRef);
    if (!binding || repositoryIdFromIdentity(binding.providerIdentity) !== saved.repositoryId) {
      fail('github_binding_invalid', 'GitHub credentials не совпадают с immutable account binding.', 503);
    }
    return binding;
  }

  async _contextFor(binding, repositoryFullName = '') {
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

  async _install(binding, repositoryFullName = '', reason = 'github_lifecycle') {
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
        if (binding) await this._install(binding, saved.fullName || '', 'startup');
        else await this._installSelectedOffline();
        if (saved?.state === 'connected') this._setConnection('connected');
        else if (saved?.state === 'pending') this._setConnection('connecting');
        else if (saved?.state === 'cleanup_pending') {
          this._setConnection('degraded', 'remote_cleanup_pending');
        } else this._setConnection('disconnected');
      } catch (err) {
        this._setConnection('degraded', err?.code || 'invalid_state');
        this.log.error?.({ code: err?.code }, 'github: startup state fail-closed');
      }
      this.initialized = true;
      return this.status();
    });
  }

  async status() {
    let view;
    try { view = await this.credentials.publicView(); } catch (err) {
      return {
        configured: false,
        state: null,
        repositoryId: null,
        fullName: null,
        connectedAt: null,
        connection: 'degraded',
        reason: safeReason(err?.code) || 'invalid_state',
        cleanupPending: false,
      };
    }
    return {
      configured: view.configured,
      state: view.state,
      repositoryId: view.repositoryId,
      fullName: view.fullName,
      connectedAt: view.connectedAt,
      connection: this.connection,
      reason: this.reason,
      cleanupPending: view.state === 'cleanup_pending',
    };
  }

  /** Data-plane lease; доступен и disconnected для старой read-only projection. */
  acquireInboxLease() {
    return this.runtime.acquire();
  }

  async _matchingHook(token, owner, repo, callback) {
    const hooks = await this.api.listRepositoryHooks(token, owner, repo, { page: 1, perPage: 100 });
    if (!Array.isArray(hooks)) {
      fail('github_hooks_invalid', 'GitHub вернул неверный список hooks.', 502);
    }
    if (hooks.length === 100) {
      fail('github_hooks_truncated', 'У repository слишком много hooks для безопасной exact-проверки.', 409);
    }
    const matches = hooks.filter((hook) => hook?.config?.url === callback);
    if (matches.length > 1) {
      fail('github_hook_ambiguous', 'Для callback найдено несколько GitHub hooks.', 409);
    }
    return matches[0] || null;
  }

  _assertLeaseOwner(saved, lease) {
    if (!lease || lease.accountRef !== saved.accountRef
        || lease.context?.repositoryId !== saved.repositoryId
        || !lease.isCurrent()) {
      fail('github_account_changed', 'GitHub account generation изменилась.', 409);
    }
  }

  async _runReconciliation(saved, context, isCurrent = () => true) {
    const assertCurrent = async () => {
      if (!await isCurrent()) {
        fail('github_account_changed', 'GitHub generation изменилась во время reconciliation.', 409);
      }
    };
    const { owner, repo } = fullNameParts(saved.fullName);
    const guardedArchive = Object.freeze({
      head: async (...args) => {
        await assertCurrent();
        const result = await context.archive.head(...args);
        await assertCurrent();
        return result;
      },
      append: async (...args) => {
        await assertCurrent();
        const result = await context.archive.append(...args);
        await assertCurrent();
        return result;
      },
    });
    await assertCurrent();
    const transport = await context.ingressState.read();
    await assertCurrent();
    const result = await this.reconcile({
      token: saved.token,
      owner,
      repo,
      repositoryId: saved.repositoryId,
      accountRef: saved.accountRef,
      archive: guardedArchive,
      boundary: transport.boundary,
    });
    await assertCurrent();
    await context.ingressState.record(result);
    await assertCurrent();
    if (result.degraded) {
      this._setConnection('degraded', result.degraded);
      fail(result.degraded, 'GitHub reconciliation не достигла безопасной boundary.', 503);
    }
    return result;
  }

  async connect({ owner, repo, token } = {}) {
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
          await this.api.getRepository(trustedToken, trustedOwner, trustedRepo),
        );
        let binding;
        if (pending.accountRef !== null) {
          if (pending.repositoryId !== repository.repositoryId) {
            fail('github_pending_mismatch', 'Pending GitHub connection принадлежит другому repository.', 409);
          }
          binding = await this._bindingForCredentials(pending);
        } else {
          const resolved = await this.bindings.resolveOrCreate([
            1, 'github.com', 'repository', repository.repositoryId,
          ], { select: false });
          binding = resolved.binding;
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
          hook = await this.api.createRepositoryHook(trustedToken, currentName.owner, currentName.repo, {
            url: callback,
            secret: pending.secret,
            active: false,
          });
        }
        assertIssuesOnlyHook(hook);
        const hookId = hookIdOf(hook.id);
        hook = assertManagedHook(await this.api.updateRepositoryHook(
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
          assertManagedHook(await this.api.updateRepositoryHook(
            trustedToken,
            currentName.owner,
            currentName.repo,
            hookId,
            { active: true, url: callback, secret: pending.secret },
          ), { hookId, callback, active: true });
          this._assertLeaseOwner(pending, lease);
          await this.api.pingRepositoryHook(
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
        this._setConnection('degraded', err?.code || 'provider_failure');
        throw err;
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
      createActivationMarker: async ({ nowMs }) => githubActivationMarker({
        afterSeq: await context.archive.head(),
        nowMs,
      }),
    });
  }

  async _restoreOffline(drained, reason) {
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
      return drained.context;
    }
    return this._install(selected, '', reason);
  }

  async _offlineRecord(cleanup, drained) {
    if (cleanup?.accountRef && cleanup?.repositoryId) {
      if (drained?.accountRef === cleanup.accountRef && drained.context) return drained;
      const binding = await this._bindingForCredentials(cleanup);
      const context = await this._contextFor(binding, cleanup.fullName || '');
      return { accountRef: binding.accountRef, context };
    }
    return drained;
  }

  async _cleanupRemoteHook(saved) {
    if (!saved?.token || !saved?.fullName) return { deleted: false, missing: true };
    const { owner, repo } = fullNameParts(saved.fullName);
    let hookId = saved.hookId;
    if (hookId === null) {
      const hook = await this._matchingHook(saved.token, owner, repo, saved.callbackUrl);
      if (!hook) return { deleted: false, missing: true };
      hookId = hookIdOf(hook.id);
    }
    return this.api.deleteRepositoryHook(saved.token, owner, repo, hookId);
  }

  async disconnect() {
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
      let drained = null;
      let offline = null;
      let credentialsCleared = false;
      try {
        // cleanup_pending сначала отзывает public ingress. drain немедленно запрещает
        // новые account leases и ждёт уже начатые операции; marker закрывается только
        // после этого, поэтому поздний append не перескочит end boundary.
        drained = await this.runtime.drain({ reason: 'provider_disconnect' });
        offline = await this._offlineRecord(cleanup, drained);
        if (offline?.context && cleanup.accountRef === offline.accountRef) {
          await this._closeActivation(offline.context, 'provider_disconnect');
        }
        await this._cleanupRemoteHook(cleanup);
        await this.credentials.clear({ cleanupComplete: true });
        credentialsCleared = true;
        await this._restoreOffline(offline, 'offline_after_disconnect');
        this._setConnection('disconnected');
        return this.status();
      } catch (err) {
        await this._restoreOffline(offline || drained, 'cleanup_pending_offline').catch((restoreError) => {
          this.log.error?.({ code: restoreError?.code }, 'github: offline context restore failed');
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

  async forceForget({ confirmOrphanHook = false } = {}) {
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
      let drained = null;
      let offline = null;
      try {
        drained = await this.runtime.drain({ reason: 'provider_force_forget' });
        offline = await this._offlineRecord(cleanup, drained);
        if (offline?.context && cleanup?.accountRef === offline.accountRef) {
          await this._closeActivation(offline.context, 'provider_force_forget');
        }
        await this.credentials.clear({ cleanupComplete: true });
        await this._restoreOffline(offline, 'offline_after_force_forget');
        this._setConnection('disconnected', 'orphan_hook_possible');
        return this.status();
      } catch (err) {
        await this._restoreOffline(offline || drained, 'force_forget_failed_offline').catch(() => {});
        this._setConnection('degraded', err?.code || 'invalid_state');
        throw err;
      }
    });
  }

  async recheck() {
    return this._serialize(async () => {
      const saved = await this.credentials.read();
      if (!saved?.accountRef || !saved?.repositoryId || !saved?.hookId || !saved?.fullName) {
        fail('github_not_connected', 'GitHub repository ещё не подключён.', 409);
      }
      if (saved.state === 'cleanup_pending') {
        fail('github_cleanup_pending', 'Сначала завершите cleanup GitHub hook.', 409);
      }
      const { owner, repo } = fullNameParts(saved.fullName);
      const repository = verifiedRepository(await this.api.getRepository(saved.token, owner, repo));
      if (repository.repositoryId !== saved.repositoryId) {
        fail('github_account_changed', 'GitHub repository identity изменилась.', 409);
      }
      const hook = await this.api.getRepositoryHook(saved.token, owner, repo, saved.hookId);
      const expectedCallback = saved.callbackUrl;
      assertManagedHook(hook, {
        hookId: saved.hookId,
        callback: expectedCallback,
        active: true,
      });
      const lease = this.runtime.acquire();
      try {
        this._assertLeaseOwner(saved, lease);
        await this._runReconciliation(saved, lease.context, () => lease.isCurrent());
        this._assertLeaseOwner(saved, lease);
        if (saved.state === 'connected') this._setConnection('connected');
        await this.api.pingRepositoryHook(saved.token, owner, repo, saved.hookId);
        this._assertLeaseOwner(saved, lease);
      } finally {
        lease.release();
      }
      return this.status();
    });
  }

  async _acceptPing(saved, payload, lease) {
    const repositoryId = normalizeGitHubRepositoryId(payload?.repository?.id, 'ping.repository.id');
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

  async handleWebhook(ingressRef, rawBody, headers) {
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
      if (parsed.payload?.action !== 'opened') {
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
        const result = await lease.context.archive.append({
          transport: { kind: 'webhook', id: headerValue(headers, 'x-github-delivery').toLowerCase() },
          repositoryId: saved.repositoryId,
          issueId: issue.issueId,
          semanticKey: githubIssueSemanticKey(saved.repositoryId, issue.issueId),
          occurredAt: normalized.occurredAt,
          snapshot: parsed.payload.issue,
        });
        await this._requirePluginEnabled();
        if (!lease.isCurrent()) fail('github_account_changed', 'GitHub generation изменилась после append.', 409);
        if (result.inserted) {
          try {
            this.onChanged({ itemRef: null, channel: 'github', status: 'new', taskId: null });
          } catch (err) {
            this.log.warn?.({ err: err?.message }, 'github: archive записан, SSE не отправлен');
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
        if (result.diagnostics.appended > 0) {
          this.onChanged({ itemRef: null, channel: 'github', status: 'new', taskId: null });
        }
        return { ran: true, result };
      } finally {
        lease.release();
      }
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); } catch (err) {
        this.log.error?.({ code: err?.code }, 'github: reconciliation tick failed');
      }
      if (!this.running) return;
      this.timer = setTimeout(loop, this.reconcileIntervalMs);
      this.timer.unref?.();
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
