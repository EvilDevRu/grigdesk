import assert from 'node:assert/strict';
import test from 'node:test';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { settle } from './helpers/pluginRuntimeUnit.js';

/**
 * Подменяется только браузерный транспорт: доставку и единственное соединение ведёт реальный SSE.
 * Неизвестное имя намеренно не получает listener, как в настоящем EventSource.
 */
async function eventsFixture(t) {
  const f = await serviceFixture(t, 'pluginRuntime/events.ts', { sse: 'composables/useSse.ts' });
  const sources = [];
  const original = globalThis.EventSource;

  globalThis.EventSource = class {
    listeners = new Map();

    constructor() {
      sources.push(this);
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    close() {}
  };
  t.after(() => {
    f.sse.resetSseForTests();
    globalThis.EventSource = original;
  });
  f.sse.sseSubscribe(() => {});

  const abort = new AbortController();
  const panelActive = f.vue.ref(true);
  const backgroundActive = f.vue.ref(true);
  const events = f.createPluginEvents('ui-module', {
    signal: abort.signal,
    panelActive,
    backgroundActive,
  });
  const emit = (data, name = 'plugin-event') => sources[0].listeners.get(name)?.({
    data: typeof data === 'string' ? data : JSON.stringify(data),
  });

  t.after(() => abort.abort());

  return {
    ...f,
    events,
    abort,
    panelActive,
    backgroundActive,
    sources,
    emit
  };
}

test('PM-EVENT-ISOLATION: только своё имя и pluginId через единственный общий SSE', async (t) => {
  const f = await eventsFixture(t);
  const received = [];

  f.events.on('progress', (data) => received.push(data));
  f.events.on('progress', () => {
    throw new Error('Ошибка одного listener');
  });
  f.events.on('progress', (data) => received.push(['second', data]));

  for (const data of [null, [], {}, '{broken', {
    pluginId: 'other',
    event: 'progress',
    data: 2
  },
    {
      pluginId: 'ui-module',
      event: 'other',
      data: 3
    }]) {
    f.emit(data);
  }

  f.emit({
    pluginId: 'ui-module',
    event: 'progress',
    data: 4
  }, 'studio-progress');
  f.emit({
    pluginId: 'ui-module',
    event: 'progress',
    data: { done: 1 }
  });
  assert.deepEqual(received, [{ done: 1 }, ['second', { done: 1 }]]);
  assert.equal(f.sources.length, 1);
});

test('PM-EVENT-LIFETIME: hidden, повторный показ, background, off и остановка', async (t) => {
  const f = await eventsFixture(t);
  const received = [];
  const off = f.events.on('tick', () => received.push('panel'));

  f.events.on('tick', () => received.push('background'), { lifetime: 'background' });
  f.emit({
    pluginId: 'ui-module',
    event: 'tick',
    data: 1
  });
  f.panelActive.value = false;
  await settle();
  f.emit({
    pluginId: 'ui-module',
    event: 'tick',
    data: 2
  });
  assert.deepEqual(received, ['panel', 'background', 'background']);
  f.panelActive.value = true;
  await settle();
  f.emit({
    pluginId: 'ui-module',
    event: 'tick',
    data: 3
  });
  assert.deepEqual(received.slice(3).sort(), ['background', 'panel']);
  off();
  off();
  f.backgroundActive.value = false;
  await settle();
  f.emit({
    pluginId: 'ui-module',
    event: 'tick',
    data: 4
  });
  assert.equal(received.length, 5);
  f.abort.abort();
  f.events.on('tick', () => received.push('revived'));
  f.emit({
    pluginId: 'ui-module',
    event: 'tick',
    data: 5
  });
  assert.equal(received.length, 5);
  assert.equal(f.sources.length, 1);
});

test('PM-EVENT-LIFETIME: Vue scope снимает регистрацию при unmount', async (t) => {
  const f = await eventsFixture(t);
  const scope = f.vue.effectScope();
  let calls = 0;

  scope.run(() => f.events.on('tick', () => calls += 1));
  f.emit({
    pluginId: 'ui-module',
    event: 'tick',
    data: 1
  });
  scope.stop();
  f.emit({
    pluginId: 'ui-module',
    event: 'tick',
    data: 2
  });
  assert.equal(calls, 1);
});
