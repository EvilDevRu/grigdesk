import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installBrowser } from './helpers/ui.js';
import { fixture } from './visual/scenarios.mjs';
import { MockLink } from '../../mobile/src/link/mockLink.ts';
import { contextDisplay } from '../../mobile/src/components/chatContext.ts';

process.env.NODE_ENV = 'test';

test('Кольцо отличает неизвестное от нуля и не выдумывает runtime окно', () => {
  const context = {
    tokens: 0,
    window: null,
    metric: 'last-request-input',
    estimate: false,
    live: true,
    compactWindow: 0,
  };
  const model = {
    context: 200000,
    contextVerified: false,
    autoCompact: true,
  };

  assert.equal(contextDisplay(context, model).percent, null);
  assert.equal(contextDisplay({ ...context, window: 1000 }, model).percent, 0);
  assert.equal(contextDisplay({
    ...context,
    tokens: 200,
    window: 1000,
    compactWindow: 400,
  }, model).percent, 50);
  assert.equal(contextDisplay({
    ...context,
    window: 1000,
    metric: 'unavailable',
  }, model).percent, null);
});

test('UI: создание с повтором, модель со сбросом, effort, перенос папки и непрочитанные', async (t) => {
  const browser = installBrowser();
  const { mount, flushPromises } =
    await import('../../mobile/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { createPinia, disposePinia } = await import('../../mobile/node_modules/pinia/dist/pinia.mjs');
  const { data } = await fixture('chat-tablet');
  const posts = [];
  let createPending = true;
  const bridge = new MockLink({
    request: async (input) => {
      const route = new URL(input.path, 'https://example.invalid').pathname.replace('/api/mobile/v1/', '');
      let value;

      if (input.method === 'POST') {
        posts.push(input);

        const body = JSON.parse(input.body);

        if (route === 'chats' && createPending) {
          createPending = false;

          return { status: 202, body: JSON.stringify({ operationPending: true }) };
        }
        if (route === 'chats') {
          data.chat.chat.id = 'new-mobile-chat';
          data.chat.chat.title = 'Новый чат';
          data.chat.chat.modelRef = body.modelRef;
          data.chats.chats.unshift({ ...data.chat.chat });
        } else if (route.endsWith('/settings')) {
          data.chat.chat.modelRef = body.modelRef;
          data.chat.chat.settings.modelRef = body.modelRef;
          data.chat.chat.effort = body.effort;
          data.chat.chat.revision += 1;
        } else if (route.endsWith('/workspace/preview')) {
          return { status: 200, body: JSON.stringify(data['workspace-preview']) };
        } else if (route.endsWith('/workspace')) {
          data.chat.chat.settings.workdir = { kind: 'path', path: '/workspace/sample' };
          data.chat.chat.settings.directory = '/workspace/sample';
          data.chat.chat.taskId = '123';
          data.chat.chat.revision += 1;
        } else if (route.endsWith('/read')) {
          data.chat.chat.unread = false;
          data.chat.chat.revision += 1;
          delete data.chat.chat.actions.read;
          data.attention.chats.unread = 0;
        }

        value = { id: data.chat.chat.id, revision: data.chat.chat.revision };
      } else {
        value = data[route.startsWith('chats/') ? 'chat' : route] || { error: 'mock_missing' };
      }

      return { status: 200, body: JSON.stringify(value) };
    },
  });

  globalThis.__mobileUiBridge = bridge;

  const { App, router } = await compileModule(webFile('../tests/mobile/helpers/testApp.ts'), {
    stubs: { '../link/index.ts': 'export const getLink = async () => globalThis.__mobileUiBridge;' },
  });
  const pinia = createPinia();

  await router.push('/chats');

  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router] } });

  t.after(async () => {
    wrapper.unmount();
    disposePinia(pinia);
    await bridge.stopEvents();
    delete globalThis.__mobileUiBridge;
    await browser.happyDOM.abort();
  });

  /**
   * Нажимает настоящую кнопку портального диалога по видимой подписи.
   * Ожидание Vue завершает запрос и смену страницы перед следующей проверкой.
   */
  const click = async (name) => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === name);

    assert.ok(button, `Нет кнопки «${name}»`);
    button.click();
    await flushPromises();
  };
  /**
   * Меняет нативный select через событие человека, без доступа к внутреннему состоянию формы.
   * Так проверяется передача выбранного значения в настоящий мобильный API-клиент.
   */
  const select = async (label, value) => {
    const input = document.querySelector(`select[aria-label="${label}"]`);

    assert.ok(input, `Нет поля «${label}»`);
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  };

  await flushPromises();
  assert.equal(wrapper.findAll('.nav-badge').length, 2);
  await wrapper.find('[aria-label="Новый чат"]').trigger('click');
  await flushPromises();
  await click('Создать чат');
  assert.match(document.querySelector('[role="dialog"]').textContent, /Повтор проверит то же действие/);
  await click('Проверить действие');
  await flushPromises();
  assert.equal(router.currentRoute.value.path, '/chats/new-mobile-chat');
  assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey);
  assert.equal(posts[0].body, posts[1].body);
  assert.equal((await bridge.getOutbox()).items.length, 0);

  await wrapper.find('.chat-model').trigger('click');
  await flushPromises();
  await select('Модель', '["two","missing"]');
  await select('Модель', '["claude","opus"]');
  assert.equal([...document.querySelectorAll('[role="dialog"] button')]
    .find((node) => node.textContent.trim() === 'Применить').disabled, true);
  document.querySelector('[role="dialog"] [role="switch"]').click();
  await flushPromises();
  await click('Применить');

  const configured = JSON.parse(posts.find((input) => input.path.endsWith('/settings')).body);

  assert.equal(configured.reset, true);
  assert.deepEqual(configured.modelRef, { provider: 'claude', model: 'opus' });
  await wrapper.find('.chat-effort-range').setValue('2');
  await flushPromises();
  assert.equal(
    JSON.parse(posts.filter((input) => input.path.endsWith('/settings')).at(-1).body).effort, 'high',
  );

  await wrapper.find('.chat-folder').trigger('click');
  await flushPromises();
  await select('Задача', '123');
  await select('Папка', 'path');

  const input = document.querySelector('[role="dialog"] input[type="text"]');

  input.value = '/workspace/sample';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
  await click('Продолжить');
  assert.match(document.querySelector('[role="dialog"]').textContent, /Новая папка: \/workspace\/sample/);
  await select('Память разговора', 'summary');
  await click('Применить');
  assert.equal(JSON.parse(posts.find((item) => item.path.endsWith('/workspace')).body).transfer, 'summary');
  assert.equal(wrapper.find('.chat-folder').attributes('aria-label'), 'Папка: /workspace/sample');
  assert.match(wrapper.find('.chat-task').text(), /№123/);

  data.chat.chat.unread = true;
  data.chat.chat.actions.read = 'r'.repeat(48);
  data.chat.chat.revision += 1;
  bridge.emit('chat', { chatId: data.chat.chat.id, kind: 'done' });
  await flushPromises();
  assert.equal(posts.filter((item) => item.path.endsWith('/read')).length, 1);
  assert.equal(data.chat.chat.unread, false);
});
