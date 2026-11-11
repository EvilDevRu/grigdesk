import assert from 'node:assert/strict';
import test from 'node:test';

import { sampleChat, readChat } from '../server/helpers/chat-list.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';
import { drain, SNAPSHOT_KEY } from './helpers/chat-load.js';

/**
 * Перезапуск окна восстанавливает настоящую страховку, созданную самим store.
 * Ответ шапки удерживается после ACK, чтобы пользователь успел открыть или изменить чат.
 */
async function recoveryFixture(t, { older = false } = {}) {
  const original = sampleChat('recovery-open');
  const other = sampleChat('recovery-other');

  original.messages = Array.from({ length: 121 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `Сообщение ${index}`,
    pid: `history-${index}`,
    steps: index % 2 ? [{ k: 'text', text: `Шаг ${index}` }] : [],
  }));

  const world = await serverWorld(t, [original, other]);
  const first = await world.open();

  first.chat.selectChat(original.id);
  await first.chat.ensureChatMessages(original.id);

  if (older) {
    await first.chat.loadOlderMessages(original.id);
  }

  const visibleCount = first.chat.session(original.id).messages.length;

  assert.equal(visibleCount, older ? 80 : 40);
  first.chat._persist(true);
  await drain();
  assert.ok(localStorage.getItem(SNAPSHOT_KEY).includes('historyWindow'));
  first.chat.loaded = false;
  first.chat.$dispose();

  const network = windowApi(world.app);
  const get = network.api.get;
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const returned = Promise.withResolvers();
  let held = false;

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const response = await get(url);

    if (!held && url.includes('/store/head/')) {
      held = true;
      entered.resolve();
      await gate.promise;
      returned.resolve();
    }

    return response;
  };

  const second = await world.open(network);

  await entered.promise;

  return {
    ...second,
    world,
    original,
    other,
    visibleCount,
    gate,
    returned,
  };
}

for (const switchAway of [false, true]) {
  test(`SNAPSHOT-OPEN: восстановление сохраняет открытую ленту, уход=${switchAway}`, async (t) => {
    const view = await recoveryFixture(t);
    const { chat, original, other } = view;
    const id = original.id;

    chat.selectChat(id);

    const surface = chat.registerSurface('страница', { chatId: id, visible: true });
    const get = view.api.get;
    const detail = Promise.withResolvers();

    t.after(() => surface.dispose());
    t.after(() => detail.resolve());
    view.api.get = async (url) => {
      if (url.startsWith(`/api/chat/store/chat/${id}`)) {
        await detail.promise;
      }

      return get(url);
    };
    assert.equal(chat.session(id).messages.length, view.visibleCount);

    if (switchAway) {
      chat.selectChat(other.id);
      surface.update({ chatId: other.id, visible: true });
    }

    view.gate.resolve();
    await view.returned.promise;
    await drain();
    assert.equal(chat.session(id).messages.length, view.visibleCount,
      'фоновые ACK и шапка не очищают уже показанную историю');
    assert.equal(chat.isChatMessagesLoaded(id), true);
    chat.selectChat(other.id);
    surface.update({ chatId: other.id, visible: true });
    chat.selectChat(id);
    surface.update({ chatId: id, visible: true });
    assert.equal(chat.session(id).messages.length, view.visibleCount);
    detail.resolve();
    await chat.ensureChatMessages(id);
    assert.equal(chat.session(id).messages.length, view.visibleCount);
    assert.equal(chat.session(id).historyWindow.stale, false);

    while (chat.session(id).historyWindow.hasOlder) {
      await chat.loadOlderMessages(id);
    }

    assert.deepEqual(chat.session(id).messages, original.messages);
    assert.deepEqual((await readChat(view.world, original)).messages, original.messages);
  });
}

test('SNAPSHOT-EDIT: правка во время сверки не становится полной записью пустого чата', async (t) => {
  const view = await recoveryFixture(t);
  const { chat, original } = view;
  const id = original.id;

  chat.session(id).draft = 'Правка во время восстановления';
  view.gate.resolve();
  await view.returned.promise;
  await drain();
  assert.equal(chat.session(id).messages.length, view.visibleCount);
  assert.ok(chat.session(id).historyWindow, 'граница частичного окна остаётся доказательством записи');
  await chat._writeChat(id);

  const saved = await readChat(view.world, original);

  assert.equal(saved.draft, 'Правка во время восстановления');
  assert.equal(saved.messages.length, original.messages.length);
  assert.equal(view.calls.some((call) => call.method === 'PUT'
    && call.url === '/api/chat/store/chat'), false);
});

test('SNAPSHOT-HIDDEN: восстановление скрытой копии не читает ленту', async (t) => {
  const view = await recoveryFixture(t);

  view.gate.resolve();
  await view.returned.promise;
  await drain();
  assert.equal(view.chat.isChatMessagesLoaded(view.original.id), false);
  assert.equal(view.calls.some((call) => call.method === 'GET'
    && call.url.startsWith('/api/chat/store/chat/')), false);
});

test('SNAPSHOT-DISPOSE: поздняя шапка не меняет завершённое окно', async (t) => {
  const view = await recoveryFixture(t);
  const count = view.chat.session(view.original.id).messages.length;

  view.chat.$dispose();
  view.gate.resolve();
  await view.returned.promise;
  await drain();
  assert.equal(view.chat.session(view.original.id).messages.length, count);
});

test('SNAPSHOT-VIEWPORT: сверка сохраняет уже читаемую старую историю', async (t) => {
  const view = await recoveryFixture(t, { older: true });
  const { chat, original } = view;
  const id = original.id;

  chat.selectChat(id);

  const surface = chat.registerSurface('старые сообщения', { chatId: id, visible: true });

  t.after(() => surface.dispose());
  chat.setChatViewport(id, false);
  view.gate.resolve();
  await view.returned.promise;
  await drain();
  await chat.ensureChatMessages(id);
  assert.equal(chat.session(id).messages.length, 80);
  assert.equal(chat.session(id).historyWindow.offset, 41);
  assert.equal(chat.hasNewerMessages(id), true);
  await chat.showLatestMessages(id);
  assert.equal(chat.session(id).messages.length, 40);
  assert.equal(chat.session(id).historyWindow.offset, 81);
  assert.deepEqual(chat.session(id).messages, original.messages.slice(-40));
});

test('SNAPSHOT-REFS: запись скрытой ленты не подтверждает отсутствующие тела старых шагов', async (t) => {
  const view = await recoveryFixture(t);
  const { chat, original } = view;
  const id = original.id;
  const final = {
    role: 'assistant',
    text: 'Новый локальный ответ',
    pid: 'recovery-final',
    steps: [{ k: 'text', text: 'Новый шаг' }],
  };

  chat.session(id).messages.push(final);
  view.gate.resolve();
  await view.returned.promise;
  await drain();
  await chat._writeChat(id);
  chat.session(id).draft = 'Черновик после подтверждения ответа';
  await chat._writeChat(id);
  assert.equal(chat.session(id).historyWindow.stale, true);

  const saved = await readChat(view.world, original);

  assert.deepEqual(saved.messages, [...original.messages, final]);
  chat.selectChat(id);

  const surface = chat.registerSurface('возврат после записи', { chatId: id, visible: true });

  t.after(() => surface.dispose());
  await chat.ensureChatMessages(id);
  assert.equal(chat.session(id).historyWindow.stale, false);
  assert.equal(chat.session(id).windowRefs, undefined);
  assert.deepEqual(chat.session(id).messages, saved.messages.slice(-40));
  assert.equal(chat.session(id).draft, saved.draft);
});
