// Неотправленные вложения — часть черновика чата. Раньше список жил в компоненте чата,
// а тот пересоздаётся при каждом переключении: картинка, приложенная и не отправленная,
// пропадала после ухода в другой чат и возвращения. Теперь вложения лежат в сторе рядом
// с текстом черновика и вместе с ним уезжают на сервер.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';

const SHOT = {
  file: '1-shot.png',
  name: 'shot.png',
  url: '/api/chat/attachment/1-shot.png',
  mime: 'image/png',
};

function chatOf(id, extra = {}) {
  return {
    id,
    title: `Чат ${id}`,
    messages: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

/**
 * Сервер, который сразу подтверждает запись и запоминает, что ему прислали.
 * Тело копируется: стор мог бы поменять объект уже после отправки.
 */
function recordingServer() {
  const writes = [];

  apiHarness.put = async (url, body) => {
    writes.push({
      url,
      body: JSON.parse(JSON.stringify(body)),
    });

    return {
      ok: true,
      written: true,
      revision: writes.length + 1,
    };
  };

  return writes;
}

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

test('вложение черновика дописывается в свой чат и уезжает на сервер без пути с диска', async () => {
  const chat = await chatStoreFixture({ sessions: [chatOf('a'), chatOf('b')] });
  const writes = recordingServer();

  chat.addDraftAttachment('a', { ...SHOT, path: '/srv/chats/attachments/1-shot.png' });
  chat._persist(true);
  await tick();
  await tick();

  assert.deepEqual(chat.sessions[0].draftAttachments, [SHOT]);
  assert.deepEqual(chat.sessions[1].draftAttachments || [], [], 'соседний чат не задет');

  const sent = writes.filter((write) => write.body.chat?.id === 'a').at(-1);

  assert.deepEqual(sent.body.chat.draftAttachments, [SHOT], 'на сервер — ссылка, без path');
});

test('загрузка, закончившаяся после переключения, попадает в чат, где её начали', async () => {
  const chat = await chatStoreFixture({ sessions: [chatOf('a'), chatOf('b')], activeId: 'b' });

  chat.addDraftAttachment('a', SHOT);

  assert.deepEqual(chat._find('a').draftAttachments, [SHOT]);
  assert.deepEqual(chat._find('b').draftAttachments || [], []);
});

test('очищенные вложения пропадают из записи чата', async () => {
  const chat = await chatStoreFixture({ sessions: [chatOf('a', { draftAttachments: [SHOT] })] });
  const writes = recordingServer();

  chat.setDraftAttachments('a', []);
  chat._persist(true);
  await tick();
  await tick();

  const sent = writes.filter((write) => write.body.chat?.id === 'a').at(-1);

  assert.equal(sent.body.chat.draftAttachments, undefined);
});

test('загруженный чат получает только корректные вложения черновика', async () => {
  const chat = await chatStoreFixture();
  const record = chatOf('a', {
    draftAttachments: [{ ...SHOT, path: '/srv/x.png' }, null, { name: 'без файла' }, { file: 7 }],
  });

  chat._normalize([record]);

  assert.deepEqual(record.draftAttachments, [SHOT]);
});

test('чат с одними вложениями считается черновиком в списке и при закрытии вкладки', async () => {
  const chat = await chatStoreFixture({
    sessions: [chatOf('a', { draftAttachments: [SHOT] }), chatOf('b')],
  });

  const row = chat.list('').find((item) => item.id === 'a');

  assert.equal(row.draft, true);
  assert.match(row.snippet, /shot\.png/);

  chat.closeSession('a');

  assert.deepEqual(chat.archived.map((item) => item.id), ['a'], 'вкладка ушла в архив, а не пропала');
});
