import assert from 'node:assert/strict';
import test from 'node:test';
import { installUiBrowser } from './helpers/ui-components.js';
import { compileVue, webFile } from './helpers/compile-vue.js';

test('TWP-01: карточка ждёт запуска синхронизации и держит снимок речи', async (t) => {
  await installUiBrowser(t);

  const { nextTick, reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const calls = [];
  const state = {
    calls,
    listener: null,
    auth: reactive({ authenticated: false }),
  };

  globalThis.__taskWindowPage = state;

  let wrapper;

  t.after(() => {
    wrapper?.unmount();
    delete globalThis.__taskWindowPage;
  });

  const component = await compileVue(webFile('src/views/TaskWindowPage.vue'), { stubs: {
      '../composables/useSse.ts': `export const sseSubscribe = (listener) => {
        globalThis.__taskWindowPage.listener = listener;
        return () => globalThis.__taskWindowPage.calls.push('unsubscribe');
      };`,
      '../stores/auth.js': 'export const useAuthStore = () => globalThis.__taskWindowPage.auth;',
      '../stores/chat.js': `export const useChatStore = () => ({
        syncSpeech: async () => globalThis.__taskWindowPage.calls.push('sync'),
        setSpeechSnapshot: (value) => globalThis.__taskWindowPage.calls.push('speech:' + value.revision),
      });`,
      '../stores/ui.js': 'export const useUiStore = () => globalThis.__taskWindowPage.ui;',
      './TaskModal.vue': `import { h, ref, onMounted } from 'vue';
        export default { setup() {
          const draft = ref('');
          onMounted(() => globalThis.__taskWindowPage.calls.push('markSeen'));
          return () => h('input', {
            'data-task-modal': '',
            value: draft.value,
            onInput: (event) => draft.value = event.target.value,
          });
        } };`,
    } });

  state.ui = reactive({
    taskId: null,
    openTaskInline(id) {
      this.taskId = id;
      calls.push('open:' + id);
    },
  });

  wrapper = mount(component, {
    props: {
      target: { kind: 'task', id: '42' },
      ready: false,
    },
  });

  assert.deepEqual(calls, ['open:42']);
  assert.equal(document.title, 'Задача #42 — GrigDesk');
  assert.equal(wrapper.find('[data-task-modal]').exists(), false);
  assert.equal(wrapper.find('[role="status"]').exists(), true);

  // До карточки окно без системных кнопок закрывается собственной полосой.
  const closeWindow = window.close;
  let closed = 0;

  window.close = () => {
    closed += 1;
  };
  t.after(() => {
    window.close = closeWindow;
  });
  await wrapper.get('.task-window-titlebar [aria-label="Закрыть окно"]').trigger('click');
  assert.equal(closed, 1);
  state.auth.authenticated = true;
  await nextTick();
  await wrapper.setProps({ ready: true });
  assert.equal(wrapper.find('[data-task-modal]').exists(), true);
  // Карточку оформляет только её собственная шапка, отдельной полосы окна нет.
  assert.equal(wrapper.find('.task-window-titlebar').exists(), false);
  await wrapper.get('[data-task-modal]').setValue('Сохраняемый черновик');

  const input = wrapper.get('[data-task-modal]').element;

  state.auth.authenticated = false;
  await nextTick();
  assert.equal(wrapper.get('[data-task-modal]').element, input);
  assert.equal(input.value, 'Сохраняемый черновик');
  state.auth.authenticated = true;
  await nextTick();
  assert.equal(wrapper.get('[data-task-modal]').element, input);
  assert.equal(input.value, 'Сохраняемый черновик');
  state.listener('speech-settings', { revision: 7 });
  state.listener('hello', {});
  state.listener('task-shelf-changed', {});
  assert.deepEqual(calls.slice(1), ['sync', 'markSeen', 'sync', 'speech:7', 'sync']);
  wrapper.unmount();
  assert.equal(calls.at(-1), 'unsubscribe');
});
