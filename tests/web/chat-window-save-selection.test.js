import assert from 'node:assert/strict';
import test from 'node:test';

import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';

/**
 * История синтетическая; настоящие store и сервер обмениваются HTTP через inject.
 * Остановка таймеров оставляет все задержки под управлением сценария.
 */
async function selectionFixture(t, id) {
  const original = sampleChat(id, { effort: 'low' });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const view = await world.open(network);

  await view.chat.ensureChatMessages(original.id);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());

  return {
    ...view,
    world,
    original,
    live: view.chat.session(original.id),
    gate,
    entered,
  };
}

test('WINDOW-SELECTION-REBASE: новый effort переживает stale со встречным выбором', async (t) => {
  const view = await selectionFixture(t, 'newer-stale-selection');
  const put = view.api.put;
  let first = true;

  view.api.put = async (url, body) => {
    if (url !== '/api/chat/store/chat/window' || !first) {
      return put(url, body);
    }

    first = false;

    const remote = await readChat(view.world, view.original);

    await writeChat(view.world, {
      ...remote,
      effort: 'medium',
      revision: remote.revision + 1,
    });

    const response = await put(url, body);

    assert.equal(response.stale, true);
    view.entered.resolve();
    await view.gate.promise;

    return response;
  };

  const saving = view.chat._saveChatNow(view.live);
  const rejected = assert.rejects(saving, { code: 'chat_revision_conflict' });

  await view.entered.promise;
  view.chat.setEffort(view.original.id, 'high');
  view.gate.resolve();
  await rejected;

  assert.equal(view.live.effort, 'high', 'поздняя сверка не откатывает новый местный выбор');
  assert.equal((await readChat(view.world, view.original)).effort, 'medium');
  assert.equal(view.chat._dirty(view.live), true);
});

test('WINDOW-SELECTION-ACK: сохранённый новый effort отменяет прежний барьер', async (t) => {
  const view = await selectionFixture(t, 'newer-confirmed-selection');
  const put = view.api.put;
  let first = true;

  view.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window' && first) {
      first = false;

      const remote = await readChat(view.world, view.original);

      await writeChat(view.world, {
        ...remote,
        title: 'Чужое название',
        revision: remote.revision + 1,
      });
    }

    return put(url, body);
  };

  const get = view.api.get;
  let heads = 0;

  view.api.get = async (...args) => {
    const response = await get(...args);

    if (args[0].includes('/store/head/') && ++heads === 2) {
      view.entered.resolve();
      await view.gate.promise;
    }

    return response;
  };

  const saving = view.chat._saveChatNow(view.live);
  const rejected = assert.rejects(saving, { code: 'chat_revision_conflict' });

  await view.entered.promise;
  view.chat.setEffort(view.original.id, 'high');
  await view.chat._writeChat(view.original.id);
  view.gate.resolve();
  await rejected;

  assert.equal(view.live.effort, 'high');
  assert.equal((await readChat(view.world, view.original)).effort, 'high');
});
