import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { loadProductModule } from './helpers/compile-vue.js';
import { apiHarness, chatStoreFixture, setChatProviders } from './helpers/chat-store.js';

const MODEL_REF = { provider: 'catalog-fixture', model: 'fixture-model' };
const PROVIDER = {
  id: MODEL_REF.provider,
  models: [{ id: MODEL_REF.model, efforts: ['high'] }],
};

/**
 * Соединяет настоящие stores чата и исполнителей через управляемый транспорт.
 * Холодный ответ и готовый каталог приходят отдельно, без живого CLI и переписки.
 */
async function fixture(t, protocol = 0) {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'catalog-chat',
      modelRef: { ...MODEL_REF },
      revision: 1,
      sessionId: 'fixture-session',
      error: null,
      effort: 'high',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const { useProvidersStore } = await loadProductModule('src/stores/providers.ts', {
    '../shared/apiClient.ts': `
      export const api = globalThis.__chatApi;
      export const failureText = (error) => error.message;
    `,
  });
  const providers = useProvidersStore();
  const gets = [];
  const posts = [];
  const puts = [];
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });

  t.after(() => finish({ providers: [PROVIDER] }));
  setChatProviders(providers);
  chat.turnProtocol = protocol;
  apiHarness.get = async (url) => {
    gets.push(url);

    return url === '/api/providers' ? { providers: [] } : pending;
  };
  apiHarness.put = async (_url, body) => {
    puts.push(body);

    return {
      revision: 2,
      schema: 2,
      modelRef: body.chat.modelRef,
    };
  };
  apiHarness.post = async (url, body) => {
    posts.push({ url, body });

    return {
      state: 'started',
      reply: 'Готово',
      model: MODEL_REF.model,
    };
  };
  await providers.load();

  return {
    chat,
    providers,
    gets,
    posts,
    puts,
    finish,
  };
}

for (const operation of ['legacy', 'turn', 'compact', 'retry']) {
  test(`холодный каталог: ${operation} ждёт модель до запуска и сохраняет точный выбор`, async (t) => {
    const own = await fixture(t, operation === 'turn' || operation === 'retry' ? 1 : 0);
    const session = own.chat.sessions[0];
    let sending;

    if (operation === 'retry') {
      session.messages.push({
        role: 'user',
        text: 'Сообщение',
        turnId: 'fixture-turn',
        delivery: 'sending',
        sentAt: 1,
      });
      sending = own.chat._deliverTurn(session.id, 'fixture-turn');
    } else {
      sending = operation === 'compact'
        ? own.chat.compact(session.id)
        : own.chat.send(session.id, 'Сообщение');
    }

    await setImmediate();
    t.diagnostic(`AGENT-DBG до каталога: ${JSON.stringify({
      providers: own.providers.providers.length,
      gets: own.gets,
      posts: own.posts.length,
      error: session.error,
    })}`);
    assert.equal(session.error, null, 'ожидание каталога не означает отсутствие модели');
    assert.equal(own.posts.length, 0);
    assert.equal(own.puts.length, 0, 'неполный каталог не попадает в durable save');
    assert.deepEqual(own.gets, ['/api/providers', '/api/providers?wait=1']);

    own.finish({ providers: [PROVIDER] });
    await sending;

    t.diagnostic(`AGENT-DBG после каталога: ${JSON.stringify({
      providers: own.providers.providers.length,
      posts: own.posts.length,
      error: session.error,
    })}`);
    assert.equal(session.error, null);
    assert.equal(own.posts.length, 1);
    assert.deepEqual(own.posts[0].body.modelRef, MODEL_REF);
    assert.equal(own.posts[0].body.effort, 'high');
    assert.equal(session.messages.filter((message) => message.role === 'error').length, 0);
  });
}

test('готовый каталог без выбранной модели даёт прежний отказ без fallback', async (t) => {
  const own = await fixture(t, 1);
  const sending = own.chat.send('catalog-chat', 'Сообщение');

  own.finish({ providers: [{ id: 'other-provider', models: [{ id: 'other-model' }] }] });
  await sending;
  assert.equal(own.posts.length, 0);
  assert.deepEqual(own.chat.sessions[0].modelRef, MODEL_REF);
  assert.match(own.chat.sessions[0].error, /недоступна в реестре/u);
});

test('параллельный повтор доставки во время загрузки не создаёт второй POST', async (t) => {
  const own = await fixture(t, 1);
  const session = own.chat.sessions[0];

  session.messages.push({
    role: 'user',
    text: 'Сообщение',
    turnId: 'fixture-turn',
    delivery: 'sending',
    sentAt: 1,
  });

  const first = own.chat._deliverTurn(session.id, 'fixture-turn');

  await setImmediate();
  assert.equal(await own.chat._deliverTurn(session.id, 'fixture-turn'), 'posting');
  own.finish({ providers: [PROVIDER] });
  assert.equal(await first, 'accepted');
  assert.equal(own.posts.length, 1);
});

test('выбор, изменённый во время загрузки, читается заново перед отправкой', async (t) => {
  const own = await fixture(t, 1);
  const sending = own.chat.send('catalog-chat', 'Сообщение');
  const currentRef = { provider: MODEL_REF.provider, model: 'next-model' };

  await setImmediate();
  own.chat.sessions[0].modelRef = currentRef;
  own.finish({ providers: [{
    ...PROVIDER,
    models: [...PROVIDER.models, { id: currentRef.model, efforts: ['high'] }],
  }] });
  await sending;
  assert.equal(own.posts.length, 1);
  assert.deepEqual(own.posts[0].body.modelRef, currentRef);
});
