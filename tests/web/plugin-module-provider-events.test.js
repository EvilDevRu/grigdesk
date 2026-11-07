import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from './helpers/pluginModuleServices.js';

test('PM-PROVIDERS: только invalidation, inactive/abort/off и новая регистрация', async (t) => {
  const f = await serviceFixture(t, 'pluginRuntime/contextServices.ts', {
    sse: 'composables/useSse.ts',
  });
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

  const active = f.vue.ref(true);
  const abort = new AbortController();
  const create = (signal) => f.createPluginContextServices({ pluginId: 'ui-module' }, {
    signal,
    panelActive: active,
    backgroundActive: f.vue.ref(true),
    isAlive: () => !signal.aborted,
  }).context;
  const context = create(abort.signal);
  const calls = [];

  assert.equal(typeof context.providers?.onChanged, 'function');

  const off = context.providers.onChanged((...args) => calls.push(args));
  const emit = (name) => sources[0].listeners.get(name)?.({ data: '{"secret":"not-delivered"}' });

  emit('plugin-event');
  emit('providers-update');
  assert.deepEqual(calls, [[]]);
  active.value = false;
  emit('providers-update');
  assert.equal(calls.length, 1);
  active.value = true;
  emit('providers-update');
  assert.equal(calls.length, 2);
  off();
  off();
  emit('providers-update');
  assert.equal(calls.length, 2);
  context.providers.onChanged(() => calls.push('old'));
  abort.abort();
  emit('providers-update');
  assert.equal(calls.length, 2);

  const next = new AbortController();

  t.after(() => next.abort());

  const nextContext = create(next.signal);
  const offNext = nextContext.providers.onChanged(() => calls.push('new'));

  emit('providers-update');
  assert.deepEqual(calls, [[], [], 'new']);
  offNext();

  const current = f.vue.shallowRef(nextContext);
  const host = document.createElement('div');
  const probe = {
    props: ['context'],
    setup(props) {
      props.context.providers.onChanged(() => calls.push('mounted'));

      return () => f.vue.h('span');
    },
  };
  const app = f.vue.createApp({ render: () => f.vue.h(probe, { context: current.value }) });

  document.body.append(host);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  emit('providers-update');
  next.abort();

  const rebound = new AbortController();

  t.after(() => rebound.abort());
  current.value = create(rebound.signal);
  await f.vue.nextTick();
  emit('providers-update');
  assert.deepEqual(calls, [[], [], 'new', 'mounted', 'mounted']);
  assert.equal(sources.length, 1);
});

test('PM-SETTINGS: цель передаётся общему requestOpen только живым context', async (t) => {
  const f = await serviceFixture(t, 'pluginRuntime/contextServices.ts', {
    settings: 'stores/settings.ts',
  });

  f.pinia.setActivePinia(f.pinia.createPinia());

  const requests = [];
  const abort = new AbortController();

  t.mock.method(f.settings.useSettingsStore(), 'requestOpen', (request) => {
    requests.push(request);

    return true;
  });

  let alive = true;
  const { context } = f.createPluginContextServices({ pluginId: 'ui-module' }, {
    signal: abort.signal,
    isAlive: () => alive,
    panelActive: f.vue.ref(true),
    backgroundActive: f.vue.ref(true),
  });

  assert.equal(typeof context.openSettings, 'function');
  assert.equal(context.openSettings({
    pageId: 'providers',
    entityId: 'fake',
    source: 'route',
  }), true);
  assert.deepEqual(requests, [{
    source: 'button',
    pageId: 'providers',
    entityId: 'fake',
  }]);
  alive = false;
  assert.equal(context.openSettings({ pageId: 'providers' }), false);
  alive = true;
  abort.abort();
  assert.equal(context.openSettings({ pageId: 'providers' }), false);
  assert.equal(requests.length, 1);
});
