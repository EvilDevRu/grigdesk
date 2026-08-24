// Проверяет кнопку компаньона в верхней панели и её изолированную компиляцию в тесте.
import assert from 'node:assert/strict';
import test from 'node:test';

import { installCompanionBrowser } from './helpers/companion-component.js';
import { compileVue, webFile } from './helpers/compile-vue.js';

const BUTTON_PATH = webFile('src/features/companion/CompanionTopbarButton.vue');
let compileNonce = 0;

// Domain-зависимости заменяются явными заглушками, общий UI бандлится реальным.
async function compileButton(deps, t) {
  const key = `__companionTopbarDeps${compileNonce++}`;
  globalThis[key] = deps;
  t.after(() => { delete globalThis[key]; });
  const fromDeps = `globalThis[${JSON.stringify(key)}]`;

  return compileVue(BUTTON_PATH, {
    stubs: {
      'vue-router': `export const useRoute = () => ${fromDeps}.useRoute();`,
      '../../stores/companion.js': `
        export const useCompanionStore = (...args) => ${fromDeps}.useCompanionStore(...args);
      `,
      './CompanionRobot.vue': `export default ${fromDeps}.CompanionRobot;`,
    },
  });
}

async function mountButton(t, { path = '/pipeline', deviceEnabled = true } = {}) {
  const browser = await installCompanionBrowser(t);
  const [{ defineComponent, h, reactive }, { mount }] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const calls = { conversations: 0, toggles: 0 };
  const route = reactive({ path });
  const companion = reactive({
    deviceEnabled,
    bubbleOpen: false,
    interaction: 'idle',
    attention: { kind: 'none', count: 0 },
  });
  Object.assign(companion, {
    openConversation() { calls.conversations += 1; return Promise.resolve(true); },
    toggleBubble() { calls.toggles += 1; companion.bubbleOpen = !companion.bubbleOpen; },
  });
  const Button = await compileButton({
    useRoute: () => route,
    useCompanionStore: () => companion,
    CompanionRobot: defineComponent({
      props: { interaction: String, attention: String },
      setup: (props) => () => h('svg', { class: `companion-robot is-${props.interaction}` }),
    }),
  }, t);
  const wrapper = mount({ setup: () => () => h(Button) }, {
    attachTo: browser.document.querySelector('#mount'),
  });
  t.after(() => wrapper.unmount());
  return { wrapper, calls, companion, route };
}

test('COMP-TB-01: вне /chats кнопка топбара переключает пузырь компаньона', async (t) => {
  const { wrapper, calls, companion } = await mountButton(t, { path: '/pipeline' });

  const button = wrapper.get('.companion-tb');
  assert.equal(button.attributes('aria-expanded'), 'false');
  await button.trigger('click');
  assert.equal(calls.toggles, 1);
  assert.equal(calls.conversations, 0, 'вне /chats разговор не подменяет пузырь');
  assert.equal(companion.bubbleOpen, true);
  assert.equal(wrapper.get('.companion-tb').attributes('aria-expanded'), 'true');
});

test('COMP-TB-02: на /chats кнопка открывает разговор и НЕ поднимает второй композер', async (t) => {
  const { wrapper, calls, companion } = await mountButton(t, { path: '/chats' });

  await wrapper.get('.companion-tb').trigger('click');
  assert.equal(calls.conversations, 1);
  assert.equal(calls.toggles, 0, 'полная страница чатов остаётся единственным композером');
  assert.equal(companion.bubbleOpen, false);
  assert.equal(wrapper.get('.companion-tb').attributes('aria-expanded'), undefined,
    'на /chats кнопка ничем не управляет — aria-expanded не выставляется');
});

test('COMP-TB-03: выключенный на устройстве компаньон не показывает кнопку', async (t) => {
  const { wrapper } = await mountButton(t, { deviceEnabled: false });
  assert.equal(wrapper.find('.companion-tb').exists(), false);
});

test('COMP-TB-04: состояние и внимание доезжают до фигурки и подписи', async (t) => {
  const { wrapper, companion } = await mountButton(t, { path: '/pipeline' });

  companion.interaction = 'listening';
  companion.attention = { kind: 'stall', count: 2 };
  await wrapper.vm.$nextTick();

  const button = wrapper.get('.companion-tb');
  assert.equal(button.attributes('data-interaction'), 'listening');
  assert.equal(button.attributes('data-attention'), 'stall');
  assert.match(button.attributes('aria-label'), /Слушаю/);
  assert.match(button.attributes('aria-label'), /Остановившихся задач: 2/);
  assert.ok(wrapper.get('.companion-robot').classes('is-listening'));
});
