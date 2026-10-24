import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { api } from '../../web/src/shared/apiClient.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { drain } from './helpers/chat-load.js';

let vue;
let locale;
let mount;
let ChatList;

const TEXT = {
  ru: {
    loading: 'Загружаем чаты…',
    failed: 'Чаты не загрузились',
    network: 'Нет связи с сервером',
    timeout: 'Сервер не ответил вовремя',
    server: 'Ошибка сервера',
    retry: 'Повторить',
    blocked: 'Создать чат можно после загрузки списка',
  },
  en: {
    loading: 'Loading chats…',
    failed: 'Chats could not be loaded',
    network: 'No connection to the server',
    timeout: 'The server did not respond in time',
    server: 'Server error',
    retry: 'Retry',
    blocked: 'You can create a chat after the list loads',
  },
};
const ERROR_KEYS = {
  network: 'core.chatListLoadNetwork',
  timeout: 'core.chatListLoadTimeout',
  server: 'core.chatListLoadServer',
};

before(async () => {
  await installUiBrowser({ after: (cleanup) => after(cleanup) });
  vue = await import('../../web/node_modules/vue/index.mjs');
  locale = await import('../../web/src/services/locale.ts');
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
  globalThis.__loadListLocale = locale;
  globalThis.__loadListConnected = vue.ref(true);

  const localeStub = `export const {
    t, messageRef, resolveUiText, uiLocale, setUiLocale, snapshotText, locales,
  } = globalThis.__loadListLocale;`;
  const sseStub = `
    export const useSse = () => ({ connected: globalThis.__loadListConnected });
    export const sseSubscribe = () => () => {};
  `;

  ChatList = await compileVue(webFile('src/views/chat/ChatList.vue'), {
    stubs: {
      '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__loadListChat;',
      '../../stores/providers.ts': `export const useProvidersStore = () => ({
        load() {}, modelOf() { return { model: null, provider: null }; },
      });`,
      './useSse.ts': sseStub,
      './useSse': sseStub,
      '../../composables/useSse.ts': sseStub,
      './services/locale.ts': localeStub,
      '../services/locale.ts': localeStub,
      '../../shared/ProviderIcon.vue': 'export default { template: "<i />" };',
    },
  });
});

/**
 * Список получает реактивное состояние и настоящие UI controls с переводчиком.
 * Его проекция намеренно содержит копию: до ready компонент не должен даже читать list.
 */
async function fixture(t, initial = {}) {
  locale.setUiLocale('ru');

  const calls = {
    list: 0,
    create: 0,
    retry: 0,
    get: 0,
  };
  const state = vue.reactive({
    loaded: false,
    loading: true,
    loadError: null,
    activeId: '',
    archived: [{ id: 'archived-copy' }],
    ...initial,
    get loadErrorMessage() {
      return this.loadError ? locale.messageRef(ERROR_KEYS[this.loadError]) : null;
    },
    list() {
      calls.list += 1;

      return [{
        id: 'copy',
        title: 'Данные Я🦊',
        snippet: 'Сохранённая копия',
        ts: 200,
        model: '',
      }];
    },
    retryLoad() {
      calls.retry += 1;
      this.loading = true;
    },
    newSession() {
      calls.create += 1;

      return 'new-chat';
    },
    selectChat() {},
    renameChat() {},
    deleteChat() {},
    restoreArchived() {},
  });

  globalThis.__loadListChat = state;
  t.mock.method(api, 'get', async (url) => {
    calls.get += 1;
    assert.equal(url, '/api/chat/sessions');

    return { sessions: [] };
  });

  const wrapper = mount(ChatList, { attachTo: document.body });

  t.after(() => {
    wrapper.unmount();
    locale.setUiLocale('ru');
    delete globalThis.__loadListChat;
  });
  await drain();

  return {
    wrapper,
    state,
    calls,
  };
}

const retryButton = (wrapper, language = 'ru') => wrapper.findAll('button')
  .find((button) => button.text() === TEXT[language].retry);

test('LIST-STATE-01', async (t) => {
  await t.test('загрузка и успешные строки', async (sub) => {
    const { wrapper, state, calls } = await fixture(sub);

    assert.ok(wrapper.text().includes(TEXT.ru.loading));
    assert.equal(wrapper.text().includes('Нет активных чатов'), false);
    assert.equal(wrapper.text().includes('Данные Я🦊'), false);
    assert.equal(calls.list, 0, 'дорогая проекция не читается до ready');
    state.loaded = true;
    state.loading = false;
    await vue.nextTick();
    assert.equal(wrapper.text().includes(TEXT.ru.loading), false);
    assert.ok(wrapper.text().includes('Данные Я🦊'));
  });

  for (const reason of ['network', 'timeout', 'server']) {
    await t.test(reason, async (sub) => {
      const { wrapper, state, calls } = await fixture(sub, { loading: false, loadError: reason });

      await wrapper.find('.search input').setValue('Нет совпадений');
      await wrapper.find('[role="switch"]').trigger('click');
      assert.ok(wrapper.text().includes(TEXT.ru.failed));
      assert.ok(wrapper.text().includes(TEXT.ru[reason]));
      assert.equal(wrapper.text().includes('Данные Я🦊'), false);
      assert.equal(wrapper.text().includes('Ничего не найдено'), false);
      assert.equal(wrapper.text().includes('Архив пуст'), false);
      assert.equal(calls.list, 0);
      assert.equal(Boolean(retryButton(wrapper)), true);
      await retryButton(wrapper).trigger('click');
      assert.equal(calls.retry, 1);
      await vue.nextTick();
      assert.equal(retryButton(wrapper).element.disabled, true);
      assert.ok(wrapper.text().includes(TEXT.ru.failed), 'ошибка остаётся во время повторной попытки');
      state.loaded = true;
      state.loading = false;
      state.loadError = null;
      await vue.nextTick();
      assert.equal(wrapper.text().includes(TEXT.ru.failed), false);
    });
  }
});

test('LIST-STATE-02', async (t) => {
  const { wrapper, state, calls } = await fixture(t);
  const create = wrapper.find('[data-context="chat-list-new"]');

  assert.equal(create.element.disabled, true);
  assert.ok(wrapper.text().includes(TEXT.ru.blocked), 'объяснение видно без tooltip');
  await create.trigger('click');
  assert.equal(calls.create, 0);
  assert.equal(wrapper.emitted('open')?.length ?? 0, 0);
  state.loaded = true;
  state.loading = false;
  await vue.nextTick();
  await create.trigger('click');
  assert.equal(calls.create, 1);
  assert.equal(wrapper.emitted('open')?.length, 1);
});

test('LIST-STATE-03', async (t) => {
  for (const reason of [null, 'network', 'timeout', 'server']) {
    await t.test(reason ?? 'loading', async (sub) => {
      const { wrapper, state, calls } = await fixture(sub, { loading: !reason, loadError: reason });
      const reads = calls.get;

      assert.ok(wrapper.text().includes(reason ? TEXT.ru.failed : TEXT.ru.loading));
      assert.ok(wrapper.text().includes(TEXT.ru.blocked));
      locale.setUiLocale('en');
      await vue.nextTick();
      assert.ok(wrapper.text().includes(reason ? TEXT.en.failed : TEXT.en.loading));
      assert.ok(wrapper.text().includes(TEXT.en.blocked));

      if (reason) {
        assert.ok(wrapper.text().includes(TEXT.en[reason]));
        assert.equal(Boolean(retryButton(wrapper, 'en')), true);
      }

      assert.equal(calls.get, reads, 'смена языка не перечитывает сервер');
      state.loaded = true;
      state.loading = false;
      state.loadError = null;
      await vue.nextTick();
      assert.ok(wrapper.text().includes('Данные Я🦊'), 'данные не переводятся');
    });
  }
});
