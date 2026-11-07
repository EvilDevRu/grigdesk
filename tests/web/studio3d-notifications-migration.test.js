import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { studioBrowserFixture } from './helpers/studio3dPluginBackground.js';
import { studioIntegrationTest, studioUntil } from '../server/helpers/studio3dPluginFixture.js';

const UNIT = {
  one: 'кредит',
  few: 'кредита',
  many: 'кредитов',
};

/**
 * Сохраняет прежний WA task DTO; mocked tasks port не создаёт сотни оплачиваемых заказов.
 * Snapshot/live проходят настоящую P projection, core emit, SSE decoder и общий alert center.
 */
function terminalRow(patch = {}) {
  return {
    intentId: randomUUID(),
    childId: 'child-1',
    modelId: 'other',
    modelName: 'Другой куб',
    versionId: 'v01-model',
    label: 'Модель',
    provider: 'tripo',
    status: 'ready',
    progress: 100,
    etaSeconds: null,
    estimated: 30,
    actual: 30,
    paymentState: 'charged',
    unit: UNIT,
    waitReason: null,
    retryAvailable: false,
    retryReason: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

/**
 * Один и тот же public notification payload создаётся серверной projection до доставки.
 * Тест вызывает переданный core broadcast port, не создавая дополнительного browser канала.
 */
async function emitTerminal(f) {
  const [item] = await f.server.studio3d.notifications(new AbortController().signal);

  assert.ok(item);
  f.server.studio3d.options.broadcast('notification', item);
  await f.settle();

  return item;
}

function integration(name, callback) {
  return studioIntegrationTest(test, name, callback, { timeout: 30000 });
}

integration('WA-03/04/06 общий bridge: один тост, plugin target, viewing и loadTasks без второго producer',
  async (t) => {
    const f = await studioBrowserFixture(t);
    let row = terminalRow();
    let toasts = [];
    let opened;
    const off = f.host.ui.subscribeToasts((items) => toasts = items);

    t.after(off);
    t.after(() => f.host.alerts.setAlertTargetOpener(null));
    f.host.alerts.setAlertTargetOpener((target) => opened = target);
    t.mock.method(f.server.studio3d.context.jobs, 'tasks', async () => [row]);
    await f.login();
    await f.ready();
    await studioUntil(async () => toasts.length, (count) => count === 1);
    await emitTerminal(f);
    await emitTerminal(f);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].tone, 'accent');
    await toasts[0].actions.find((action) => action.id === 'open').run();
    assert.deepEqual(opened, {
      kind: 'plugin',
      pluginId: 'studio3d',
      params: { model: 'other', version: 'v01-model' },
    });
    assert.equal(f.counts().panel, 0);
    f.emit('hello', {});
    await f.settle();
    assert.equal(toasts.length, 1);

    const lease = await f.acquire();
    const session = await f.product.session(lease.context);

    lease.context.notifications.setViewing('model:visible');
    await session.store.loadTasks();
    row = terminalRow({
      modelId: 'visible',
      versionId: 'v02-visible',
      status: 'failed',
      error: {
        kind: 'network',
        message: 'Ошибка задачи',
        detail: null,
      },
    });
    await session.store.loadTasks();
    await emitTerminal(f);
    assert.equal(toasts.length, 1);
    lease.release();
    assert.equal(toasts.length, 1);
    row = { ...row, intentId: randomUUID() };
    await emitTerminal(f);
    assert.equal(toasts.length, 2);
    assert.equal(f.sources.filter((source) => !source.closed).length, 1);
  });

/**
 * Новая bootstrap instance читает persistent seen из того же браузерного профиля.
 * Модуль панели не импортируется; это проверка reload контракта bridge, не установки package.
 */
function reloadBridge(f) {
  f.dispose();

  const router = {
    currentRoute: f.host.vue.ref({
      path: '/chats',
      meta: {},
      params: {},
    }),
    push: async () => {},
  };

  const pinia = f.host.pinia.createPinia();
  const auth = f.host.auths.useAuthStore(pinia);
  const shell = f.host.shells.useShellStore(pinia);

  auth.$patch({
    ready: true,
    authenticated: true,
    clientScope: f.authStore.clientScope,
  });
  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'fixture-profile' } };

  return f.host.installPluginRuntime(pinia, router, {
    subscribe: f.host.sse.sseSubscribe,
    backgroundImport: async (url) => {
      if (url === 'vue') {
        return f.host.vue;
      }
      if (url === '@grigdesk/ui') {
        return f.host.ui;
      }

      return f.product.background();
    },
    loadPluginModule: async () => assert.fail('Reload уведомлений не импортирует UI.'),
  });
}

integration('WA-11 общий bridge: reload не повторяет исход, seen ограничен500 и failed сохраняет текст',
  async (t) => {
    const f = await studioBrowserFixture(t, { panel: false });
    let row = terminalRow();
    let toasts = [];
    const off = f.host.ui.subscribeToasts((items) => toasts = items);

    t.after(off);
    t.mock.method(f.server.studio3d.context.jobs, 'tasks', async () => [row]);
    await f.login('notification-user');
    await f.ready();
    await studioUntil(async () => toasts.length, (count) => count === 1);
    assert.equal(toasts.length, 1);

    const snapshots = f.requests.filter((request) => request.path === '/api/plugins/notifications').length;
    const dispose = reloadBridge(f);

    t.after(dispose);
    await f.ready();
    await studioUntil(async () => f.requests.filter((request) =>
      request.path === '/api/plugins/notifications').length, (count) => count > snapshots);
    await f.settle();
    assert.equal(toasts.length, 0);
    await emitTerminal(f);
    assert.equal(toasts.length, 0);

    for (let index = 0; index < 510; index += 1) {
      row = terminalRow();
      await emitTerminal(f);
    }

    const keys = JSON.parse(localStorage.getItem(
      'grigdesk-plugin-notifications-seen:notification-user:studio3d'));

    assert.equal(keys.length, 500);
    assert.equal(new Set(keys).size, 500);
    row = terminalRow({ status: 'failed' });
    await emitTerminal(f);
    assert.equal(f.host.ui.resolveUiText(toasts.at(-1).title), 'Не получилось: «Другой куб»');
    assert.equal(f.counts().panel, 0);
    assert.equal(f.fake.requests.filter((request) => request.path.endsWith('/text-to-model')).length, 0);
    dispose();
  });

/**
 * Старое browser намерение содержит полный запрос и канонический fingerprint прежнего owner.
 * Его libraryId/UUID/at не меняются при переходе первой UI session в библиотеку B.
 */
async function pendingDraft(f) {
  const quoted = await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Сохранённая форма A' },
  });

  assert.equal(quoted.statusCode, 200, quoted.body);

  const quote = quoted.json();
  const key = randomUUID();
  const owner = f.authStore.clientScope;
  const snapshot = {
    provider: 'tripo',
    operation: 'text-to-model',
    values: quote.validation.values,
    expectedPrice: quote.quote.total,
    libraryId: f.libraryId,
    name: 'Сохранённая форма A',
  };

  return {
    key,
    owner,
    libraryId: f.libraryId,
    fingerprint: f.product.inspector.storage.studioFingerprint({
      owner,
      kind: 'run',
      modelId: undefined,
      versionId: undefined,
      request: snapshot,
    }),
    at: Date.now(),
    kind: 'run',
    request: { ...snapshot, idempotencyKey: key },
  };
}

integration('UI-ADAPTERS первая session после settings A→B отправляет run/retry/batch B и отвергает marker A',
  async (t) => {
    const f = await studioBrowserFixture(t);

    await f.login();
    await f.ready();

    const lease = await f.acquire();
    const session = await f.product.session(lease.context);
    const originalStore = session.store;
    const pending = await pendingDraft(f);
    const generation = f.plugins.byId('studio3d').runtimeGeneration;

    t.after(lease.release);
    await f.storage.put(pending);
    f.hook((request) => request.path.includes(`/jobs/${pending.key}?`)
      ? Response.json({ error: 'fixture_unavailable' }, { status: 503 }) : undefined);
    await f.service().recoverPending();

    const settings = await f.plugins.saveSettings('studio3d', {
      ...f.plugins.byId('studio3d').values,
      libraryDir: path.join(f.root, 'ui-library-b'),
    });

    assert.equal(settings.ok, true, JSON.stringify(settings));

    const state = await studioUntil(async () => originalStore.state,
      (value) => value?.library.ok && value.libraryId !== pending.libraryId);
    const libraryId = state.libraryId;
    const quote = await f.call('POST', '/quote', {
      libraryId,
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'Форма B' },
    });

    assert.equal(quote.statusCode, 200, quote.body);

    const quoted = quote.json();
    const input = {
      provider: 'tripo',
      operation: 'text-to-model',
      values: quoted.validation.values,
      expectedPrice: quoted.quote.total,
      name: 'Форма B',
    };
    const runKey = randomUUID();

    f.fake.respondOnce('POST', /text-to-model/, 400, { code: 1003, message: 'fixture params' });

    const result = await originalStore.run(libraryId, input, runKey);

    await f.server.studio3d.context.jobs.tick();

    const retryKey = randomUUID();
    const retry = await originalStore.retry(libraryId, result.model.id, result.versions[0].id,
      input.expectedPrice, retryKey);
    const batchQuote = await originalStore.batchQuote([{
      provider: input.provider,
      operation: input.operation,
      values: input.values,
      name: 'Строка B',
      expectedPrice: input.expectedPrice,
      project: null,
      category: null,
    }]);
    const batchKey = randomUUID();
    const batch = await originalStore.batchRun(libraryId, {
      snapshot: batchQuote.snapshot,
      snapshotHash: batchQuote.snapshotHash,
    }, batchKey);
    const posts = f.requests.filter((request) => request.method === 'POST'
      && (request.path === '/api/ext/studio3d/run' || request.path.endsWith('/retry')
        || request.path === '/api/ext/studio3d/batches/run'));

    assert.equal(retry.libraryId, libraryId);
    assert.equal(batch.libraryId, libraryId);
    assert.equal(posts.length, 3);
    assert.deepEqual(posts.map((request) => JSON.parse(request.init.body).idempotencyKey),
      [runKey, retryKey, batchKey]);
    assert.equal(posts.every((request) => JSON.parse(request.init.body).libraryId === libraryId), true);
    assert.equal(f.plugins.byId('studio3d').runtimeGeneration, generation);
    assert.equal((await f.product.session(lease.context)).store, originalStore);
    assert.deepEqual(await f.storage.list(pending.owner), [pending]);

    const saved = JSON.stringify(await f.storage.list(pending.owner));

    await assert.rejects(originalStore.run(pending.libraryId, input),
      (error) => error.code === 'stale_library');
    await assert.rejects(originalStore.retry(pending.libraryId, result.model.id, result.versions[0].id,
      input.expectedPrice), (error) => error.code === 'stale_library');
    await assert.rejects(originalStore.batchRun(pending.libraryId, {
      snapshot: batchQuote.snapshot,
      snapshotHash: batchQuote.snapshotHash,
    }), (error) => error.code === 'stale_library');
    assert.equal(JSON.stringify(await f.storage.list(pending.owner)), saved);
    assert.equal(f.requests.filter((request) => request.method === 'POST'
      && (request.path === '/api/ext/studio3d/run' || request.path.endsWith('/retry')
        || request.path === '/api/ext/studio3d/batches/run')).length, 3);
  });
