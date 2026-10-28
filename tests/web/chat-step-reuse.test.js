import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { chatStoreFixture } from './helpers/chat-store.js';
import {
  protocolChanges,
  protocolHead,
  protocolList,
  protocolReconcile,
} from './helpers/chat-protocol.js';
import { applyAssistantFinal } from '../../web/src/stores/chatInTurn.ts';
import { messageKey } from '../../shared/chat/chatMessageIdentity.ts';
import { historyStepReuseAck, restoreHistorySteps } from '../../server/src/lib/chat/historyStepReuse.ts';

const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

const baseChat = () => ({
  id: 'reuse-chat',
  title: 'Тест',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  model: 'test-model',
  modelRef: {
    provider: 'test-provider',
    model: 'test-model'
  },
  workdir: {
    kind: 'grigdesk'
  },
  messages: [{
    role: 'assistant',
    text: 'Первый ответ',
    runId: 'first-run',
    assistantMessageId: 'first-answer',
    receipt: {
      revision: 1
    },
    steps: [{
      k: 'tool',
      text: 'Первое тело'
    }],
    attachments: [{
      name: 'first'
    }]
  }],
  draft: '',
});

/**
 * Управляемая сеть сериализует тело до ожидания, как настоящий apiClient.
 * Серверный resolver и ACK builder проверяют позиции и именно отправленный снимок.
 */
async function setup({
  loaded = true,
  capability = 1,
  slow = false
} = {}) {
  let stored = baseChat();
  const requests = [];
  let rejectNext = null;
  const api = {
    /**
     * Чтение возвращает отдельную серверную копию и объявляет текущую capability.
     * Управляемая замена базы проверяет GET, который нельзя принять поверх dirty-правки.
     */
    async get(url) {
      if (url === '/api/chat/store' || url === '/api/chat/store/list') {
        const store = {
          sessions: [structuredClone(stored)],
          archived: [],
          historyStepReuseProtocol: capability
        };

        return url.endsWith('/list') ? protocolList(store) : store;
      }
      if (url.startsWith('/api/chat/store/head/')) {
        return { head: protocolHead(stored) };
      }
      if (url.startsWith('/api/chat/store/chat/')) {
        return {
          chat: structuredClone(stored),
          version: protocolHead(stored).version,
        };
      }

      return {
        active: [],
        pending: [],
        waiting: []
      };
    },
    /**
     * Сверка использует ту же серверную копию, что каталог и адресная лента.
     * Пустая очередь не добавляет записей в журнал PUT, проверяемый барьерами refs.
     */
    async post(url, body) {
      if (url === '/api/chat/store/changes') {
        return protocolChanges({
          sessions: [structuredClone(stored)],
          archived: [],
          historyStepReuseProtocol: capability,
        }, body.known);
      }
      if (url === '/api/chat/store/reconcile') {
        return protocolReconcile();
      }

      throw new Error(`Неожиданный POST: ${url}`);
    },
    /**
     * Сериализация фиксирует данные до ожидания ответа управляемого сервера.
     * Тест может изменить живую историю и завершить ACK отдельно.
     */
    put(url, body) {
      if (url === '/api/chat/store/meta') {
        return Promise.resolve({
          ok: true
        });
      }

      const sent = JSON.parse(JSON.stringify(body));
      const request = {
        url,
        sent,
        body
      };

      requests.push(request);

      /**
       * Восстанавливаем ссылки и подтверждаем итоговую историю отправленного запроса.
       * Управляемые поля ответа позволяют отдельно проверить отсутствие или повреждение ACK.
       */
      const finish = (extra = {}) => {
        let incoming;

        try {
          incoming = sent.reuseSteps ?
            restoreHistorySteps(sent.chat, stored, sent.reuseSteps) :
            sent.chat;
        } catch (error) {
          // Настоящий HTTP-адаптер передаёт status/data, по которым разрешён full fallback.
          throw Object.assign(error, { status: error.statusCode, data: { error: error.code } });
        }

        stored = {
          ...incoming,
          revision: stored.revision + 1
        };

        const response = {
          ok: true,
          revision: stored.revision,
          stale: false,
          restored: 0,
          dropped: 0,
          stepReuseAck: historyStepReuseAck(incoming, stored),
          ...extra,
        };

        return response;
      };

      if (rejectNext) {
        const error = rejectNext;

        rejectNext = null;

        return Promise.reject(error);
      }
      if (!slow) {
        return Promise.resolve(finish());
      }

      return new Promise((resolve, reject) => {
        request.finish = (extra) => resolve(finish(extra));
        request.reject = reject;
      });
    },
    async del() {
      return {};
    },
  };
  const chat = await chatStoreFixture({
    sessions: [baseChat()]
  }, {
    api,
    fromServer: loaded
  });

  cleanups.push(() => chat.$dispose());

  if (loaded) {
    const surface = chat.registerSurface({}, { chatId: stored.id, visible: true });

    cleanups.push(() => surface.dispose());
    // В исходном протоколе лента уже полная после _load; в новом ждём то же состояние.
    await chat.ensureChatMessages?.(stored.id);
  }

  chat.historyStepReuseProtocol = capability;

  return {
    chat,
    session: chat.sessions[0],
    requests,
    api,
    replaceStored(next) {
      stored = structuredClone(next);
    },
    setCapability(next) {
      capability = next;
    },
    rejectNext(error) {
      rejectNext = error;
    },
  };
}

const conflict = (status = 409, name = 'chat_steps_changed') => Object.assign(new Error(name), {
  status,
  data: {
    error: name
  },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('загруженная proxy-история даёт refs сразу; новый снимок только после валидного ACK', async () => {
  for (const loaded of [true, false]) {
    const {
      chat,
      session,
      requests
    } = await setup({
      loaded
    });

    session.draft = 'первая правка';
    await chat._writeChat(session.id);
    assert.equal(requests[0].url.endsWith('/step-reuse'), loaded);
    session.draft = 'следующая правка';
    await chat._writeChat(session.id);
    assert.equal(requests[1].url.endsWith('/step-reuse'), true);
    assert.equal(Object.hasOwn(requests[1].sent.chat.messages[0], 'steps'), false);
    assert.equal(chat._dirty(session), false);
    await chat._writeChat(session.id);
    assert.equal(requests.length, 2);
  }
});

test('без capability, без revision и после browser snapshot используется только full', async () => {
  const {
    chat,
    session,
    requests
  } = await setup({
    capability: 0
  });

  session.draft = 'правка';
  await chat._writeChat(session.id);
  assert.equal(requests[0].url, '/api/chat/store/chat');
  assert.deepEqual(requests[0].sent.chat.messages[0].steps, baseChat().messages[0].steps);

  const browser = await setup({
    loaded: false
  });

  delete browser.session.revision;
  browser.session.draft = 'browser';
  await browser.chat._writeChat(browser.session.id);
  assert.equal(browser.requests[0].url, '/api/chat/store/chat');
});

test('замена массива той же длины и copy-on-write тела проходят dirty и полную передачу', async () => {
  const {
    chat,
    session,
    requests
  } = await setup();
  const old = session.messages[0].steps;

  session.messages[0].steps = [...old];
  assert.equal(chat._dirty(session), true);
  await chat._writeChat(session.id);
  assert.equal(requests[0].url, '/api/chat/store/chat');
  session.messages[0].steps = old.map((step) => ({
    ...step,
    text: 'Изменённое тело'
  }));
  await chat._writeChat(session.id);
  assert.equal(requests[1].sent.chat.messages[0].steps[0].text, 'Изменённое тело');
  assert.equal(chat._dirty(session), false);
});

test('неприменённый GET сохраняет локальную revision и сбрасывает основание refs', async () => {
  for (const wholeStore of [false, true]) {
    const {
      chat,
      session,
      requests,
      replaceStored
    } = await setup();

    session.draft = 'Местная несохранённая правка';
    replaceStored({
      ...baseChat(),
      revision: 10,
      draft: 'Чужая правка'
    });

    if (wholeStore) {
      await chat._resyncStore();
    } else {
      await chat._pullChat(session.id, false);
    }

    assert.equal(session.revision, 1);
    assert.equal(session.draft, 'Местная несохранённая правка');
    assert.equal(chat._dirty(session), true);
    await chat._writeChat(session.id);
    assert.equal(requests[0].url, '/api/chat/store/chat');
    assert.equal(requests[0].sent.chat.revision, 1);
    assert.deepEqual(requests[0].sent.chat.messages[0].steps, baseChat().messages[0].steps);
  }
});

test('потеря capability и dispose освобождают подтверждения предыдущего экземпляра', async () => {
  for (const disposed of [false, true]) {
    const {
      chat,
      session,
      requests,
      setCapability
    } = await setup();

    if (disposed) {
      chat.$dispose();
    } else {
      setCapability(0);
      await chat._resyncStore();
    }

    session.draft = 'Следующая запись';
    await chat._writeChat(session.id);
    assert.equal(requests[0].url, '/api/chat/store/chat');
  }
});

test('более свежий browser snapshot не подтверждает steps при capability сервера', async (t) => {
  const previousStorage = globalThis.localStorage;
  const snapshot = {
    ...baseChat(),
    updatedAt: 1000,
    draft: 'Восстановленный текст'
  };
  const data = new Map([
    ['grigdesk-chat-snapshot', JSON.stringify({
      sessions: [snapshot],
      archived: []
    })]
  ]);

  globalThis.localStorage = {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  t.after(() => {
    if (previousStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousStorage;
    }
  });

  const {
    chat,
    session,
    requests
  } = await setup();

  await chat._writeChat(session.id);
  assert.equal(chat.historyStepReuseProtocol, 1);
  assert.equal(requests[0].url, '/api/chat/store/chat');
  assert.equal(requests[0].sent.chat.draft, 'Восстановленный текст');
  assert.deepEqual(requests[0].sent.chat.messages[0].steps, snapshot.messages[0].steps);
});

test('ACK до финализации оставляет новые receipt, steps, сообщения и draft dirty', async () => {
  const {
    chat,
    session,
    requests
  } = await setup({
    slow: true
  });

  session.draft = 'первый';

  const first = chat._writeChat(session.id);

  Object.freeze(requests[0].body.chat.messages[0].receipt);
  Object.freeze(requests[0].body.chat.messages[0].steps?.[0]);
  Object.freeze(requests[0].body.chat.messages[0].steps);
  applyAssistantFinal(session.messages, {
    runId: 'first-run',
    assistantMessageId: 'first-answer'
  }, {
    role: 'assistant',
    text: 'Финальный текст',
    receipt: {
      revision: 2
    },
    steps: [{
      k: 'tool',
      text: 'Новые steps'
    }],
  });
  session.messages.push({
    role: 'user',
    text: 'Следующая задача'
  });
  session.draft = 'второй';

  const next = chat._writeChat(session.id);

  assert.equal(requests[0].sent.chat.messages[0].text, 'Первый ответ');
  assert.equal(requests[0].body.chat.messages[0].receipt.revision, 1);
  requests[0].finish();
  await first;
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].sent.chat.messages[0].text, 'Финальный текст');
  assert.equal(requests[1].sent.chat.messages[0].receipt.revision, 2);
  assert.equal(requests[1].sent.chat.messages[0].steps[0].text, 'Новые steps');
  assert.equal(requests[1].sent.chat.messages.length, 2);
  assert.equal(requests[1].sent.chat.draft, 'второй');
  assert.equal(chat._dirty(session), true);
  requests[1].finish();
  await next;
  assert.equal(chat._dirty(session), false);
});

test('named409 и исчезнувший URI дают один полный retry со старым телом и прежней CAS', async () => {
  for (const status of [409, 404, 405]) {
    const {
      chat,
      session,
      requests,
      rejectNext
    } = await setup();

    session.draft = 'правка';
    rejectNext(conflict(status));
    await chat._writeChat(session.id);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.endsWith('/step-reuse'), true);
    assert.equal(requests[1].url, '/api/chat/store/chat');
    assert.equal(requests[1].sent.chat.revision, 1);
    assert.equal(requests[1].sent.chat.messages[0].steps[0].text, 'Первое тело');
    assert.equal(chat.historyStepReuseProtocol, status === 409 ? 1 : 0);
  }
});

test('между sparse, отказом и full retry copy-on-write сохраняет прежнее тело снимка', async () => {
  const {
    chat,
    session,
    requests
  } = await setup({
    slow: true
  });

  session.draft = 'первая правка';

  const first = chat._writeChat(session.id);

  session.messages[0].steps = [{
    k: 'tool',
    text: 'Новое тело'
  }];

  const next = chat._writeChat(session.id);

  requests[0].reject(conflict());
  await tick();
  assert.equal(requests[1].sent.chat.messages[0].steps[0].text, 'Первое тело');
  requests[1].finish();
  await first;
  await tick();
  assert.equal(requests[2].sent.chat.messages[0].steps[0].text, 'Новое тело');
  requests[2].finish();
  await next;
});

test('generic409, 400, сеть, auth и лимиты не маскируются full retry', async () => {
  for (const error of [conflict(409, 'chat_busy'), conflict(400), conflict(401), conflict(413),
      conflict(500), new TypeError('Сеть')
    ]) {
    const {
      chat,
      session,
      requests,
      rejectNext
    } = await setup();

    session.draft = 'правка';
    rejectNext(error);
    await assert.rejects(chat._writeChat(session.id), {
      message: error.message
    });
    assert.equal(requests.length, 1);
    assert.equal(chat._dirty(session), true);
  }
});

test('более новый GET и удаление не откатываются поздним ACK', async () => {
  for (const removed of [false, true]) {
    const {
      chat,
      session,
      requests
    } = await setup({
      slow: true
    });

    session.draft = 'правка';

    const first = chat._writeChat(session.id);

    if (removed) {
      chat._dropRemoteChat(session.id);
    } else {
      chat._applyRemoteChat({
        ...baseChat(),
        revision: 10,
        title: 'Новая база'
      }, false);
    }

    requests[0].finish();
    await first;
    assert.equal(chat.session(session.id)?.revision ?? null, removed ? null : 10);

    if (!removed) {
      assert.equal(chat._dirty(session), false);
    }
  }
});

test('неполный ACK подтверждает только свои позиции; невалидный ACK сбрасывает refs', async () => {
  const {
    chat,
    session,
    requests
  } = await setup({
    slow: true
  });

  session.messages.push({
    role: 'assistant',
    text: 'Другой',
    steps: [{
      k: 'tool',
      text: 'Второй'
    }]
  });

  const first = chat._writeChat(session.id);

  requests[0].finish({
    stepReuseAck: {
      protocol: 1,
      revision: 2,
      confirmed: [{
        messageIndex: 0,
        sourceIndex: 0,
        expectedKey: messageKey(session.messages[0]),
        expectedLength: 1,
      }]
    }
  });
  await first;
  session.draft = 'новый';

  const second = chat._writeChat(session.id);

  assert.equal(requests[1].sent.reuseSteps.refs.length, 1);
  assert.equal(requests[1].sent.chat.messages[1].steps[0].text, 'Второй');
  requests[1].finish({
    stepReuseAck: {
      protocol: 1,
      revision: 3,
      confirmed: [{
        messageIndex: 0,
        sourceIndex: 0,
        expectedKey: 'Неверный ключ',
        expectedLength: 1,
      }]
    }
  });
  await second;
  session.draft = 'ещё';

  const third = chat._writeChat(session.id);

  assert.equal(requests[2].url, '/api/chat/store/chat');
  requests[2].finish();
  await third;
});

test('подтверждённые тела не читаются при sparse; второй store не разделяет подтверждения', async () => {
  const {
    chat,
    session,
    requests
  } = await setup();

  session.messages[0].steps = [{
    k: 'tool',
    get text() {
      throw new Error('Прочитано тело');
    }
  }];
  chat._markSent({
    fromServer: true
  });
  session.draft = 'только метаданные';
  await chat._writeChat(session.id);
  assert.equal(requests[0].url.endsWith('/step-reuse'), true);

  const other = await setup({
    loaded: false
  });

  other.session.draft = 'другое окно';
  await other.chat._writeChat(other.session.id);
  assert.equal(other.requests[0].url, '/api/chat/store/chat');
});

test('ошибка полного fallback завершает попытку; следующий retry не повторяет sparse', async () => {
  const {
    chat,
    session,
    requests
  } = await setup({
    slow: true
  });

  session.draft = 'правка';

  const first = chat._writeChat(session.id);
  const failure = assert.rejects(first, /Полный PUT упал/);

  requests[0].reject(conflict());
  await tick();
  requests[1].reject(new Error('Полный PUT упал'));
  await failure;

  const next = chat._writeChat(session.id);

  await tick();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, '/api/chat/store/chat');
  requests[2].finish();
  await next;
});

test('финальная история отделена от активной ленты и её вложенных объектов', () => {
  const activeSteps = [{
    k: 'tool',
    text: 'Работаю',
    input: {
      command: 'first'
    }
  }];
  const history = [];

  applyAssistantFinal(history, {}, {
    role: 'assistant',
    text: 'Готово',
    steps: activeSteps
  });
  Object.freeze(history[0].steps[0].input);
  Object.freeze(history[0].steps[0]);
  Object.freeze(history[0].steps);
  activeSteps[0].input.command = 'second';
  activeSteps.push({
    k: 'note',
    text: 'Поздний шаг'
  });
  assert.equal(history[0].steps.length, 1);
  assert.equal(history[0].steps[0].input.command, 'first');
});
