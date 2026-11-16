import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonRequest, sampleChat, writeChat } from '../server/helpers/chat-list.js';
import { ensureMessages, serverWorld, windowApi } from './helpers/chat-lazy.js';

/**
 * Удерживает один уже сформированный HTTP-ответ, оставляя сервер доступным другим окнам.
 * Барьер освобождается при завершении теста даже после неудачного утверждения.
 */
function holdResponse(t, api, method, match) {
  const call = api[method];
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let held = false;

  t.after(() => gate.resolve());
  api[method] = async (...args) => {
    const result = await call(...args);

    if (!held && match(...args)) {
      held = true;
      entered.resolve();
      await gate.promise;
    }

    return result;
  };

  return {
    entered: entered.promise,
    release: () => gate.resolve(),
  };
}

for (const mode of ['page', 'resync']) {
  test(`CATALOG-DELETE: поздний ${mode} не возвращает удаление, новый запрос допускает восстановление`,
    async (t) => {
      const original = sampleChat(`catalog-delete-${mode}`);
      const world = await serverWorld(t, [original]);
      const network = windowApi(world.app);
      const { chat } = await world.open(network);
      const held = holdResponse(t, network.api, mode === 'page' ? 'get' : 'post', (url, body) => (
        mode === 'page' ? url.includes('/store/list?') : url === '/api/chat/store/changes' && !!body.top
      ));
      const loading = mode === 'page' ? chat.refreshChatPage() : chat._resyncPagedStore();

      await held.entered;

      const removed = await world.app.inject({
        method: 'DELETE',
        url: `/api/chat/store/chat/${original.id}`,
      });

      assert.equal(removed.statusCode, 200);
      chat._dropRemoteChat(original.id);
      held.release();
      await loading;
      assert.equal(chat._find(original.id), null);
      assert.equal(chat.list('').some((row) => row.id === original.id), false);

      await writeChat(world, {
        ...original,
        revision: original.revision + 2,
        title: 'Восстановлен новым запросом',
      });
      await chat.refreshChatPage();
      assert.equal(chat._find(original.id).title, 'Восстановлен новым запросом');
    });

  test(`CATALOG-EDIT: поздний ${mode} сохраняет новую шапку и членство списка`, async (t) => {
    const original = sampleChat(`catalog-edit-${mode}`);
    const world = await serverWorld(t, [original]);
    const network = windowApi(world.app);
    const { chat } = await world.open(network);
    const held = holdResponse(t, network.api, mode === 'page' ? 'get' : 'post', (url, body) => (
      mode === 'page' ? url.includes('/store/list?') : url === '/api/chat/store/changes' && !!body.top
    ));
    const loading = mode === 'page' ? chat.refreshChatPage() : chat._resyncPagedStore();

    await held.entered;
    await writeChat(world, {
      ...original,
      revision: original.revision + 1,
      title: 'Название из нового события',
    });

    const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

    chat._applyChatHead(head);
    held.release();
    await loading;
    assert.equal(chat._find(original.id).title, 'Название из нового события');
    assert.equal(chat.list('').some((row) => row.id === original.id), true);
  });
}

test('CATALOG-GONE: задержанный gone не удаляет уже восстановленный чат', async (t) => {
  const original = sampleChat('catalog-late-gone');
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);

  await world.app.inject({ method: 'DELETE', url: `/api/chat/store/chat/${original.id}` });

  const held = holdResponse(t, network.api, 'post', (url, body) => (
    url === '/api/chat/store/changes' && !!body.top
  ));
  const loading = chat._resyncPagedStore();

  await held.entered;
  await writeChat(world, {
    ...original,
    revision: original.revision + 1,
    title: 'Восстановлен до ответа',
  });

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  chat._applyChatHead(head);
  held.release();
  await loading;
  assert.equal(chat._find(original.id)?.title, 'Восстановлен до ответа');
});

test('CATALOG-SEARCH: старый reconnect не меняет сниппет нового поиска', async (t) => {
  const original = sampleChat('catalog-search-scope', {
    messages: [
      { role: 'assistant', text: 'alpha первый фрагмент' },
      { role: 'assistant', text: 'beta другой фрагмент' },
    ],
  });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);

  await chat.searchChats('alpha');

  const held = holdResponse(t, network.api, 'post', (url, body) => (
    url === '/api/chat/store/changes' && body.top?.q === 'alpha'
  ));
  const reconnect = chat._resyncPagedStore();

  await held.entered;
  await chat.searchChats('beta');
  assert.match(chat.list('beta')[0].snippet, /beta/);
  held.release();
  await reconnect;
  assert.equal(chat.search.query, 'beta');
  assert.match(chat.list('beta')[0].snippet, /beta/);
});

test('CATALOG-MEMBERSHIP: другой поиск во время continuation не теряет карточку за cursor',
  async (t) => {
    const records = Array.from({ length: 45 }, (_, index) => sampleChat(
      `catalog-member-${String(index).padStart(2, '0')}`,
      { title: index === 44 ? 'Искомая карточка' : 'Обычная карточка' },
    ));
    const world = await serverWorld(t, records);
    const network = windowApi(world.app);
    const { chat } = await world.open(network);
    const held = holdResponse(t, network.api, 'get', (url) => (
      url.includes('/store/list?') && url.includes('cursor=')
    ));
    const loading = chat.loadChatPage();

    await held.entered;
    await chat.searchChats('Искомая');
    assert.equal(chat.list('Искомая').length, 1);
    held.release();
    await loading;
    assert.equal(chat.list('').length, 45);
    assert.equal(chat.pageFor().hasMore, false);
  });

test('CATALOG-REFRESH-DELETE: ожидание ленты не даёт старому top вернуть удалённую карточку',
  async (t) => {
    const original = sampleChat('catalog-refresh-delete');
    const world = await serverWorld(t, [original]);
    const network = windowApi(world.app);
    const { chat } = await world.open(network);

    await ensureMessages(chat, original.id);
    chat._visible = () => true;
    await writeChat(world, {
      ...original,
      revision: original.revision + 1,
      title: 'Изменение перед сверкой',
    });

    const held = holdResponse(t, network.api, 'get', (url) => url.includes('window=1'));
    const loading = chat._resyncPagedStore();

    await held.entered;
    chat._dropRemoteChat(original.id);
    held.release();
    await loading;
    assert.equal(chat._find(original.id), null);
  });

test('отброшенная старая шапка не отменяет summary свежего события', async (t) => {
  const original = sampleChat('review-summary-stale', { unread: true });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const { chat } = await world.open(network);
  const old = await jsonRequest(world.app, 'GET', `/api/chat/store/head/${original.id}`);
  const fresh = await jsonRequest(world.app, 'PATCH', `/api/chat/store/chat/${original.id}`, {
    patch: { unread: false }, origin: 'other-window',
  });
  const post = network.api.post;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();

  t.after(() => gate.resolve());
  network.api.post = async (url, body) => {
    const result = await post(url, body);

    if (url === '/api/chat/store/changes') {
      entered.resolve();
      await gate.promise;
      finished.resolve();
    }

    return result;
  };
  await chat._pullChat(original.id, false, fresh.head);
  await entered.promise;
  await chat._pullChat(original.id, false, old.head);
  gate.resolve();
  await finished.promise;
  await new Promise(setImmediate);
  assert.equal(chat._find(original.id).unread, false);
  assert.equal(chat.unreadCount, 0);
});
