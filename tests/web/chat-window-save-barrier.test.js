import assert from 'node:assert/strict';
import test from 'node:test';

import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';

/**
 * Настоящий store открывает синтетическую историю через серверный модуль.
 * Управляемый транспорт удерживает ответы без чтения пользовательских разговоров.
 */
async function barrierFixture(t, id = 'window-barrier') {
  const original = sampleChat(id, { effort: 'low' });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const view = await world.open(network);

  await view.chat.ensureChatMessages(original.id);

  return {
    ...view,
    original,
    world,
    live: view.chat.session(original.id),
  };
}

/**
 * Один уже сформированный ответ задерживается до явного завершения гонки.
 * Освобождение зарегистрировано и на аварийном выходе теста.
 */
function holdResponse(t, api, method, match) {
  const request = api[method];
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let held = false;

  t.after(() => gate.resolve());
  api[method] = async (...args) => {
    const response = await request(...args);

    if (!held && match(...args)) {
      held = true;
      entered.resolve(response);
      await gate.promise;
    }

    return response;
  };

  return { entered: entered.promise, release: gate.resolve };
}

test('WINDOW-BARRIER: чужие переименования не блокируют уже сохранённое сообщение', async (t) => {
  const view = await barrierFixture(t);
  const peers = [await view.world.open(), await view.world.open(), await view.world.open()];
  const put = view.api.put;
  const acknowledgements = [];

  view.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window') {
      const index = acknowledgements.length;
      const peer = peers[index % peers.length];

      peer.chat.session(view.original.id).title = `Чужое изменение ${index}`;
      await peer.chat._writeChat(view.original.id);
    }

    const response = await put(url, body);

    if (url === '/api/chat/store/chat/window') {
      acknowledgements.push(response);
    }

    return response;
  };

  view.live.messages.push({
    role: 'user',
    text: 'Новое сообщение',
    pid: 'durable-message',
  });

  const response = await view.chat._saveChatNow(view.live);
  const stored = await readChat(view.world, view.original);

  assert.equal(response.stale, true);
  assert.ok(acknowledgements.length <= 2, 'при совпавших настройках не нужна победа общей revision');
  assert.equal(stored.messages.filter((message) => message.pid === 'durable-message').length, 1);
  assert.equal(view.chat.saveError, null);
});

test('WINDOW-BARRIER-HEAD: поздняя шапка не понижает более новую известную ревизию', async (t) => {
  const view = await barrierFixture(t);
  const peers = [await view.world.open(), await view.world.open()];
  const put = view.api.put;
  let writes = 0;
  let reads = 0;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.chat._visible = () => false;
  view.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window' && writes < peers.length) {
      const peer = peers[writes];

      peer.chat.session(view.original.id).title = `Чужая правка ${writes++}`;
      await peer.chat._writeChat(view.original.id);
    }

    return put(url, body);
  };

  const held = holdResponse(t, view.api, 'get', (url) => (
    url.includes('/store/head/') && ++reads === 2
  ));

  view.live.draft = 'Местный черновик';

  const saving = view.chat._writeChat(view.original.id);
  const old = await held.entered;
  const stored = await readChat(view.world, view.original);

  await writeChat(view.world, {
    ...stored,
    revision: stored.revision + 1,
    messages: [...stored.messages, {
      role: 'assistant',
      text: 'Новый итог',
      pid: 'remote-final',
    }],
    unread: true,
  });

  const head = (await view.world.app.inject(`/api/chat/store/head/${view.original.id}`)).json().head;

  await view.chat._pullChat(view.original.id, false, head);
  held.release();
  await saving;

  assert.ok(head.revision > old.head.revision);
  assert.ok(view.live.revision >= head.revision);
  assert.equal(view.live.unread, true);
});

for (const changedBase of [false, true]) {
  const trigger = changedBase ? '409 при изменении базы окна' : 'stale при изменении шапки';

  test(`WINDOW-BARRIER-SELECTION: ${trigger} сохраняет выбранный для запуска effort`, async (t) => {
    const view = await barrierFixture(t);
    const put = view.api.put;
    let first = true;

    view.api.put = async (url, body) => {
      if (url === '/api/chat/store/chat/window' && first) {
        first = false;

        const remote = await readChat(view.world, view.original);

        await writeChat(view.world, {
          ...remote,
          effort: 'high',
          revision: remote.revision + 1,
          messages: changedBase
            ? remote.messages.map((message) => ({ ...message, text: 'Чужая правка базы' }))
            : remote.messages,
        });
      }

      return put(url, body);
    };

    view.live.messages.push({
      role: 'user',
      text: 'Начать с low',
      pid: 'intended-effort',
    });
    await view.chat._saveChatNow(view.live);

    const saved = await readChat(view.world, view.original);

    assert.equal(view.live.effort, 'low');
    assert.equal(saved.effort, 'low');
    assert.equal(saved.messages.filter((message) => message.pid === 'intended-effort').length, 1);
  });
}

test('WINDOW-BARRIER-ACK: поздний фоновый ACK сохраняет новую местную модель', async (t) => {
  const view = await barrierFixture(t);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const held = holdResponse(t, view.api, 'put', (url) => url === '/api/chat/store/chat/window');

  view.live.draft = 'Новый черновик';

  const saving = view.chat._writeChat(view.original.id);

  await held.entered;
  view.chat.setModel(view.original.id, 'new-local-model');
  held.release();
  await saving;

  assert.equal(view.live.modelRef.model, 'new-local-model');
  assert.equal(view.chat._dirty(view.live), true);
});

for (const selection of ['model', 'effort']) {
  test(`WINDOW-BARRIER-NEWER: новый ${selection} во время PUT отменяет прежний запуск`, async (t) => {
    const view = await barrierFixture(t);

    t.mock.timers.enable({ apis: ['setTimeout'] });

    const held = holdResponse(t, view.api, 'put', (url) => url === '/api/chat/store/chat/window');
    const saving = view.chat._saveChatNow(view.live);
    const rejected = assert.rejects(saving, { code: 'chat_revision_conflict' });

    await held.entered;

    if (selection === 'model') {
      view.chat.setModel(view.original.id, 'new-local-model');
    } else {
      view.chat.setEffort(view.original.id, 'high');
    }

    held.release();
    await rejected;
    assert.equal(selection === 'model' ? view.live.modelRef.model : view.live.effort,
      selection === 'model' ? 'new-local-model' : 'high');
  });
}

test('WINDOW-BARRIER-DISPOSE: поздний ACK не разрешает отправку закрытого клиента', async (t) => {
  const view = await barrierFixture(t);
  const held = holdResponse(t, view.api, 'put', (url) => url === '/api/chat/store/chat/window');
  const saving = view.chat._saveChatNow(view.live);
  const rejected = assert.rejects(saving);

  await held.entered;
  view.chat.$dispose();
  held.release();
  await rejected;

  assert.equal(view.calls.filter((call) => call.method === 'PUT'
    && call.url === '/api/chat/store/chat/window').length, 1);
});

test('WINDOW-BARRIER-NEWER-HEAD: новый effort во время сверки шапки отменяет старый запуск', async (t) => {
  const view = await barrierFixture(t);
  const peer = await view.world.open();
  const put = view.api.put;
  let reads = 0;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window') {
      peer.chat.session(view.original.id).title = 'Чужое переименование';
      await peer.chat._writeChat(view.original.id);
    }

    return put(url, body);
  };

  const held = holdResponse(t, view.api, 'get', (url) => (
    url.includes('/store/head/') && ++reads === 2
  ));
  const saving = view.chat._saveChatNow(view.live);
  const rejected = assert.rejects(saving, { code: 'chat_revision_conflict' });

  await held.entered;
  view.chat.setEffort(view.original.id, 'high');
  held.release();
  await rejected;

  assert.equal(view.live.effort, 'high');
  assert.equal(view.chat._dirty(view.live), true);
});

test('WINDOW-BARRIER-CONFIRMED: подтверждённый effort совпадает и с живым выбором запуска', async (t) => {
  const view = await barrierFixture(t);
  const put = view.api.put;
  const get = view.api.get;
  let first = true;
  let heads = 0;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window' && first) {
      first = false;

      const remote = await readChat(view.world, view.original);

      await writeChat(view.world, {
        ...remote,
        effort: 'high',
        revision: remote.revision + 1,
      });
    }

    return put(url, body);
  };
  view.api.get = async (url, options) => {
    if (url.includes('/store/head/') && ++heads === 2) {
      const remote = await readChat(view.world, view.original);

      await writeChat(view.world, {
        ...remote,
        effort: 'low',
        revision: remote.revision + 1,
      });
    }

    return get(url, options);
  };

  await view.chat._saveChatNow(view.live);

  const saved = await readChat(view.world, view.original);

  assert.equal(view.live.effort, 'low');
  assert.equal(saved.effort, 'low');
});

test('WINDOW-BARRIER-NEWER-409: новый effort до восстановления базы отменяет прежний запуск', async (t) => {
  const view = await barrierFixture(t);
  const put = view.api.put;
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let first = true;

  t.after(() => gate.resolve());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window' && first) {
      first = false;

      const remote = await readChat(view.world, view.original);

      await writeChat(view.world, {
        ...remote,
        revision: remote.revision + 1,
        messages: remote.messages.map((message) => ({ ...message, text: 'Изменённая база' })),
      });

      try {
        return await put(url, body);
      } catch (error) {
        entered.resolve();
        await gate.promise;

        throw error;
      }
    }

    return put(url, body);
  };

  const saving = view.chat._saveChatNow(view.live);
  const rejected = assert.rejects(saving);

  await entered.promise;
  view.chat.setEffort(view.original.id, 'high');
  gate.resolve();
  await rejected;

  assert.equal(view.live.effort, 'high');
  assert.equal(view.chat._dirty(view.live), true);
});
