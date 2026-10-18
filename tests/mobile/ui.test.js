import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installBrowser } from './helpers/ui.js';
import { MockLink } from '../../mobile/src/link/mockLink.ts';

process.env.NODE_ENV = 'test';

/**
 * Золотые ответы переводят только URL в имена DTO, без подмены продуктового клиента.
 * POST capture позволяет проверить actionToken, id вариантов и стабильный clientId.
 */
async function samples() {
  const result = {};

  for (const name of [
    'hello',
    'chats',
    'chat',
    'waiting',
    'details',
    'tasks',
    'task',
    'plan',
    'b24-tasks',
    'b24-task',
    'launch-options',
    'app',
    'accepted',
    'stop',
    'waiting-result',
    'gate',
    'resume',
    'launch',
  ]) {
    result[name] = JSON.parse(
      await readFile(
        new URL(`../fixtures/mobile-contract/v1/${name}.json`, import.meta.url),
        'utf8',
      ),
    );
  }

  return result;
}

/**
 * Маршруты теста используют настоящий decoder и только синтетические данные v1.
 * Неизвестный URL возвращает явный отказ, вместо ложного успешного значения.
 */
function kindOf(input) {
  const route = new URL(input.path, 'https://example.invalid').pathname.replace(
    '/api/mobile/v1/',
    '',
  );
  const routes = [
    /^hello$/,
    /^chats$/,
    /^chats\/[^/]+$/,
    /^waiting$/,
    /^waiting\/[^/]+\/details$/,
    /^tasks$/,
    /^tasks\/[^/]+$/,
    /^tasks\/[^/]+\/plan$/,
    /^b24\/tasks$/,
    /^b24\/tasks\/[^/]+$/,
    /^b24\/tasks\/[^/]+\/launch-options$/,
    /^app$/,
  ];
  const kinds = [
    'hello',
    'chats',
    'chat',
    'waiting',
    'details',
    'tasks',
    'task',
    'plan',
    'b24-tasks',
    'b24-task',
    'launch-options',
    'app',
  ];

  if (input.method === 'POST') {
    return route.endsWith('/messages')
      ? 'accepted'
      : route.startsWith('waiting/')
        ? 'waiting-result'
        : route.split('/').at(-1);
  }

  return kinds[routes.findIndex((pattern) => pattern.test(route))];
}

const clickText = async (wrapper, text) => {
  const button = wrapper.findAll('button').find((element) => element.text() === text);

  assert.equal(Boolean(button), true, `Нет кнопки ${text}`);
  await button.trigger('click');
};

test('MA-10…31: экраны используют native bridge, проверенный API и общий диалог', async (t) => {
  const browser = installBrowser();
  const { mount, flushPromises } =
    await import('../../mobile/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { createPinia, disposePinia } =
    await import('../../mobile/node_modules/pinia/dist/pinia.mjs');
  const data = await samples();
  const activeCount = data.chats.chats.length;

  data.chats.chats.push({
    ...data.chats.chats[0],
    id: 'archived-chat',
    title: 'Архивный разговор',
    archived: true,
    preview: 'Уникальная фраза завершённого разговора',
  });
  data.chat.chat.actions.stop = 'synthetic-stop-token';

  const posts = [];
  let delayChat = null;
  const bridge = new MockLink({
    request: async (input) => {
      const kind = kindOf(input);
      const value = structuredClone(data[kind] || { error: 'mock_missing' });

      if (kind === 'chat' && delayChat) {
        const wait = delayChat;

        delayChat = null;
        await wait();
      }

      if (input.method === 'POST') {
        posts.push(input);

        if (kind === 'accepted') {
          value.clientId = JSON.parse(input.body).clientId;
        }
      }

      return {
        status: kind === 'accepted' ? 202 : 200,
        body: JSON.stringify(value),
      };
    },
  });

  globalThis.__mobileUiBridge = bridge;

  const { App, router, useLinkStore } = await compileModule(
    webFile('../tests/mobile/helpers/testApp.ts'),
    {
      stubs: {
        '../link/index.ts': 'export const getLink = async () => globalThis.__mobileUiBridge;',
      },
    },
  );
  const pinia = createPinia();

  await router.push('/chats');

  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  });

  t.after(async () => {
    wrapper.unmount();
    disposePinia(pinia);
    await bridge.stopEvents();
    delete globalThis.__mobileUiBridge;
    await browser.happyDOM.abort();
  });
  await flushPromises();
  assert.match(wrapper.text(), /Чаты/);
  assert.match(wrapper.text(), new RegExp(data.chats.chats[0].title));
  await wrapper.find('input[type="search"]').setValue('такого разговора нет');
  assert.match(wrapper.text(), /Чаты не найдены/);
  assert.equal(wrapper.findAll('.split-list .mobile-list-row').length, 0);
  await clickText(wrapper, 'Сбросить фильтры');
  assert.equal(wrapper.findAll('.split-list .mobile-list-row').length, activeCount);
  assert.equal(wrapper.find('.split-list .list-count').exists(), false);
  await wrapper.find('[role="switch"]').trigger('click');
  assert.equal(wrapper.findAll('.split-list .mobile-list-row').length, 1);
  assert.match(wrapper.find('.split-list .mobile-list-row').text(), /Архивный разговор/);
  await wrapper.find('input[type="search"]').setValue('уникальная фраза');
  assert.equal(wrapper.findAll('.split-list .mobile-list-row').length, 1);
  await router.push('/chats/' + data.chat.chat.id);
  await flushPromises();
  await router.push('/chats');
  await flushPromises();
  assert.equal(wrapper.find('[role="switch"]').attributes('aria-checked'), 'true');
  assert.equal(wrapper.find('input[type="search"]').element.value, 'уникальная фраза');
  await wrapper.find('[role="switch"]').trigger('click');
  await wrapper.find('input[type="search"]').setValue(`  ${data.chat.chat.title.toUpperCase()}  `);
  await router.push('/chats/' + data.chat.chat.id);
  await flushPromises();
  await router.push('/chats');
  await flushPromises();
  assert.equal(wrapper.find('input[type="search"]').element.value.trim(), data.chat.chat.title.toUpperCase());
  await router.push('/chats/' + data.chat.chat.id);
  await flushPromises();
  assert.equal(wrapper.find('img[src="x"]').exists(), false);
  assert.equal(wrapper.find('.pane-head [aria-label="Стоп"]').exists(), false);
  assert.equal(wrapper.find('.composer-actions [aria-label="Стоп"]').exists(), true);
  await wrapper.find('.mobile-composer textarea').setValue('Черновик для планшета');
  await router.push('/tasks');
  await flushPromises();
  await router.push('/chats/' + data.chat.chat.id);
  await flushPromises();
  assert.equal(wrapper.find('.mobile-composer textarea').element.value, 'Черновик для планшета');
  assert.match(wrapper.find('.split-list').text(), /Черновик:\s+Черновик для планшета/);
  await wrapper.find('.mobile-composer textarea').setValue('Сообщение с телефона');
  await clickText(wrapper, 'Отправить');
  await flushPromises();

  const sent = posts.find((item) => item.path.endsWith('/messages'));

  assert.equal(Boolean(sent), true, wrapper.text());
  assert.equal(JSON.parse(sent.body).text, 'Сообщение с телефона');
  assert.equal(typeof sent.idempotencyKey, 'string');
  assert.equal(wrapper.find('textarea').element.value, '');

  let releaseChat;

  delayChat = () => new Promise((resolve) => {
    releaseChat = resolve;
  });
  bridge.emit('chat', { chatId: data.chat.chat.id, kind: 'progress' });
  await flushPromises();
  data.chat.messages[1].parts = [{ type: 'text', text: 'Итог после медленного чтения' }];
  bridge.emit('chat', { chatId: data.chat.chat.id, kind: 'done' });
  releaseChat();
  await flushPromises();
  assert.match(wrapper.find('.chat-feed').text(), /Итог после медленного чтения/);
  await router.push('/tasks');
  await flushPromises();
  assert.match(wrapper.text(), /Конвейер/);
  await clickText(wrapper, 'Требуют меня');
  assert.equal(
    wrapper.findAll('.split-list .mobile-list-row').length,
    data.tasks.tasks.filter((task) => task.needsHuman).length,
  );
  await clickText(wrapper, 'Все');
  await wrapper.find('input[type="search"]').setValue(data.task.task.id);
  assert.equal(wrapper.findAll('.split-list .mobile-list-row').length, 1);
  await router.push('/tasks/' + data.task.task.id);
  await flushPromises();
  await clickText(wrapper, 'План');
  await flushPromises();
  assert.match(wrapper.text(), new RegExp(data.plan.text.slice(0, 10)));

  if (data.task.task.needsHuman?.kind === 'gate') {
    await clickText(wrapper, 'Принять');
    await flushPromises();
    assert.equal(document.body.querySelectorAll('[role="dialog"]').length, 1);

    const buttons = [...document.body.querySelector('[role="dialog"]').querySelectorAll('button')];

    buttons.find((button) => button.textContent === 'Принять').click();
    await flushPromises();
    assert.equal(
      JSON.parse(posts.find((item) => item.path.endsWith('/gate')).body).decision,
      'approve',
    );
  }

  await router.push('/b24');
  await flushPromises();
  await clickText(wrapper, 'На конвейере');
  assert.equal(
    wrapper.findAll('.split-list .mobile-list-row').length,
    data['b24-tasks'].tasks.filter((task) => task.onPipeline).length,
  );
  await clickText(wrapper, 'Все');
  await router.push('/b24/' + data['b24-task'].task.id);
  await flushPromises();
  assert.match(wrapper.text(), /Запустить на конвейере/);
  await clickText(wrapper, 'Запустить на конвейере');
  await flushPromises();
  assert.match(document.body.textContent, /Варианты запуска|Запустить на конвейере/);
  await clickText(wrapper, data['launch-options'].options[0].title);
  await flushPromises();

  const launchConfirm = [
    ...document.body.querySelector('[role=dialog]').querySelectorAll('button'),
  ].find((button) => button.textContent === 'Запустить');

  launchConfirm.click();
  await flushPromises();

  const launched = JSON.parse(posts.find((item) => item.path.endsWith('/launch')).body);

  assert.equal(launched.optionId, data['launch-options'].options[0].id);
  assert.equal(launched.actionToken, data['launch-options'].actionToken);
  await router.push('/more');
  await flushPromises();
  assert.match(wrapper.text(), /Размер окна:/);
  assert.match(wrapper.text(), /Версия приложения: 0\.1\.0/);
  await clickText(wrapper, 'Проверить обновление');
  await flushPromises();
  assert.match(wrapper.text(), /Доступна версия|Установлена последняя версия/);
  useLinkStore(pinia).minApp = '1.0.0';
  await router.push('/chats/' + data.chat.chat.id);
  await flushPromises();
  assert.match(wrapper.text(), /Обнови приложение/);
  assert.equal(wrapper.find('.mobile-composer').exists(), false);
  assert.equal(wrapper.find('nav').exists(), false);
  useLinkStore(pinia).minApp = '0.1.0';
  await flushPromises();
  bridge.lock();
  await flushPromises();
  assert.match(wrapper.text(), /Приложение заблокировано/);
  assert.equal(wrapper.find('nav').exists(), false);
  await useLinkStore(pinia).unlock();
  await flushPromises();
  assert.equal(wrapper.find('nav').exists(), true);
  bridge.state.revoked = true;
  useLinkStore(pinia).fatal('device_revoked');
  await flushPromises();
  assert.match(wrapper.text(), /Телефон отозван в GrigDesk/);
  await clickText(wrapper, 'Отвязать');
  await flushPromises();
  assert.equal(document.body.querySelectorAll('[role="dialog"]').length, 1);

  const confirm = [
    ...document.body.querySelector('[role="dialog"]').querySelectorAll('button'),
  ].find((button) => button.textContent === 'Отвязать');

  confirm.click();
  await flushPromises();
  assert.match(wrapper.text(), /Подключить GrigDesk/);
});
