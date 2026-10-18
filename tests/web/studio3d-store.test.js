process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile, singletonUrl } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { LIBRARY_ID, INTENT_ID, detailDto, modelDto, stateDto, tasksDto,
  UNIT } from './helpers/studio3d-fixtures.js';

const TRANSPORT = `export const api = new Proxy({}, {
get: (_, key) => (...args) => globalThis.__studio.api[key](...args) });
export class ApiError extends Error { constructor(message, status,
  data) { super(message); this.status=status; this.data=data; } }
globalThis.__studioApiError=ApiError;`;
const SSE = `export const sseSubscribe = (fn) => { globalThis.__studio.listeners.add(fn);
return () => globalThis.__studio.listeners.delete(fn); };`;
const ALERTS = `export const alertUser = (value) => globalThis.__studio.alerts.push(value);
export const dismissAlertScope = () => {};`;
const PENDING = `export const studioPending = {
list: async (owner) => [...globalThis.__studio.pending.values()].filter(x=>x.owner===owner),
put: async (record) => { globalThis.__studio.pending.set(record.key, structuredClone(record)); },
remove: async (key) => globalThis.__studio.pending.delete(key) };
export const studioFingerprint = (value) => JSON.stringify(value);`;

/**
 * API хранит каждый payload до ответа; callback может вернуть deferred promise.
 * Pending repository имитирует durable storage между двумя Pinia instances.
 */
function harness() {
  const h = {
    calls: [],
    listeners: new Set(),
    alerts: [],
    pending: new Map(),
    handlers: {}
  };

  /**
   * Один transport сохраняет вызов до управляемого ответа или сетевого отказа.
   * Непредусмотренный endpoint явно падает, чтобы тест не проходил пустой заглушкой.
   */
  const invoke = async (method, url, body, options) => {
    h.calls.push({
      method,
      url,
      body: structuredClone(body),
      options
    });
    
    if (h.handlers[url]) {
      return h.handlers[url](body, options);
    }
    if (url.endsWith('/state')) {
      return stateDto();
    }
    if (url.includes('/models?')) {
      return {
        libraryId: LIBRARY_ID,
        models: [modelDto()],
        total: 1,
        broken: []
      };
    }
    if (url.endsWith('/tasks')) {
      return tasksDto();
    }
    if (url.includes('/models/')) {
      return detailDto();
    }
    if (url.endsWith('/offers')) {
      return { libraryId: LIBRARY_ID, offers: [] };
    }
    if (url.endsWith('/run')) {
      return {
        libraryId: LIBRARY_ID,
        intentId: body.idempotencyKey,
        deleted: false,
        model: modelDto(),
        versions: []
      };
    }
    
    throw new Error(`Нет фикстуры ${method} ${url}`);
  };
  
  h.api = Object.fromEntries(['get', 'post', 'patch', 'del', 'upload', 'postBytes', 'getBlob']
    .map((method) => [method, (url, body, options) => invoke(method, url, body, options)]));
  globalThis.__studio = h;
  
  return h;
}

test('WA-01–07 transport, stale replies, SSE lifetime и durable UUID', async (t) => {
  await installUiBrowser(t);
  

  const { createPinia, setActivePinia } = await import(singletonUrl('pinia'));
  const { useStudio3dStore } = await compileModule(webFile('src/stores/studio3d.ts'), { stubs: {
    '../../shared/apiClient.ts': TRANSPORT,
    '../shared/apiClient.ts': TRANSPORT,
    '../composables/useSse.ts': SSE,
    '../shared/alerts.ts': ALERTS,
    '../features/studio3d/pendingIntents.ts': PENDING
  } });
  const h = harness();
  
  setActivePinia(createPinia());
  
  const store = useStudio3dStore();
  
  await store.start('fixture-user');
  assert.equal(h.listeners.size, 1);
  await store.start('fixture-user');
  assert.equal(h.listeners.size, 1);
  await store.openModel('fixture-model');
  
  for (const listener of h.listeners) {
    listener('studio-progress', {
      libraryId: LIBRARY_ID,
      modelId: 'fixture-model',
      versionId: 'v01-model',
      status: 'running',
      progress: 80,
      etaSeconds: 2
    });
  }
  
  assert.equal(store.detail.versions[0].progress, 80);
  
  const request = {
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Куб' },
    expectedPrice: 30
  };
  
  h.handlers['/api/studio3d/run'] = async (body) => {
    assert.equal(h.pending.has(body.idempotencyKey), true);
    
    throw new TypeError('fixture offline');
  };
  await assert.rejects(store.run(request), /fixture offline/);
  
  const first = h.calls.filter((call) => call.url.endsWith('/run')).at(-1).body;
  
  await assert.rejects(store.run(request), /fixture offline/);
  assert.equal(h.calls.filter((call) => call.url.endsWith('/run')).at(-1).body.idempotencyKey,
    first.idempotencyKey);
  assert.equal(h.pending.size, 1);
  store.stop();
  assert.equal(h.listeners.size, 0);
  assert.equal(store.state, null);

  const ApiError = globalThis.__studioApiError;
  const fresh = () => {
    const next = harness();
    
    setActivePinia(createPinia());
    
    return { h: next, store: useStudio3dStore() };
  };

  await t.test('WA-02 поиск debounce и фильтры; WA-07 обратные ответы не меняют detail', async (scenario) => {
    const { h, store } = fresh();
    
    scenario.after(() => store.stop());
    await store.start('fixture-user');
    scenario.mock.timers.enable({ apis: ['setTimeout'] });
    store.filters = { project: 'demo', has: 'rig' };
    
    const before = h.calls.length;
    const first = store.search('ку');
    const second = store.search('куб');

    scenario.mock.timers.tick(301);
    await Promise.all([first, second]);
    assert.equal(h.calls.length, before + 1);
    assert.equal(h.calls.at(-1).url.includes('q=%D0%BA%D1%83%D0%B1'), true);
    assert.equal(h.calls.at(-1).url.includes('project=demo'), true);
    
    let resolveOld;
    
    h.handlers['/api/studio3d/models/old'] = () => new Promise((resolve) => {
      resolveOld = resolve;
    });
    h.handlers['/api/studio3d/models/new'] = () => detailDto({ model: modelDto({ id: 'new' }) });
    
    const old = store.openModel('old');
    
    await store.openModel('new');
    resolveOld(detailDto({ model: modelDto({ id: 'old' }) }));
    await old;
    assert.equal(store.detail.model.id, 'new');
    assert.equal(store.openedModel, 'new');
  });

  await t.test('WA-03/04/06 changed coalesces, route leave сохраняет listener, reconnect не дублирует тост',
    async (scenario) => {
      const { h, store } = fresh();
      
      scenario.after(() => store.stop());
      await store.start('fixture-user');
      await store.openModel('fixture-model');
      store.setViewingModel('');
      
      const row = {
        intentId: INTENT_ID,
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
        updatedAt: '2026-10-11T11:00:00Z'
      };
      
      h.handlers['/api/studio3d/tasks'] = () => tasksDto({ recent: [row] });
      scenario.mock.timers.enable({ apis: ['setTimeout'] });
      
      const previous = h.calls.filter((call) => call.url.includes('/models?')).length;
      
      for (const listener of h.listeners) {
        listener('studio-changed', {
          libraryId: LIBRARY_ID,
          modelId: 'other',
          versionId: 'v01-model',
          status: 'ready'
        });
        listener('studio-changed', {
          libraryId: LIBRARY_ID,
          modelId: 'other',
          versionId: 'v01-model',
          status: 'ready'
        });
      }
      
      scenario.mock.timers.tick(301);
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      assert.equal(h.calls.filter((call) => call.url.includes('/models?')).length, previous + 1);
      assert.equal(h.listeners.size, 1);
      assert.equal(h.alerts.length, 1);
      assert.equal(h.alerts[0].tone, 'accent');
      assert.deepEqual(h.alerts[0].target, {
        kind: 'studio',
        modelId: 'other',
        versionId: 'v01-model'
      });
      
      for (const listener of h.listeners) {
        listener('hello', {});
      }
      
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      assert.equal(h.alerts.length, 1);
      store.setViewingModel('visible');
      await store.loadTasks();
      h.handlers['/api/studio3d/tasks'] = () => tasksDto({ recent: [{
        ...row,
        intentId: crypto.randomUUID(),
        modelId: 'visible',
        status: 'failed',
        error: {
          kind: 'network',
          message: 'Ошибка задачи',
          detail: null
        }
      }] });
      await store.loadTasks();
      assert.equal(h.alerts.length, 1);
    });

  await t.test('WA-05/07 double click и reload после 404 повторяют полный прежний request',
    async (scenario) => {
    const { h, store } = fresh();
    
    scenario.after(() => store.stop());
    await store.start('fixture-user');
    h.handlers['/api/studio3d/run'] = () => {
      throw new TypeError('fixture offline');
    };
    
    const input = {
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'Снимок' },
      expectedPrice: 30
    };
    
    await Promise.allSettled([store.run(input), store.run(input)]);
    
    const original = h.calls.filter((call) => call.url.endsWith('/run'))[0].body;
    
    assert.equal(h.calls.filter((call) => call.url.endsWith('/run')).length, 1);
    input.values.prompt = 'Новая форма';
    await assert.rejects(store.run(input));
    assert.equal(h.pending.size, 2);
    store.stop();
    setActivePinia(createPinia());
    
    const restored = useStudio3dStore();
    
    scenario.after(() => restored.stop());
    
    for (const record of h.pending.values()) {
      h.handlers[`/api/studio3d/jobs/${record.key}?libraryId=${LIBRARY_ID}`] = () => {
        throw new ApiError('not found', 404, { error: 'not_found' });
      };
    }
    
    h.handlers['/api/studio3d/run'] = (body) => ({
      libraryId: LIBRARY_ID,
      intentId: body.idempotencyKey,
      deleted: false,
      model: modelDto(),
      versions: []
    });
    await restored.start('fixture-user');
    
    const replay = h.calls.filter((call) => call.url.endsWith('/run')
      && call.body.idempotencyKey === original.idempotencyKey).at(-1).body;
    
    assert.deepEqual(replay, original);
    assert.equal(h.pending.size, 0);
  });

  await t.test('WA-08 старше 10 минут не отправляется, 4xx при восстановлении снимает запись',
    async (scenario) => {
    const { h, store } = fresh();

    scenario.after(() => store.stop());
    await store.start('fixture-user');
    h.handlers['/api/studio3d/run'] = () => {
      throw new TypeError('fixture offline');
    };

    const input = {
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'Старый заказ' },
      expectedPrice: 30,
      name: 'Старый заказ'
    };

    await assert.rejects(store.run(input));

    const record = [...h.pending.values()][0];

    record.at = Date.now() - 11 * 60 * 1000;

    const sentBefore = h.calls.filter((call) => call.url.endsWith('/run')).length;

    h.handlers[`/api/studio3d/jobs/${record.key}?libraryId=${LIBRARY_ID}`] = () => {
      throw new ApiError('not found', 404, { error: 'not_found' });
    };
    store.stop();
    setActivePinia(createPinia());

    const restored = useStudio3dStore();

    scenario.after(() => restored.stop());
    await restored.start('fixture-user');

    assert.equal(h.calls.filter((call) => call.url.endsWith('/run')).length, sentBefore);
    assert.equal(h.pending.size, 0);
    assert.equal(h.alerts.some((alert) => alert.title.includes('не отправлен')), true);

    // 4xx при восстановлении снимает запись: повтор не должен пройти позже сам.
    const second = fresh();

    setActivePinia(createPinia());

    const store2 = useStudio3dStore();

    scenario.after(() => store2.stop());
    await store2.start('fixture-user');
    second.h.handlers['/api/studio3d/run'] = () => {
      throw new TypeError('fixture offline');
    };
    await assert.rejects(store2.run(input));
    assert.equal(second.h.pending.size, 1);

    store2.stop();
    setActivePinia(createPinia());

    const store3 = useStudio3dStore();

    scenario.after(() => store3.stop());

    const secondKey = [...second.h.pending.keys()][0];

    second.h.handlers[`/api/studio3d/jobs/${secondKey}?libraryId=${LIBRARY_ID}`] = () => {
      throw new ApiError('цена изменилась', 409, { error: 'price_changed' });
    };
    await store3.start('fixture-user');

    assert.equal(second.h.pending.size, 0);
    assert.equal(second.h.calls.filter((call) => call.url.endsWith('/run')).length, 1);
    assert.equal(second.h.alerts.some((alert) => alert.title.includes('не отправлен')), true);

    store3.stop();
    setActivePinia(createPinia());

    const store4 = useStudio3dStore();

    scenario.after(() => store4.stop());
    await store4.start('fixture-user');

    assert.equal(second.h.calls.filter((call) => call.url.endsWith('/run')).length, 1);
  });

  await t.test('WA-11 тосты переживают reload; хранилище ограничено 500 ключами', async (scenario) => {
    const { h, store } = fresh();
    const recent = {
      intentId: crypto.randomUUID(),
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
      updatedAt: '2026-10-11T11:00:00Z'
    };

    h.handlers['/api/studio3d/tasks'] = () => tasksDto({ active: [], recent: [recent] });
    scenario.after(() => store.stop());
    await store.start('notification-user');
    assert.equal(h.alerts.length, 1);
    store.stop();
    setActivePinia(createPinia());

    const restored = useStudio3dStore();

    scenario.after(() => restored.stop());
    await restored.start('notification-user');
    assert.equal(h.alerts.length, 1);

    for (let index = 0; index < 510; index += 1) {
      h.handlers['/api/studio3d/tasks'] = () => tasksDto({
        active: [],
        recent: [{ ...recent, intentId: crypto.randomUUID() }]
      });
      await restored.loadTasks();
    }

    const keys = JSON.parse(localStorage.getItem('grigdesk-studio3d-seen:notification-user'));

    assert.equal(keys.length, 500);
    assert.equal(new Set(keys).size, 500);

    h.handlers['/api/studio3d/tasks'] = () => tasksDto({
      active: [],
      recent: [{
        ...recent,
        intentId: crypto.randomUUID(),
        status: 'failed'
      }]
    });
    await restored.loadTasks();
    assert.equal(h.alerts.at(-1).title, 'Не получилось: «Другой куб»');
  });

  await t.test('WA-10 стор применяет настоящий studio-progress от worker без HTTP', async (scenario) => {
    const { promises: fs } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createLibrary } = await import('../../server/src/lib/studio3d/library.ts');
    const { createIntents } = await import('../../server/src/lib/studio3d/intents.ts');
    const { createJobs } = await import('../../server/src/lib/studio3d/jobs.ts');
    const { createTripoStudio } = await import('../../server/src/lib/tripo/studio.ts');
    const { startFakeTripo, fakeTaskId } = await import('../server/helpers/fakeTripo.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-progress-'));
    const fake = await startFakeTripo();
    const library = createLibrary({ dir });
    const provider = createTripoStudio({ env: fake.env, baseUrl: fake.baseUrl });
    const { h, store } = fresh();
    const events = [];

    await library.ensure();

    const jobs = createJobs({
      library,
      intents: createIntents({ library }),
      providers: [provider],
      setTimer: () => 1,
      clearTimer: () => {},
      broadcast: (name, data) => events.push({ name, data })
    });

    scenario.after(async () => {
      store.stop();
      await jobs.stop();
      await library.close();
      await fake.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const values = provider.validate('text-to-model', { prompt: 'Синтетическая модель' }, {}).values;
    const result = await jobs.run({
      libraryId: library.libraryId,
      idempotencyKey: crypto.randomUUID(),
      provider: 'tripo',
      operation: 'text-to-model',
      values,
      expectedPrice: provider.quote('text-to-model', values, {}).total
    });

    h.handlers['/api/studio3d/state'] = () => stateDto({ libraryId: library.libraryId });
    h.handlers[`/api/studio3d/models/${result.model.id}`] = () => detailDto({
      libraryId: library.libraryId,
      model: result.model,
      versions: result.versions
    });
    await store.start('fixture-user');
    await store.openModel(result.model.id);
    await jobs.tick();
    fake.progress(fakeTaskId(1), 42, 19);
    await jobs.tick();

    const event = events.findLast((item) => item.name === 'studio-progress');
    const callsBefore = h.calls.length;

    assert.ok(event);

    for (const listener of h.listeners) {
      listener(event.name, event.data);
    }

    assert.equal(store.detail.versions[0].status, 'running');
    assert.equal(store.detail.versions[0].progress, 42);
    assert.equal(store.detail.versions[0].etaSeconds, 19);
    assert.equal(h.calls.length, callsBefore);
  });

  await t.test('WA-09 4xx повторного POST снимает намерение и показывает причину', async (scenario) => {
    const { h, store } = fresh();

    scenario.after(() => store.stop());
    await store.start('fixture-user');
    h.handlers['/api/studio3d/run'] = () => {
      throw new TypeError('fixture offline');
    };

    await assert.rejects(store.run({
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'Новый заказ' },
      expectedPrice: 30,
      name: 'Новый заказ'
    }));

    const record = [...h.pending.values()][0];

    h.handlers[`/api/studio3d/jobs/${record.key}?libraryId=${LIBRARY_ID}`] = () => {
      throw new ApiError('not found', 404, { error: 'not_found' });
    };
    h.handlers['/api/studio3d/run'] = () => {
      throw new ApiError('Цена изменилась', 409, {
        error: 'price_changed',
        message: 'Цена изменилась'
      });
    };
    store.stop();
    setActivePinia(createPinia());

    const restored = useStudio3dStore();

    scenario.after(() => restored.stop());
    await restored.start('fixture-user');
    assert.equal(h.pending.size, 0);
    assert.equal(restored.pending.length, 0);
    assert.equal(h.alerts.at(-1).title, 'Заказ «Новый заказ» не отправлен: Цена изменилась');

    restored.stop();
    setActivePinia(createPinia());

    const next = useStudio3dStore();

    scenario.after(() => next.stop());
    await next.start('fixture-user');
    assert.equal(h.calls.filter((call) => call.url.endsWith('/run')).length, 2);
  });

  await t.test('WA-07 quote и offers в обратном порядке, logout во время durable write', async (scenario) => {
    const { h, store } = fresh();
    
    scenario.after(() => store.stop());
    await store.start('fixture-user');
    scenario.mock.timers.enable({ apis: ['setTimeout'] });
    
    let oldReply;
    const response = (amount, values) => ({
      libraryId: LIBRARY_ID,
      quote: {
        total: amount,
        lines: [],
        unit: UNIT,
        usd: null,
        note: null
      },
      validation: {
        values,
        errors: [],
        warnings: []
      }
    });
    
    h.handlers['/api/studio3d/quote'] = (body) => body.values.prompt === 'старое'
      ? new Promise((resolve) => {
        oldReply = resolve;
      }) : response(40, body.values);
    
    const first = store.quote({
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'старое' }
    });

    scenario.mock.timers.tick(301);
    
    const second = store.quote({
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'новое' }
    });
    
    assert.equal(store.quoted, null);
    scenario.mock.timers.tick(301);
    await second;
    oldReply(response(30, { prompt: 'старое' }));
    await first;
    assert.equal(store.quoted.quote.total, 40);
    assert.equal(store.quoted.validation.values.prompt, 'новое');

    const saved = h.pending;
    let releaseWrite;
    const originalSet = saved.set.bind(saved);
    
    saved.set = (key, record) => {
      originalSet(key, record);
      store.stop();
      
      return saved;
    };
    await assert.rejects(store.run({
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'Закрытая сессия' },
      expectedPrice: 30
    }), /Сессия изменилась/);
    assert.equal(h.calls.some((call) => call.url.endsWith('/run')), false);
    assert.equal(store.pending.length, 0);
    assert.equal(saved.size, 1);
  });

  await t.test('WA-01/05 price_changed и invalid DTO сохраняют ясную ошибку', async (scenario) => {
    const { h, store } = fresh();
    
    scenario.after(() => store.stop());
    await store.start('fixture-user');
    h.handlers['/api/studio3d/run'] = () => {
      throw new ApiError('Цена изменилась', 409, {
        error: 'price_changed',
        message: 'Цена изменилась',
        quote: {
          total: 40,
          lines: [{ label: 'Модель', amount: 40 }],
          unit: UNIT,
          usd: null,
          note: null
        }
      });
    };
    
    const result = await store.run({
      provider: 'tripo',
      operation: 'text-to-model',
      values: { prompt: 'Куб' },
      expectedPrice: 30
    });
    
    assert.equal(result.priceChanged.total, 40);
    assert.equal(store.pending[0].blocked, 'Цена изменилась');
    h.handlers['/api/studio3d/models?offset=0&limit=50'] = () => ({ unknown: true });
    await store.loadModels();
    assert.equal(store.error.includes('Некорректный ответ раздела «3D»'), true);
  });
  await t.test('WA-12 retry и batchRun сохраняют запись до POST и шлют свой адрес и тело',
    async (scenario) => {
    const { h, store } = fresh();
    const retryKey = '00000000-0000-4000-8000-000000000011';
    const batchKey = '00000000-0000-4000-8000-000000000012';
    const retryUrl = '/api/studio3d/models/fixture-model/versions/v01-model/retry';
    const batchUrl = '/api/studio3d/batches/run';
    const snapshotHash = 'a'.repeat(64);
    const snapshot = {
      libraryId: LIBRARY_ID,
      rows: [{
        provider: 'tripo',
        operation: 'text-to-model',
        values: { prompt: 'Первый' },
        name: 'Первый',
        project: null,
        category: null,
        expectedPrice: 40
      }],
      catalogVersion: 'fixture',
      totalEstimated: 40,
      unit: UNIT
    };
    const stored = {};

    scenario.after(() => store.stop());
    await store.start('fixture-user');

    // Запись читается в момент POST: так видно, что она сохранена до отправки.
    h.handlers[retryUrl] = (body) => {
      stored.retry = structuredClone(h.pending.get(body.idempotencyKey));

      return {
        libraryId: LIBRARY_ID,
        intentId: body.idempotencyKey,
        deleted: false,
        model: modelDto(),
        versions: []
      };
    };
    // Адрес пачки тоже оканчивается на «/run»: общий запасной ответ harness ему не подходит.
    h.handlers[batchUrl] = (body) => {
      stored.batch = structuredClone(h.pending.get(body.idempotencyKey));

      return {
        libraryId: LIBRARY_ID,
        intentId: body.idempotencyKey,
        children: [],
        status: 'waiting',
        totalEstimated: 40,
        unit: UNIT
      };
    };

    const startedAt = Date.now();

    await store.retry('fixture-model', 'v01-model', 30, retryKey);
    await store.batchRun({ snapshot, snapshotHash }, batchKey);

    const posts = h.calls.filter((call) => call.url === retryUrl || call.url === batchUrl);

    assert.deepEqual(posts.map((call) => [call.method, call.url, call.options.retry]), [
      ['post', retryUrl, false],
      ['post', batchUrl, false]
    ]);
    assert.deepEqual(posts[0].body, {
      expectedPrice: 30,
      libraryId: LIBRARY_ID,
      idempotencyKey: retryKey
    });
    assert.deepEqual(posts[1].body, {
      snapshot,
      snapshotHash,
      libraryId: LIBRARY_ID,
      idempotencyKey: batchKey
    });
    assert.equal(h.calls.some((call) => call.url === '/api/studio3d/run'), false);
    assert.equal(h.pending.size, 0);

    const { fingerprint: retryFingerprint, at: retryAt, ...retryRecord } = stored.retry;
    const { fingerprint: batchFingerprint, at: batchAt, ...batchRecord } = stored.batch;

    // Отпечаток считается без idempotencyKey; порядок ключей не важен, поэтому сверка разбором.
    assert.deepEqual(JSON.parse(retryFingerprint), {
      owner: 'fixture-user',
      kind: 'retry',
      modelId: 'fixture-model',
      versionId: 'v01-model',
      request: { expectedPrice: 30, libraryId: LIBRARY_ID }
    });
    assert.deepEqual(JSON.parse(batchFingerprint), {
      owner: 'fixture-user',
      kind: 'batch',
      request: {
        snapshot,
        snapshotHash,
        libraryId: LIBRARY_ID
      }
    });
    assert.equal(retryAt >= startedAt && retryAt <= Date.now(), true);
    assert.equal(batchAt >= startedAt && batchAt <= Date.now(), true);

    // Сохранённый JSON записи: у batch нет верхних modelId/versionId.
    assert.deepEqual(JSON.parse(JSON.stringify(retryRecord)), {
      key: retryKey,
      owner: 'fixture-user',
      libraryId: LIBRARY_ID,
      kind: 'retry',
      request: {
        expectedPrice: 30,
        libraryId: LIBRARY_ID,
        idempotencyKey: retryKey
      },
      modelId: 'fixture-model',
      versionId: 'v01-model'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(batchRecord)), {
      key: batchKey,
      owner: 'fixture-user',
      libraryId: LIBRARY_ID,
      kind: 'batch',
      request: {
        snapshot,
        snapshotHash,
        libraryId: LIBRARY_ID,
        idempotencyKey: batchKey
      }
    });
  });

});

test('WA-09 pending прежнего владельца виден после перехода и не отправляется заново',
  async (t) => {
    await installUiBrowser(t);

    const { createPinia, setActivePinia } = await import(singletonUrl('pinia'));
    const { useStudio3dStore } = await compileModule(webFile('src/stores/studio3d.ts'), {
      stubs: {
        '../../shared/apiClient.ts': TRANSPORT,
        '../shared/apiClient.ts': TRANSPORT,
        '../composables/useSse.ts': SSE,
        '../shared/alerts.ts': ALERTS,
        '../features/studio3d/pendingIntents.ts': PENDING,
      },
    });
    const h = harness();

    // Запись сохранена прежней версией под строковым login владельца.
    h.pending.set('legacy-intent', {
      key: 'legacy-intent',
      owner: 'legacy-login',
      kind: 'run',
      libraryId: LIBRARY_ID,
      at: Date.now(),
      request: {
        provider: 'tripo',
        operation: 'text-to-model',
        values: { prompt: 'Старый заказ' },
        expectedPrice: 30,
        name: 'Старый заказ',
      },
    });
    // Сервер недоступен: запись обязана остаться видимой, а не превратиться в новый заказ.
    h.handlers[`/api/studio3d/jobs/legacy-intent?libraryId=${LIBRARY_ID}`] = () => {
      throw new TypeError('fixture offline');
    };

    setActivePinia(createPinia());

    const store = useStudio3dStore();

    t.after(() => store.stop());

    // clientScope перехода равен прежнему login: запись не теряется.
    await store.start('legacy-login');

    assert.equal(store.pending.length, 1);
    assert.equal(store.pending[0].key, 'legacy-intent');
    assert.equal(h.pending.has('legacy-intent'), true);
    assert.deepEqual(h.calls.filter((call) => call.url.endsWith('/run')), []);
  });
