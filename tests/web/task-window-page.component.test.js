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
      '../stores/auth.ts': 'export const useAuthStore = () => globalThis.__taskWindowPage.auth;',
      '../stores/chat.ts': `export const useChatStore = () => ({
        syncSpeech: async () => globalThis.__taskWindowPage.calls.push('sync'),
        setSpeechSnapshot: (value) => globalThis.__taskWindowPage.calls.push('speech:' + value.revision),
      });`,
      '../stores/ui.ts': 'export const useUiStore = () => globalThis.__taskWindowPage.ui;',
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
    openTaskInline(id, source) {
      this.taskId = id;
      this.taskSource = source;
      calls.push('open:' + id);
    },
  });

  wrapper = mount(component, {
    props: {
      target: { kind: 'task', id: '42' },
      ready: false,
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(state.ui.taskId, null);
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
    closeWindow.call(window);
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
  assert.equal(wrapper.get('[data-task-modal]').element === input, true);
  assert.equal(input.value, 'Сохраняемый черновик');
  state.auth.authenticated = true;
  await nextTick();
  assert.equal(wrapper.get('[data-task-modal]').element === input, true);
  assert.equal(input.value, 'Сохраняемый черновик');
  state.listener('speech-settings', { revision: 7 });
  state.listener('hello', {});
  state.listener('task-shelf-changed', {});
  assert.deepEqual(calls, ['sync', 'open:42', 'markSeen', 'sync', 'speech:7', 'sync']);

  const source = `grigdesk-b24@${'a'.repeat(64)}`;

  await wrapper.setProps({ target: {
    kind: 'task',
    id: '42',
    source,
  } });
  assert.equal(state.ui.taskSource, source);
  wrapper.unmount();
  assert.equal(calls.at(-1), 'unsubscribe');
});

test('TWP-LOCAL-01: документ собственной задачи ждёт соединения с нейтральной подписью', async (t) => {
  await installUiBrowser(t);

  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const component = await compileVue(webFile('src/views/TaskWindowPage.vue'), {
    stubs: {
      '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      '../stores/auth.ts': 'export const useAuthStore = () => ({ authenticated: false });',
      '../stores/chat.ts': 'export const useChatStore = () => ({ syncSpeech() {} });',
      '../stores/ui.ts': 'export const useUiStore = () => ({ taskId: null, openTaskInline() {} });',
      './TaskModal.vue': 'export default { template: "<section>Своя задача</section>" };',
    },
  });
  const wrapper = mount(component, {
    props: { target: { kind: 'task', id: '100000000001' }, ready: false },
  });

  t.after(() => wrapper.unmount());
  assert.doesNotMatch(wrapper.text(), /Битрикс24/);
  assert.doesNotMatch(wrapper.attributes('aria-label') || '', /Битрикс24/);
  assert.equal(document.title, 'Задача #100000000001 — GrigDesk');
});

test('TWP-BOOT-01: начальная очистка сессии не закрывает локальную или внешнюю карточку', async (t) => {
  await installUiBrowser(t);

  const { nextTick, reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const state = {
    auth: reactive({ authenticated: false }),
    ui: reactive({
      taskId: null,
      taskSource: undefined,
      openTaskInline(id, source) {
        this.taskId = id;
        this.taskSource = source;
      },
      close() {
        this.taskId = null;
        this.taskSource = undefined;
      },
    }),
  };

  globalThis.__taskWindowBootstrap = state;

  const originalClose = window.close;
  let closeCount = 0;

  window.close = () => {
    closeCount += 1;
  };
  t.after(() => {
    window.close = originalClose;
    delete globalThis.__taskWindowBootstrap;
  });

  const component = await compileVue(webFile('src/views/TaskWindowPage.vue'), {
    stubs: {
      '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      '../stores/auth.ts': 'export const useAuthStore = () => globalThis.__taskWindowBootstrap.auth;',
      '../stores/chat.ts': 'export const useChatStore = () => ({ syncSpeech() {} });',
      '../stores/ui.ts': 'export const useUiStore = () => globalThis.__taskWindowBootstrap.ui;',
      './TaskModal.vue': `export default {
        template: '<textarea data-task-draft aria-label="Черновик"></textarea>',
      };`,
    },
  });
  const externalSource = `grigdesk-b24-discript@${'a'.repeat(64)}`;
  const targets = [
    {
      kind: 'task',
      id: '42',
      source: externalSource,
    },
    {
      kind: 'task',
      id: '100000000001',
      source: 'grigdesk',
    },
    { kind: 'task', id: '43' },
  ];

  for (const target of targets) {
    state.auth.authenticated = false;
    state.ui.close();
    closeCount = 0;

    const wrapper = mount(component, { props: { target, ready: false } });

    try {
      // App очищает UI при первом получении профиля и владельца сессии.
      // Эта очистка предшествует готовности карточки и не означает её закрытие человеком.
      state.ui.close();
      await nextTick();
      assert.equal(closeCount, 0, 'Начальная очистка не должна закрывать окно');
      assert.equal(wrapper.find('[data-task-draft]').exists(), false);
      assert.equal(document.title, `Задача #${target.id} — GrigDesk`);

      state.auth.authenticated = true;
      await wrapper.setProps({ ready: true });
      assert.equal(state.ui.taskId, target.id);
      assert.equal(state.ui.taskSource, target.source);
      assert.equal(closeCount, 0);
      await wrapper.get('[data-task-draft]').setValue('Сохраняемый черновик');

      const draft = wrapper.get('[data-task-draft]').element;

      state.auth.authenticated = false;
      await nextTick();
      state.auth.authenticated = true;
      await nextTick();
      assert.equal(wrapper.get('[data-task-draft]').element, draft);
      assert.equal(draft.value, 'Сохраняемый черновик');
      assert.equal(closeCount, 0);

      // После готовности явное закрытие по-прежнему завершает native-документ.
      state.ui.close();
      await nextTick();
      assert.equal(closeCount, 1);
    } finally {
      wrapper.unmount();
    }
  }
});
