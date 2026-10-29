import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { ApiError } from '../../web/src/shared/apiClient.ts';

const identity = {
  task: '7',
  profile: 'demo',
  attempt: `a_${'a'.repeat(32)}`,
  node: 'check',
  stop: 'human',
  stageSequence: 2,
  stageHeadHash: 'b'.repeat(64)
};
const doc = {
  schemaVersion: 1,
  id: `c_${'a'.repeat(32)}`,
  identity,
  revision: 2,
  decisionRevision: 1,
  state: 'awaiting_user',
  automatic: false,
  createdAt: new Date().toISOString(),
  operations: [],
  messages: [{
    id: 'message',
    sequence: 1,
    author: 'arbiter',
    text: 'Сохранённая реплика',
    status: 'complete',
    createdAt: new Date().toISOString(),
    revision: 2
  }],
  result: null,
  capabilities: {
    status: 'unknown',
    message: '',
    targets: []
  },
  hasMore: false,
  afterSequence: 1,
  readOnly: false
};

/**
 * Подменяется только сеть и общая SSE подписка, Pinia и алгоритм восстановления настоящие.
 * Хранилище общее для двух экземпляров, чтобы имитировать перезагрузку окна.
 */
async function fixture(t) {
  const saved = new Map();
  const storage = {
    getItem: (key) => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key)
  };
  const previous = globalThis.localStorage;

  globalThis.localStorage = storage;
  t.after(() => {
    globalThis.localStorage = previous;
  });

  const posts = [];

  globalThis.arbiterStoreTestApi = {
    get: async (url) => url.endsWith('/current') ? {
      identity,
      conversationId: doc.id,
      capabilities: doc.capabilities
    }
      : structuredClone(doc),
    post: async (url, body) => {
      posts.push({ url, body: JSON.parse(JSON.stringify(body)) });

      throw new TypeError('Соединение потеряно');
    },
  };

  const module = await compileModule(webFile('src/stores/arbiterConversations.ts'), {
    stubs: {
      '../composables/useSse.ts': 'export const sseSubscribe = (fn) => { '
        + 'globalThis.arbiterStoreTestEvent = fn; return () => {}; };',
      '../shared/apiClient.ts': 'export const api = globalThis.arbiterStoreTestApi;'
        + '\nexport { ApiError } from "./src/shared/apiClient.ts";',
      './apiClient.ts': 'export const api = globalThis.arbiterStoreTestApi;'
        + '\nexport { ApiError } from "./src/shared/apiClient.ts";',
    }
  });

  setActivePinia(createPinia());

  const store = module.useArbiterConversationsStore();

  store.start('fixture-owner');
  t.after(() => store.stop());

  return {
    store,
    posts,
    module,
    saved,
  };
}

test('snapshot сохраняется; сигнал и hello догружают историю через единую SSE', async (t) => {
  const { store } = await fixture(t);

  await store.open('7');

  assert.equal(store.document('7', doc.id).messages[0].text, 'Сохранённая реплика');
  globalThis.arbiterStoreTestEvent('arbiter-conversation', {
    task: '7',
    conversationId: doc.id,
    revision: 3
  });
  globalThis.arbiterStoreTestEvent('hello', {});
  await store.refresh('7', doc.id);
  assert.equal(store.document('7', doc.id).revision, 2);
});

test(("исторический диалог читается при отказе current; битый browser storage " +
  "закрывает отправку"),
  async (t) => {
    const { store, saved, posts } = await fixture(t);

    globalThis.arbiterStoreTestApi.get = async (url) => {
      if (url.endsWith('/current')) {
        throw new Error('Попытка уже архивирована');
      }

      return structuredClone(doc);
    };
    await store.open('7', doc.id);
    assert.equal(store.document('7', doc.id).messages[0].text, 'Сохранённая реплика');
    saved.set('grigdesk-arbiter-conversations:fixture-owner', '{invalid');
    store.stop();
    store.start('fixture-owner');
    store.merge('7', doc);
    assert.match(store.storageError, /Отправка закрыта/);
    await assert.rejects(store.send('7', doc.id, 'discuss', { text: 'Не терять' }), /Отправка закрыта/);
    assert.equal(posts.length, 0);
  }
);

test('поздний снимок и чужая задача не затирают новый документ', async (t) => {
  const { store } = await fixture(t);

  store.merge('7', { ...doc, revision: 5 });
  store.merge('7', {
    ...doc,
    revision: 3,
    state: 'analyzing'
  });

  assert.equal(store.document('7', doc.id).revision, 5);
  assert.equal(store.document('8', doc.id), null);
});

test('потеря сети и reload сохраняют requestId; новая отправка не создаёт новое действие', async (t) => {
  const { store, posts, module } = await fixture(t);

  await store.open('7');
  await assert.rejects(store.send('7', doc.id, 'discuss', { text: 'Что известно?' }));

  const requestId = posts[0].body.requestId;

  store.stop();
  setActivePinia(createPinia());

  const reopened = module.useArbiterConversationsStore();

  reopened.start('fixture-owner');
  t.after(() => reopened.stop());
  await reopened.open('7');
  await assert.rejects(reopened.retryPending('7'));

  assert.equal(posts[1].body.requestId, requestId);
  assert.equal(reopened.pending['7'].body.requestId, requestId);
});

test('повреждённая вложенная схема черновика не попадает в поля после reload', async (t) => {
  const { store, saved } = await fixture(t);

  store.stop();
  saved.set('grigdesk-arbiter-conversations:fixture-owner', JSON.stringify({
    pending: {}, drafts: { stopped: { text: 12, answers: null } },
  }));
  store.start('fixture-owner');
  assert.match(store.storageError, /Отправка закрыта/);
  assert.equal(Object.keys(store.drafts).length, 0);
});

test('явный HTTP 409 снимает pending; черновик сохраняется для нового решения', async (t) => {
  const { store } = await fixture(t);

  await store.open('7');
  store.draftFor(identity).text = 'Моё уточнение';
  globalThis.arbiterStoreTestApi.post = async () => {
    throw new ApiError('Решение устарело', 409, { error: 'stale_stop' });
  };

  await assert.rejects(store.send('7', doc.id, 'discuss', { text: 'Моё уточнение' }), /Решение устарело/);
  assert.equal(store.pending['7'], undefined);
  assert.equal(store.draftFor(identity).text, 'Моё уточнение');
});

test('смена владельца не ждёт HTTP прежнего сервера и не принимает его поздний snapshot',
  { timeout: 5000 }, async (t) => {
    const { store } = await fixture(t);
    let release;
    let entered;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let first = true;

    globalThis.arbiterStoreTestApi.get = async (url) => {
      if (url.endsWith('/current')) {
        return {
          identity,
          conversationId: doc.id,
          capabilities: doc.capabilities
        };
      }
      if (first) {
        first = false;
        entered();

        return held;
      }

      return { ...structuredClone(doc), revision: 6 };
    };
    t.after(() => release(doc));

    const oldLoad = store.refresh('7', doc.id, true);

    await started;
    store.stop();
    store.start('another-owner');
    await store.open('7');
    assert.equal(store.document('7', doc.id).revision, 6);
    release(doc);
    await oldLoad;
    assert.equal(store.document('7', doc.id).revision, 6);
  });

test('hello находит диалог, созданный пока событие SSE было потеряно', async (t) => {
  const { store, posts } = await fixture(t);
  let exists = false;

  globalThis.arbiterStoreTestApi.get = async (url) => url.endsWith('/current')
    ? {
      identity,
      conversationId: exists ? doc.id : null,
      capabilities: doc.capabilities
    }
    : structuredClone(doc);
  await store.open('7');
  assert.equal(store.document('7', doc.id), null);
  exists = true;
  globalThis.arbiterStoreTestEvent('hello', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.currentByTask['7'].conversationId, doc.id);
  assert.equal(store.document('7', doc.id).messages.length, 1);
  assert.equal(posts.length, 0);
});

test('поздний current прежнего stop не заменяет уже прочитанную новую остановку', async (t) => {
  const { store } = await fixture(t);
  let release;
  let entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let first = true;
  const newer = {
    ...identity,
    stageSequence: 3,
    stageHeadHash: 'c'.repeat(64)
  };

  globalThis.arbiterStoreTestApi.get = async () => {
    if (first) {
      first = false;
      entered();

      return held;
    }

    return {
      identity: newer,
      conversationId: null,
      capabilities: doc.capabilities
    };
  };
  t.after(() => release({
    identity,
    conversationId: null,
    capabilities: doc.capabilities
  }));

  const old = store.open('7');

  await started;
  await store.open('7');
  release({
    identity,
    conversationId: null,
    capabilities: doc.capabilities
  });
  await old;
  assert.equal(store.currentByTask['7'].identity.stageSequence, 3);
});

test('обновление раннего partial между страницами дочитывается по первой revision прохода', async (t) => {
  const { store } = await fixture(t);
  const first = Array.from({ length: 100 }, (_, index) => ({
    ...doc.messages[0],
    id: index === 0 ? 'message' : `message-${index + 1}`,
    sequence: index + 1,
    status: 'partial',
  }));
  const pages = [
    {
      ...doc,
      revision: 2,
      messages: first,
      afterSequence: 100,
      hasMore: true
    },
    {
      ...doc,
      revision: 3,
      messages: [{
        ...doc.messages[0],
        id: 'tail',
        sequence: 101
      }],
      afterSequence: 101
    },
    {
      ...doc,
      revision: 3,
      messages: [{
        ...doc.messages[0],
        text: 'Дополнено',
        revision: 3
      }],
      afterSequence: 101
    },
  ];
  const requests = [];

  globalThis.arbiterStoreTestApi.get = async (url) => {
    if (url.endsWith('/current')) {
      return {
        identity,
        conversationId: doc.id,
        capabilities: doc.capabilities
      };
    }

    requests.push(url);

    return pages.shift();
  };
  await store.open('7');
  assert.equal(store.document('7', doc.id).messages.length, 101);
  assert.equal(store.document('7', doc.id).messages[0].text, 'Дополнено');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].includes('knownRevision=2'), true);
});
