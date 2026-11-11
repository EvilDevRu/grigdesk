// Удалённый чат не воскресает при синхронизации нескольких устройств:
// страховочная копия телефона пережидала удаление в localStorage и следующим
// открытием возвращала разговор на сервер. Регресс закрывает оба пути: живое
// событие gone и пробуждение устройства, которое удаления не видело совсем.
import assert from 'node:assert/strict';
import test from 'node:test';

import { sampleChat } from '../server/helpers/chat-list.js';
import { waitFor } from '../server/helpers/chat-turns.js';
import { windowApi, serverWorld } from './helpers/chat-lazy.js';
import { drain, SNAPSHOT_KEY } from './helpers/chat-load.js';

/**
 * Окно телефона открывает ленту чата и записывает настоящую страховку стора:
 * копия с historyWindow в общем localStorage — ровно то, что раньше воскрешало
 * удалённый разговор при следующей загрузке.
 */
async function phoneWithSnapshot(world, id) {
  const phone = await world.open();

  phone.chat.selectChat(id);
  await phone.chat.ensureChatMessages(id);
  phone.chat._persist(true);
  await drain();
  assert.ok(snapshotHas(id), 'страховка чата записана до удаления');

  return phone;
}

/**
 * Проверяет именно запись чата в снимке: поле activeId в том же JSON осталось бы
 * от выбранной вкладки, и поиск подстроки по всему файлу ложно совпадал бы с ним.
 */
function snapshotHas(id) {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');

    return [...(parsed?.sessions || []), ...(parsed?.archived || [])]
      .some((entry) => entry.id === id);
  } catch {
    return false;
  }
}

function hasChat(chat, id) {
  return chat.sessions.some((entry) => entry.id === id)
    || (chat.archived || []).some((entry) => entry.id === id);
}

test('GONE-CLEANUP: чужое удаление стирает чат вместе со страховочной копией', async (t) => {
  const original = sampleChat('deleted-gone');
  const world = await serverWorld(t, [original]);
  const phone = await phoneWithSnapshot(world, original.id);

  // Настоящий DELETE настоящего модуля чата; телефону событие приходит как чужое.
  const desktop = windowApi(world.app);

  await desktop.api.del(`/api/chat/store/chat/${original.id}?origin=desktop`);
  phone.sse('chat-store', {
    id: original.id,
    gone: true,
    origin: 'desktop',
    at: Date.now(),
  });
  await drain();

  assert.ok(!hasChat(phone.chat, original.id), 'чата больше нет в списке');
  assert.ok(!snapshotHas(original.id),
    'страховка удалённого чата стёрта из localStorage');
  assert.equal(phone.chat.snapshotRecovery[original.id], undefined,
    'очередь восстановления не держит удалённый чат');
});

test('RESURRECT-BLOCK: страховка спящего телефона не воскрешает удалённый чат', async (t) => {
  const original = sampleChat('deleted-restore');
  const world = await serverWorld(t, [original]);
  const first = await phoneWithSnapshot(world, original.id);

  // Телефон закрылся до удаления: события gone он не видел и не увидит.
  first.chat.loaded = false;
  first.chat.$dispose();

  const desktop = windowApi(world.app);

  await desktop.api.del(`/api/chat/store/chat/${original.id}?origin=desktop`);

  // Телефон просыпается: страховка ещё держит чат, которого на сервере уже нет.
  const second = await world.open();

  // Восстановление ходит в реальный файловый стор сервера, поэтому ждём устойчивое
  // состояние списка, а не фиксированное число тиков очереди.
  await waitFor(() => !hasChat(second.chat, original.id), {
    what: 'отказ восстановления убирает удалённый чат из списка',
  });
  await drain();

  assert.ok(!snapshotHas(original.id),
    'отказ восстановления стёр страховку, а не запланировал повтор');
  assert.equal(second.chat.snapshotRecovery[original.id], undefined,
    'очередь восстановления не держит удалённый чат');

  // Попытка восстановления дошла до сервера и была отвергнута именно памяткой.
  const attempt = second.calls.find((call) => call.method === 'PUT'
    && call.url.includes('/api/chat/store/chat/window'));

  assert.ok(attempt, 'восстановление действительно отправило PUT');
  assert.equal(attempt.response.error, 'chat_deleted');

  // Серверная проверка: файл не воссоздан восстановлением.
  const list = await world.app.inject({
    method: 'GET',
    url: '/api/chat/store/list?page=1&archived=0&limit=40',
  });
  const body = list.json();

  assert.ok(![...(body.sessions || []), ...(body.archived || [])]
    .some((head) => head.id === original.id), 'на сервере чат не воскрес');
});
