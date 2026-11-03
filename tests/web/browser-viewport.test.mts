import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

const browser = await createUiBrowser();
const vueRuntime = new URL('../../web/node_modules/vue/index.mjs', import.meta.url);
const testUtilsRuntime = new URL(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs', import.meta.url,
);
const [{ nextTick }, { mount, flushPromises }, fixture] = await Promise.all([
  import(vueRuntime.href) as Promise<typeof import('vue')>,
  import(testUtilsRuntime.href) as Promise<typeof import('@vue/test-utils')>,
  compileModule(new URL('./helpers/browserViewportHarness.ts', import.meta.url).pathname),
]);

test.after(() => browser.close());
Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => new browser.DOMRect(10, 20, 640, 480),
});

test('VP01: layer registration скрывает view синхронно, tooltip не закрывает viewport', async (t) => {
  const calls: Record<string, unknown>[] = [];

  window.grigdeskBrowser = {
    invoke: async (request) => {
      calls.push(request as Record<string, unknown>);

      return {};
    },
    hide: (request) => {
      calls.push(request);

      return true;
    },
    subscribe: () => () => undefined,
    subscribeIntent: () => () => undefined,
  };

  const wrapper = mount(fixture.BrowserViewport, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  await flushPromises();

  const first = calls.findLast((item) => item.operation === 'layout')!;

  assert.deepEqual(first.rect, {
    x: 10,
    y: 20,
    width: 640,
    height: 480
  });

  const layer = fixture.registerUiLayer('viewport-modal', { name: 'dialog', close: () => true });

  t.after(() => layer.unregister());

  const immediate = calls.at(-1)!;

  assert.equal(immediate.operation, 'hide');
  assert.equal(immediate.instance, first.instance);
  assert.ok(Number(immediate.revision) > Number(first.revision));

  const count = calls.length;

  await nextTick();
  await flushPromises();
  assert.equal(calls.length, count);
  layer.unregister();
  await flushPromises();
  assert.equal(calls.at(-1)!.operation, 'layout');

  const beforeTooltip = calls.length;
  const tooltip = fixture.registerUiLayer('viewport-tip', { name: 'tooltip', close: () => true });

  await flushPromises();
  assert.equal(calls.length, beforeTooltip, 'tooltip не скрывает и не переставляет native view');
  tooltip.unregister();
  await flushPromises();
  assert.equal(calls.length, beforeTooltip);
  assert.equal(calls.at(-1)!.operation, 'layout');
});

test('VP02: late mount ACK не возвращает unmounted instance поверх нового view', async () => {
  const calls: Record<string, unknown>[] = [];
  let release!: (value: unknown) => void;
  let firstMount = true;

  window.grigdeskBrowser = {
    invoke: async (request) => {
      const value = request as Record<string, unknown>;

      calls.push(value);

      if (value.operation === 'viewport-mount' && firstMount) {
        firstMount = false;

        return new Promise((resolve) => {
          release = resolve;
        });
      }

      return {};
    },
    hide: (request) => {
      calls.push(request);

      return true;
    },
    subscribe: () => () => undefined,
    subscribeIntent: () => () => undefined,
  };

  const old = mount(fixture.BrowserViewport, { attachTo: document.body });
  const oldId = calls[0]!.instance;

  old.unmount();

  const current = mount(fixture.BrowserViewport, { attachTo: document.body });

  try {
    await flushPromises();

    const nextId = calls.findLast((item) => item.operation === 'layout')!.instance;

    assert.notEqual(nextId, oldId);
    release({});
    await flushPromises();
    assert.equal(calls.some((item) => item.operation === 'layout' && item.instance === oldId), false);
    assert.equal(calls.at(-1)!.instance, nextId);
  } finally {
    current.unmount();
  }
});

test('VP03: оповещение синхронно скрывает guest и закрытие возвращает текущую страницу', async (t) => {
  const calls: Record<string, unknown>[] = [];

  window.grigdeskBrowser = {
    invoke: async (request) => {
      calls.push(request as Record<string, unknown>);

      return {};
    },
    hide: (request) => {
      calls.push(request);

      return true;
    },
    subscribe: () => () => undefined,
    subscribeIntent: () => () => undefined,
  };

  const wrapper = mount(fixture.BrowserViewport, { attachTo: document.body });

  t.after(() => {
    wrapper.unmount();
    fixture.dismissToast('viewport-toast');
  });
  await flushPromises();
  assert.equal(calls.at(-1)!.operation, 'layout');
  fixture.showToast({
    id: 'viewport-toast',
    title: 'Нужен ответ',
    durationMs: 0,
  });
  assert.equal(calls.at(-1)!.operation, 'hide');

  const count = calls.length;

  await flushPromises();
  assert.equal(calls.length, count);
  fixture.dismissToast('viewport-toast');
  await flushPromises();
  assert.equal(calls.at(-1)!.operation, 'layout');
  assert.equal(calls.filter((item) => item.operation === 'viewport-mount').length, 1);
});
