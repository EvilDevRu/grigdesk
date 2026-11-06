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

  state.chat.selectChat(id);

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
  state.chat.selectChat(second.id);
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

test('PAGE-UI-HISTORY: prepend сохраняет anchor и новый ответ не уводит вниз', async (t) => {
  const original = sampleChat('detail-anchor', {
    messages: Array.from({
      length: 80
    }, (_, index) => ({

      role: 'assistant',
      text: `Строка ${index}`,
      pid: `anchor-${index}`,

    })),
  });
  const state = await fixture(t, { chats: [original] });

  await state.chat.ensureChatMessages(state.id);
  await drain();

  const body = state.wrapper.get('.cs-body').element;
  let height = 2000;
  const anchor = state.wrapper.findAll('.msg').find((row) => row.text().includes('Строка 40')).element;
  const anchorKey = anchor.getAttribute('data-history-key');

  t.mock.method(anchor, 'getBoundingClientRect', () => ({

    top: state.chat.session(state.id).messages.length === 40 ? 100 : 2100 - body.scrollTop + 100,

    bottom: 2200,
    left: 0,
    right: 200,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {},

  }));
  t.mock.method(body, 'getBoundingClientRect', () => ({

    top: 0,
    bottom: 400,
    left: 0,
    right: 200,
    width: 200,
    height: 400,
    x: 0,
    y: 0,
    toJSON() {},

  }));

  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(body, 'clientHeight', { configurable: true, value: 400 });
  body.scrollTop = 100;

  const firstText = state.wrapper.findAll('.conversation-group').at(0).text();

  await state.wrapper.get('.cs-body').trigger('scroll');
  await drain();
  height = 4000;
  await drain();
  assert.equal(state.chat.session(state.id).messages.length, 80);
  assert.ok(state.wrapper.text().includes(firstText));
  assert.equal(anchor.getAttribute('data-history-key'), anchorKey);
  assert.equal(anchor.getBoundingClientRect().top, 100);
  assert.ok(body.scrollTop < height - body.clientHeight);

  const top = body.scrollTop;

  state.chat.session(state.id).messages.push({
    role: 'assistant',
    text: 'Поздний ответ',
    pid: 'late-anchor'
  });
  await drain();
  assert.equal(body.scrollTop, top);
});

test('PAGE-UI-GAP: новые сообщения ждут явного перехода при чтении вверх', async (t) => {
  const original = sampleChat('visible-gap', {
    messages: Array.from({
      length: 101
    }, (_, index) => ({

      role: 'assistant',
      text: `Старая ${index}`,
      pid: `old-gap-${index}`,

    })),
  });
  const state = await fixture(t, { chats: [original] });

  await state.chat.ensureChatMessages(state.id);
  await drain();

  const body = state.wrapper.get('.cs-body');

  Object.defineProperty(body.element, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(body.element, 'clientHeight', { configurable: true, value: 400 });
  body.element.scrollTop = 600;
  await body.trigger('scroll');

  const old = [...state.chat.session(state.id).messages];

  for (let index = 101; index < 181; index += 1) {
    original.messages.push({
      role: 'assistant',
      text: `Новая ${index}`,
      pid: `new-gap-${index}`
    });
  }

  await state.chat._pullChat(state.id, false);
  await drain();
  assert.deepEqual(state.chat.session(state.id).messages, old);
  assert.equal(body.element.scrollTop, 600);

  const jump = state.wrapper.findAll('button').find((button) => button.text() === 'К новым сообщениям');

  assert.ok(jump);
  await jump.trigger('click');
  await drain();
  assert.deepEqual(state.chat.session(state.id).messages, original.messages.slice(141));
  assert.equal(state.chat.hasNewerMessages(state.id), false);
});

test('PAGE-UI-OLDER-WITH-NEWER: новый хвост оставляет доступной старую историю', async (t) => {
  const original = sampleChat('older-with-pending-tail', {
    messages: Array.from({ length: 101 }, (_, index) => ({
      role: 'assistant',
      text: `Строка ${index}`,
      pid: `pending-tail-${index}`,
    })),
  });
  const state = await fixture(t, { chats: [original] });

  await state.chat.ensureChatMessages(state.id);
  state.chat.setChatViewport(state.id, false);
  original.messages.push({
    role: 'assistant',
    text: 'Поздний ответ',
    pid: 'pending-tail-new',
  });
  await state.chat._pullChat(state.id, false);
  await drain();

  const older = state.wrapper.findAll('button')
    .find((button) => button.text() === 'Показать более ранние сообщения');

  assert.ok(older);
  assert.equal(state.chat.hasNewerMessages(state.id), true);
  await older.trigger('click');
  await drain();
  assert.equal(state.chat.session(state.id).messages.length, 80);
  assert.equal(state.chat.hasNewerMessages(state.id), true);
});

test('PAGE-UI-SEND-FAILURE: отказ истории показывает причину и восстанавливает черновик', async (t) => {
  for (const failure of ['declined', 'rejected']) {
    await t.test(failure, async (t) => {
      const state = await fixture(t, { chats: [sampleChat(`send-failure-${failure}`)] });

      await state.chat.ensureChatMessages(state.id);
      t.mock.method(state.chat, 'send', async () => {
        if (failure === 'rejected') {
          throw new Error('Не удалось перечитать историю');
        }

        return false;
      });
      await state.wrapper.get('textarea').setValue('Неотправленный текст');
      await state.wrapper.get('[data-context="chat-send"]').trigger('click');
      await drain();
      assert.equal(state.wrapper.get('textarea').element.value, 'Неотправленный текст');
      assert.equal(state.chat.session(state.id).draft, 'Неотправленный текст');
      assert.ok(state.wrapper.get('.in-err').text());

      if (failure === 'rejected') {
        assert.equal(state.wrapper.get('.in-err').text(), 'Не удалось перечитать историю');
      }
    });
  }
});
