// Композер чата пересоздаётся при каждом переключении чатов (ChatsView ставит :key).
// Неотправленные вложения раньше жили в самом компоненте и пропадали вместе с ним;
// теперь композер читает и пишет их через стор, а загрузка помнит свой чат.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileChatSession } from './helpers/chat-session.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';
globalThis.__sharedChatContextFill = (await import('../../shared/chatContext.ts')).contextFill;

const PREFIX = '__draftAttachments';
const MODEL = {
  id: 'test-model',
  name: 'Test',
  efforts: [],
};
const PROVIDER = {
  id: 'codex',
  name: 'Codex',
  color: '#10a37f',
  available: true,
  models: [MODEL],
  commands: [],
};
const SHOT = {
  file: '1-shot.png',
  name: 'shot.png',
  url: '/api/chat/attachment/1-shot.png',
  mime: 'image/png',
};
const STUBS = ['Api', 'ChatStore', 'TasksStore', 'UiStore', 'Router', 'ProvidersStore'];

function sessionOf(id) {
  return {
    id,
    title: `Чат ${id}`,
    taskId: null,
    purpose: '',
    model: MODEL.id,
    modelRef: {
      provider: PROVIDER.id,
      model: MODEL.id,
    },
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sending: false,
    compacting: false,
    sessionResetting: false,
    contextTokens: 0,
  };
}

/**
 * Стор с двумя реактивными чатами: вложения черновика пишутся в сам чат, как в боевом
 * сторе. Остальные действия композеру в этих сценариях не нужны и ничего не делают.
 */
function storeOf(sessions) {
  const find = (id) => sessions.find((session) => session.id === id);

  return {
    sessions,
    archived: [],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    setEffort() {},
    setMode() {},
    setTask() {},
    setTitle() {},
    permFor: () => null,
    questionFor: () => null,
    isOnConveyor: () => false,
    tabLabel: (id) => find(id)?.title,
    setDraftAttachments(id, list) {
      find(id).draftAttachments = list;
    },
    addDraftAttachment(id, attachment) {
      find(id).draftAttachments = [...(find(id).draftAttachments || []), attachment];
    },
    send: async () => true,
    async stop() {},
  };
}

/**
 * Подменяет сторы и API, которые ChatSession берёт по префиксу. `upload` можно
 * задержать: так проверяется ответ сервера, пришедший уже после ухода из чата.
 */
function installStubs(store, upload) {
  globalThis[`${PREFIX}Api`] = {
    url: (value) => value,
    get: async () => ({ tasks: [] }),
    upload,
  };
  globalThis[`${PREFIX}ChatStore`] = () => store;
  globalThis[`${PREFIX}TasksStore`] = () => ({ load: async () => null });
  globalThis[`${PREFIX}UiStore`] = () => ({ openTaskLaunch() {} });
  globalThis[`${PREFIX}Router`] = { async push() {} };
  globalThis[`${PREFIX}ProvidersStore`] = () => ({
    providers: [PROVIDER],
    load() {},
    modelOf: () => ({
      id: MODEL.id,
      model: MODEL,
      provider: PROVIDER,
    }),
    visibleModels: () => PROVIDER.models,
    modesOf: () => [],
  });
}

/**
 * Два реактивных чата в управляемом сторе и настоящий ChatSession. Возвращает `open`
 * для переключения чатов и `find` для проверки того, что записано в сам чат.
 */
async function harness(t, { upload = async () => SHOT } = {}) {
  const browser = await installUiBrowser(t, 'https://cockpit.test/#/chats');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const sessions = reactive([sessionOf('a'), sessionOf('b')]);
  const find = (id) => sessions.find((session) => session.id === id);

  installStubs(storeOf(sessions), upload);

  const [{ mount, flushPromises }, ChatSession] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession(PREFIX),
  ]);
  let wrapper = null;

  /**
   * Открывает чат так же, как ChatsView с :key: прежний композер уничтожается,
   * новый создаётся с нуля и видит только то, что лежит в сторе.
   */
  const open = async (sid) => {
    wrapper?.unmount();
    wrapper = mount(ChatSession, {
      attachTo: browser.document.querySelector('#mount'),
      props: { sid },
    });
    await flushPromises();

    return wrapper;
  };

  t.after(() => {
    wrapper?.unmount();

    for (const suffix of STUBS) {
      delete globalThis[`${PREFIX}${suffix}`];
    }
  });

  return {
    open,
    find,
    flushPromises,
  };
}

async function dropImage(wrapper, flushPromises) {
  await wrapper.trigger('drop', {
    dataTransfer: {
      types: ['Files'],
      files: [new Blob(['png'], { type: 'image/png' })],
    },
  });
  await flushPromises();
}

test('приложенная картинка остаётся в чате после ухода в другой чат и возвращения', async (t) => {
  const { open, find, flushPromises } = await harness(t);

  await dropImage(await open('a'), flushPromises);
  assert.equal((await open('b')).findAll('.pend .chip').length, 0, 'в другом чате вложения нет');

  const back = await open('a');

  assert.equal(back.findAll('.pend .chip').length, 1);
  assert.deepEqual(find('a').draftAttachments, [SHOT]);
});

test('ответ загрузки после переключения дописывает вложение в исходный чат', async (t) => {
  let finish = null;
  const { open, find, flushPromises } = await harness(t, {
    upload: () => new Promise((resolve) => {
      finish = resolve;
    }),
  });

  await dropImage(await open('a'), flushPromises);
  await open('b');
  finish(SHOT);
  await flushPromises();

  assert.deepEqual(find('a').draftAttachments, [SHOT]);
  assert.equal(find('b').draftAttachments, undefined);
});

test('крестик на чипе убирает вложение из черновика чата', async (t) => {
  const { open, find, flushPromises } = await harness(t);
  const wrapper = await open('a');

  await dropImage(wrapper, flushPromises);
  await wrapper.get('[data-context="chat-pending-remove"]').trigger('click');
  await flushPromises();

  assert.deepEqual(find('a').draftAttachments, []);
  assert.equal(wrapper.findAll('.pend .chip').length, 0);
});
