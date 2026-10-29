import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sampleChat } from '../server/helpers/chat-list.js';
import { waitFor } from '../server/helpers/chat-turns.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { detailReads, lazyWindow } from './helpers/chat-lazy.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { drain } from './helpers/chat-load.js';

let mount;

let ChatList;

before(async () => {
  await installUiBrowser({ after: (fn) => after(fn) });
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
  ChatList = await compileVue(webFile('src/views/chat/ChatList.vue'), {
    stubs: {
      '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__remoteSearchChat;',
      '../../stores/providers.ts': `export const useProvidersStore = () => ({
        load() {}, modelOf() { return { model: null, provider: null }; },
      });`,
      '../../composables/useSse.ts': `export const useSse = () => ({ connected: true });
        export const sseSubscribe = () => () => {};`,
      './useSse.ts': `export const useSse = () => ({ connected: true });
        export const sseSubscribe = () => () => {};`,
      './useSse': `export const useSse = () => ({ connected: true });
        export const sseSubscribe = () => () => {};`,
      '../../shared/ProviderIcon.vue': 'export default { template: "<i />" };',
    },
  });
});

/**
 * Поиск проходит от настоящего поля ввода до API; store не получает полные сообщения.
 * Каждый запрос удерживается отдельно, чтобы ответы можно было переставить местами.
 */
async function fixture(t, { fail = false } = {}) {

  const requests = [];

  const first = sampleChat('remote-first', { title: 'Первый разговор' });

  const second = sampleChat('remote-second', { title: 'Второй разговор' });

  const archived = sampleChat('remote-archived', {
    title: 'Старый разговор',
    archived: true,
  });

  let broken = fail;

  const state = await lazyWindow(t, {
    chats: [first, second, archived],
    onCall: async ({ url }) => {
      if (url.startsWith('/api/chat/store/search?')) {

        const gate = Promise.withResolvers();

        const params = new URL(url, 'http://fixture.test').searchParams;

        requests.push({
          gate,
          params,
        });

        if (broken) {
          throw new TypeError('Нет связи с сервером');
        }

        return gate.promise;
      }

      return undefined;
    },
  });

  globalThis.__remoteSearchChat = state.chat;

  const wrapper = mount(ChatList, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  await drain();

  return {
    ...state,
    wrapper,
    requests,
    restore() {
      broken = false;
    },
  };
}

test('SEARCH-REMOTE: текст неоткрытой ленты найден сервером без скачивания сообщений', async (t) => {

  const state = await fixture(t);

  await state.wrapper.find('.search input').setValue('редкая строка');
  await waitFor(() => state.requests.length === 1);
  assert.equal(state.requests[0].params.get('q'), 'редкая строка');
  assert.equal(state.requests[0].params.get('archived'), '0');
  assert.equal(state.wrapper.text().includes('Ничего не найдено'), false, 'pending не равен пустой выдаче');
  state.requests[0].gate.resolve({ matches: [{
    id: 'remote-first',
    snippetSource: '…редкая строка вокруг',
  }] });
  await waitFor(() => state.wrapper.text().includes('редкая строка вокруг'));
  assert.equal(state.wrapper.text().includes('Второй разговор'), false);
  assert.equal(detailReads(state.calls, 'remote-first').length, 0);
  assert.deepEqual(state.chat._find('remote-first').messages || [], []);
});

test('SEARCH-RACE: старый запрос и старый архивный scope не меняют новый результат', async (t) => {

  const state = await fixture(t);

  const input = state.wrapper.find('.search input');

  await input.setValue('первое');
  await waitFor(() => state.requests.length === 1);
  await input.setValue('второе');
  await waitFor(() => state.requests.length === 2);
  state.requests[1].gate.resolve({ matches: [{
    id: 'remote-second',
    snippetSource: 'второе совпадение',
  }] });
  await waitFor(() => state.wrapper.text().includes('второе совпадение'));
  state.requests[0].gate.resolve({ matches: [{
    id: 'remote-first',
    snippetSource: 'первое устаревшее',
  }] });
  await drain();
  assert.equal(state.wrapper.text().includes('первое устаревшее'), false);
  await state.wrapper.find('[role="switch"]').trigger('click');
  await waitFor(() => state.requests.length === 3);
  assert.equal(state.requests[2].params.get('archived'), '1');
  state.requests[2].gate.resolve({ matches: [{
    id: 'remote-archived',
    snippetSource: 'архивное совпадение',
  }] });
  await waitFor(() => state.wrapper.text().includes('архивное совпадение'));
  assert.equal(state.wrapper.text().includes('Второй разговор'), false);
  await input.setValue('');
  await drain();
  assert.equal(state.wrapper.text().includes('Старый разговор'), true);
});

test('SEARCH-RACE: ошибка показывает причину и повтор текущего запроса', async (t) => {

  const state = await fixture(t, { fail: true });

  await state.wrapper.find('.search input').setValue('искомое');
  await waitFor(() => state.requests.length === 1);
  await drain();
  assert.match(state.wrapper.text(), /Нет связи|не загруз|Ошибка/);
  assert.equal(state.wrapper.text().includes('Ничего не найдено'), false);

  const retry = state.wrapper.findAll('button').find((button) => button.text() === 'Повторить');

  assert.ok(retry, 'доступен повтор поиска');
  state.restore();
  await retry.trigger('click');
  await waitFor(() => state.requests.length === 2);
  assert.equal(state.requests[1].params.get('q'), 'искомое');
  state.requests[1].gate.resolve({ matches: [{
    id: 'remote-first',
    snippetSource: 'искомое найдено',
  }] });
  await waitFor(() => state.wrapper.text().includes('искомое найдено'));
});
