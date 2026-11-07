import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { chatStoreFixture, sseOf } from '../web/helpers/chat-store.js';
import {
  chatAppFixture,
  Fastify,
  saveChat,
  turnBody,
  waitFor,
  TEST_MODEL_REF
} from './helpers/chat-turns.js';

/**
 * Настоящие маршруты принимают JSON-снимок и возвращают ошибки того же вида, что apiClient.
 * Журнал хранит только форму запросов, чтобы проверить refs и число полных загрузок.
 */
function windowApi(app) {
  const requests = [];

  /**
   * Inject получает уже сериализованное тело, а не ссылки на изменяемое состояние окна.
   * Отказ маршрута передаётся клиенту с HTTP-кодом и кодом ошибки для fallback.
   */
  const call = async (method, url, payload) => {
    const body = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));

    const request = {
      method,
      url,
      body
    };

    requests.push(request);

    const response = await app.inject({
      method,
      url,
      ...(body ? {
        payload: body
      } : {})
    });
    const data = response.json();

    request.result = {
      status: response.statusCode,
      revision: data.revision,
      stale: data.stale,
      restored: data.restored,
      dropped: data.dropped,
      confirmed: data.stepReuseAck?.confirmed.length
    };

    if (response.statusCode >= 400) {
      throw Object.assign(new Error(data.error), {
        status: response.statusCode,
        data
      });
    }

    return data;
  };

  return {
    requests,
    useServer(next) {
      app = next;
    },
    api: {
      get: (url) => call('GET', url),
      put: (url, body) => call('PUT', url, body),
      post: (url, body) => call('POST', url, body),
      del: (url) => call('DELETE', url),
    }
  };
}

/**
 * Серия проходит через реальный canonical pipeline, pending и очередь сохранения окна.
 * Серверные мутации действительно меняют revision; стабильные записи после них снова используют refs.
 */
async function exercise(t, legacy) {
  const runs = [];
  let release;
  let onSse;
  const finalSteps = [{
    k: 'tool',
    text: 'Новая лента',
    input: {
      command: 'synthetic'
    }
  }];
  const executor = {
    id: 'test-provider',
    async run(options) {
      runs.push(options);
      await new Promise((resolve) => {
        release = resolve;
      });

      return {
        reply: 'Итог',
        steps: finalSteps,
        assistantMessageId: 'final-12345678'
      };
    },
  };
  const fixture = await chatAppFixture(t, {
    executor,
    onEvent(name, data) {
      if (onSse) {
        setImmediate(() => onSse(name, structuredClone(data)));
      }
    }
  });

  t.after(() => release?.());

  const initial = [0, 1].map((index) => ({
    role: 'assistant',
    text: 'Одинаковый ответ',
    model: 'test-model',
    ...(!legacy ? {
      runId: `old-run-${index}`,
      assistantMessageId: `old-answer-${index}`
    } : {}),
    steps: [{
      k: 'tool',
      text: `Тело ${index}`
    }],
  }));

  await saveChat(fixture.app, 'flow-chat', {
    messages: initial
  });

  const transport = windowApi(fixture.app);
  const chat = await chatStoreFixture({}, {
    api: transport.api,
    fromServer: true
  });

  t.after(() => {
    onSse = null;
    chat.$dispose();
  });

  const session = chat.session('flow-chat');
  const surface = chat.registerSurface({}, { chatId: session.id, visible: true });

  await chat.ensureChatMessages(session.id);
  t.after(() => surface.dispose());

  onSse = sseOf(chat);

  const saveDraft = async (text) => {
    session.draft = text;
    await chat._writeChat(session.id);
  };

  for (let index = 0; index < 5; index += 1) {
    await saveDraft(`До запуска ${index}`);
  }

  assert.equal(transport.requests.filter((request) => request.method === 'PUT')
    .every((request) => request.url.endsWith('/window') && !!request.body.reuseSteps), true);

  session.messages.push({
    role: 'user',
    text: 'Задача',
    turnId: 'flow-turn-123456'
  });
  await chat._writeChat(session.id);

  const started = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody(session.id, 'flow-turn-123456', 'Задача')
  });

  assert.equal(started.statusCode, 202);
  await waitFor(() => runs.length === 1, {
    what: 'исполнитель'
  });
  await chat._loadActive();
  await chat._resyncStore();

  for (const [index, id] of ['mid-12345678', 'final-12345678'].entries()) {
    await runs[0].onAssistantMessage({
      assistantMessageId: id,
      text: index ? 'Итог' : 'Промежуточный ответ',
      sourceRevision: 1,
      complete: true,
    });
    await waitFor(() => session.messages.some((message) => message.assistantMessageId === id));
    await chat._writeChat(session.id);
  }

  release();
  await waitFor(() => fixture.events.some((event) => event.event === 'chat-done'));
  await chat._collectPending();
  await chat._writeChat(session.id);

  const finalMessages = session.messages.filter((message) => message.assistantMessageId ===
    'final-12345678');

  assert.equal(finalMessages.length, 1);
  assert.deepEqual(session.messages.find((message) => message.assistantMessageId === 'final-12345678')
    .steps,
    finalSteps);
  assert.deepEqual((await transport.api.get('/api/chat/pending')).pending, []);

  const external = new ChatHistoryStore({
    chatsDir: fixture.config.chatsDir,
    registryProvider: async () => ({
      'test-provider': [{
        id: 'test-model'
      }]
    })
  });

  await external.patchExecution(session.id, () => ({
    contextTokens: 123
  }));
  await saveDraft('После изменения revision');
  await saveDraft('Подтверждение новой базы');

  const stableStart = transport.requests.length;

  for (let index = 0; index < 5; index += 1) {
    await saveDraft(`После запуска ${index}`);
  }

  const stable = transport.requests.slice(stableStart).filter((request) => request.method === 'PUT');

  assert.equal(stable.length, 5);
  assert.equal(stable.every((request) => request.url.endsWith('/window') && !!request.body.reuseSteps), true,
    JSON.stringify(transport.requests.filter((request) => request.method === 'PUT')
      .map((request) => ({
        url: request.url,
        result: request.result
      }))));
  assert.equal(stable.every((request) => request.body.chat.messages
      .filter((message) => message.role === 'assistant')
      .every((message) => !Object.hasOwn(message, 'steps'))), true,
    JSON.stringify(stable.map((request) => ({
      refs: request.body.reuseSteps?.refs,
      remaining: request.body.chat.messages.filter((message) => Object.hasOwn(message, 'steps'))
    }))));

  const durable = await external.readOne(session.id);

  assert.deepEqual(durable.messages.slice(0, 2), initial);
  assert.deepEqual(durable.messages.map((message) => message.steps),
    session.messages.map((message) => message.steps));

  const archived = await transport.api.put('/api/chat/store/chat/window', {
    window: stable.at(-1).body.window,
    chat: {
      ...stable.at(-1).body.chat,
      revision: durable.revision
    },
    archived: true,
    reuseSteps: {
      ...stable.at(-1).body.reuseSteps,
      baseRevision: durable.revision
    },
  });

  assert.equal(archived.ok, true);
  await chat._resyncStore();
  assert.equal(chat.isArchived(session.id), true);
  chat.restoreArchived(session.id);

  const restored = await chat._writeChat(session.id);

  assert.equal(restored?.ok, true, 'восстановление из архива требует подтверждённой записи');
  assert.equal(await chat._writeChat(session.id), null, 'ACK не оставляет архивность dirty');

  const reloaded = await chatStoreFixture({}, {
    api: transport.api,
    fromServer: true
  });

  t.after(() => reloaded.$dispose());
  await reloaded.ensureChatMessages(session.id);

  assert.deepEqual(reloaded.session(session.id).messages, (await external.readOne(session.id)).messages);
  assert.equal(reloaded.session(session.id).modelRef.provider, TEST_MODEL_REF.provider);
  // Окна теста больше не реагируют на поздние уведомления закрываемого сервера.
  onSse = null;
  // Закрываем debounce до сервера: иначе проверка сама создаёт бесконечный retry
  // в уже закрытый Fastify, хотя все проверяемые записи успели сохраниться.
  chat._persist(true);
  await waitFor(() => transport.requests.every((request) => request.result));
  chat.$dispose();
  reloaded.$dispose();
}

for (const legacy of [false, true]) {
  test(`полная серия настоящего store/маршрутов/pending (${legacy ? 'legacy' : 'modern'})`, async (t) => {
    await exercise(t, legacy);
  });
}

test('после window GET старый HTTP-маршрутизатор отказывает без full fallback', async (t) => {
  const fixture = await chatAppFixture(t);
  const initial = [{
    role: 'assistant',
    text: 'Старый ответ',
    steps: [{
      k: 'tool',
      text: 'Сохранённое тело'
    }]
  }];

  await saveChat(fixture.app, 'rollback-chat', {
    messages: initial
  });

  const transport = windowApi(fixture.app);
  const chat = await chatStoreFixture({}, {
    api: transport.api,
    fromServer: true
  });
  const session = chat.session('rollback-chat');
  const surface = chat.registerSurface({}, { chatId: session.id, visible: true });

  await chat.ensureChatMessages(session.id);
  t.after(() => surface.dispose());

  const history = new ChatHistoryStore({
    chatsDir: fixture.config.chatsDir,
    registryProvider: async () => ({
      'test-provider': [{
        id: 'test-model'
      }]
    }),
  });
  const previous = await history.readOne(session.id);
  const oldServer = Fastify();
  const fullBodies = [];

  oldServer.put('/api/chat/store/meta', async (request) => {
    await history.saveMeta(request.body);

    return {
      ok: true
    };
  });
  oldServer.put('/api/chat/store/chat', async (request) => {
    // Прежний маршрут читает полный chat, archived и origin, без refs и новых ACK.
    // Отсутствующий sparse URI обрабатывает настоящий маршрутизатор Fastify.
    assert.deepEqual((await history.readOne(session.id)).messages, previous.messages);
    fullBodies.push(request.body);

    const result = await history.saveOne(request.body.chat, request.body.archived);

    return {
      ok: true,
      revision: result.chat.revision,
      stale: result.stale
    };
  });
  t.after(() => oldServer.close());
  transport.useServer(oldServer);
  session.draft = 'После отката сервера';
  await assert.rejects(chat._writeChat(session.id), (error) => error.status === 404);

  const writes = transport.requests.filter((request) => request.method === 'PUT');

  assert.deepEqual(writes.map((request) => request.result.status), [404]);
  assert.equal(writes[0].url, '/api/chat/store/chat/window');
  assert.equal(Object.hasOwn(writes[0].body.chat.messages[0], 'steps'), false);
  assert.equal(fullBodies.length, 0);
  assert.deepEqual((await history.readOne(session.id)).messages, previous.messages);
  assert.equal(session.draft, 'После отката сервера');
  assert.ok(chat.saveError);
  chat.$dispose();
});
