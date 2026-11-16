import assert from 'node:assert/strict';
import test from 'node:test';

import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';
import { ensureMessages, serverWorld } from './helpers/chat-lazy.js';
import { chatNotifications } from './helpers/chat-store.js';

for (const historyLoaded of [false, true]) {
  for (const stepReuse of [false, true]) {
    test(`UNREAD-SYNC: три устройства, history=${historyLoaded}, refs=${stepReuse}`, async (t) => {
      const original = sampleChat('cross-device-read', { unread: true });
      const world = await serverWorld(t, [original]);
      const desktop = await world.open();
      const phone = await world.open();
      const tablet = await world.open();

      await ensureMessages(desktop.chat, original.id);

      for (const view of [phone, tablet]) {
        view.chat.historyStepReuseProtocol = Number(stepReuse);

        if (historyLoaded) {
          await ensureMessages(view.chat, original.id);
          view.chat._find(original.id).draft = 'Черновик другого устройства';
        } else {
          view.chat._find(original.id).title = 'Название другого устройства';
        }
      }

      desktop.chat._visible = () => true;
      desktop.chat.markRead(original.id);
      await desktop.chat._writeChat(original.id);
      assert.equal((await readChat(world, original)).unread, false);

      for (const view of [phone, tablet]) {
        if (!historyLoaded) {
          const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

          await view.chat._pullChat(original.id, false, head);
        }

        await view.chat._writeChat(original.id);

        const saved = await readChat(world, original);

        assert.equal(saved.unread, false, 'соседняя правка не возвращает непрочитанность');
        assert.equal(view.chat._find(original.id).unread, false);
        assert.equal(saved.messages.length, original.messages.length);
        assert.equal(historyLoaded ? saved.draft : saved.title,
          historyLoaded ? 'Черновик другого устройства' : 'Название другого устройства');
      }

      const reopened = await world.open();

      assert.equal(reopened.chat._find(original.id).unread, false);
      assert.equal(chatNotifications().length, 0, 'старый ответ не создаёт оповещений');
    });
  }
}

for (const stepReuse of [false, true]) {
  test(`UNREAD-NEW: старое прочтение не скрывает новый ответ, refs=${stepReuse}`, async (t) => {
    const original = sampleChat('new-remote-reply', { unread: true });
    const world = await serverWorld(t, [original]);
    const desktop = await world.open();

    await ensureMessages(desktop.chat, original.id);
    desktop.chat.historyStepReuseProtocol = Number(stepReuse);
    desktop.chat._visible = () => true;
    desktop.chat.markRead(original.id);

    const fresh = {
      role: 'assistant',
      pid: 'new-remote-final',
      text: 'Новый ответ после прочтения',
    };
    const before = await readChat(world, original);

    await writeChat(world, {
      ...before,
      revision: before.revision + 1,
      messages: [...before.messages, fresh],
      unread: true,
    });
    await desktop.chat._writeChat(original.id);

    const saved = await readChat(world, original);

    assert.equal(saved.unread, true, 'новый ответ ещё не прочитан');
    assert.equal(desktop.chat._find(original.id).unread, true);
    assert.equal(saved.messages.filter((message) => message.pid === fresh.pid).length, 1);
  });

  test(`UNREAD-READ: прочтение того же ответа переживает чужой rename, refs=${stepReuse}`, async (t) => {
    const original = sampleChat('same-reply-read', { unread: true });
    const world = await serverWorld(t, [original]);
    const desktop = await world.open();

    await ensureMessages(desktop.chat, original.id);
    desktop.chat.historyStepReuseProtocol = Number(stepReuse);
    desktop.chat._visible = () => true;
    desktop.chat.markRead(original.id);

    const before = await readChat(world, original);

    await writeChat(world, {
      ...before,
      revision: before.revision + 1,
      title: 'Переименован в другом окне',
    });
    await desktop.chat._writeChat(original.id);
    assert.equal((await readChat(world, original)).unread, false);
  });

  test(`UNREAD-LOCAL: новый локальный итог остаётся непрочитанным, refs=${stepReuse}`, async (t) => {
    const original = sampleChat('new-local-reply', { unread: false });
    const world = await serverWorld(t, [original]);
    const desktop = await world.open();

    await ensureMessages(desktop.chat, original.id);
    desktop.chat.historyStepReuseProtocol = Number(stepReuse);
    desktop.chat._visible = () => false;

    const before = await readChat(world, original);

    await writeChat(world, {
      ...before,
      revision: before.revision + 1,
      title: 'Переименован в другом окне',
    });
    desktop.chat._applyPending(desktop.chat._find(original.id), {
      id: 'new-local-final',
      chatKey: original.id,
      role: 'assistant',
      reply: 'Новый локальный ответ',
      at: original.updatedAt + 1000,
    });
    await desktop.chat._writeChat(original.id);

    const saved = await readChat(world, original);

    assert.equal(saved.unread, true);
    assert.equal(saved.messages.filter((message) => message.pid === 'new-local-final').length, 1);
    assert.equal(chatNotifications().length, 1);
  });
}

test('UNREAD-LATE: поздняя шапка не отменяет подтверждённое прочтение', async (t) => {
  const original = sampleChat('late-head-read', { unread: true });
  const world = await serverWorld(t, [original]);
  const desktop = await world.open();
  const { head: oldHead } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  desktop.chat._visible = () => true;
  desktop.chat.markRead(original.id);
  await desktop.chat._writeChat(original.id);
  desktop.chat._applyChatHead(oldHead);
  assert.equal(desktop.chat._find(original.id).unread, false);
});

test('UNREAD-FLIP: молчаливый чужой flip гасится корректирующей записью', async (t) => {
  const original = sampleChat('silent-unread-flip', { unread: false });
  const world = await serverWorld(t, [original]);
  const desktop = await world.open();

  await ensureMessages(desktop.chat, original.id);
  desktop.chat._visible = () => true;
  desktop.chat.markRead(original.id);
  await desktop.chat._writeChat(original.id);
  assert.equal((await readChat(world, original)).unread, false);

  // Чужая запись (материализация pending, PATCH третьего окна) меняет метку молча,
  // не меняя ленту: отпечаток «уже отправлено» у этого окна остаётся прежним.
  const before = await readChat(world, original);

  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    unread: true,
  });

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  desktop.chat._applyChatHead(head);
  // Загруженная лента применяет чужую шапку тем же правилом, что и лёгкая: при том же
  // ответе местное прочтение не превращается обратно в «не прочитано».
  assert.equal(desktop.chat._find(original.id).unread, false);

  await desktop.chat._writeChat(original.id);

  assert.equal((await readChat(world, original)).unread, false,
    'расхождение с подтверждённой шапкой доезжает до сервера');
});

test('UNREAD-REMOTE-READ: прочитанный на другом устройстве ответ не возвращает точку', async (t) => {
  const original = sampleChat('remote-read-reply', { unread: true });
  const world = await serverWorld(t, [original]);
  const desktop = await world.open();
  const tablet = await world.open();

  await ensureMessages(desktop.chat, original.id);
  desktop.chat._visible = () => true;
  desktop.chat.markRead(original.id);
  await desktop.chat._writeChat(original.id);
  assert.equal((await readChat(world, original)).unread, false);

  // Новый ответ пришёл и был прочитан на десктопе, пока планшет был не в сети:
  // серверная шапка уже говорит unread:false.
  const fresh = {
    role: 'assistant',
    pid: 'remote-read-final',
    text: 'Ответ, прочитанный на другом устройстве',
  };
  const before = await readChat(world, original);

  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    messages: [...before.messages, fresh],
    unread: false,
  });

  // Планшет возвращается к связи и получает шапку с ответом, который для него новый.
  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  await tablet.chat._pullChat(original.id, false, head);

  assert.equal(tablet.chat._find(original.id).unread, false,
    'шапка не поднимает точку у чата, не открытого в этом окне');

  await tablet.chat._writeChat(original.id);

  assert.equal((await readChat(world, original)).unread, false,
    'запись планшета не возвращает точку на сервер');
});

test('DIRTY-FULL-UNREAD: чужой новый финал в dirty полной ленте сохраняет server unread', async (t) => {
  const original = sampleChat('review-dirty-full-unread', { unread: false });
  const world = await serverWorld(t, [original]);
  const { chat } = await world.open();

  chat.pagingEnabled = false;
  chat._visible = () => false;
  await ensureMessages(chat, original.id);

  const live = chat._find(original.id);
  const before = await readChat(world, original);

  live.draft = 'Местный несохранённый черновик';
  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    unread: true,
    messages: [...before.messages, {
      role: 'assistant',
      text: 'Чужой непрочитанный ответ',
      pid: 'remote-unread-final',
    }],
  });

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  await chat._pullChat(original.id, false, head);
  assert.equal(live.messages.at(-1).pid, 'remote-unread-final');
  await chat._writeChat(original.id);
  assert.equal((await readChat(world, original)).unread, true);
  assert.equal(live.draft, 'Местный несохранённый черновик');
});

test('REVIEW-NEW-LOCAL-UNREAD: новый локальный чат не гасит непрочитанный чужой финал', async (t) => {
  const world = await serverWorld(t, [sampleChat('neighbor')]);
  const { chat } = await world.open();

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const id = chat.newSession();

  chat._visible = () => false;
  await chat._writeChat(id);

  const live = chat._find(id);
  const before = (await world.app.inject(`/api/chat/store/chat/${id}`)).json().chat;

  assert.equal(live.historyWindow, undefined);
  live.draft = 'Новый местный черновик';
  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    unread: true,
    messages: [...before.messages, {
      role: 'assistant',
      text: 'Ответ второго клиента',
      pid: 'new-local-remote-final',
    }],
  });

  const { head } = (await world.app.inject(`/api/chat/store/head/${id}`)).json();

  await chat._pullChat(id, false, head);
  await chat._writeChat(id);

  const saved = (await world.app.inject(`/api/chat/store/chat/${id}`)).json().chat;

  assert.equal(saved.unread, true);
  assert.equal(live.draft, 'Новый местный черновик');
});
