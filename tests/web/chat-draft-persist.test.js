// Набор текста в чате подвешивал вкладку на сотни миллисекунд ровно на паузе в наборе.
// Виноват был не поллинг: черновик
// сохраняется тем же `_persist`, что и переписка, а тот синхронно сериализовал ВСЮ историю
// — сначала в страховочный снимок localStorage, потом ещё раз по каждому чату ради
// сравнения с уже отправленным. Основной объём большой истории составляли ленты шагов.
//
// Здесь закреплено лечение: снимок идёт без шагов и не пишется ради черновика, а сравнение
// «уехало ли» считается по отпечатку, в котором шаги заменены своим числом.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';

const SNAP_KEY = 'grigdesk-chat-snapshot';

/** localStorage в тестовом Node отсутствует, а снимок пишется именно туда. */
function fakeStorage({ quota = Infinity } = {}) {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > quota) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
  return data;
}

// Тяжёлый чат: одно сообщение с длинной лентой шагов — ровно то, из чего состоит история.
function heavyChat(id, { steps = 200, at = 1000 } = {}) {
  return {
    id,
    taskId: null,
    title: `Чат ${id}`,
    messages: [
      { role: 'user', text: 'Сделай' },
      {
        role: 'assistant',
        text: 'Готово',
        steps: Array.from({ length: steps }, (_, i) => ({
          kind: 'tool', at: i, text: `шаг ${i} `.repeat(40),
        })),
      },
    ],
    sessionId: 's', contextTokens: 10, draft: '', createdAt: at, updatedAt: at,
    sending: false, compacting: false, steps: [],
  };
}

test('CHAT-DRAFT-01: черновик не пишет страховочный снимок, а ответ агента — пишет', async () => {
  const store = fakeStorage();
  const chat = await chatStoreFixture({ sessions: [heavyChat('c1')] });

  chat.setDraft('c1', 'печатаю');
  await new Promise((r) => setTimeout(r, 350)); // дебаунс _persist
  assert.equal(store.get(SNAP_KEY), undefined, 'ради черновика снимок не переписывается');

  const session = chat.sessions[0];
  session.messages.push({ role: 'assistant', text: 'Ответ' });
  session.updatedAt = 2000;
  chat._persist(true);
  assert.ok(store.get(SNAP_KEY), 'изменение переписки снимок обновляет');
});

test('CHAT-DRAFT-02: снимок хранит переписку без лент шагов и влезает в квоту', async () => {
  // Квота ~5 МБ; берём заведомо меньший потолок, чтобы полная версия в него не влезала.
  const store = fakeStorage({ quota: 300_000 });
  const chat = await chatStoreFixture({
    sessions: [heavyChat('c1'), heavyChat('c2', { at: 1100 })],
  });

  chat.sessions[0].messages.push({ role: 'assistant', text: 'Ответ' });
  chat._persist(true);

  const snap = JSON.parse(store.get(SNAP_KEY));
  const messages = snap.sessions.flatMap((s) => s.messages);
  assert.equal(messages.length, 5, 'сама переписка в снимке остаётся вся');
  assert.ok(messages.every((m) => m.steps === undefined), 'лент шагов в снимке нет');
  assert.equal(
    snap.sessions.find((s) => s.id === 'c1').messages.at(-1).text,
    'Ответ',
    'ради чего снимок и нужен — последний ответ на месте',
  );
});

test('CHAT-DRAFT-03: при переполнении квоты остаются последние чаты целиком', async () => {
  // Старые чаты тяжёлые, свежие — короткие: полный снимок в квоту не влезает, урезанный да.
  const old = Array.from({ length: 5 }, (_, i) => {
    const c = heavyChat(`старый-${i}`, { steps: 0, at: 100 + i });
    c.messages.push({ role: 'assistant', text: 'а'.repeat(5000) });
    return c;
  });
  const fresh = Array.from({ length: 20 }, (_, i) => heavyChat(`свежий-${i}`, { steps: 0, at: 9000 + i }));
  const store = fakeStorage({ quota: 20_000 });
  const chat = await chatStoreFixture({ sessions: [...old, ...fresh] });

  chat._persist(true);

  const snap = JSON.parse(store.get(SNAP_KEY));
  assert.equal(snap.sessions.length, 20, 'оставлены последние SNAP_FALLBACK_CHATS чатов');
  assert.ok(snap.sessions.every((s) => s.id.startsWith('свежий')), 'свежее важнее старого');
  assert.deepEqual(snap.archived, [], 'архив в укороченную версию не идёт');
});

test('CHAT-DRAFT-04: сравнение с отправленным не зависит от объёма лент, но ловит переписку', async () => {
  fakeStorage();
  const puts = [];
  const chat = await chatStoreFixture({ sessions: [heavyChat('c1')] });
  apiHarness.put = async (url, body) => { puts.push(body?.chat?.id ?? url); return {}; };

  // Стор совпал с сервером — писать нечего.
  chat._persist(true);
  assert.deepEqual(puts, [], 'без изменений PUT не уходит');

  // Новое сообщение вместе со своей лентой шагов обязано уехать.
  chat.sessions[0].messages.push({ role: 'assistant', text: 'Ответ', steps: [{ kind: 'text', at: 1 }] });
  chat.sessions[0].updatedAt = 3000;
  chat._persist(true);
  assert.deepEqual(puts, ['c1'], 'изменение переписки уезжает на сервер');
  // Запись одного чата идёт по очереди: следующая ждёт ответа на эту.
  await new Promise(setImmediate);

  // Отпечаток считается по числу шагов, а не по их содержимому: дописанный шаг виден.
  puts.length = 0;
  chat.sessions[0].messages.at(-1).steps.push({ kind: 'res', at: 2 });
  chat._persist(true);
  await new Promise(setImmediate);
  assert.deepEqual(puts, ['c1'], 'дописанный шаг тоже уезжает');
});
