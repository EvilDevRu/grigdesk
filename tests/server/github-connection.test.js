import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountRuntimeManager } from '../../server/src/lib/accountRuntime.ts';
import { GitHubAccountBindings } from '../../server/src/lib/github/accountBindings.ts';
import { createGitHubAccountContextFactory } from '../../server/src/lib/github/accountContext.ts';
import {
  GitHubConnection,
  GitHubConnectionError,
} from '../../server/src/lib/github/connection.ts';
import { GitHubCredentialsStore } from '../../server/src/lib/github/credentialsStore.ts';

const TOKEN = 'github_pat_connection_private_value_123456';
const OTHER_TOKEN = 'github_pat_other_private_value_654321';
const ACCOUNT = 'acc_connection_github_0001';
const REPOSITORY = '123456';
const FULL_NAME = 'acme/support';
const BASE_URL = 'https://grigdesk.example.test/hooks/github';
const NOW = 1_786_172_400_000;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const clone = (value) => structuredClone(value);

function diagnostics(over = {}) {
  return {
    initialBaseline: false,
    baselineTruncated: false,
    boundaryReached: true,
    exhausted: false,
    limitReached: false,
    pages: 1,
    rows: 0,
    issues: 0,
    pullRequests: 0,
    appended: 0,
    duplicates: 0,
    archiveHeadBefore: 0,
    archiveHead: 0,
    ...over,
  };
}

const reconciliationResult = (over = {}) => ({
  boundary: null,
  advanced: false,
  degraded: null,
  diagnostics: diagnostics(),
  ...over,
});

function fakeContextFactory({ events = [], contexts = new Map() } = {}) {
  const calls = [];
  const factory = async ({ accountRef, repositoryId, repositoryFullName }) => {
    calls.push({ accountRef, repositoryId, repositoryFullName });
    let context = contexts.get(accountRef);
    if (!context) {
      let seq = 0;
      let participation = 'never_activated';
      let activationVersion = 0;
      let boundary = null;
      let records = 0;
      let archiveAppend = async (entry) => {
        seq += 1;
        return { appended: true, inserted: true, duplicate: false, seq, row: entry };
      };
      context = {
        repositoryId,
        repositoryFullName,
        archive: {
          async head() { return seq; },
          async list() { return []; },
          async append(entry) { return archiveAppend(entry); },
          setAppend(fn) { archiveAppend = fn; },
          setHead(value) { seq = value; },
        },
        rules: { async ruleFor() { return null; } },
        inboxState: {
          async read() { return null; },
          async activationWindows() { return []; },
          async activate() {},
          async summary() {
            return {
              participation,
              activationVersion,
              currentEpoch: activationVersion ? 1 : null,
              startedAtMs: activationVersion ? NOW - 1000 : null,
              endedAtMs: participation === 'deactivated' ? NOW : null,
              endReason: participation === 'deactivated' ? 'provider_disconnect' : null,
            };
          },
          async deactivate({ expectedActivationVersion, endReason, createActivationMarker, nowMs }) {
            events.push('close_activation');
            assert.equal(expectedActivationVersion, activationVersion);
            await createActivationMarker({ nowMs });
            participation = 'deactivated';
            activationVersion += 1;
            return this.summary();
          },
          setActive(version = 1) {
            participation = 'active';
            activationVersion = version;
          },
        },
        ingressState: {
          async read() { return { boundary: clone(boundary) }; },
          async record(result) {
            events.push('record_reconciliation');
            records += 1;
            boundary = clone(result.boundary);
          },
          get records() { return records; },
        },
      };
      contexts.set(accountRef, context);
    } else if (repositoryFullName) {
      context.repositoryFullName = repositoryFullName;
    }
    return context;
  };
  factory.calls = calls;
  factory.contexts = contexts;
  return factory;
}

function fakeApi({ events = [] } = {}) {
  const hooks = new Map();
  const counters = {
    getRepository: 0,
    list: 0,
    create: 0,
    update: 0,
    ping: 0,
    delete: 0,
  };
  let nextHook = 700;
  let failGetRepository = null;
  let createFailure = null;
  let deleteFailures = 0;
  let beforeCreate = null;

  const requireToken = (token) => assert.equal(token, TOKEN);
  const hookClone = (hook) => clone(hook);
  const api = {
    hooks,
    counters,
    setGetRepositoryFailure(error) { failGetRepository = error; },
    setCreateFailure(mode, error = Object.assign(new Error('create failed'), { code: 'github_provider_failure' })) {
      createFailure = { mode, error };
    },
    setDeleteFailures(count) { deleteFailures = count; },
    setBeforeCreate(callback) { beforeCreate = callback; },

    async getRepository(token) {
      requireToken(token);
      counters.getRepository += 1;
      if (failGetRepository) {
        const error = failGetRepository;
        failGetRepository = null;
        throw error;
      }
      return { id: Number(REPOSITORY), full_name: FULL_NAME, has_issues: true };
    },
    async listRepositoryHooks(token) {
      requireToken(token);
      counters.list += 1;
      return [...hooks.values()].map(hookClone);
    },
    async getRepositoryHook(token, owner, repo, hookId) {
      requireToken(token);
      const hook = hooks.get(String(hookId));
      if (!hook) throw Object.assign(new Error('not found'), { code: 'github_not_found' });
      return hookClone(hook);
    },
    async createRepositoryHook(token, owner, repo, input) {
      requireToken(token);
      counters.create += 1;
      await beforeCreate?.(input);
      if (createFailure?.mode === 'before') {
        const { error } = createFailure;
        createFailure = null;
        throw error;
      }
      const id = String(nextHook++);
      const hook = {
        id: Number(id),
        active: input.active,
        events: ['issues'],
        config: { url: input.url, content_type: 'json', insecure_ssl: '0' },
      };
      hooks.set(id, hook);
      events.push('remote_create');
      if (createFailure?.mode === 'after') {
        const { error } = createFailure;
        createFailure = null;
        throw error;
      }
      return hookClone(hook);
    },
    async updateRepositoryHook(token, owner, repo, hookId, changes) {
      requireToken(token);
      counters.update += 1;
      const hook = hooks.get(String(hookId));
      if (!hook) throw Object.assign(new Error('not found'), { code: 'github_not_found' });
      if (Object.hasOwn(changes, 'active')) hook.active = changes.active;
      if (changes.url) hook.config.url = changes.url;
      events.push(changes.active ? 'remote_activate' : 'remote_deactivate');
      return hookClone(hook);
    },
    async pingRepositoryHook(token) {
      requireToken(token);
      counters.ping += 1;
      events.push('remote_ping_request');
    },
    async deleteRepositoryHook(token, owner, repo, hookId) {
      requireToken(token);
      counters.delete += 1;
      events.push('remote_delete');
      if (deleteFailures > 0) {
        deleteFailures -= 1;
        throw Object.assign(new Error(`provider unavailable; ${TOKEN} must stay private`), {
          code: 'github_provider_failure',
        });
      }
      const deleted = hooks.delete(String(hookId));
      return { deleted, missing: !deleted };
    },
  };
  return api;
}

async function fixture(t, {
  enabled = () => true,
  events = [],
  api = fakeApi({ events }),
  contextFactory = fakeContextFactory({ events }),
  runtime = null,
  reconcileImpl = null,
  log = { error() {}, warn() {} },
  onChanged = () => {},
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-connection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = NOW;
  const credentials = new GitHubCredentialsStore({
    file: path.join(dir, 'credentials.json'),
    now: () => now++,
  });
  const bindings = new GitHubAccountBindings({
    file: path.join(dir, 'bindings.json'),
    randomBytes: (size) => Buffer.alloc(size, 0x31),
    now: () => now++,
  });
  const ownRuntime = runtime || new AccountRuntimeManager({
    channel: 'github',
    onDrain: async ({ reason }) => events.push(`drain:${reason}`),
  });
  let currentReconcile = reconcileImpl || (async () => reconciliationResult());
  const reconcile = (...args) => currentReconcile(...args);
  let randomCall = 0;
  const connection = new GitHubConnection({
    credentials,
    bindings,
    accountContextFor: contextFactory,
    webhookBaseUrl: BASE_URL,
    runtime: ownRuntime,
    api,
    reconcile,
    enabled,
    randomBytes(size) {
      randomCall += 1;
      return Buffer.alloc(size, 0x40 + randomCall);
    },
    now: () => now++,
    onChanged,
    log,
    reconcileIntervalMs: 10_000,
  });
  return {
    dir,
    connection,
    credentials,
    bindings,
    runtime: ownRuntime,
    api,
    contextFactory,
    events,
    setReconcile(fn) { currentReconcile = fn; },
  };
}

function webhook(saved, { event = 'ping', payload = null, validSignature = true } = {}) {
  const body = Buffer.from(JSON.stringify(payload || {
    zen: 'Keep it logically awesome.',
    repository: { id: Number(REPOSITORY), full_name: FULL_NAME },
  }));
  const signature = createHmac('sha256', saved.secret).update(body).digest('hex');
  return {
    body,
    headers: {
      'x-hub-signature-256': `sha256=${validSignature ? signature : '0'.repeat(64)}`,
      'x-github-event': event,
      'x-github-delivery': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'x-github-hook-id': saved.hookId,
      'x-github-hook-installation-target-type': 'repository',
      'x-github-hook-installation-target-id': saved.repositoryId,
    },
  };
}

async function connectWaitingPing(env) {
  const status = await env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN });
  const saved = await env.credentials.read();
  assert.equal(status.connection, 'connecting');
  assert.equal(saved.state, 'pending');
  assert.ok(saved.hookId);
  return saved;
}

async function acceptPing(env, saved = null) {
  const current = saved || await env.credentials.read();
  const request = webhook(current);
  return env.connection.handleWebhook(current.ingressRef, request.body, request.headers);
}

test('connect остаётся pending до единственного signed ping и не раскрывает credentials', async (t) => {
  const env = await fixture(t);
  const saved = await connectWaitingPing(env);

  assert.equal((await env.connection.status()).connection, 'connecting');
  assert.equal((await env.connection.tick()).reason, 'not_connected');
  assert.equal((await env.credentials.read()).state, 'pending');

  const bad = webhook(saved, { validSignature: false });
  await assert.rejects(
    () => env.connection.handleWebhook(saved.ingressRef, bad.body, bad.headers),
    (error) => error.code === 'github_signature_invalid',
  );
  assert.equal((await env.credentials.read()).state, 'pending');

  const opened = webhook(saved, {
    event: 'issues',
    payload: {
      action: 'opened',
      repository: { id: Number(REPOSITORY), full_name: FULL_NAME },
      issue: {
        id: 501,
        number: 7,
        title: 'До ping',
        body: null,
        created_at: '2026-08-09T12:00:00Z',
        user: { id: 9, login: 'reporter' },
      },
    },
  });
  await assert.rejects(
    () => env.connection.handleWebhook(saved.ingressRef, opened.body, opened.headers),
    (error) => error.code === 'github_ingress_not_ready',
  );
  assert.equal((await env.credentials.read()).state, 'pending');

  assert.deepEqual(await acceptPing(env, saved), {
    accepted: true, kind: 'ping', inserted: false,
  });
  assert.equal((await env.credentials.read()).state, 'connected');
  assert.equal((await env.connection.status()).connection, 'connected');

  const publicJson = JSON.stringify(await env.connection.status());
  for (const forbidden of [
    TOKEN,
    saved.secret,
    saved.accountRef,
    saved.ingressRef,
    saved.callbackUrl,
    'github_pat_',
    'webhook-secret',
  ]) {
    assert.equal(publicJson.includes(forbidden), false);
  }
  assert.equal(env.api.counters.create, 1);
  assert.equal(env.api.counters.ping, 1, 'REST ping request сам не переводит lifecycle в connected');
});

test('pending draft после crash повторяется с теми же секретами и без remote orphan', async (t) => {
  const env = await fixture(t);
  env.api.setGetRepositoryFailure(Object.assign(new Error('temporary'), { code: 'github_provider_failure' }));
  await assert.rejects(
    () => env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN }),
    (error) => error.code === 'github_provider_failure',
  );
  const draft = await env.credentials.read();
  assert.equal(draft.state, 'pending');
  assert.equal(draft.accountRef, null);
  assert.equal(draft.repositoryId, null);
  assert.equal(draft.hookId, null);
  assert.equal(env.api.hooks.size, 0);

  const restarted = new GitHubConnection({
    credentials: env.credentials,
    bindings: env.bindings,
    accountContextFor: env.contextFactory,
    webhookBaseUrl: BASE_URL,
    runtime: new AccountRuntimeManager({ channel: 'github' }),
    api: env.api,
    reconcile: async () => reconciliationResult(),
    randomBytes() { throw new Error('resume не должен менять ingressRef/secret'); },
    now: () => NOW + 100,
    reconcileIntervalMs: 10_000,
  });
  await restarted.initialize();
  await assert.rejects(
    () => restarted.connect({ owner: 'acme', repo: 'support', token: OTHER_TOKEN }),
    (error) => error.code === 'github_pending_mismatch'
      && !error.message.includes(TOKEN)
      && !error.message.includes(OTHER_TOKEN),
  );
  await restarted.connect({ owner: 'acme', repo: 'support', token: TOKEN });
  const resumed = await env.credentials.read();
  assert.equal(resumed.ingressRef, draft.ingressRef);
  assert.equal(resumed.secret, draft.secret);
  assert.ok(resumed.hookId);
  assert.equal(env.api.hooks.size, 1);
});

test('crash до verified WAL не переключает selected account; resume reuse-ит binding', async (t) => {
  const env = await fixture(t);
  const originalUpdate = env.credentials.update.bind(env.credentials);
  let crash = true;
  env.credentials.update = async (patch) => {
    if (crash && patch.accountRef) {
      crash = false;
      throw Object.assign(new Error('simulated crash before verified WAL'), {
        code: 'simulated_crash',
      });
    }
    return originalUpdate(patch);
  };

  await assert.rejects(
    () => env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN }),
    (error) => error.code === 'simulated_crash',
  );
  assert.equal((await env.credentials.read()).accountRef, null);
  assert.equal(await env.bindings.selected(), null,
    'selected pointer не публикуется раньше verified credentials + metadata');
  assert.equal((await env.bindings.read()).bindings.length, 1,
    'unselected immutable binding остаётся безопасным resume handle');
  assert.equal(env.api.hooks.size, 0);

  const restarted = new GitHubConnection({
    credentials: env.credentials,
    bindings: env.bindings,
    accountContextFor: env.contextFactory,
    webhookBaseUrl: BASE_URL,
    runtime: new AccountRuntimeManager({ channel: 'github' }),
    api: env.api,
    reconcile: async () => reconciliationResult(),
    now: () => NOW + 100,
    reconcileIntervalMs: 10_000,
  });
  await restarted.initialize();
  await restarted.connect({ owner: 'acme', repo: 'support', token: TOKEN });
  const selected = await env.bindings.selected();
  assert.equal(selected.accountRef, (await env.credentials.read()).accountRef);
  assert.equal((await env.bindings.read()).bindings.length, 1);
  assert.equal(env.api.hooks.size, 1);
});

test('WAL verified_no_hook предшествует create; crash после remote create resume-ит exact callback', async (t) => {
  const env = await fixture(t);
  env.api.setBeforeCreate(async () => {
    const beforeRemote = await env.credentials.read();
    assert.equal(beforeRemote.state, 'pending');
    assert.equal(beforeRemote.repositoryId, REPOSITORY);
    assert.equal(beforeRemote.fullName, FULL_NAME);
    assert.ok(beforeRemote.accountRef);
    assert.equal(beforeRemote.hookId, null);
  });
  env.api.setCreateFailure('after');
  await assert.rejects(
    () => env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN }),
    (error) => error.code === 'github_provider_failure',
  );
  const crashed = await env.credentials.read();
  assert.equal(crashed.repositoryId, REPOSITORY);
  assert.equal(crashed.hookId, null);
  assert.equal(env.api.hooks.size, 1, 'remote side effect успел завершиться');

  const restarted = new GitHubConnection({
    credentials: env.credentials,
    bindings: env.bindings,
    accountContextFor: env.contextFactory,
    webhookBaseUrl: '',
    runtime: new AccountRuntimeManager({ channel: 'github' }),
    api: env.api,
    reconcile: async () => reconciliationResult(),
    now: () => NOW + 100,
    reconcileIntervalMs: 10_000,
  });
  await restarted.initialize();
  await restarted.connect({ owner: 'acme', repo: 'support', token: TOKEN });
  assert.equal(env.api.counters.create, 1, 'resume переиспользовал hook, не создал второй');
  assert.equal(env.api.hooks.size, 1);
  assert.equal((await env.credentials.read()).hookId, '700');
  assert.equal(env.api.hooks.get('700').config.url, crashed.callbackUrl,
    'resume использует durable callback и не зависит от текущего configured base');
});

test('waiting-ping resume не создаёт замену изменённому managed hook и сохраняет cleanup handle', async (t) => {
  const env = await fixture(t);
  const saved = await connectWaitingPing(env);
  env.api.hooks.get(saved.hookId).config.url = 'https://attacker.example/changed';
  const createsBefore = env.api.counters.create;

  await assert.rejects(
    () => env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN }),
    (error) => error.code === 'github_hook_changed',
  );
  assert.equal(env.api.counters.create, createsBefore,
    'изменённый hook не оставляется orphan рядом с новой копией');
  assert.equal((await env.credentials.read()).hookId, saved.hookId);

  await env.connection.disconnect();
  assert.equal(env.api.hooks.size, 0, 'disconnect удаляет сохранённый exact hookId даже после drift');
});

test('connect не принимает provider response без exact issues/json/TLS hook contract', async (t) => {
  const api = fakeApi();
  const originalUpdate = api.updateRepositoryHook.bind(api);
  api.updateRepositoryHook = async (...args) => {
    const hook = await originalUpdate(...args);
    hook.events = ['issues', 'push'];
    hook.config.insecure_ssl = '1';
    return hook;
  };
  const env = await fixture(t, { api });

  await assert.rejects(
    () => env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN }),
    (error) => error.code === 'github_hook_changed',
  );
  assert.equal((await env.credentials.read()).state, 'pending');
  assert.equal(env.api.counters.ping, 0);
});

test('disconnect из обоих verified_no_hook crash windows exact-cleanup-ит callback', async (t) => {
  await t.test('remote create ещё не начался', async (st) => {
    const env = await fixture(st);
    env.api.setCreateFailure('before');
    await assert.rejects(
      () => env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN }),
      (error) => error.code === 'github_provider_failure',
    );
    assert.equal((await env.credentials.read()).hookId, null);
    assert.equal(env.api.hooks.size, 0);
    await env.connection.disconnect();
    assert.equal(env.api.counters.list >= 2, true, 'disconnect сделал exact callback lookup');
    assert.equal(await env.credentials.read(), null);
  });

  await t.test('remote create завершился, hookId не записан', async (st) => {
    const env = await fixture(st);
    env.api.setCreateFailure('after');
    await assert.rejects(
      () => env.connection.connect({ owner: 'acme', repo: 'support', token: TOKEN }),
      (error) => error.code === 'github_provider_failure',
    );
    assert.equal((await env.credentials.read()).hookId, null);
    assert.equal(env.api.hooks.size, 1);
    const restarted = new GitHubConnection({
      credentials: env.credentials,
      bindings: env.bindings,
      accountContextFor: env.contextFactory,
      webhookBaseUrl: '',
      runtime: new AccountRuntimeManager({ channel: 'github' }),
      api: env.api,
      reconcile: async () => reconciliationResult(),
      now: () => NOW + 100,
      reconcileIntervalMs: 10_000,
    });
    await restarted.initialize();
    await restarted.disconnect();
    assert.equal(env.api.counters.delete, 1);
    assert.equal(env.api.hooks.size, 0);
    assert.equal(await env.credentials.read(), null);
  });
});

test('disconnect делает local revoke + drain до activation close и remote cleanup', async (t) => {
  const events = [];
  const drainStarted = deferred();
  const runtime = new AccountRuntimeManager({
    channel: 'github',
    onDrain: async ({ reason }) => {
      events.push(`drain:${reason}`);
      if (reason === 'provider_disconnect') drainStarted.resolve();
    },
  });
  const env = await fixture(t, { events, runtime });
  const saved = await connectWaitingPing(env);
  await acceptPing(env, saved);
  env.runtime.snapshot().context.inboxState.setActive(1);
  const held = env.connection.acquireInboxLease();

  const originalUpdate = env.credentials.update.bind(env.credentials);
  env.credentials.update = async (patch) => {
    const result = await originalUpdate(patch);
    if (patch.state === 'cleanup_pending') events.push('local_revoke');
    return result;
  };
  const originalClear = env.credentials.clear.bind(env.credentials);
  env.credentials.clear = async (input) => {
    const result = await originalClear(input);
    events.push('credentials_clear');
    return result;
  };

  const disconnecting = env.connection.disconnect();
  await drainStarted.promise;
  assert.equal(held.isCurrent(), false);
  assert.equal(env.api.counters.delete, 0, 'remote cleanup ждёт старые leases');
  assert.deepEqual(events.slice(-2), ['local_revoke', 'drain:provider_disconnect']);
  held.release();

  const status = await disconnecting;
  assert.equal(status.connection, 'disconnected');
  assert.equal(await env.credentials.read(), null);
  assert.equal(env.api.hooks.size, 0);
  assert.deepEqual(events.slice(-5), [
    'local_revoke',
    'drain:provider_disconnect',
    'close_activation',
    'remote_delete',
    'credentials_clear',
  ]);
  const offline = env.connection.acquireInboxLease();
  assert.equal(offline.accountRef, saved.accountRef);
  offline.release();
});

test('remote cleanup failure сохраняет credentials для retry; force-forget требует confirm', async (t) => {
  const env = await fixture(t);
  const saved = await connectWaitingPing(env);
  await acceptPing(env, saved);
  env.runtime.snapshot().context.inboxState.setActive(1);
  env.api.setDeleteFailures(1);

  let cleanupError;
  try {
    await env.connection.disconnect();
  } catch (error) {
    cleanupError = error;
  }
  assert.equal(cleanupError.code, 'github_cleanup_pending');
  assert.equal(cleanupError.statusCode, 503);
  assert.equal(cleanupError.message.includes(TOKEN), false);
  assert.equal((await env.credentials.read()).state, 'cleanup_pending');
  assert.equal(env.api.hooks.size, 1);
  assert.equal(env.runtime.snapshot().accountRef, saved.accountRef,
    'local offline read context восстановлен несмотря на remote failure');

  await assert.rejects(
    () => env.connection.forceForget(),
    (error) => error.code === 'github_force_forget_confirmation',
  );
  await env.connection.disconnect();
  assert.equal(env.api.counters.delete, 2);
  assert.equal(env.api.hooks.size, 0);
  assert.equal(await env.credentials.read(), null);

  const orphanEnv = await fixture(t);
  const orphanSaved = await connectWaitingPing(orphanEnv);
  await acceptPing(orphanEnv, orphanSaved);
  orphanEnv.api.setDeleteFailures(1);
  await assert.rejects(() => orphanEnv.connection.disconnect());
  const deletesBefore = orphanEnv.api.counters.delete;
  const forgotten = await orphanEnv.connection.forceForget({ confirmOrphanHook: true });
  assert.equal(forgotten.connection, 'disconnected');
  assert.equal(forgotten.reason, 'orphan_hook_possible');
  assert.equal(orphanEnv.api.counters.delete, deletesBefore, 'force-forget не притворяется remote cleanup');
  assert.equal(orphanEnv.api.hooks.size, 1);
  assert.equal(await orphanEnv.credentials.read(), null);
});

test('plugin off блокирует webhook и tick до credentials/archive/network', async () => {
  const counters = { credentials: 0, selected: 0, context: 0, reconcile: 0, network: 0 };
  const connection = new GitHubConnection({
    credentials: {
      async read() { counters.credentials += 1; throw new Error('не читать'); },
      async publicView() { return { configured: false, state: null }; },
    },
    bindings: {
      async selected() { counters.selected += 1; return null; },
    },
    accountContextFor: async () => { counters.context += 1; return {}; },
    webhookBaseUrl: BASE_URL,
    runtime: new AccountRuntimeManager({ channel: 'github' }),
    enabled: async () => false,
    api: {
      getRepository: async () => { counters.network += 1; },
    },
    reconcile: async () => { counters.reconcile += 1; },
    reconcileIntervalMs: 10_000,
  });

  assert.deepEqual(await connection.tick(), { ran: false, reason: 'plugin_disabled' });
  await assert.rejects(
    () => connection.handleWebhook('anything', Buffer.from('not-json'), {}),
    (error) => error instanceof GitHubConnectionError
      && error.code === 'github_plugin_disabled'
      && error.statusCode === 404,
  );
  assert.deepEqual(counters, {
    credentials: 0, selected: 0, context: 0, reconcile: 0, network: 0,
  });
});

test('disable во время reconciliation отбрасывает provider result до archive commit', async (t) => {
  let enabled = true;
  const env = await fixture(t, { enabled: () => enabled });
  const saved = await connectWaitingPing(env);
  await acceptPing(env, saved);
  const context = env.runtime.snapshot().context;
  const started = deferred();
  const finish = deferred();
  let appends = 0;
  context.archive.setAppend(async () => {
    appends += 1;
    return { appended: true, inserted: true, duplicate: false, seq: 1 };
  });
  env.setReconcile(async ({ archive }) => {
    started.resolve();
    await finish.promise;
    await archive.append({ simulated: true });
    return reconciliationResult();
  });

  const ticking = env.connection.tick();
  await started.promise;
  enabled = false;
  finish.resolve();
  await assert.rejects(
    () => ticking,
    (error) => error.code === 'github_plugin_disabled',
  );
  assert.equal(appends, 0, 'guard проверяется внутри reconciliation перед каждым append');
});

test('generation race во время reconciliation не commit-ит cursor', async (t) => {
  const env = await fixture(t);
  const saved = await connectWaitingPing(env);
  await acceptPing(env, saved);
  const context = env.runtime.snapshot().context;
  const recordsBefore = context.ingressState.records;
  const started = deferred();
  const finish = deferred();
  let archiveAppends = 0;
  context.archive.setAppend(async () => {
    archiveAppends += 1;
    return { appended: true, inserted: true, duplicate: false, seq: 1 };
  });
  env.setReconcile(async ({ archive }) => {
    started.resolve();
    await finish.promise;
    await archive.append({ simulated: true });
    return reconciliationResult();
  });

  const ticking = env.connection.tick();
  await started.promise;
  const draining = env.runtime.drain({ reason: 'generation_test' });
  await Promise.resolve();
  finish.resolve();
  await assert.rejects(
    () => ticking,
    (error) => error.code === 'github_account_changed' && error.statusCode === 409,
  );
  await draining;
  assert.equal(archiveAppends, 0,
    'stale generation отбрасывается внутри reconciler до archive append');
  assert.equal(context.ingressState.records, recordsBefore,
    'stale reconciliation отбрасывается до durable cursor record');
});

test('generation race после webhook append не публикует поздний success', async (t) => {
  let changed = 0;
  const env = await fixture(t, { onChanged: () => { changed += 1; } });
  const saved = await connectWaitingPing(env);
  await acceptPing(env, saved);
  const context = env.runtime.snapshot().context;
  const started = deferred();
  const finish = deferred();
  let durableAppends = 0;
  context.archive.setAppend(async () => {
    started.resolve();
    await finish.promise;
    durableAppends += 1;
    return { appended: true, inserted: true, duplicate: false, seq: 1 };
  });
  const opened = webhook(await env.credentials.read(), {
    event: 'issues',
    payload: {
      action: 'opened',
      repository: { id: Number(REPOSITORY), full_name: FULL_NAME },
      issue: {
        id: 7001,
        number: 70,
        title: 'Generation race',
        body: null,
        created_at: '2026-08-09T12:00:00Z',
        user: { id: 9, login: 'reporter' },
      },
    },
  });

  const accepting = env.connection.handleWebhook(
    saved.ingressRef,
    opened.body,
    opened.headers,
  );
  await started.promise;
  const draining = env.runtime.drain({ reason: 'generation_test' });
  await Promise.resolve();
  finish.resolve();
  await assert.rejects(
    () => accepting,
    (error) => error.code === 'github_account_changed',
  );
  await draining;
  assert.equal(durableAppends, 1, 'append уже durable и будет semantic-dedupe на provider retry');
  assert.equal(changed, 0, 'stale generation не публикует inbox-changed/success');
});

test('restart без credentials устанавливает selected account из durable fullName metadata offline', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-offline-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bindings = new GitHubAccountBindings({
    file: path.join(dir, 'bindings.json'),
    randomBytes: (size) => Buffer.alloc(size, 0x55),
    now: () => NOW,
  });
  const { binding } = await bindings.resolveOrCreate([
    1, 'github.com', 'repository', REPOSITORY,
  ]);
  const accountContextFor = createGitHubAccountContextFactory({
    dir: path.join(dir, 'github'),
    now: () => NOW,
  });
  await accountContextFor({
    accountRef: binding.accountRef,
    repositoryId: REPOSITORY,
    repositoryFullName: FULL_NAME,
  });
  const credentials = new GitHubCredentialsStore({
    file: path.join(dir, 'credentials.json'),
    now: () => NOW,
  });
  let network = 0;
  const connection = new GitHubConnection({
    credentials,
    bindings,
    accountContextFor,
    webhookBaseUrl: BASE_URL,
    runtime: new AccountRuntimeManager({ channel: 'github' }),
    api: { getRepository: async () => { network += 1; } },
    reconcile: async () => { network += 1; },
    reconcileIntervalMs: 10_000,
  });

  const status = await connection.initialize();
  assert.equal(status.connection, 'disconnected');
  assert.equal(network, 0);
  const lease = connection.acquireInboxLease();
  assert.equal(lease.accountRef, binding.accountRef);
  assert.equal(lease.context.repositoryId, REPOSITORY);
  assert.equal(lease.context.repositoryFullName, FULL_NAME);
  assert.equal(Object.hasOwn(lease.context, 'token'), false);
  assert.equal(Object.hasOwn(lease.context, 'secret'), false);
  lease.release();
});
