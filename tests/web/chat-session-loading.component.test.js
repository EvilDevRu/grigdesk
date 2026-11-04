import { compileModule, webFile } from './helpers/compile-vue.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sampleChat } from '../server/helpers/chat-list.js';
import { waitFor } from '../server/helpers/chat-turns.js';
import { compileChatSession } from './helpers/chat-session.js';
import { detailReads, lazyWindow } from './helpers/chat-lazy.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { drain } from './helpers/chat-load.js';

const PREFIX = '__lazyDetail';

const MODEL = {
  id: 'test-model',
  name: 'Тест',
  efforts: [],
};

const PROVIDER = {
  id: 'test-provider',
  name: 'Тест',
  available: true,
  models: [MODEL],
  commands: [],
};

let mount;

let ChatSession;
let helpEntry;

before(async () => {
  process.env.NODE_ENV = 'test';
  await installUiBrowser({ after: (fn) => after(fn) });
  helpEntry = await compileModule(webFile('../tests/web/helpers/help-entry.ts'), {
    stubs: { '../router.ts': 'export const router = { push: async () => {} };' },
  });
  globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
  globalThis[`${PREFIX}TasksStore`] = () => ({ load: async () => null });
  globalThis[`${PREFIX}UiStore`] = () => ({ openTaskLaunch() {} });
  globalThis[`${PREFIX}ProvidersStore`] = () => ({
    providers: [PROVIDER],
    load() {},
    modelOf: () => ({
      id: MODEL.id,
      model: MODEL,
      provider: PROVIDER,
    }),
    visibleModels: () => [MODEL],
    modesOf: () => [],
  });
  globalThis[`${PREFIX}Api`] = {
    url: (value) => value,
    get: async () => ({
      tasks: [],
      sessions: [],
      commands: [],
      profiles: [],
    }),
  };
  globalThis[`${PREFIX}ChatStore`] = () => globalThis.__lazyDetailChat;
  ChatSession = await compileChatSession(PREFIX);
});

/**
 * Настоящий компонент получает настоящий lazy-store, сеть управляет только ответами detail.
 * Видимость регистрируется снаружи, как у телефонной колонки и страницы ChatsView.
 */
async function fixture(t, options = {}) {

  const state = await lazyWindow(t, options);

  const id = state.chat.sessions[0].id;

  globalThis.__lazyDetailChat = state.chat;

  const surface = state.chat.registerSurface('страница', {
    chatId: id,
    visible: true,
  });

  const wrapper = mount(ChatSession, {
    attachTo: document.body,
    props: { sid: id },
  });

  t.after(() => {
    wrapper.unmount();
    surface.dispose();
  });
  await drain();

  return {
    ...state,
    wrapper,
    surface,
    id,
  };
}

test('DETAIL-STATE: загрузка ленты видна до ответа, затем видны сообщения', async (t) => {

  const gate = Promise.withResolvers();

  const original = sampleChat('detail-visible');

  const state = await fixture(t, {
    chats: [original],
    detail: () => gate.promise,
  });

  assert.match(state.wrapper.text(), /Загружа|Loading/);
  assert.equal(state.wrapper.find('textarea').element?.disabled ?? true, true);
  assert.equal(state.wrapper.text().includes('Ответ'), false);
  assert.equal(detailReads(state.calls, original.id).length, 1);
  gate.resolve({
    chat: original,
    version: 'version-one',
  });
  await waitFor(() => state.wrapper.text().includes('Ответ'));
  assert.doesNotMatch(state.wrapper.text(), /Загружаем сообщения/);
});

test('DETAIL-ERROR: причина и повтор не создают параллельных запросов', async (t) => {

  let broken = true;

  const gate = Promise.withResolvers();

  const original = sampleChat('detail-error');

  const state = await fixture(t, {
    chats: [original],
    detail: async () => {
      if (broken) {
        throw new TypeError('Нет связи с сервером');
      }

      return gate.promise;
    },
  });

  assert.match(state.wrapper.text(), /Нет связи|не загруз|Ошибка/);

  const retry = state.wrapper.findAll('button').find((button) => button.text() === 'Повторить');

  assert.ok(retry, 'есть видимая кнопка повтора');
  broken = false;
  await retry.trigger('click');
  await retry.trigger('click');
  await drain();
  assert.equal(detailReads(state.calls, original.id).length, 2);
  gate.resolve({
    chat: original,
    version: 'version-one',
  });
  await waitFor(() => state.wrapper.text().includes('Ответ'));
});

test('DETAIL-DRAFT: смена sid и скрытая колонка не сохраняют пустой черновик', async (t) => {

  const gate = Promise.withResolvers();

  const first = sampleChat('draft-first', { draft: 'Серверный черновик' });

  const second = sampleChat('draft-second', { draft: 'Черновик второго' });

  const state = await fixture(t, {
    chats: [first, second],
    detail: async (id) => id === first.id ? gate.promise : {
      chat: second,
      version: 'version-one',
    },
  });

  assert.match(state.wrapper.text(), /Загружа|Loading/);
  state.surface.update({
    chatId: second.id,
    visible: false,
  });
  await state.wrapper.setProps({ sid: second.id });
  await drain();
  assert.equal(detailReads(state.calls, second.id).length, 0, 'скрытая колонка не открывает чат');
  gate.resolve({
    chat: first,
    version: 'version-one',
  });
  await drain();
  state.surface.update({
    chatId: second.id,
    visible: true,
  });
  await waitFor(() => state.wrapper.find('textarea').element?.value === second.draft);
  assert.equal(state.chat._find(first.id).draft, first.draft);

  const draftWrites = state.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method));

  assert.equal(draftWrites.some((call) => call.body?.chat?.draft === ''), false);
});

/**
 * Справка монтируется настоящим диалогом на той же активной Pinia, что лента разговора.
 * Только сетевой ответ корпуса синтетический; эффект клика виден в настоящем тексте статьи.
 */
function mountHelpForError(t) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const corpus = {
    format: 1,
    version: '0.1.0',
    commit: 'a'.repeat(40),
    revision: 'b'.repeat(64),
    locale: 'ru',
    articles: [
      {
        id: 'overview',
        file: 'README.md',
        title: 'Начало',
        section: 'Помощь',

        keywords: [],
        routes: [],
        markdown: '# Начало'
      },
      {
        id: 'troubleshooting',
        file: 'troubleshooting.md',
        title: 'Разбор неполадки',
        section: 'Помощь',

        keywords: [],
        routes: [],
        markdown: '# Разбор неполадки\nПроверьте подключение.'
      },
    ],
  };

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    assert.equal(String(url), '/api/help');

    return Response.json(corpus);
  };

  const auth = helpEntry.useAuthStore();

  auth.authenticated = true;
  auth.clientScope = 'help-fixture';

  const help = helpEntry.useHelpStore();

  help.close();

  const dialog = mount(helpEntry.HelpDialog, { attachTo: document.body });

  t.after(() => {
    dialog.unmount();
    help.close();
    globalThis.fetch = originalFetch;
  });

  return { help, calls };
}

test('HELP-ERR1: ошибка истории открывает troubleshooting без повтора чтения и потери draft', async (t) => {
  const state = await fixture(t, {
    chats: [sampleChat('history-help')],
    detail: async () => {
      throw new TypeError('История недоступна');
    },
  });
  const session = state.chat.sessions.find((entry) => entry.id === state.id);

  session.draft = 'НЕОТПРАВЛЕННЫЙ ЧЕРНОВИК';

  const readsBefore = detailReads(state.calls, state.id).length;
  const help = mountHelpForError(t);

  await state.wrapper.get('[data-role="chat-history-help"]').trigger('click');
  await drain();
  assert.equal(help.help.isOpen, true);
  assert.equal(help.help.articleId, 'troubleshooting');
  assert.match(document.querySelector('[data-role="help-dialog"]').textContent, /Разбор неполадки/u);
  assert.equal(session.draft, 'НЕОТПРАВЛЕННЫЙ ЧЕРНОВИК');
  assert.equal(detailReads(state.calls, state.id).length, readsBefore);
  assert.equal(state.calls.some((call) => call.method === 'POST' && call.url === '/api/chat'), false);
});

test('HELP-ERR2: ошибка подготовки в ленте открывает troubleshooting без отправки модели', async (t) => {
  const original = sampleChat('turn-error-help', {
    draft: 'ПРЕЖНИЙ ТЕКСТ',
    messages: [{ role: 'error', text: 'Не удалось подготовить исполнителя' }],
  });
  const state = await fixture(t, { chats: [original] });
  const help = mountHelpForError(t);

  assert.equal(state.wrapper.get('textarea').element.value, 'ПРЕЖНИЙ ТЕКСТ');
  await state.wrapper.get('[data-role="chat-error-help"]').trigger('click');
  await drain();
  assert.equal(help.help.articleId, 'troubleshooting');
  assert.match(document.querySelector('[data-role="help-dialog"]').textContent, /Разбор неполадки/u);
  assert.equal(state.wrapper.get('textarea').element.value, 'ПРЕЖНИЙ ТЕКСТ');
  assert.equal(state.calls.some((call) => call.method === 'POST' && call.url === '/api/chat'), false);
});
