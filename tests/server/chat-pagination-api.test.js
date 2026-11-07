import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLight, jsonRequest, listFixture, readChat, sampleChat, writeChat,
} from './helpers/chat-list.js';

const list = '/api/chat/store/list?page=1&archived=0&limit=40';

// Синтетические даты задают однозначный порядок без ожидания часов.
// Ленты принадлежат временной папке, реальная переписка не используется.
function catalog(count = 95) {
  return Array.from({ length: count }, (_, index) => sampleChat(`page-${index}`, {
    title: `Чат ${index}`,
    updatedAt: 10000 - index,
  }));
}

test('PAGE-LIST: сервер отдаёт 40, 40, 15 карточек вместо всего каталога', async (t) => {
  const fixture = await listFixture(t, catalog());
  const first = await jsonRequest(fixture.app, 'GET', list);

  assert.equal(first.sessions.length, 40);
  assert.deepEqual(first.archived, []);
  assert.equal(first.listProtocol, 2);
  assertLight(first);
  assert.equal(first.summary.active, 95);

  const ids = first.sessions.map((head) => head.id);
  let cursor = first.page.nextCursor;

  for (let attempt = 0; cursor && attempt < 3; attempt += 1) {
    const next = await jsonRequest(fixture.app, 'GET', `${list}&cursor=${encodeURIComponent(cursor)}`);

    assert.ok(next.sessions.length <= 40);
    assertLight(next);
    ids.push(...next.sessions.map((head) => head.id));
    cursor = next.page.nextCursor;
  }

  assert.equal(cursor, null);
  assert.deepEqual(ids, catalog().map((chat) => chat.id));
  assert.equal(new Set(ids).size, 95);
});

test('PAGE-DELTA: knownOnly не приносит соседние 94 карточки', async (t) => {
  const fixture = await listFixture(t, catalog());
  const head = (await jsonRequest(fixture.app, 'GET', '/api/chat/store/head/page-0')).head;
  const data = await jsonRequest(fixture.app, 'POST', '/api/chat/store/changes', {
    known: { [head.id]: head.version },
    onlyKnown: true,
  });

  assert.deepEqual(data.sessions, []);
  assert.deepEqual(data.archived, []);
  assert.deepEqual(data.gone, []);
  assert.equal(data.summary.active, 95);
});

test('PAGE-SEARCH: q выбирает последнее совпадение вне preview, а не первые 40', async (t) => {
  const records = catalog(120).map((chat) => ({
    ...chat,
    archived: true,
    messages: [{ role: 'assistant', text: 'Обычный ответ' }],
  }));

  records[119].messages[0].text = 'я'.repeat(1500) + ' УНИКАЛЬНЫЙ ХВОСТ';

  const fixture = await listFixture(t, records);
  const result = await jsonRequest(fixture.app, 'GET',
    '/api/chat/store/list?page=1&archived=1&limit=40&q=УНИКАЛЬНЫЙ');

  assert.deepEqual(result.archived.map((head) => head.id), ['page-119']);
  assert.equal(result.sessions.length, 0);
  assert.equal(result.page.hasMore, false);
  assert.equal(result.archived[0].snippetSource, '…' + 'я'.repeat(23) + ' УНИКАЛЬНЫЙ ХВОСТ');
  assert.equal(result.summary.archived, 120);

  const empty = await jsonRequest(fixture.app, 'GET',
    '/api/chat/store/list?page=1&archived=1&limit=40&q=НЕСУЩЕСТВУЕТ');

  assert.deepEqual(empty.archived, []);
  assert.equal(empty.summary.archived, 120);
});

test('PAGE-LIST-RACE: изменившая активность не пропускает id старого snapshot', async (t) => {
  const fixture = await listFixture(t, catalog());
  const first = await jsonRequest(fixture.app, 'GET', list);
  const record = await readChat(fixture, catalog()[70]);

  record.updatedAt = 20000;
  await writeChat(fixture, record);

  const second = await jsonRequest(fixture.app, 'GET',
    `${list}&cursor=${encodeURIComponent(first.page.nextCursor)}`);
  const third = await jsonRequest(fixture.app, 'GET',
    `${list}&cursor=${encodeURIComponent(second.page.nextCursor)}`);
  const ids = [...first.sessions, ...second.sessions, ...third.sessions].map((head) => head.id);

  assert.deepEqual(new Set(ids), new Set(catalog().map((chat) => chat.id)));
  assert.equal(ids.length, 95);
});

test('PAGE-EXPIRED-SERVER: TTL даёт410 без выдачи нового списка', async (t) => {
  let now = Date.now();

  t.mock.method(Date, 'now', () => now);

  const fixture = await listFixture(t, catalog());
  const first = await jsonRequest(fixture.app, 'GET', list);

  now += 600001;

  const response = await fixture.app.inject({
    method: 'GET', url: `${list}&cursor=${encodeURIComponent(first.page.nextCursor)}`,
  });

  assert.equal(response.statusCode, 410);
  assert.equal(response.json().error, 'chat_page_expired');
  assert.equal('sessions' in response.json(), false);
});

test('PAGE-VALIDATION: неверная порция и top-scope возвращают 400', async (t) => {
  const fixture = await listFixture(t, catalog(1));

  for (const suffix of ['&limit=101', '&q=' + 'x'.repeat(257), '&unknown=1']) {
    const response = await fixture.app.inject({ method: 'GET', url: list + suffix });

    assert.equal(response.statusCode, 400);
  }
  for (const top of [{ q: 42 }, { archived: 'yes' }, { unknown: true }, { q: 'x'.repeat(257) }]) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/chat/store/changes',
      payload: {
        known: {},
        onlyKnown: true,
        top,
      },
    });

    assert.equal(response.statusCode, 400);
  }
});
