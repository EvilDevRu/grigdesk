import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { messageKey } from '../../shared/chatMessageIdentity.ts';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { chatAppFixture, saveChat } from './helpers/chat-turns.js';

const ROUTE = '/api/chat/store/chat/step-reuse';
const messages = () => [{
    role: 'assistant',
    text: 'Одинаковый старый ответ',
    steps: [{
      k: 'tool',
      text: 'первый'
    }]
  },
  {
    role: 'assistant',
    text: 'Одинаковый старый ответ',
    steps: [{
      k: 'tool',
      text: 'второй'
    }]
  },
];

/**
 * Сетевой снимок удаляет только подтверждённые steps и сохраняет точные позиции legacy-реплик.
 * Исходная полная история остаётся доступной для проверки fallback и результата GET.
 */
function sparse(chat) {
  const refs = chat.messages.flatMap((message, index) => Array.isArray(message.steps) ? [{
    messageIndex: index,
    sourceIndex: index,
    expectedKey: messageKey(message),
    expectedLength: message.steps.length,
  }] : []);
  const copy = {
    ...chat,
    messages: chat.messages.map(({
      steps,
      ...message
    }) => message)
  };

  return {
    chat: copy,
    reuseSteps: {
      protocol: 1,
      baseRevision: chat.revision,
      refs
    }
  };
}

test('маршруты full → refs → GET сохраняют legacy-ленты, no-op не повышает revision и SSE', async (t) => {
  const {
    app,
    events
  } = await chatAppFixture(t);
  const ack = await saveChat(app, 'reuse-chat', {
    messages: messages()
  });
  const original = (await app.inject('/api/chat/store/chat/reuse-chat')).json().chat;

  assert.equal((await app.inject('/api/chat/store')).json().historyStepReuseProtocol, 1);
  assert.equal(ack.stepReuseAck.confirmed.length, 2);

  const request = sparse({
    ...original,
    draft: 'правка'
  });
  const response = await app.inject({
    method: 'PUT',
    url: ROUTE,
    payload: request
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().stepReuseAck.confirmed.length, 2);

  const saved = (await app.inject('/api/chat/store/chat/reuse-chat')).json().chat;

  assert.deepEqual(saved.messages, messages());

  const eventCount = events.length;
  const noop = await app.inject({
    method: 'PUT',
    url: ROUTE,
    payload: sparse(saved)
  });

  assert.equal(noop.json().written, false);
  assert.equal(noop.json().revision, saved.revision);
  assert.equal(events.length, eventCount);
});

test('повреждённые refs отказывают без записи и освобождают учёт сохранений', async (t) => {
  const {
    app,
    events
  } = await chatAppFixture(t);

  await saveChat(app, 'bad-refs-chat', {
    messages: messages()
  });

  const original = (await app.inject('/api/chat/store/chat/bad-refs-chat')).json().chat;
  const cases = [
    [400, (body) => {
      body.reuseSteps.protocol = '1';
    }],
    [400, (body) => {
      body.reuseSteps.baseRevision = 0;
    }],
    [400, (body) => {
      body.reuseSteps.refs[0].messageIndex = 2;
    }],
    [400, (body) => {
      body.reuseSteps.refs[0].expectedLength = -1;
    }],
    [400, (body) => {
      body.reuseSteps.refs[0].extra = true;
    }],
    [400, (body) => {
      body.reuseSteps.refs[1].messageIndex = 0;
    }],
    [400, (body) => {
      body.reuseSteps.refs[1].sourceIndex = 0;
    }],
    [400, (body) => {
      body.chat.messages[0].steps = null;
    }],
    [400, (body) => {
      body.chat.messages = [];
    }],
    [409, (body) => {
      body.reuseSteps.refs[0].sourceIndex = 9;
    }],
    [409, (body) => {
      body.reuseSteps.refs[0].expectedKey = 'другой';
    }],
    [409, (body) => {
      body.reuseSteps.refs[0].expectedLength = 9;
    }],
    [409, (body) => {
      body.chat.revision += 1;
    }],
    [409, (body) => {
      body.reuseSteps.baseRevision += 1;
    }],
  ];
  const eventCount = events.length;

  for (const [status, change] of cases) {
    const request = sparse(original);

    change(request);

    const result = await app.inject({
      method: 'PUT',
      url: ROUTE,
      payload: request
    });

    assert.equal(result.statusCode, status, result.body);
    assert.equal(result.json().error, status === 400 ? 'bad_step_reuse' : 'chat_steps_changed');
    assert.deepEqual((await app.inject('/api/chat/store/chat/bad-refs-chat')).json().chat, original);
    assert.equal(events.length, eventCount);
  }

  const deleted = await app.inject({
    method: 'DELETE',
    url: '/api/chat/store/chat/bad-refs-chat'
  });

  assert.equal(deleted.statusCode, 200);
});

test('конфликт revision не обходит stale CAS; архив, новые steps и очистка остаются полными', async (t) => {
  const {
    app
  } = await chatAppFixture(t);

  await saveChat(app, 'conflict-chat', {
    messages: messages()
  });

  const original = (await app.inject('/api/chat/store/chat/conflict-chat')).json().chat;
  const other = {
    ...original,
    draft: 'другое окно',
    messages: [...original.messages,
      {
        role: 'user',
        text: 'Новая задача'
      }
    ]
  };

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: other
    }
  });

  const conflict = await app.inject({
    method: 'PUT',
    url: ROUTE,
    payload: sparse(original)
  });

  assert.equal(conflict.statusCode, 409);

  const full = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: original
    }
  });

  assert.equal(full.json().stale, true);

  const saved = (await app.inject('/api/chat/store/chat/conflict-chat')).json().chat;

  assert.equal(saved.messages.at(-1).text, 'Новая задача');

  const archived = await app.inject({
    method: 'PUT',
    url: ROUTE,
    payload: {
      ...sparse(saved),
      archived: true
    }
  });

  assert.equal(archived.statusCode, 200);

  const clear = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...saved,
        revision: archived.json().revision,
        messages: []
      },
      archived: true,
    }
  });

  assert.equal(clear.statusCode, 200);
  assert.deepEqual((await app.inject('/api/chat/store/chat/conflict-chat')).json().chat.messages, []);
});

test('canonical protection с нулевыми флагами не подтверждает заменённые тела той же длины', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-reuse-canonical-'));

  t.after(() => fs.rm(dir, {
    recursive: true,
    force: true
  }));

  const store = new ChatHistoryStore({
    chatsDir: dir
  });
  const incoming = {
    id: 'canonical-chat',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [{
      role: 'assistant',
      assistantMessageId: 'answer',
      runId: 'run',
      text: 'Ответ',
      steps: [{
        k: 'tool',
        text: 'клиент'
      }]
    }],
  };
  const first = await store.saveOne(incoming);

  store.setCanonicalMessages(() => [{
    ...incoming.messages[0],
    serverCanonical: true,
    steps: [{
      k: 'tool',
      text: 'сервер'
    }]
  }]);

  const saved = await store.saveOne({
    ...first.chat,
    draft: 'изменение'
  });

  assert.equal(saved.stale, false);
  assert.equal(saved.restored, 0);
  assert.equal(saved.dropped, 0);
  assert.deepEqual(saved.stepReuseAck.confirmed, []);
  assert.equal((await store.readOne(incoming.id)).messages[0].steps[0].text, 'сервер');
});

test('ошибка durable write и отсутствие базы не создают подтверждение и revision', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-reuse-write-'));

  t.after(() => fs.rm(dir, {
    recursive: true,
    force: true
  }));

  const store = new ChatHistoryStore({
    chatsDir: dir
  });
  const first = await store.saveOne({
    id: 'write-chat',
    messages: messages(),
    createdAt: 1000
  });

  store.writeAtomic = async () => {
    throw new Error('disk failure');
  };

  const body = sparse({
    ...first.chat,
    draft: 'правка'
  });

  await assert.rejects(store.saveOne(body.chat, false, {
    reuseSteps: body.reuseSteps
  }), /disk failure/);
  assert.deepEqual(await store.readOne('write-chat'), first.chat);
  await assert.rejects(store.saveOne({
    ...body.chat,
    id: 'missing'
  }, false, {
    reuseSteps: body.reuseSteps
  }), {
    code: 'chat_steps_changed'
  });
});
