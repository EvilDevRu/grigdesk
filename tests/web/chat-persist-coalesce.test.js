// Сохранение истории при медленном сервере. Раньше отпечаток записи попадал в карту
// «уже на сервере» только после ACK: второй `_persist` до ответа слал тот же снимок ещё
// раз, и при задержках PUT-ы одного чата копились в очереди браузера. Теперь запись
// чата идёт по очереди: одинаковый снимок не уходит дважды, а правка, сделанная пока
// летит первый PUT, уезжает следом и не теряется.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';

function slowServer() {
  const writes = [];

  apiHarness.put = (url, body) => new Promise((resolve) => {
    writes.push({
      url,
      body: JSON.parse(JSON.stringify(body)),
      resolve,
    });
  });

  return writes;
}

// Ответ сервера на запись чата: новая ревизия и, если нужно, признак stale.
function ack(revision, extra = {}) {
  return {
    ok: true,
    written: true,
    revision,
    ...extra,
  };
}

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

test('повторное сохранение при задержанном ACK объединяется, а новая правка не теряется', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'slow-chat',
      title: 'Медленный сервер',
      messages: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const writes = slowServer();
  const session = chat.sessions[0];

  session.draft = 'первая правка';
  chat._persist(true);
  chat._persist(true);
  await tick();
  assert.equal(writes.length, 1, 'одинаковый снимок до ACK второй раз не уходит');

  session.draft = 'вторая правка';
  chat._persist(true);
  await tick();
  assert.equal(writes.length, 1, 'новая запись ждёт ответа на предыдущую, а не спорит с ней');

  writes[0].resolve(ack(2));
  await tick();
  await tick();
  assert.equal(writes.length, 2, 'правка, сделанная во время полёта, уехала следом');
  assert.equal(writes[1].body.chat.draft, 'вторая правка');
  assert.equal(writes[1].body.chat.revision, 2, 'и уже с ревизией из первого ACK');

  writes[1].resolve(ack(3));
  await tick();
  chat._persist(true);
  await tick();
  assert.equal(writes.length, 2, 'после ACK лишних PUT нет');
  assert.equal(session.revision, 3);
});

test('барьер перед запуском ждёт летящую запись того же чата, а не посылает конкурирующую', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'barrier-chat',
      messages: [],
      revision: 4,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const writes = slowServer();
  const session = chat.sessions[0];

  session.draft = 'черновик';
  chat._persist(true);
  await tick();
  session.messages.push({ role: 'user', text: 'сообщение' });

  const barrier = chat._saveChatNow(session);

  await tick();
  assert.equal(writes.length, 1, 'барьер встал в очередь за летящим PUT');

  writes[0].resolve(ack(5));
  await tick();
  await tick();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].body.chat.revision, 5, 'CAS-база барьера — ревизия предыдущего ACK');
  assert.equal(writes[1].body.chat.messages.at(-1).text, 'сообщение');
  writes[1].resolve(ack(6, { stale: false }));
  await barrier;
  assert.equal(session.revision, 6);
});
