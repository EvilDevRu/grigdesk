import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonRequest, readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';
import { chatStoreFixture } from './helpers/chat-store.js';
import { drain, SNAPSHOT_KEY } from './helpers/chat-load.js';
import { controlledExecutor, waitFor } from '../server/helpers/chat-turns.js';

test('PAGE-ACK-CLEAN: подтверждение окна не оставляет чат dirty и не повторяет PUT', async (t) => {
  const world = await serverWorld(t, chats(1));
  const view = await world.open();
  const id = 'web-page-0';

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const session = view.chat.session(id);

  session.draft = 'Сохраняемый черновик';
  await view.chat._writeChat(id);
  assert.equal(view.chat._dirty(session), false);

  const before = view.calls.length;

  await view.chat._writeChat(id);
  assert.equal(view.calls.slice(before).some((call) => call.method === 'PUT'), false);
});

test('PAGE-SEND-RESTORED: после слияния и очистки черновика отправка достигает приёма', async (t) => {
  const records = chats(1);
  const world = await serverWorld(t, records);
  const view = await world.open();
  const id = records[0].id;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const remote = await jsonRequest(world.app, 'GET', `/api/chat/store/chat/${id}`);

  await jsonRequest(world.app, 'PUT', '/api/chat/store/chat', {
    chat: {
      ...remote.chat,
      messages: [...remote.chat.messages, {
        role: 'note',
        text: 'Серверное сжатие',
        pid: 'server-compact-note',
      }],
    },
    archived: false,
  });

  const session = view.chat.session(id);

  session.messages.push({ role: 'note', text: 'Локальное сжатие' });
  session.draft = 'Сообщение после сжатия';
  await view.chat._writeChat(id);
  assert.equal(session.historyWindow.stale, true);
  view.chat.setDraft(id, '');

  let admitted = false;

  t.mock.method(view.chat, '_sendTurn', async () => {
    admitted = true;

    return true;
  });

  assert.equal(await view.chat.send(id, 'Сообщение после сжатия'), true);
  assert.equal(admitted, true);
  assert.equal(session.historyWindow.stale, false);
  assert.ok(session.messages.some((message) => message.pid === 'server-compact-note'));
});

test('PAGE-ACK-EDIT: поздний ACK не подтверждает черновик, изменённый во время PUT', async (t) => {
  const world = await serverWorld(t, chats(1));
  const network = windowApi(world.app);
  const put = network.api.put;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());
  network.api.put = async (url, body) => {
    const response = await put(url, body);

    if (url === '/api/chat/store/chat/window') {
      entered.resolve();
      await gate.promise;
    }

    return response;
  };

  const view = await world.open(network);
  const id = 'web-page-0';

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const session = view.chat.session(id);

  session.draft = 'Первый черновик';

  const saving = view.chat._writeChat(id);

  await entered.promise;
  session.draft = 'Набрано во время записи';
  gate.resolve();
  await saving;
  assert.equal(session.draft, 'Набрано во время записи');
  assert.equal(view.chat._dirty(session), true);
  await view.chat._writeChat(id);
  assert.equal(view.chat._dirty(session), false);
});

test('PAGE-OLDER-WITH-NEWER: новый хвост не блокирует чтение старых сообщений', async (t) => {
  const records = chats(1);
  const world = await serverWorld(t, records);
  const view = await world.open();
  const id = records[0].id;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const surface = view.chat.registerSurface('older-with-newer', { chatId: id, visible: true });

  t.after(() => surface.dispose());
  view.chat.setChatViewport(id, false);

  const remote = await jsonRequest(world.app, 'GET', `/api/chat/store/chat/${id}`);

  await jsonRequest(world.app, 'PUT', '/api/chat/store/chat', {
    chat: {
      ...remote.chat,
      messages: [...remote.chat.messages, {
        role: 'assistant',
        text: 'Новый ответ',
        pid: 'newer-tail',
      }],
    },
    archived: false,
  });
  await view.chat._pullChat(id, false);
  assert.equal(view.chat.hasNewerMessages(id), true);
  await view.chat.loadOlderMessages(id);

  const session = view.chat.session(id);

  assert.equal(session.messages.length, 80);
  assert.equal(session.messages[0].text, 'Ответ 0/21');
  assert.equal(session.messages.at(-1).text, 'Ответ 0/100');
  assert.equal(view.chat.hasNewerMessages(id), true);
  await view.chat.loadOlderMessages(id);
  assert.equal(session.messages.length, 101);
});

test('PAGE-SEND-DURING-REFRESH: отправка дожидается фонового чтения и принимает свежий хвост', async (t) => {
  const world = await serverWorld(t, chats(1));
  const network = windowApi(world.app);
  const get = network.api.get;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let hold = false;

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const response = await get(url);

    if (hold && url.includes('/store/chat/') && url.includes('window=1')) {
      hold = false;
      entered.resolve();
      await gate.promise;
    }

    return response;
  };

  const view = await world.open(network);
  const id = 'web-page-0';

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const session = view.chat.session(id);

  session.draft = 'Сохранённый черновик';
  await view.chat._writeChat(id);
  session.historyWindow.stale = true;
  view.chat.setDraft(id, '');
  view.chat.setChatViewport(id, false);
  hold = true;

  const refreshing = view.chat._refreshChatWindow(id);

  await entered.promise;
  t.mock.method(view.chat, '_sendTurn', async () => true);

  const sending = view.chat.send(id, 'Сохранённый черновик');

  gate.resolve();
  await refreshing;
  assert.equal(await sending, true);
  assert.equal(session.historyWindow.stale, false);
});

// Много карточек нужны, чтобы прежний цельный список не выглядел правильным.
// Каждая содержит сообщения: запрет фонового detail проверяется по журналу HTTP.
function chats(count = 95) {
  return Array.from({ length: count }, (_, index) => sampleChat(`web-page-${index}`, {
    updatedAt: 10000 - index,
    messages: Array.from({ length: 101 }, (_, position) => ({
      role: 'assistant',
      text: `Ответ ${index}/${position}`,
      pid: `web-message-${index}-${position}`,
    })),
  }));
}

test('PAGE-REMOTE-NEW: чат другого окна сразу появляется в открытом списке', async (t) => {
  const world = await serverWorld(t, chats());
  const view = await world.open();
  const remote = sampleChat('remote-created-chat', {
    title: 'Макеты настройки досок',
    updatedAt: Date.now(),
  });
  const cursor = view.chat.pageFor('', false).nextCursor;
  const before = view.calls.length;

  await jsonRequest(world.app, 'PUT', '/api/chat/store/chat', { chat: remote, archived: false });
  view.sse('chat-store', {
    id: remote.id,
    archived: false,
    origin: 'another-window',
  });
  await waitFor(() => view.chat.sessions.some((chat) => chat.id === remote.id));
  assert.equal(view.chat.list('').some((chat) => chat.id === remote.id), true,
    'Полученная по SSE карточка видна без поиска, reconnect и перезагрузки');
  assert.equal(view.chat.pageFor('', false).nextCursor, cursor);
  assert.equal(view.calls.slice(before).some((call) => call.url.includes('/store/chat/')), false,
    'Новая карточка не требует скачивать переписку');
});

test('PAGE-REMOTE-KNOWN: обновление найденного чата дополняет список и сохраняет поиск', async (t) => {
  const records = chats();
  const remote = records.at(-1);

  remote.title = 'Уникальный макет';

  const world = await serverWorld(t, records);
  const view = await world.open();

  await view.chat.searchChats('Уникальный макет', false);
  assert.equal(view.chat.list('').some((chat) => chat.id === remote.id), false);
  assert.deepEqual(view.chat.list('Уникальный макет').map((chat) => chat.id), [remote.id]);

  const cursor = view.chat.pageFor('', false).nextCursor;

  await jsonRequest(world.app, 'PUT', '/api/chat/store/chat', {
    chat: {
      ...remote,
      title: 'Уникальный макет обновлён',
      updatedAt: Date.now(),
    },
    archived: false,
  });
  view.sse('chat-store', {
    id: remote.id,
    archived: false,
    origin: 'another-window',
  });
  await waitFor(() => view.chat.session(remote.id)?.title === 'Уникальный макет обновлён');
  assert.equal(view.chat.list('').some((chat) => chat.id === remote.id), true);
  assert.deepEqual(view.chat.list('Уникальный макет').map((chat) => chat.id), [remote.id]);
  assert.equal(view.chat.pageFor('', false).nextCursor, cursor);
});

test('PAGE-OPEN: restored activeId и видимость не читают историю до выбора', async (t) => {
  const world = await serverWorld(t, chats());
  const id = 'web-page-0';

  await jsonRequest(world.app, 'PUT', '/api/chat/store/meta', { activeId: id });

  const network = windowApi(world.app);
  const chat = await chatStoreFixture({}, { api: network.api, unloaded: true });
  const surface = chat.registerSurface('restored-wide-page', { chatId: id, visible: true });

  t.after(() => {
    surface.dispose();
    chat.loaded = false;
    chat.$dispose();
  });
  await chat.ensure();
  await drain();
  assert.equal(chat.activeId, id);
  assert.equal(chat.list('').length, 40);
  assert.equal(chat.isChatMessagesLoaded(id), false);
  assert.equal(network.calls.some((call) => call.url === '/api/chat/store'), false);
  assert.equal(network.calls.some((call) => /store\/chat\/web-page/.test(call.url)), false);
});

test('PAGE-OLDER: две одновременные прокрутки добавляют одну старую порцию', async (t) => {
  const world = await serverWorld(t, chats(1));
  const view = await world.open();
  const id = 'web-page-0';

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const before = view.calls.length;

  await Promise.all([view.chat.loadOlderMessages?.(id), view.chat.loadOlderMessages?.(id)]);

  const session = view.chat.session(id);

  assert.equal(session.messages.length, 80);
  assert.equal(session.messages[0].text, 'Ответ 0/21');
  assert.equal(session.messages.at(-1).text, 'Ответ 0/100');
  assert.equal(view.calls.slice(before).filter((call) => call.method === 'GET'
    && call.url.includes('before=')).length, 1);
});

test('PAGE-WINDOW-SAVE: черновик и новое сообщение не обрезают историю', async (t) => {
  const records = chats(1);
  const world = await serverWorld(t, records);
  const view = await world.open();
  const id = records[0].id;

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const session = view.chat.session(id);
  const original = await readChat(world, records[0]);

  session.draft = 'Несохранённый текст';
  session.messages.push({
    role: 'user',
    text: 'Новый запрос',
    turnId: 'page-save-turn'
  });
  await view.chat._writeChat(id);

  const saved = await readChat(world, records[0]);

  assert.deepEqual(saved.messages.slice(0, 101), original.messages);
  assert.equal(saved.messages.at(-1).turnId, 'page-save-turn');
  assert.equal(saved.draft, 'Несохранённый текст');
  assert.equal(view.calls.some((call) => call.method === 'PUT'
    && call.url === '/api/chat/store/chat'), false);
});

test('PAGE-FIRST-WINDOW: явный выбор читает40, сосед не загружается', { timeout: 10000 }, async (t) => {
  const world = await serverWorld(t, chats(2));
  const view = await world.open();

  view.chat.selectChat('web-page-0');
  await view.chat.ensureChatMessages('web-page-0');
  assert.equal(view.chat.session('web-page-0').messages.length, 40);
  assert.equal(view.chat.isChatMessagesLoaded('web-page-1'), false);
  assert.equal(view.calls.some((call) => call.url === '/api/chat/store/chat/web-page-0'), false);
});

test('PAGE-ARCHIVE-FIRST: первый вход загружает ровно одну порцию', { timeout: 10000 }, async (t) => {
  const records = [...chats(1), ...chats(85).map((chat) => ({

    ...chat,
    id: 'archive-' + chat.id,
    archived: true,

  }))];
  const world = await serverWorld(t, records);
  const view = await world.open();

  assert.equal(view.chat.archived.length, 0);
  await Promise.all([view.chat.ensureChatPage('', true), view.chat.ensureChatPage('', true)]);
  assert.equal(view.chat.list('', true).length, 40);
  assert.equal(view.calls.filter((call) => call.method === 'GET'
    && call.url.includes('page=1') && call.url.includes('archived=1')).length, 1);
});

test('PAGE-MEMBERSHIP: archive/restore сохраняет карточку и cursors обеих групп', async (t) => {
  const world = await serverWorld(t, [...chats(), sampleChat('old-archive', { archived: true })]);
  const view = await world.open();

  await view.chat.ensureChatPage('', true);

  const cursor = view.chat.pageFor('', false).nextCursor;
  const id = 'web-page-0';

  view.chat.deleteChat(id);
  await view.chat._writeChat(id);
  assert.equal(view.chat.list('').some((row) => row.id === id), false);
  assert.equal(view.chat.list('', true).some((row) => row.id === id), true);
  view.chat.restoreArchived(id);
  await view.chat._writeChat(id);
  assert.equal(view.chat.list('').filter((row) => row.id === id).length, 1);
  assert.equal(view.chat.list('', true).some((row) => row.id === id), false);
  assert.equal(view.chat.pageFor('', false).nextCursor, cursor);
});

test('PAGE-QUERY-LATE: поздний A не заменяет результаты B', { timeout: 10000 }, async (t) => {
  const records = chats();

  records[93].messages[0].text = 'уникальное ААА';
  records[94].messages[0].text = 'уникальное БББ';

  const world = await serverWorld(t, records);
  const network = windowApi(world.app);
  const get = network.api.get;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const data = await get(url);

    if (new URL(url, 'http://fixture').searchParams.get('q') === 'ААА') {
      entered.resolve();
      await gate.promise;
    }

    return data;
  };

  const view = await world.open(network);
  const first = view.chat.searchChats('ААА', false);

  await entered.promise;
  await view.chat.searchChats('БББ', false);
  gate.resolve();
  await first;
  assert.deepEqual(view.chat.list('БББ').map((row) => row.id), ['web-page-94']);
  assert.equal(view.chat.search.query, 'БББ');
});

test('PAGE-RETRY: отказ второй страницы сохраняет первую и тот же cursor', async (t) => {
  const world = await serverWorld(t, chats());
  const network = windowApi(world.app);
  const get = network.api.get;
  let broken = true;
  const attempts = [];

  network.api.get = async (url) => {
    if (url.includes('page=1') && url.includes('cursor=')) {
      attempts.push(url);

      if (broken) {
        throw new TypeError('Нет связи');
      }
    }

    return get(url);
  };

  const view = await world.open(network);
  const firstIds = view.chat.list('').map((row) => row.id);
  const cursor = view.chat.pageFor('', false).nextCursor;

  await view.chat.loadChatPage('', false);
  assert.deepEqual(view.chat.list('').map((row) => row.id), firstIds);
  assert.equal(view.chat.pageFor('', false).nextCursor, cursor);
  assert.ok(view.chat.pageFor('', false).error);
  broken = false;
  await view.chat.loadChatPage('', false);
  assert.equal(view.chat.list('').length, 80);
  assert.equal(attempts[0], attempts[1]);
});

test('PAGE-EXPIRED: refresh после410 читает первую страницу без старого cursor', async (t) => {
  const world = await serverWorld(t, chats());
  const network = windowApi(world.app);
  const get = network.api.get;
  let expire = false;
  const requested = [];

  network.api.get = async (url) => {
    requested.push(url);

    if (expire && url.includes('cursor=')) {
      throw Object.assign(new Error('Истёк список'), {
        status: 410, data: { error: 'chat_page_expired' },
      });
    }

    return get(url);
  };

  const view = await world.open(network);
  const ids = view.chat.list('').map((row) => row.id);

  expire = true;
  await view.chat.loadChatPage('', false);
  assert.deepEqual(view.chat.list('').map((row) => row.id), ids);
  assert.equal(view.chat.pageFor('', false).needsRefresh, true);

  // Автовосстановление уже пробует перечитать список само; при вечно истекающем
  // cursor оно оставляет кнопку, не отправляя протухший cursor повторно.
  const pageState = () => view.chat.pageFor('', false);

  for (let i = 0; i < 300 && pageState().loading; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));

  const before = requested.length;

  await view.chat.refreshChatPage('', false);
  assert.equal(requested[before].includes('cursor='), false);
  assert.equal(view.chat.pageFor('', false).needsRefresh, false);
  expire = false;
  await view.chat.loadChatPage('', false);
  assert.equal(view.chat.list('').length, 80);
});

test('PAGE-EXPIRED-AUTO: истёкший cursor перечитывается сам и возвращает глубину списка', async (t) => {
  const world = await serverWorld(t, chats());
  const network = windowApi(world.app);
  const get = network.api.get;
  let expireNextCursor = false;
  const requested = [];

  network.api.get = async (url) => {
    requested.push(url);

    if (expireNextCursor && url.includes('cursor=')) {
      expireNextCursor = false;

      throw Object.assign(new Error('Истёк список'), {
        status: 410, data: { error: 'chat_page_expired' },
      });
    }

    return get(url);
  };

  const view = await world.open(network);

  await view.chat.loadChatPage('', false);
  assert.equal(view.chat.list('').length, 80);

  // Продолжение упирается в истёкший cursor: восстановление запускается само.
  expireNextCursor = true;
  await view.chat.loadChatPage('', false);

  const pageState = () => view.chat.pageFor('', false);

  for (let i = 0; i < 300 && (pageState().needsRefresh || pageState().loading
    || pageState().ids.length < 80); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(pageState().needsRefresh, false,
    'кнопка «Обновить» не требуется: список восстановился сам');
  assert.equal(view.chat.list('').length, 80, 'прежняя глубина показанных карточек вернулась');
  assert.equal(pageState().error, '', 'ошибка истёкшего cursor не осталась');
});

test('PAGE-OLDER-DIRTY-NEIGHBOR: чтение A не подтверждает несохранённый B', async (t) => {
  const records = chats(2);
  const world = await serverWorld(t, records);
  const view = await world.open();

  t.mock.timers.enable({ apis: ['setTimeout'] });

  for (const record of records) {
    view.chat.selectChat(record.id);
    await view.chat.ensureChatMessages(record.id);
  }

  const neighbor = view.chat.session(records[1].id);

  neighbor.draft = 'Останется несохранённым до явной записи';
  neighbor.messages.push({
    role: 'user',
    text: 'Из B',
    turnId: 'neighbor-turn'
  });
  await view.chat.loadOlderMessages(records[0].id);
  assert.equal(view.chat._dirty(neighbor), true);
  assert.equal(view.calls.some((call) => call.method === 'PUT'
    && call.body?.chat?.id === neighbor.id), false);
  t.mock.timers.reset();
  await view.chat._writeChat(neighbor.id);

  const saved = await readChat(world, records[1]);

  assert.equal(saved.draft, neighbor.draft);
  assert.equal(saved.messages.at(-1).turnId, 'neighbor-turn');
});

test('PAGE-SNAPSHOT: потеря ACK восстанавливается без detail до выбора', { timeout: 10000 }, async (t) => {
  const records = chats(1);

  records[0].messages.forEach((message, index) => {
    message.steps = [{ k: 'text', text: 'Старый шаг ' + index }];
  });

  const world = await serverWorld(t, records);
  const network = windowApi(world.app);
  const put = network.api.put;
  let lose = true;

  network.api.put = async (url, body) => {
    const result = await put(url, body);

    if (url === '/api/chat/store/chat/window' && lose) {
      lose = false;

      throw new TypeError('Ответ PUT потерян после записи');
    }

    return result;
  };

  const first = await world.open(network);
  const id = records[0].id;

  first.chat.selectChat(id);
  await first.chat.ensureChatMessages(id);

  const before = await readChat(world, records[0]);
  const session = first.chat.session(id);

  session.draft = 'Текст из страховки';
  session.messages.push({

    role: 'assistant',
    text: 'Локальный ответ',
    pid: 'snapshot-page-answer',

    steps: [{ k: 'text', text: 'Единственная новая лента' }],

  });
  first.chat._persist(true);

  const originalSnapshot = localStorage.getItem(SNAPSHOT_KEY);

  assert.ok(originalSnapshot.includes('historyWindow'));
  assert.ok(originalSnapshot.includes('Единственная новая лента'));
  await waitFor(() => network.calls.some((call) => call.url === '/api/chat/store/chat/window'
    && call.done), { what: 'первый PUT дошёл до сервера' });
  first.chat.loaded = false;
  first.chat.$dispose();

  const recovery = windowApi(world.app);
  const recoveryPut = recovery.api.put;
  const recoveryEntered = Promise.withResolvers();
  const recoveryAck = Promise.withResolvers();

  t.after(() => recoveryAck.resolve());
  recovery.api.put = async (url, body) => {
    const result = await recoveryPut(url, body);

    if (url === '/api/chat/store/chat/window') {
      recoveryEntered.resolve();
      await recoveryAck.promise;
    }

    return result;
  };

  const opening = world.open(recovery);

  await recoveryEntered.promise;
  assert.equal(localStorage.getItem(SNAPSHOT_KEY), originalSnapshot);
  recoveryAck.resolve();

  const second = await opening;

  await waitFor(() => second.calls.some((call) => call.method === 'PUT'
    && call.url === '/api/chat/store/chat/window' && call.done), { what: 'recovery ACK' });
  await drain();

  const saved = await readChat(world, records[0]);

  assert.deepEqual(saved.messages.slice(0, 101), before.messages);
  assert.equal(saved.messages.filter((message) => message.pid === 'snapshot-page-answer').length, 1);
  assert.deepEqual(saved.messages.at(-1).steps, [{ k: 'text', text: 'Единственная новая лента' }]);
  assert.equal(saved.draft, 'Текст из страховки');
  assert.equal(second.calls.some((call) => call.method === 'GET' && /store\/chat\//.test(call.url)), false);
  await waitFor(() => localStorage.getItem(SNAPSHOT_KEY) !== originalSnapshot, {
    what: 'страховка удалена только после завершённого recovery ACK',
  });
});

test('PAGE-ROLLBACK: новый route404 сохраняет данные и не вызывает legacy PUT', async (t) => {
  const world = await serverWorld(t, chats(1));
  const network = windowApi(world.app);
  const put = network.api.put;

  network.api.put = (url, body) => url === '/api/chat/store/chat/window'
    ? Promise.reject(Object.assign(new Error('Сервер старее окна'), { status: 404 })) : put(url, body);

  const view = await world.open(network);
  const id = 'web-page-0';

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);
  view.chat.session(id).draft = 'Сохранять при отказе';
  view.chat._persist(true);
  await drain();
  assert.ok(localStorage.getItem(SNAPSHOT_KEY).includes('Сохранять при отказе'));
  assert.equal(network.calls.some((call) => call.method === 'PUT'
    && call.url === '/api/chat/store/chat'), false);
});

test('PAGE-WINDOW-CONFLICT: два409 оставляют draft/outbox и прекращают автоматический PUT', async (t) => {
  const world = await serverWorld(t, chats(1));
  const network = windowApi(world.app);
  const put = network.api.put;
  let attempts = 0;

  network.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window') {
      attempts += 1;

      throw Object.assign(new Error('Конфликт окна'), {
        status: 409, data: { error: 'chat_window_changed' },
      });
    }

    return put(url, body);
  };

  const view = await world.open(network);
  const id = 'web-page-0';

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const session = view.chat.session(id);

  session.draft = 'Не терять';
  session.messages.push({

    role: 'user',
    text: 'В очереди',
    turnId: 'conflict-turn',
    delivery: 'sending',

    outbox: { seed: 'сохранить' },
    steps: [{ k: 'text', text: 'локальные шаги' }],

  });
  await assert.rejects(view.chat._writeChat(id));
  assert.equal(attempts, 2);
  assert.equal(session.draft, 'Не терять');
  assert.equal(session.messages.filter((message) => message.turnId === 'conflict-turn').length, 1);
  assert.deepEqual(session.messages.at(-1).outbox, { seed: 'сохранить' });
  assert.deepEqual(session.messages.at(-1).steps, [{ k: 'text', text: 'локальные шаги' }]);
  assert.ok(view.chat.messageLoads[id].error || view.chat.saveError);
});

test('PAGE-SEND: первый suffix достаточен для одного server-owned хода', { timeout: 10000 }, async (t) => {
  const control = controlledExecutor();
  const records = chats(1);
  const world = await serverWorld(t, records, { executor: control.executor });
  const view = await world.open();
  const id = records[0].id;

  t.after(() => control.runs.forEach((run) => run.release('cleanup')));
  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const original = await readChat(world, records[0]);
  const send = view.chat.send(id, 'Проверка порционной отправки');
  const [run] = await control.waitForRuns(1);

  run.release('Порционный ответ');
  await send;
  await waitFor(() => world.events.some((entry) => entry.event === 'chat-done'), { what: 'итог хода' });
  await view.chat._collectPending();
  await view.chat._writeChat(id);

  const saved = await readChat(world, records[0]);
  const sent = saved.messages.filter((message) => message.role === 'user'
    && message.text === 'Проверка порционной отправки');

  assert.equal(control.runs.length, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].turnId);
  assert.deepEqual(saved.messages.slice(0, 101), original.messages);
  assert.equal(view.calls.some((call) => call.method === 'GET'
    && call.url === `/api/chat/store/chat/${id}`), false);
});

test('PAGE-LATE: dispose отменяет older и игнорирует поздний ответ', { timeout: 10000 }, async (t) => {
  const world = await serverWorld(t, chats(1));
  const network = windowApi(world.app);
  const get = network.api.get;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let signal;

  t.after(() => gate.resolve());
  network.api.get = async (url, options) => {
    const result = await get(url);

    if (url.includes('before=')) {
      signal = options?.signal;
      entered.resolve();
      await gate.promise;
    }

    return result;
  };

  const view = await world.open(network);
  const id = 'web-page-0';

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const session = view.chat.session(id);
  const original = [...session.messages];
  const job = view.chat.loadOlderMessages(id).catch(() => {});

  await entered.promise;
  view.chat.loaded = false;
  view.chat.$dispose();
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);

  const count = network.calls.length;

  gate.resolve();
  await job;
  await drain();
  assert.deepEqual(session.messages, original);
  assert.equal(network.calls.length, count);
});

test('PAGE-WINDOW-REBASE: настоящий409 меняет базу и сохраняет все данные', { timeout: 10000 }, async (t) => {
  const records = chats(1);
  const world = await serverWorld(t, records);
  const network = windowApi(world.app);
  const put = network.api.put;
  const sentBases = [];
  let alter = true;

  network.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window') {
      sentBases.push(structuredClone(body.window));

      if (alter) {
        alter = false;

        const current = await readChat(world, records[0]);

        current.messages[0].text = 'Серверный prefix изменён';
        await writeChat(world, current);
      }
    }

    return put(url, body);
  };

  const view = await world.open(network);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const id = records[0].id;

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);
  await view.chat.loadOlderMessages(id);

  const session = view.chat.session(id);

  session.draft = 'Черновик при конфликте';
  session.messages.push({

    role: 'user',
    text: 'Локальный запрос',
    turnId: 'real-rebase-turn',
    delivery: 'sending',

    outbox: { seed: 'Выжимка' },
    steps: [{ k: 'text', text: 'Новые локальные шаги' }],

  });

  const before = view.calls.length;

  await view.chat._writeChat(id);

  const saved = await readChat(world, records[0]);

  assert.equal(sentBases.length, 2);
  assert.notEqual(sentBases[0].prefixHash, sentBases[1].prefixHash);
  assert.equal(saved.messages[0].text, 'Серверный prefix изменён');
  assert.deepEqual(saved.messages.slice(1, 101), records[0].messages.slice(1));
  assert.equal(saved.messages.filter((message) => message.turnId === 'real-rebase-turn').length, 1);
  assert.deepEqual(saved.messages.at(-1).outbox, { seed: 'Выжимка' });
  assert.deepEqual(saved.messages.at(-1).steps, [{ k: 'text', text: 'Новые локальные шаги' }]);
  assert.equal(saved.draft, 'Черновик при конфликте');

  const reads = view.calls.slice(before).filter((call) => call.method === 'GET'
    && call.url.includes('/store/chat/'));

  assert.ok(reads.length >= 1 && reads.length <= 3);
  assert.ok(reads.every((call) => call.url.includes('window=1')));
});

test('PAGE-REOPEN: hidden append читается одним свежим окном после выбора', async (t) => {
  const records = chats(1);
  const world = await serverWorld(t, records);
  const view = await world.open();
  const id = records[0].id;

  view.chat.selectChat(id);

  const surface = view.chat.registerSurface('reopen', { chatId: id, visible: true });

  t.after(() => surface.dispose());
  await view.chat.ensureChatMessages(id);
  surface.update({ chatId: id, visible: false });

  const current = await readChat(world, records[0]);

  current.messages.push({
    role: 'assistant',
    text: 'Ответ в скрытом чате',
    pid: 'hidden-reply'
  });
  await writeChat(world, current);

  const head = (await jsonRequest(world.app, 'GET', `/api/chat/store/head/${id}`)).head;
  const before = view.calls.length;

  await view.chat._pullChat(id, false, head);
  assert.equal(view.calls.slice(before).some((call) => call.url.includes('/store/chat/')), false);
  view.chat.selectChat(id);
  surface.update({ chatId: id, visible: true });
  await view.chat.ensureChatMessages(id, { jumpToLatest: true });
  assert.equal(view.chat.session(id).messages.at(-1).pid, 'hidden-reply');
  assert.equal(view.calls.slice(before).filter((call) => call.method === 'GET'
    && call.url.includes('/store/chat/')).length, 1);
});

test('PAGE-GAP: 80 новых записей не склеиваются с устаревшими40', async (t) => {
  const records = chats(1);
  const world = await serverWorld(t, records);
  const view = await world.open();
  const id = records[0].id;

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const current = await readChat(world, records[0]);

  for (let index = 101; index < 181; index += 1) {
    current.messages.push({
      role: 'assistant',
      text: `Новая ${index}`,
      pid: `gap-${index}`
    });
  }

  await writeChat(world, current);

  const head = (await jsonRequest(world.app, 'GET', `/api/chat/store/head/${id}`)).head;

  await view.chat._pullChat(id, false, head);

  const before = view.calls.length;

  view.chat.selectChat(id);

  const surface = view.chat.registerSurface('gap-reopen', { chatId: id, visible: true });

  t.after(() => surface.dispose());
  await view.chat.ensureChatMessages(id, { jumpToLatest: true });

  const session = view.chat.session(id);

  assert.deepEqual(session.messages, current.messages.slice(141));
  assert.equal(session.messages.length, session.historyWindow.end - session.historyWindow.offset);
  assert.equal(view.calls.slice(before).filter((call) => call.url.includes('before=')).length, 0);
  await view.chat.loadOlderMessages(id);
  assert.deepEqual(session.messages, current.messages.slice(101));
  session.draft = 'Сохранить после разрыва';
  await view.chat._writeChat(id);

  const saved = await readChat(world, records[0]);

  assert.deepEqual(saved.messages, current.messages);
  assert.equal(saved.draft, 'Сохранить после разрыва');
});

test('PAGE-REMOTE-SCOPE: head переносит тот же загруженный скрытый объект', async (t) => {
  const records = chats(2);
  const world = await serverWorld(t, records);
  const view = await world.open();

  await view.chat.ensureChatPage('', true);

  const id = records[0].id;

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const session = view.chat.session(id);
  const messages = session.messages;

  await jsonRequest(world.app, 'PATCH', `/api/chat/store/chat/${id}`, { patch: { archived: true } });

  const head = (await jsonRequest(world.app, 'GET', `/api/chat/store/head/${id}`)).head;
  const before = view.calls.length;

  await view.chat._pullChat(id, true, head);
  assert.equal(view.chat.session(id), session);
  assert.equal(session.messages, messages);
  assert.equal(view.chat.isArchived(id), true);
  assert.equal(view.chat.list('', true).filter((row) => row.id === id).length, 1);
  assert.equal(view.chat.list('').some((row) => row.id === id), false);
  assert.equal(view.calls.slice(before).some((call) => call.url.includes('/store/chat/')), false);
});

test('PAGE-ARCHIVE-LAST-LOADED: 40 из95 не создают новый пустой диалог', async (t) => {
  const records = chats();
  const world = await serverWorld(t, records);
  const view = await world.open();

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const cursor = view.chat.pageFor('', false).nextCursor;

  for (const record of records.slice(0, 40)) {
    view.chat.deleteChat(record.id);
    await view.chat._writeChat(record.id);
  }

  assert.equal(view.chat.sessions.some((session) => (
    !records.some((record) => record.id === session.id)
  )), false);

  const summary = await jsonRequest(world.app, 'POST', '/api/chat/store/changes', {
    known: {},
    onlyKnown: true,
  });

  assert.equal(summary.summary.active, 55);
  assert.equal(view.chat.pageFor('', false).nextCursor, cursor);
  await view.chat.loadChatPage('', false);
  assert.equal(view.chat.list('').length, 40);
});

test('PAGE-SUMMARY-ACK: старый ответ не возвращает unread после подтверждения', {
  timeout: 10000,
}, async (t) => {
  const records = chats();

  records[0].unread = true;
  records[94].unread = true;

  const world = await serverWorld(t, records);
  const network = windowApi(world.app);
  const post = network.api.post;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let hold = false;

  t.after(() => gate.resolve());
  network.api.post = async (url, body, options) => {
    const data = await post(url, body, options);

    if (url === '/api/chat/store/changes' && hold) {
      hold = false;
      entered.resolve();
      await gate.promise;
    }

    return data;
  };

  const view = await world.open(network);

  hold = true;

  const stale = view.chat._resyncStore();

  await entered.promise;
  assert.equal(view.chat.unreadCount, 2);

  const id = records[0].id;

  view.chat.selectChat(id);
  await view.chat.ensureChatMessages(id);

  const surface = view.chat.registerSurface('read-summary', { chatId: id, visible: true });

  t.after(() => surface.dispose());
  view.chat.markRead(id);
  assert.equal(view.chat.unreadCount, 1);
  await view.chat._writeChat(id);
  assert.equal(view.chat.unreadCount, 1);
  await waitFor(() => view.chat.catalogSummary.unread === 1, { what: 'свежая база ДО старого ответа' });
  assert.equal(view.chat.unreadCount, 1);
  gate.resolve();
  await stale;
  await drain();
  assert.equal(view.chat.catalogSummary.unread, 1);
  assert.equal(view.chat.unreadCount, 1);

  const authoritative = await jsonRequest(world.app, 'POST', '/api/chat/store/changes', {
    known: {}, onlyKnown: true,
  });

  assert.equal(authoritative.summary.unread, 1);
  assert.equal(view.chat.catalogSummary.unread, 1);
  assert.equal(view.chat.list('').some((row) => row.id === records[94].id), false);
});

test('PAGE-OVERLAP-NEW-HISTORY: clear не смешивает старые сообщения с новой лентой', async (t) => {
  const records = chats(1);
  const world = await serverWorld(t, records);
  const view = await world.open();
  const id = records[0].id;

  view.chat.selectChat(id);

  const surface = view.chat.registerSurface('overlap-new-history', { chatId: id, visible: true });

  t.after(() => surface.dispose());
  await view.chat.ensureChatMessages(id);
  await view.chat.loadOlderMessages(id);
  view.chat.setChatViewport(id, false);

  const oldWindow = [...view.chat.session(id).messages];
  const latest = await jsonRequest(world.app, 'GET', `/api/chat/store/chat/${id}`);

  await jsonRequest(world.app, 'PUT', '/api/chat/store/chat', {
    chat: { ...latest.chat, messages: [] }, archived: false,
  });

  const cleared = await readChat(world, records[0]);
  const newMessages = Array.from({
    length: 120
  }, (_, index) => ({

    role: 'assistant',
    text: `Новая история ${index}`,
    pid: `new-history-${index}`,

    steps: [{ k: 'text', text: `Новые шаги ${index}` }],

  }));

  await jsonRequest(world.app, 'PUT', '/api/chat/store/chat', {
    chat: { ...cleared, messages: newMessages }, archived: false,
  });

  const head = (await jsonRequest(world.app, 'GET', `/api/chat/store/head/${id}`)).head;
  const beforeRefresh = view.calls.length;

  await view.chat._pullChat(id, false, head);
  assert.deepEqual(view.chat.session(id).messages, oldWindow);
  assert.equal(view.chat.hasNewerMessages(id), true);
  await view.chat.showLatestMessages(id);
  assert.deepEqual(view.chat.session(id).messages, newMessages.slice(80));
  await view.chat.loadOlderMessages(id);
  assert.deepEqual(view.chat.session(id).messages, newMessages.slice(40));
  view.chat.session(id).draft = 'Черновик новой истории';
  await view.chat._writeChat(id);

  const saved = await readChat(world, records[0]);

  assert.deepEqual(saved.messages, newMessages);
  assert.equal(saved.draft, 'Черновик новой истории');
  assert.equal(view.calls.slice(beforeRefresh).some((call) => call.method === 'GET'
    && call.url === `/api/chat/store/chat/${id}`), false);
});

test('PAGE-SEARCH-CACHE: девятый scope вытесняет старый, возврат читает новую порцию', async (t) => {
  const world = await serverWorld(t, chats());
  const view = await world.open();

  for (let index = 0; index < 9; index += 1) {
    await view.chat.searchChats(`query-${index}`);
  }

  const queries = Object.keys(view.chat.catalogPages).filter((key) => JSON.parse(key)[1]);

  assert.equal(queries.length, 8);
  assert.equal(queries.some((key) => JSON.parse(key)[1] === 'query-0'), false);

  const before = view.calls.length;

  await view.chat.searchChats('query-0');
  assert.equal(view.calls.slice(before).filter((call) => call.url.includes('q=query-0')).length, 1);
});

test('PAGE-META: reconnect обновляет папки и сохраняет местный выбор', async (t) => {
  const world = await serverWorld(t, chats());
  const view = await world.open();
  const remote = { kind: 'path', path: '/synthetic/remote' };
  const local = { kind: 'path', path: '/synthetic/local' };

  await jsonRequest(world.app, 'PUT', '/api/chat/store/meta', {
    defWorkdir: remote,
    recentWorkdirs: [remote],
  });
  await view.chat._resyncStore();
  assert.deepEqual(view.chat.defWorkdir, remote);
  assert.deepEqual(view.chat.recentWorkdirs, [remote]);
  view.chat.defWorkdir = local;
  await view.chat._resyncStore();
  assert.deepEqual(view.chat.defWorkdir, local);
});
