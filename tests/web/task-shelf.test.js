import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

let sharedModule;
let sharedModuleError;

try {
  sharedModule = await import('../../web/src/shared/taskShelfDecision.ts');
} catch (error) {
  sharedModuleError = error;
}

let storeModule;
let storeModuleError;

try {
  storeModule = await compileModule(webFile('src/stores/taskShelf.ts'), {
    stubs: {
      '../shared/alerts.ts': 'export const alertUser = () => true;'
        + ' export const dismissAlert = () => {};',
    },
  });
} catch (error) {
  storeModuleError = error;
}

function decision(snapshot, observed) {
  const operation = sharedModule?.default
    || Object.values(sharedModule || {}).find((value) => typeof value === 'function');
  assert.equal(
    typeof operation,
    'function',
    `Единый чистый решатель полки ещё не реализован: ${sharedModuleError?.message || 'нет экспорта'}`,
  );
  return operation({ snapshot, observed });
}

function baseSnapshot(overrides = {}) {
  return {
    analysis: {
      state: 'queued',
      queuedAt: '2026-08-26T08:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      generatedAt: null,
    },
    pipeline: {
      attempt: 'a1',
      daemon: 'running',
      result: null,
      stall: null,
      gateKnown: true,
      gate: null,
    },
    b24: {
      present: true,
      status: 'IN_PROGRESS',
      statusKind: 'active',
      unread: 0,
    },
    ...overrides,
  };
}

test('Завершившаяся оценка зажигает полку словами', () => {
  const snapshot = baseSnapshot();
  const result = decision(snapshot, baseSnapshot({
    analysis: {
      ...snapshot.analysis,
      state: 'done',
      finishedAt: '2026-08-26T08:10:00.000Z',
      generatedAt: '2026-08-26T08:10:01.000Z',
    },
  }));

  assert.deepEqual({ state: result.state, source: result.source, message: result.message }, {
    state: 'lit',
    source: 'analysis',
    message: 'Оценка готова',
  });
});

test('Провал оценки зажигает полку и назван словами', () => {
  const snapshot = baseSnapshot();
  const result = decision(snapshot, baseSnapshot({
    analysis: {
      ...snapshot.analysis,
      state: 'failed',
      finishedAt: '2026-08-26T08:10:00.000Z',
    },
  }));

  assert.deepEqual({ state: result.state, source: result.source, message: result.message }, {
    state: 'lit',
    source: 'analysis',
    message: 'Оценка завершилась с ошибкой',
  });
});

test('Вторая неудачная оценка отличается от первой числовыми временами', () => {
  // Сервер присылает времена триажа числом. Пока снимок читал их строкой, оба
  // провала выглядели одинаково — и на второй карточка уже не загоралась.
  const failed = (finishedAt) => baseSnapshot({
    analysis: {
      state: 'failed',
      queuedAt: finishedAt - 60_000,
      startedAt: finishedAt - 30_000,
      finishedAt,
      generatedAt: null,
    },
  });
  const first = decision(baseSnapshot({
    analysis: { ...baseSnapshot().analysis, queuedAt: 1_756_195_200_000 },
  }), failed(1_756_195_800_000));
  const second = decision(first.snapshot, failed(1_756_199_400_000));

  assert.deepEqual({
    first: [first.state, first.source],
    second: [second.state, second.source],
    kept: second.snapshot.analysis.finishedAt,
    distinct: first.fingerprint !== second.fingerprint,
  }, {
    first: ['lit', 'analysis'],
    second: ['lit', 'analysis'],
    kept: 1_756_199_400_000,
    distinct: true,
  });
});

test('Новые ворота конвейера зажигают полку словами', () => {
  const result = decision(baseSnapshot(), baseSnapshot({
    pipeline: {
      ...baseSnapshot().pipeline,
      gate: 'Подтвердить план',
    },
  }));

  assert.deepEqual({ state: result.state, source: result.source, message: result.message }, {
    state: 'lit',
    source: 'pipeline',
    message: 'Конвейер ждёт решения: Подтвердить план',
  });
});

test('Остановка конвейера зажигает полку словами', () => {
  const result = decision(baseSnapshot(), baseSnapshot({
    pipeline: {
      ...baseSnapshot().pipeline,
      stall: 'Агент не отвечает',
    },
  }));

  assert.deepEqual({ state: result.state, source: result.source, message: result.message }, {
    state: 'lit',
    source: 'pipeline',
    message: 'Конвейер остановился: Агент не отвечает',
  });
});

test('Завершение прогона зажигает полку словами', () => {
  const result = decision(baseSnapshot(), baseSnapshot({
    pipeline: {
      ...baseSnapshot().pipeline,
      daemon: 'stopped',
      result: 'completed',
    },
  }));

  assert.deepEqual({ state: result.state, source: result.source, message: result.message }, {
    state: 'lit',
    source: 'pipeline',
    message: 'Прогон конвейера завершён',
  });
});

test('Текущая стадия выводит ожидание конвейера и ответа без selector причины', () => {
  const afterAnalysis = baseSnapshot({
    analysis: {
      ...baseSnapshot().analysis,
      state: 'done',
      finishedAt: '2026-08-26T08:10:00.000Z',
    },
  });
  const pipeline = decision(afterAnalysis, afterAnalysis);
  const answer = decision(afterAnalysis, baseSnapshot({
    analysis: afterAnalysis.analysis,
    pipeline: { ...afterAnalysis.pipeline, daemon: 'stopped', result: 'completed' },
  }));

  assert.deepEqual([pipeline.reasonText, answer.reasonText], [
    'Жду конвейер',
    'Жду ответ в задаче',
  ]);
});

test('Открытые ворота называют ожидание решением человека, а не ответом в задаче', () => {
  // Прогон доехал до узла человека и закрылся, но сами ворота остались открытыми:
  // result и gate приезжают из разных источников и спокойно сосуществуют.
  const gated = baseSnapshot({
    pipeline: {
      ...baseSnapshot().pipeline,
      daemon: 'stopped',
      result: 'completed',
      gate: 'принять работу — проверить в браузере',
    },
  });

  assert.equal(decision(gated, gated).reasonText, 'Жду моего решения');
});

test('Затык конвейера называется затыком и не притворяется штатным ожиданием', () => {
  const stalled = baseSnapshot({
    pipeline: { ...baseSnapshot().pipeline, daemon: 'stopped', stall: 'Узел оборвался' },
  });

  assert.equal(decision(stalled, stalled).reasonText, 'Конвейер встал');
});

test('Рост непрочитанных комментариев зажигает полку словами', () => {
  const result = decision(baseSnapshot(), baseSnapshot({
    b24: { ...baseSnapshot().b24, unread: 2 },
  }));

  assert.deepEqual({ state: result.state, source: result.source, message: result.message }, {
    state: 'lit',
    source: 'comments',
    message: 'Новые комментарии: 2',
  });
});

test('Подтверждённое закрытие B24-задачи зажигает полку словами', () => {
  const result = decision(baseSnapshot(), baseSnapshot({
    b24: { present: false, status: null, statusKind: null, unread: 0 },
  }));

  assert.deepEqual({ state: result.state, source: result.source, message: result.message }, {
    state: 'lit',
    source: 'b24',
    message: 'Задача завершена или закрыта',
  });
});

test('Недоступный источник не считается событием', () => {
  const result = decision(baseSnapshot(), baseSnapshot({ analysis: null }));

  assert.equal(result.state, 'neutral');
});

test('Недоступные данные B24 не считаются закрытием задачи', () => {
  const result = decision(baseSnapshot(), baseSnapshot({ b24: null }));

  assert.equal(result.state, 'neutral');
});

test('Недоступные данные конвейера не считаются его остановкой', () => {
  const result = decision(baseSnapshot(), baseSnapshot({ pipeline: null }));

  assert.equal(result.state, 'neutral');
});

test('Неизвестное состояние ворот не зажигает полку', () => {
  const result = decision(baseSnapshot(), baseSnapshot({
    pipeline: {
      ...baseSnapshot().pipeline,
      gateKnown: false,
      gate: 'Подтвердить план',
    },
  }));

  assert.equal(result.state, 'neutral');
});

test('Первое появление источника создаёт базу без огонька', () => {
  const current = baseSnapshot();
  const result = decision(baseSnapshot({ analysis: null }), current);

  assert.deepEqual({ state: result.state, snapshot: result.snapshot.analysis }, {
    state: 'neutral',
    // Снимок вкладки прошлого формата читается, но наружу время уходит числом.
    snapshot: { ...current.analysis, queuedAt: 1_787_731_200_000 },
  });
});

test('После гашения новый снимок нейтрален, а следующее событие зажигает снова', () => {
  const first = decision(baseSnapshot(), baseSnapshot({
    b24: { ...baseSnapshot().b24, unread: 1 },
  }));
  const acknowledged = decision(first.snapshot, baseSnapshot({
    b24: { ...baseSnapshot().b24, unread: 1 },
  }));
  const next = decision(acknowledged.snapshot, baseSnapshot({
    b24: { ...baseSnapshot().b24, unread: 2 },
  }));

  assert.deepEqual(
    [first.state, acknowledged.state, next.state],
    ['lit', 'neutral', 'lit'],
  );
});

test('Зажжённое событие не гаснет при временно недоступном источнике', () => {
  const first = decision(baseSnapshot(), baseSnapshot({
    b24: { ...baseSnapshot().b24, unread: 1 },
  }));
  const unavailable = sharedModule.default({
    snapshot: first.snapshot,
    observed: baseSnapshot({ b24: null }),
    latched: first,
  });

  assert.deepEqual({ state: unavailable.state, message: unavailable.message }, {
    state: 'lit',
    message: 'Новые комментарии: 1',
  });
});

async function shelfStore() {
  assert.equal(
    typeof storeModule?.useTaskShelfStore,
    'function',
    `Клиентский стор полки ещё не реализован: ${storeModuleError?.message || 'нет экспорта'}`,
  );
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  setActivePinia(createPinia());
  return storeModule.useTaskShelfStore();
}

function serverSnapshot(scope, revision, taskIds) {
  return {
    scope,
    revision,
    entries: taskIds.map((taskId) => ({
      taskId: String(taskId),
      title: `Задача ${taskId}`,
      addedAt: '2026-08-26T08:00:00.000Z',
      reason: 'manual',
      snapshot: baseSnapshot(),
    })),
  };
}

test('Стор игнорирует поздний снимок с меньшей revision того же аккаунта', async () => {
  const store = await shelfStore();
  store.applySnapshot(serverSnapshot('scope-a', 3, [42]));
  const applied = store.applySnapshot(serverSnapshot('scope-a', 2, [77]));

  assert.deepEqual({ applied, revision: store.revision, taskIds: store.entries.map((e) => e.taskId) }, {
    applied: false,
    revision: 3,
    taskIds: ['42'],
  });
});

test('Стор принимает меньшую revision только от нового account scope', async () => {
  const store = await shelfStore();
  store.applySnapshot(serverSnapshot('scope-a', 8, [42]));
  const applied = store.applySnapshot(serverSnapshot('scope-b', 1, [77]));

  assert.deepEqual({ applied, scope: store.scope, taskIds: store.entries.map((e) => e.taskId) }, {
    applied: true,
    scope: 'scope-b',
    taskIds: ['77'],
  });
});

test('Очистка при выходе удаляет account-scoped снимок только из памяти', async () => {
  const store = await shelfStore();
  store.applySnapshot(serverSnapshot('scope-a', 3, [42]));
  store.clear();

  assert.deepEqual({
    scope: store.scope,
    revision: store.revision,
    entries: store.entries,
    loaded: store.loaded,
  }, {
    scope: '',
    revision: -1,
    entries: [],
    loaded: false,
  });
});

async function analysisFixture({ enabled = true, autoAdd = true, shelfError = null } = {}) {
  const calls = [];
  let autoAddEnabled = autoAdd;
  globalThis.__shelfAnalysisHarness = {
    api: {
      // Сервер отвечает на постановку в очередь своим контрактом, а не «ок».
      async post() { return { outcome: 'queued', position: 1 }; },
      async get() { return []; },
    },
    shelf: {
      async autoAdd(id) {
        calls.push(String(id));
        if (shelfError) throw shelfError;
        return true;
      },
    },
    plugins: {
      enabled: (id) => id === 'shelf' && enabled,
      byId: () => ({ values: { autoAddOnAnalysis: autoAddEnabled } }),
    },
  };
  const module = await compileModule(webFile('src/actions/analysis/index.ts'), {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__shelfAnalysisHarness.api;',
      '../../stores/taskShelf.ts': [
        'export const useTaskShelfStore = () => globalThis.__shelfAnalysisHarness.shelf;',
      ].join('\n'),
      '../../stores/plugins.ts': [
        'export const usePluginsStore = () => globalThis.__shelfAnalysisHarness.plugins;',
      ].join('\n'),
      './plugins.ts': [
        'export const usePluginsStore = () => globalThis.__shelfAnalysisHarness.plugins;',
      ].join('\n'),
    },
  });
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  setActivePinia(createPinia());
  return {
    analyze: module.analyzeTask,
    stopPolling: module.stopAnalysisPolling,
    calls,
    setAutoAdd(value) { autoAddEnabled = value; },
  };
}

test('Оба входа триажа автоматически ставят задачи на полку через общий analyze', async (t) => {
  const { analyze, stopPolling, calls } = await analysisFixture();
  t.after(() => {
    stopPolling();
    delete globalThis.__shelfAnalysisHarness;
  });
  await analyze(42);
  await analyze(77);

  assert.deepEqual(calls, ['42', '77']);
});

test('Живая настройка разрешает и запрещает авто-постановку', async (t) => {
  const { analyze, stopPolling, calls, setAutoAdd } = await analysisFixture();
  t.after(() => {
    stopPolling();
    delete globalThis.__shelfAnalysisHarness;
  });
  await analyze(42);
  setAutoAdd(false);
  await analyze(77);

  assert.deepEqual(calls, ['42']);
});

test('Ошибка авто-постановки не маскирует успешный запуск триажа', async (t) => {
  const fixture = await analysisFixture({ shelfError: new Error('полка недоступна') });
  t.after(() => {
    fixture.stopPolling();
    delete globalThis.__shelfAnalysisHarness;
  });
  const result = await fixture.analyze(42);

  assert.deepEqual({ result, calls: fixture.calls }, {
    result: { outcome: 'queued', position: 1 },
    calls: ['42'],
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function reactiveStoreFixture({
  currentState = 'queued',
  browserNotifications = true,
  enabled = true,
  taskOnBoard = true,
  getImpl = null,
  detailImpl = null,
  putImpl = null,
  delImpl = null,
} = {}) {
  const notifications = [];
  const server = serverSnapshot('scope-a', 1, [42]);
  const harness = {
    apiGetCalls: 0,
    detailGetCalls: 0,
    apiCalls: [],
    api: {
      async get(url) {
        if (/^\/api\/b24\/task\/\d+$/.test(url)) {
          harness.detailGetCalls += 1;
          harness.apiCalls.push({ method: 'GET', url });
          if (detailImpl) return detailImpl(url, harness.detailGetCalls);
          return { title: 'Задача 42', group_name: 'GrigDesk' };
        }
        harness.apiGetCalls += 1;
        harness.apiCalls.push({ method: 'GET', url: '/api/b24/task-shelf' });
        if (getImpl) return getImpl(harness.apiGetCalls);
        return structuredClone(server);
      },
      async put(url, body) {
        harness.apiCalls.push({
          method: 'PUT',
          url,
          body: body === undefined ? undefined : structuredClone(body),
        });
        if (putImpl) return putImpl(url, body);
        return structuredClone(server);
      },
      async del(url) {
        harness.apiCalls.push({ method: 'DELETE', url });
        if (delImpl) return delImpl(url);
        return structuredClone(server);
      },
    },
    notifications,
    sseHandler: null,
  };
  globalThis.__taskShelfStoreHarness = harness;
  const module = await compileModule(webFile('src/stores/taskShelf.ts'), {
    stubs: {
      '../shared/apiClient.ts': 'export const api = globalThis.__taskShelfStoreHarness.api;',
      './apiClient.ts': 'export const api = globalThis.__taskShelfStoreHarness.api;',
      '../shared/alerts.ts': [
        'export const alertUser = (notice) => {',
        '  globalThis.__taskShelfStoreHarness.notifications.push(',
        '    [notice.title, notice.body, notice.id, notice]);',
        '  return true;',
        '};',
      ].join('\n'),
      '../composables/useSse.ts': [
        'export const sseSubscribe = (handler) => {',
        '  globalThis.__taskShelfStoreHarness.sseHandler = handler;',
        '  return () => { globalThis.__taskShelfStoreHarness.sseHandler = null; };',
        '};',
      ].join('\n'),
      './analysis.ts': [
        'export const useAnalysisStore = () => globalThis.__taskShelfStoreHarness.analysis;',
      ].join('\n'),
      './notifyWatch.ts': [
        'export const useNotifyWatchStore = () => globalThis.__taskShelfStoreHarness.pipeline;',
      ].join('\n'),
      './board.ts': [
        'export const useBoardStore = () => globalThis.__taskShelfStoreHarness.board;',
      ].join('\n'),
      './plugins.ts': [
        'export const usePluginsStore = () => globalThis.__taskShelfStoreHarness.plugins;',
      ].join('\n'),
    },
  }).catch((error) => {
    assert.fail(`Клиентский стор полки ещё не реализован или не собирается: ${error.message}`);
  });
  const [{ reactive }, { createPinia, setActivePinia }] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  harness.analysis = reactive({
    loadedAt: 1,
    error: null,
    byTask: {
      42: {
        task: 42,
        status: {
          task: 42,
          state: currentState,
          queuedAt: 1_787_731_200_000,
          startedAt: null,
          finishedAt: currentState === 'done' ? 1_787_731_800_000 : null,
        },
        analysis: currentState === 'done'
          ? { generated_at: '2026-08-26T08:10:01.000Z' }
          : null,
      },
    },
  });
  harness.pipeline = reactive({ loadedAt: 1, error: null, observedByTask: {} });
  harness.board = reactive({
    loadedAt: 1,
    error: null,
    data: {
      tasks: taskOnBoard ? [{
        id: 42,
        title: 'Задача 42',
        group: 'GrigDesk',
        status: 'IN_PROGRESS',
        statusKind: 'active',
        statusText: 'В работе — таймер идёт',
        unread: 0,
        responsible: 'Иван Петров',
        deadline: '29.08.2026',
        overdue: false,
      }] : [],
      toReview: [],
      created: [],
      accomplice: [],
      auditor: [],
    },
  });
  harness.plugins = reactive({
    loaded: true,
    list: [{
      id: 'shelf',
      enabled,
      values: { browserNotifications, autoAddOnAnalysis: true },
    }],
    enabled: (id) => id === 'shelf' && enabled,
    byId: () => ({
      values: { browserNotifications, autoAddOnAnalysis: true },
    }),
  });
  setActivePinia(createPinia());
  const store = module.useTaskShelfStore();

  return { store, harness };
}

async function settleStore() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

test('Первый снимок показывает накопленный огонь без оповещения', async (t) => {
  const { store, harness } = await reactiveStoreFixture({ currentState: 'done' });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();

  assert.deepEqual({
    litCount: store.litCount,
    notifications: harness.notifications.length,
  }, {
    litCount: 1,
    notifications: 0,
  });
});

test('Новый переход в огонь отправляет ровно одно браузерное оповещение', async (t) => {
  const { store, harness } = await reactiveStoreFixture();
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  harness.analysis.byTask[42].status = {
    ...harness.analysis.byTask[42].status,
    state: 'done',
    finishedAt: 1_787_731_800_000,
  };
  harness.analysis.byTask[42].analysis = {
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  await settleStore();
  harness.analysis.byTask[42] = { ...harness.analysis.byTask[42] };
  await settleStore();

  assert.equal(harness.notifications.length, 1);
});

test('Рост непрочитанных после базовой линии оповещает ровно один раз', async (t) => {
  const { store, harness } = await reactiveStoreFixture();
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  harness.board.data.tasks[0].unread = 1;
  await settleStore();
  harness.board.data.tasks[0] = { ...harness.board.data.tasks[0] };
  await settleStore();

  assert.deepEqual({
    litCount: store.litCount,
    notifications: harness.notifications.map(([, message]) => message),
  }, {
    litCount: 1,
    notifications: ['Новые комментарии: 1'],
  });
});

test('Первое появление источника становится базой для следующего события', async (t) => {
  const initial = serverSnapshot('scope-a', 1, [42]);
  initial.entries[0].snapshot.analysis = null;
  const { store, harness } = await reactiveStoreFixture({ getImpl: () => initial });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  harness.analysis.loadedAt = 0;
  store.start();
  await settleStore();

  harness.analysis.loadedAt = 1;
  await settleStore();
  assert.equal(store.litCount, 0);

  harness.analysis.byTask[42].status = {
    ...harness.analysis.byTask[42].status,
    state: 'done',
    finishedAt: 1_787_731_800_000,
  };
  harness.analysis.byTask[42].analysis = {
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  await settleStore();

  assert.deepEqual({ litCount: store.litCount, notifications: harness.notifications.length }, {
    litCount: 1,
    notifications: 1,
  });
});

test('Зажжённая строка переживает отказ источника без повторного оповещения', async (t) => {
  const { store, harness } = await reactiveStoreFixture();
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  harness.analysis.byTask[42].status = {
    ...harness.analysis.byTask[42].status,
    state: 'done',
    finishedAt: 1_787_731_800_000,
  };
  harness.analysis.byTask[42].analysis = {
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  await settleStore();
  harness.analysis.error = new Error('триаж недоступен');
  await settleStore();
  harness.analysis.error = null;
  await settleStore();

  assert.deepEqual({ litCount: store.litCount, notifications: harness.notifications.length }, {
    litCount: 1,
    notifications: 1,
  });
});

test('Выключенные браузерные оповещения не озвучивают новый огонь', async (t) => {
  const { store, harness } = await reactiveStoreFixture({ browserNotifications: false });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  harness.analysis.byTask[42].status = {
    ...harness.analysis.byTask[42].status,
    state: 'done',
    finishedAt: 1_787_731_800_000,
  };
  harness.analysis.byTask[42].analysis = {
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  await settleStore();

  assert.equal(harness.notifications.length, 0);
});

test('Выключенный плагин не читает API и скрывает вычисленное состояние', async (t) => {
  const { store, harness } = await reactiveStoreFixture({
    currentState: 'done',
    enabled: false,
  });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();

  assert.deepEqual({ apiGetCalls: harness.apiGetCalls, litCount: store.litCount }, {
    apiGetCalls: 0,
    litCount: 0,
  });
});

test('Недоступная доска не зажигает задачу как закрытую', async (t) => {
  const { store, harness } = await reactiveStoreFixture();
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  harness.board.loadedAt = 0;
  harness.board.error = new Error('доска недоступна');
  harness.board.data.tasks = [];
  store.start();
  await settleStore();

  assert.equal(store.litCount, 0);
});

test('Строка полки получает живую карточку B24, оценки и прогресса конвейера', async (t) => {
  const { store, harness } = await reactiveStoreFixture({ currentState: 'done' });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  harness.analysis.byTask[42].analysis = {
    complexity: 4,
    risk: 3,
    diff_size: 'M',
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  harness.pipeline.observedByTask[42] = {
    ...baseSnapshot().pipeline,
    progress: { done: 3, total: 7 },
    stage: { id: 'review', label: 'Проверка', state: 'run' },
  };
  store.start();
  await settleStore();

  const [row] = store.rows;
  assert.deepEqual({
    title: row?.title,
    project: row?.details?.project,
    responsible: row?.details?.responsible,
    deadline: row?.details?.deadline,
    detailGetCalls: harness.detailGetCalls,
    activities: row?.details?.activities?.map((activity) => ({
      kind: activity.kind,
      value: activity.value,
    })),
  }, {
    title: 'Задача 42',
    project: 'GrigDesk',
    responsible: 'Иван Петров',
    deadline: '29.08.2026',
    detailGetCalls: 0,
    activities: [
      { kind: 'b24', value: 'В работе — таймер идёт' },
      { kind: 'analysis', value: 'Готова · сложность 4/5 · риск 3/5 · дифф M' },
      { kind: 'pipeline', value: '3/7 · Проверка' },
    ],
  });
});

function pipelineActivityOf(store) {
  return store.rows[0]?.details?.activities
    ?.find((activity) => activity.kind === 'pipeline') || null;
}

test('Полосу прогона рисуют только живые цифры вотчера', async (t) => {
  const { store, harness } = await reactiveStoreFixture({ currentState: 'done' });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  harness.pipeline.observedByTask[42] = {
    ...baseSnapshot().pipeline,
    progress: { done: 3, total: 7 },
    stage: { id: 'review', label: 'Проверка', state: 'run' },
  };
  store.start();
  await settleStore();

  const counted = pipelineActivityOf(store);

  harness.pipeline.observedByTask[42] = { ...baseSnapshot().pipeline, progress: null };
  await settleStore();

  const moving = pipelineActivityOf(store);

  delete harness.pipeline.observedByTask[42];
  await settleStore();

  const forgotten = pipelineActivityOf(store);

  assert.deepEqual({
    counted: counted?.progress,
    moving: moving?.progress,
    forgotten: forgotten?.progress ?? null,
    forgottenValue: forgotten?.value,
  }, {
    counted: { done: 3, total: 7 },
    moving: { done: 0, total: 0 },
    forgotten: null,
    forgottenValue: 'Последний прогон сейчас не виден',
  });
});

test('Остановленный прогон без цифр графа полосы не получает', async (t) => {
  const { store, harness } = await reactiveStoreFixture({ currentState: 'done' });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  harness.pipeline.observedByTask[42] = {
    ...baseSnapshot().pipeline,
    daemon: 'stopped',
    result: 'human-rewind',
    progress: null,
  };
  store.start();
  await settleStore();

  const activity = pipelineActivityOf(store);

  assert.deepEqual({ value: activity?.value, progress: activity?.progress ?? null }, {
    value: 'Завершён · human-rewind',
    progress: null,
  });
});

test('Идущий заход прячет прошлые цифры и называет себя по ним', async (t) => {
  const { store, harness } = await reactiveStoreFixture({ currentState: 'done' });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  harness.analysis.byTask[42].analysis = {
    complexity: 4,
    risk: 3,
    diff_size: 'M',
    needs_clarification: true,
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  store.start();
  await settleStore();

  const analysisActivity = () => store.rows[0]?.details?.activities
    ?.find((activity) => activity.kind === 'analysis');

  harness.analysis.byTask[42].status.state = 'running';
  await settleStore();

  assert.deepEqual({
    value: analysisActivity()?.value,
    tone: analysisActivity()?.tone,
  }, {
    value: 'Переоценка идёт',
    tone: 'accent',
  });

  harness.analysis.byTask[42].analysis = null;
  await settleStore();

  assert.equal(analysisActivity()?.value, 'Разведка идёт');

  harness.analysis.byTask[42].status.state = 'queued';
  await settleStore();

  assert.equal(analysisActivity()?.value, 'В очереди');
});

test('Строка полки помечается завершённой по живому состоянию B24', async (t) => {
  const { store, harness } = await reactiveStoreFixture();
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  const before = store.rows[0]?.completed;

  harness.board.data.tasks[0].statusKind = 'done';
  harness.board.data.tasks[0].statusText = 'Завершена';
  await settleStore();

  assert.deepEqual({ before, after: store.rows[0]?.completed }, {
    before: false,
    after: true,
  });
});

test('Задача вне текущей доски получает проект из полной карточки B24', async (t) => {
  const { store, harness } = await reactiveStoreFixture({
    taskOnBoard: false,
    detailImpl: async () => ({
      title: 'Журнал: исправить количество запросов',
      group_name: 'arsenkin.ru',
    }),
  });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();

  const [row] = store.rows;
  const b24 = row?.details?.activities?.find((activity) => activity.kind === 'b24');
  assert.deepEqual({
    title: row?.title,
    project: row?.details?.project,
    b24: b24?.value,
    completed: row?.completed,
    detailGetCalls: harness.detailGetCalls,
  }, {
    title: 'Журнал: исправить количество запросов',
    project: 'arsenkin.ru',
    b24: 'Не видна на текущей доске',
    completed: true,
    detailGetCalls: 1,
  });
});

test('Повторная сверка доски не дублирует загрузку проекта', async (t) => {
  const detail = deferred();
  const { store, harness } = await reactiveStoreFixture({
    taskOnBoard: false,
    detailImpl: () => detail.promise,
  });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  harness.board.loadedAt += 1;
  await settleStore();

  assert.equal(harness.detailGetCalls, 1);
  detail.resolve({ title: 'Задача 42', group_name: 'Архивный проект' });
  await settleStore();
  assert.equal(store.rows[0]?.details?.project, 'Архивный проект');
});

test('Ошибка чтения проекта не скрывает карточку и не запускает цикл запросов', async (t) => {
  const { store, harness } = await reactiveStoreFixture({
    taskOnBoard: false,
    detailImpl: async () => { throw new Error('детали недоступны'); },
  });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  harness.board.loadedAt += 1;
  await settleStore();

  assert.deepEqual({
    taskId: store.rows[0]?.taskId,
    project: store.rows[0]?.details?.project,
    detailGetCalls: harness.detailGetCalls,
    error: store.error,
  }, {
    taskId: '42',
    project: '',
    detailGetCalls: 1,
    error: null,
  });
});

test('Ручная кнопка отправляет фактическое done завершённого триажа', async (t) => {
  const { store, harness } = await reactiveStoreFixture({ currentState: 'done' });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });

  await store.toggle(42);
  const mutation = harness.apiCalls.find((call) => call.method === 'PUT');

  assert.deepEqual({
    reason: mutation?.body?.reason,
    createIfMissing: mutation?.body?.createIfMissing,
    analysis: mutation?.body?.snapshot?.analysis,
    error: store.error,
  }, {
    reason: 'manual',
    createIfMissing: true,
    analysis: {
      state: 'done',
      queuedAt: 1_787_731_200_000,
      startedAt: null,
      finishedAt: 1_787_731_800_000,
      generatedAt: '2026-08-26T08:10:01.000Z',
    },
    error: null,
  });
});

test('Повторное нажатие снимает запись, а следующее возвращает её', async (t) => {
  const { store, harness } = await reactiveStoreFixture({
    delImpl: () => serverSnapshot('scope-a', 2, []),
    putImpl: () => serverSnapshot('scope-a', 3, [42]),
  });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.applySnapshot(serverSnapshot('scope-a', 1, [42]));
  await store.toggle(42);
  await store.toggle(42);

  assert.deepEqual(harness.apiCalls.map((call) => ({
    method: call.method,
    url: call.url,
    createIfMissing: call.body?.createIfMissing,
  })), [{
    method: 'DELETE',
    url: '/api/b24/task-shelf/42',
    createIfMissing: undefined,
  }, {
    method: 'PUT',
    url: '/api/b24/task-shelf/42',
    createIfMissing: true,
  }]);
});

test('Гашение огонька обновляет только существующую запись', async (t) => {
  const updated = serverSnapshot('scope-a', 2, [42]);
  const { store, harness } = await reactiveStoreFixture({ putImpl: () => updated });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.applySnapshot(serverSnapshot('scope-a', 1, [42]));
  await store.acknowledge(42);
  const mutation = harness.apiCalls.find((call) => call.method === 'PUT');

  assert.deepEqual({
    createIfMissing: mutation?.body?.createIfMissing,
    taskIds: store.entries.map((entry) => entry.taskId),
  }, {
    createIfMissing: false,
    taskIds: ['42'],
  });
});

test('Наступление события зажигает строку, но не меняет серверные записи', async (t) => {
  const { store, harness } = await reactiveStoreFixture();
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.applySnapshot(serverSnapshot('scope-a', 1, [42]));
  store.start();
  await settleStore();
  const before = structuredClone(store.entries);
  harness.analysis.byTask[42].status = {
    ...harness.analysis.byTask[42].status,
    state: 'done',
    finishedAt: 1_787_731_800_000,
  };
  harness.analysis.byTask[42].analysis = {
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  await settleStore();

  assert.deepEqual({ entries: store.entries, litCount: store.litCount }, {
    entries: before,
    litCount: 1,
  });
});

test('Поздний ответ прежней epoch не возвращает запись после clear', async (t) => {
  const pending = deferred();
  const { store } = await reactiveStoreFixture({ getImpl: () => pending.promise });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  const loading = store.load();
  await Promise.resolve();
  store.clear();
  pending.resolve(serverSnapshot('scope-a', 9, [42]));
  await loading;

  assert.deepEqual({ scope: store.scope, revision: store.revision, entries: store.entries }, {
    scope: '',
    revision: -1,
    entries: [],
  });
});

test('SSE во время летящего GET запускает ровно одно trailing-перечитывание', async (t) => {
  const pending = deferred();
  const { store, harness } = await reactiveStoreFixture({
    getImpl: (call) => call === 1
      ? pending.promise
      : Promise.resolve(serverSnapshot('scope-a', 2, [42])),
  });
  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await Promise.resolve();
  harness.sseHandler?.('task-shelf-changed');
  pending.resolve(serverSnapshot('scope-a', 1, [42]));
  await settleStore();

  assert.equal(harness.apiGetCalls, 2);
});

test('Панель, чип и оповещение не содержат второй копии правил событий', async () => {
  let sources;
  try {
    sources = await Promise.all([
      readFile(webFile('src/shared/taskShelfDecision.ts'), 'utf8'),
      readFile(webFile('src/stores/taskShelf.ts'), 'utf8'),
      readFile(webFile('src/views/shelf/TaskShelfPanel.vue'), 'utf8'),
      readFile(webFile('src/shared/layout/ToolHost.vue'), 'utf8'),
    ]);
  } catch (error) {
    assert.fail(`Единый shared-контракт полки ещё не собран: ${error.message}`);
  }
  const [shared, store, panel, host] = sources;
  const duplicateRules = [panel, host]
    .some((source) => /gateKnown|generatedAt|finishedAt|statusKind|TERMINAL_ANALYSIS|TERMINAL_B24/.test(source));

  assert.deepEqual({
    sharedExportsDecision: /export\s+(?:default\s+)?(?:function|const)\b/.test(shared),
    storeImportsDecision: /from\s+['"]\.\.\/shared\/taskShelfDecision\.ts['"]/.test(store),
    duplicateRules,
  }, {
    sharedExportsDecision: true,
    storeImportsDecision: true,
    duplicateRules: false,
  });
});

test('Новое событие полки задаёт область и открывает карточку задачи', async (t) => {
  const { store, harness } = await reactiveStoreFixture();

  t.after(() => {
    store.stop?.();
    delete globalThis.__taskShelfStoreHarness;
  });
  store.start();
  await settleStore();
  harness.analysis.byTask[42].status = {
    ...harness.analysis.byTask[42].status,
    state: 'done',
    finishedAt: 1_787_731_800_000,
  };
  harness.analysis.byTask[42].analysis = {
    generated_at: '2026-08-26T08:10:01.000Z',
  };
  await settleStore();
  harness.analysis.byTask[42] = { ...harness.analysis.byTask[42] };
  await settleStore();

  assert.equal(harness.notifications.length, 1);

  const notice = harness.notifications[0][3];

  assert.equal(notice?.scope, 'task:42');
  assert.equal(notice.tone, 'accent');
  assert.deepEqual(notice.target, { kind: 'task', taskId: '42' });
  assert.equal(Boolean(notice.sticky), false);
});
