import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

async function mountPanel(t) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/settings' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
  })) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  let delivery = null;
  let stopped = false;
  const marks = [];
  globalThis.__webLogPanelRuntime = {
    mark: (text) => {
      marks.push(text);
      return { page: 'page-aaaaaaaaaaaaaaaa', seq: marks.length };
    },
    transport: { subscribeDelivery: (fn) => {
      delivery = fn;
      return () => { stopped = true; };
    } },
  };
  globalThis.__webLogPanelStatus = {
    ringCount: 1, pendingCount: 1, ringFrom: null, ringTo: null,
    lossCount: 0, storageAvailable: true,
    level: 'verbose',
  };
  const [{ mount }, { nextTick }, Panel] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    compileVue(webFile('src/views/settings/WebLogPanel.vue'), {
      stubs: {
        '../../ui': `
          import { defineComponent, h } from 'vue';
          export const UiButton = defineComponent({
            inheritAttrs: false,
            setup(_, { attrs, slots }) {
              return () => h('button', attrs, slots.default?.());
            },
          });
          export const UiTextarea = defineComponent({
            props: ['modelValue'], emits: ['update:modelValue'], inheritAttrs: false,
            setup(props, { attrs, emit }) {
              return () => h('textarea', { ...attrs, value: props.modelValue,
                onInput: (event) => emit('update:modelValue', event.target.value) });
            },
          });
        `,
        '../../shared/apiClient.ts': 'export const api = { downloadGet: async () => { throw new Error("unused"); } };',
        '../../shared/webLogRuntime.ts': 'export const getWebLogRuntime = () => globalThis.__webLogPanelRuntime;',
        '../../stores/webLog.ts': 'export const useWebLogStore = () => globalThis.__webLogPanelStatus;',
      },
    }),
  ]);
  const wrapper = mount(Panel, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    delete globalThis.__webLogPanelRuntime;
    delete globalThis.__webLogPanelStatus;
  });
  return { wrapper, nextTick, marks, deliver: (value) => delivery(value), stopped: () => stopped };
}

test('панель сообщает об успехе только после ACK текущей отметки', async (t) => {
  const { wrapper, nextTick, marks, deliver, stopped } = await mountPanel(t);
  await wrapper.get('#web-log-comment').setValue('После сбоя');
  await wrapper.get('.web-log-actions button').trigger('click');
  assert.deepEqual(marks, ['После сбоя']);
  assert.match(wrapper.get('[role="status"]').text(), /Ожидает отправки/u);

  deliver({ key: { page: 'page-aaaaaaaaaaaaaaaa', seq: 999 }, status: 'ack' });
  await nextTick();
  assert.match(wrapper.get('[role="status"]').text(), /Ожидает отправки/u);

  deliver({ key: { page: 'page-aaaaaaaaaaaaaaaa', seq: 1 }, status: 'ack' });
  await nextTick();
  assert.match(wrapper.get('[role="status"]').text(), /Сохранено на сервере/u);

  await wrapper.get('.web-log-actions button').trigger('click');
  deliver({ key: { page: 'page-aaaaaaaaaaaaaaaa', seq: 2 }, status: 'drop' });
  await nextTick();
  assert.match(wrapper.get('[role="status"]').text(), /Отметка не сохранена/u);

  await wrapper.get('.web-log-actions button').trigger('click');
  deliver({ key: { page: 'page-aaaaaaaaaaaaaaaa', seq: 3 }, status: 'evicted' });
  await nextTick();
  assert.match(wrapper.get('[role="status"]').text(), /Подтверждение сохранения не получено/u);
  deliver({ key: { page: 'page-aaaaaaaaaaaaaaaa', seq: 3 }, status: 'ack' });
  await nextTick();
  assert.match(wrapper.get('[role="status"]').text(), /Сохранено на сервере/u);

  globalThis.__webLogPanelRuntime.mark = () => null;
  await wrapper.get('.web-log-actions button').trigger('click');
  assert.match(wrapper.get('[role="status"]').text(), /Не удалось создать отметку/u);
  wrapper.unmount();
  assert.equal(stopped(), true);
});
