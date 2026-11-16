import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

import { ensureMessages, serverWorld, windowApi } from './helpers/chat-lazy.js';
import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';

test('REVIEW-REFRESH: SSE во время независимого latest не теряет новый хвост', async (t) => {
  const original = sampleChat('review-refresh', { unread: false });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);

  await ensureMessages(chat, original.id);
  chat._visible = () => true;

  const get = network.api.get;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let hold = true;

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const result = await get(url);

    if (hold && url.includes('window=1')) {
      hold = false;
      entered.resolve();
      await gate.promise;
    }

    return result;
  };

  const refreshing = chat._refreshChatWindow(original.id);

  await entered.promise;

  const before = await readChat(world, original);

  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    messages: [...before.messages, {
      role: 'assistant',
      text: 'Новый хвост',
      pid: 'review-new-final',
    }],
  });

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();
  const update = chat._pullChat(original.id, false, head);

  gate.resolve();
  await Promise.all([refreshing, update]);
  assert.equal(chat._find(original.id).messages.at(-1).pid, 'review-new-final');
  assert.equal(chat._find(original.id).historyWindow.stale, false);
});

test('REVIEW-DETAIL: SSE той же версии не ломает первое открытие сообщений', async (t) => {
  const original = sampleChat('review-detail', { unread: false });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);
  const get = network.api.get;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let hold = true;

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const result = await get(url);

    if (hold && url.includes('window=1')) {
      hold = false;
      entered.resolve();
      await gate.promise;
    }

    return result;
  };

  const loading = chat.ensureChatMessages(original.id);

  await entered.promise;

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  await chat._pullChat(original.id, false, head);
  gate.resolve();
  await loading;
  assert.equal(chat.isChatMessagesLoaded(original.id), true,
    `Первая лента осталась незагруженной: ${JSON.stringify(chat.messageLoads[original.id])}`);
});

test('REVIEW-CANDIDATE: переход к новым не принимает старый candidate поверх нового SSE', async (t) => {
  const original = sampleChat('review-candidate', { unread: false });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);

  await ensureMessages(chat, original.id);
  chat._visible = () => true;
  chat.setChatViewport(original.id, false);

  const before = await readChat(world, original);
  const second = {
    ...before,
    revision: before.revision + 1,
    messages: [...before.messages, {
      role: 'assistant',
      text: 'Второй хвост',
      pid: 'second-tail',
    }],
  };

  await writeChat(world, second);

  const head2 = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json().head;

  await chat._pullChat(original.id, false, head2);
  assert.equal(chat.hasNewerMessages(original.id), true);

  await writeChat(world, {
    ...second,
    revision: second.revision + 1,
    messages: [...second.messages, {
      role: 'assistant',
      text: 'Третий хвост',
      pid: 'third-tail',
    }],
  });

  const head3 = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json().head;
  const get = network.api.get;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let hold = true;

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const result = await get(url);

    if (hold && url.includes('window=1')) {
      hold = false;
      entered.resolve();
      await gate.promise;
    }

    return result;
  };

  const update = chat._pullChat(original.id, false, head3);

  await entered.promise;

  const jumping = chat.showLatestMessages(original.id);

  gate.resolve();
  await Promise.all([update, jumping]);
  assert.equal(chat._find(original.id).messages.at(-1).pid, 'third-tail');
});

test('REVIEW-DELETE-PAGE: поздняя страница не возвращает удалённый чат', async (t) => {
  const original = sampleChat('review-delete-page', { unread: false });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);
  const get = network.api.get;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const result = await get(url);

    if (url.includes('/store/list?')) {
      entered.resolve();
      await gate.promise;
    }

    return result;
  };

  const loading = chat.refreshChatPage();

  await entered.promise;
  chat._dropRemoteChat(original.id);
  gate.resolve();
  await loading;
  assert.equal(chat._find(original.id), null);
});

test('слитая рассылка должна сохранить изменение чужого автора для последнего писателя', async (t) => {
  const original = sampleChat('review-origin-race', { unread: true });
  const windows = [];
  const world = await serverWorld(t, [original], {
    onEvent: (name, data) => windows.forEach((view) => view.sse(name, data)),
  });
  const a = await world.open();
  const b = await world.open();

  windows.push(a, b);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const read = ChatHistoryStore.prototype.readEntry;
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let held = false;

  t.after(() => gate.resolve());
  t.mock.method(ChatHistoryStore.prototype, 'readEntry', async function (id) {
    const inBroadcast = new Error().stack.includes('broadcastChatStore');
    const entry = await read.call(this, id);

    if (!held && inBroadcast) {
      held = true;
      entered.resolve();
      await gate.promise;
    }

    return entry;
  });
  a.chat.renameChat(original.id, 'Название из окна A');

  const savingA = a.chat._writeChat(original.id);

  await entered.promise;
  b.chat._visible = () => true;
  b.chat.markRead(original.id);
  await b.chat._writeChat(original.id);
  gate.resolve();
  await savingA;
  await b.chat._resyncStore();
  assert.equal(b.chat._find(original.id).title, 'Название из окна A');
  assert.deepEqual(b.chat._headMetadataPatch(original.id), {}, 'чужая правка не отправляется обратно');
});

test('PATCH-LATE: задержанный ACK не откатывает принятую новую шапку', async (t) => {
  const original = sampleChat('patch-late', { unread: true });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);
  const patch = network.api.patch;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  network.api.patch = async (...args) => {
    const response = await patch(...args);

    entered.resolve();
    await gate.promise;

    return response;
  };
  chat._visible = () => true;
  chat.markRead(original.id);

  const saving = chat._writeChat(original.id);

  await entered.promise;

  const before = await readChat(world, original);

  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    unread: true,
    messages: [...before.messages, { role: 'assistant', text: 'Новый финал' }],
  });

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  await chat._pullChat(original.id, false, head);
  gate.resolve();
  await saving;
  assert.equal(chat._find(original.id).revision, head.revision);
  assert.equal(chat._find(original.id).unread, true);
  assert.deepEqual(chat._headMetadataPatch(original.id), {});
});

test('DETAIL-CHURN: непрерывные изменения ограничивают загрузку тремя чтениями и допускают повтор',
  async (t) => {
    const original = sampleChat('detail-churn');
    const world = await serverWorld(t, [original]);
    const network = windowApi(world.app);
    const { chat } = await world.open(network);
    const get = network.api.get;
    let reads = 0;
    let changing = true;

    network.api.get = async (url) => {
      const result = await get(url);

      if (changing && url.includes('window=1')) {
        reads += 1;

        if (reads > 5) {
          throw new Error('Неограниченная перезагрузка');
        }

        const before = await readChat(world, original);

        await writeChat(world, {
          ...before,
          revision: before.revision + 1,
          draft: `Чужой черновик ${reads}`,
        });

        const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

        await chat._pullChat(original.id, false, head);
      }

      return result;
    };
    await chat.ensureChatMessages(original.id);
    assert.equal(reads, 3);
    assert.equal(chat.messageLoads[original.id].state, 'error');
    assert.equal(chat.isChatMessagesLoaded(original.id), false);
    changing = false;
    await chat.ensureChatMessages(original.id);
    assert.equal(chat.messageLoads[original.id].state, 'loaded');
    assert.equal(chat._find(original.id).draft, 'Чужой черновик 3');
  });

test('PATCH-EDIT: ACK сохраняет название и прочтение, изменённые после отправки', async (t) => {
  const original = sampleChat('patch-edit', { unread: true });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);
  const patch = network.api.patch;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  network.api.patch = async (...args) => {
    const response = await patch(...args);

    entered.resolve();
    await gate.promise;

    return response;
  };
  chat.renameChat(original.id, 'Отправленное название');

  const saving = chat._writeChat(original.id);

  await entered.promise;
  chat.renameChat(original.id, 'Новое местное название');
  chat._visible = () => true;
  chat.markRead(original.id);
  gate.resolve();
  await saving;
  assert.equal(chat._find(original.id).title, 'Новое местное название');
  assert.equal(chat._find(original.id).unread, false);
  await chat._writeChat(original.id);

  const saved = await readChat(world, original);

  assert.equal(saved.title, 'Новое местное название');
  assert.equal(saved.unread, false);
});

test('прочтение прежнего ответа во время PATCH не читает новый финал из ACK', async (t) => {
  const original = sampleChat('patch-read-old', { unread: true });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);
  const patch = network.api.patch;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  network.api.patch = async (...args) => {
    await patch(...args);
    entered.resolve();
    await gate.promise;

    return (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();
  };
  chat.renameChat(original.id, 'Моя правка названия');

  const saving = chat._writeChat(original.id);

  await entered.promise;
  chat._visible = () => true;
  chat.markRead(original.id);

  const before = await readChat(world, original);

  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    unread: true,
    messages: [...before.messages, {
      role: 'assistant',
      text: 'Новый непрочитанный ответ',
      pid: 'new-final',
    }],
  });
  gate.resolve();
  await saving;
  assert.equal(chat._find(original.id).unread, true, 'отметка прочтения относилась к прежнему финалу');
  await chat._writeChat(original.id);
  assert.equal((await readChat(world, original)).unread, true);
});
