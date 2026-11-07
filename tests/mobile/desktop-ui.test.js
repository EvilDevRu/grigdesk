import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installBrowser } from './helpers/ui.js';
import { MockLink } from '../../mobile/src/link/mockLink.ts';
import { messageIntent } from '../../mobile/src/api/client.ts';

process.env.NODE_ENV = 'test';

/**
 * Android и desktop монтируют один и тот же компонент с явной подменой платформы.
 * Проверяются видимые действия и восстановление состояния, а не только исходный текст SFC.
 */
test('DC-33/34/34a/34b: desktop и Android сохраняют свои действия и состояния восстановления', async (t) => {
  const browser = installBrowser();
  const { mount, flushPromises } =
    await import('../../mobile/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { createPinia, disposePinia } = await import('../../mobile/node_modules/pinia/dist/pinia.mjs');

  t.after(() => browser.happyDOM.abort());

  for (const desktop of [true, false]) {
    const stubs = { '../platform.ts': `export const isDesktop = ${desktop};` };
    const { PairForm, router, useLinkStore } = await compileModule(
      webFile('../tests/mobile/helpers/testApp.ts'), { stubs },
    );
    const pinia = createPinia();
    const store = useLinkStore(pinia);
    const state = {
      paired: true,
      unlocked: true,
      generation: 1,
      relays: [],
      brainName: 'Тест',
      deviceName: 'Тест',
    };

    store.state = { ...state };
    store.bridge = { getOutbox: async () => ({ items: [] }), downloadUpdate: async () => {} };
    store.api = { getApp: async () => ({ version: '0.2.0' }) };

    const global = { plugins: [pinia, router] };
    const form = mount(PairForm, { global });

    assert.equal(form.text().includes('Сканировать QR'), !desktop);
    assert.equal(form.find('textarea').exists(), true);
    assert.match(form.text(), /Вставить код/);
    form.unmount();

    const moreComponent = await compileVue(webFile('src/views/MoreView.vue'), {
      stubs: {
        ...stubs,
        '../stores/link.ts': `export const useLinkStore = () => globalThis.__desktopUiStore;
          export const onSignal = () => () => {}; export const onClear = () => {};`,
      },
    });

    globalThis.__desktopUiStore = store;

    const more = mount(moreComponent, { global });

    await flushPromises();
    assert.equal(more.text().includes('Проверить обновление'), !desktop);
    assert.match(more.text(), /Версия приложения: 0.1.0/);

    if (desktop) {
      assert.match(more.text(), /ставится установщиком/);
      assert.doesNotMatch(more.text(), /Скачать и установить/);
    } else {
      const check = more.findAll('button').find((button) => button.text() === 'Проверить обновление');

      await check.trigger('click');
      await flushPromises();
      assert.match(more.text(), /Доступна версия 0.2.0/);
      assert.match(more.text(), /Скачать и установить/);
    }

    more.unmount();
    store.state = {
      ...state,
      paired: false,
      unlocked: false,
      error: 'Нет защищённого хранилища ключей.',
    };

    let resets = 0;

    store.reset = async () => {
      resets += 1;
    };
    store.unlock = async () => {
      store.state = { ...state };
    };

    const screenStubs = {
      ...stubs,
      '../stores/link.ts': `export const useLinkStore = () => globalThis.__desktopUiStore;
        export const onSignal = () => () => {}; export const onClear = () => {};`,
    };
    const addComponent = await compileVue(webFile('src/views/AddRelayView.vue'), { stubs: screenStubs });
    const add = mount(addComponent, { global });

    assert.match(add.text(), /Нет защищённого хранилища ключей/);
    assert.match(add.text(), /Отвязать незавершённую привязку/);
    assert.equal(add.text().includes('Повторить'), desktop);

    if (desktop) {
      await add.findAll('button').find((button) => button.text() === 'Повторить').trigger('click');
      await flushPromises();
      assert.equal(store.state.paired, true);
      assert.equal(resets, 0);
    }

    add.unmount();
    store.state = {
      ...state,
      unlocked: false,
      error: 'Ошибка восстановления.',
    };

    const lockComponent = await compileVue(webFile('src/views/LockView.vue'), { stubs: screenStubs });
    const lock = mount(lockComponent, { global });

    assert.equal(lock.text().includes('Ошибка восстановления.'), desktop);
    assert.equal(lock.text().includes('отпечатком пальца'), !desktop);
    lock.unmount();
    disposePinia(pinia);
  }

  delete globalThis.__desktopUiStore;
});

/**
 * Настоящие App, store и outbox получают minApp выше версии desktop через hello.
 * Сохранённая команда остаётся в native, а интерфейс предлагает только ручную установку.
 */
test('DC-34b: несовместимый desktop не повторяет очередь и не скачивает APK', async (t) => {
  const browser = installBrowser();
  const { mount, flushPromises } =
    await import('../../mobile/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { createPinia, disposePinia } = await import('../../mobile/node_modules/pinia/dist/pinia.mjs');
  const hello = JSON.parse(await readFile(
    new URL('../fixtures/mobile-contract/v1/hello.json', import.meta.url), 'utf8',
  ));
  const intent = messageIntent('chat', 'Сохранённое сообщение');
  const requests = [];
  const bridge = new MockLink({
    outbox: [intent],
    request: async (input) => {
      requests.push(input);

      assert.equal(input.method, 'GET');

      const body = input.path === '/api/mobile/v1/hello'
        ? { ...hello, minApp: '9.0.0' }
        : input.path.includes('/deliveries')
          ? { deliveries: [] }
          : { state: 'not_found', result: null };

      return { status: 200, body: JSON.stringify(body) };
    },
  });
  let downloads = 0;

  bridge.downloadUpdate = async () => {
    downloads += 1;
  };
  globalThis.__desktopIncompatibleBridge = bridge;

  const { App, router, useLinkStore, useChatsStore } = await compileModule(
    webFile('../tests/mobile/helpers/testApp.ts'),
    { stubs: {
      '../platform.ts': 'export const isDesktop = true;',
      '../link/index.ts': 'export const getLink = async () => globalThis.__desktopIncompatibleBridge;',
    } },
  );
  const pinia = createPinia();

  await router.push('/chats/chat');

  const screen = mount(App, { global: { plugins: [pinia, router] } });

  t.after(async () => {
    screen.unmount();
    disposePinia(pinia);
    await bridge.stopEvents();
    delete globalThis.__desktopIncompatibleBridge;
    await browser.happyDOM.abort();
  });
  await flushPromises();
  assert.match(screen.text(), /Обнови приложение/);
  assert.match(screen.text(), /ставится установщиком/);
  assert.doesNotMatch(screen.text(), /Проверить обновление|Скачать и установить/);
  assert.equal(screen.find('textarea').exists(), false);

  const store = useLinkStore(pinia);

  await assert.rejects(store.api.sendMessage('chat', '', intent),
    (error) => error.code === 'update_required');

  const queue = useChatsStore(pinia).queue();

  await queue.restore();
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].state, 'failed');
  assert.match(queue.items[0].error, /Обнов/);
  assert.deepEqual((await bridge.getOutbox()).items, [intent]);
  assert.equal(requests.some((input) => input.method === 'POST'), false);
  assert.equal(downloads, 0);
});
