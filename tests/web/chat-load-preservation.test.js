import assert from 'node:assert/strict';
import test from 'node:test';

import { chatStoreFixture } from './helpers/chat-store.js';
import { drain, loadApi, memoryStorage, SERVER_CHAT, SNAPSHOT_KEY, LEGACY_KEY } from './helpers/chat-load.js';

/**
 * Отложенная запись снимка принадлежит только текущей фикстуре и её storage.
 * После dispose сбрасываем таймеры, чтобы они не попали в следующий тест.
 */
function isolatePersistenceTimers(t, chat) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    chat.$dispose();
    t.mock.timers.reset();
  });
}

test('LOAD-KEEP-01', async (t) => {
  memoryStorage(t);

  const { api, calls } = loadApi(async () => ({ sessions: [], archived: [] }));
  const chat = await chatStoreFixture({}, { api, unloaded: true });

  isolatePersistenceTimers(t, chat);
  await chat.ensure();
  assert.equal(chat.loaded, true);
  assert.equal(chat.sessions.length, 1);
  assert.equal(chat.activeId, chat.sessions[0].id);
  await chat.ensure();
  assert.equal(chat.sessions.length, 1);
  assert.equal(calls.filter(([method, url]) => method === 'GET' && url === '/api/chat/store/list').length, 1);
});

test('LOAD-KEEP-02', async (t) => {
  const snapshot = {
    sessions: [{
      ...SERVER_CHAT,
      updatedAt: 300,
      messages: [{ role: 'assistant', text: 'Последний ответ' }],
    }],
    archived: [],
    turnProtocol: 0,
    speech: { engine: 'browser', language: 'en' },
  };
  const server = {
    sessions: [{ ...SERVER_CHAT, messages: [] }],
    archived: [],
    turnProtocol: 1,
    workdirProtocol: 1,
    historyStepReuseProtocol: 1,
    speech: { engine: 'whisper', language: 'ru' },
  };

  memoryStorage(t, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });

  const { api, calls } = loadApi(async () => server);
  const chat = await chatStoreFixture({}, { api, unloaded: true });

  isolatePersistenceTimers(t, chat);
  await chat._load();
  await drain();
  assert.equal(chat.sessions[0].messages[0].text, snapshot.sessions[0].messages[0].text);
  assert.equal(chat.turnProtocol, server.turnProtocol);
  assert.equal(chat.workdirProtocol, server.workdirProtocol);
  assert.equal(chat.historyStepReuseProtocol, server.historyStepReuseProtocol);
  assert.equal(chat.speech.engine, server.speech.engine);
  assert.equal(chat.speech.language, server.speech.language);
  assert.ok(calls.some(([method, url, body]) => method === 'PUT' && url === '/api/chat/store/chat'
    && body.chat.messages[0].text === snapshot.sessions[0].messages[0].text));
});

test('LOAD-KEEP-03', async (t) => {
  for (const populated of [false, true]) {
    await t.test(populated ? 'сервер приоритетен' : 'импорт legacy', async (sub) => {
      const legacy = {
        sessions: [{
          ...SERVER_CHAT,
          id: 'legacy',
          title: 'Старое окно',
        }],
        archived: [],
      };
      const encoded = JSON.stringify(legacy);
      const storage = memoryStorage(sub, { [LEGACY_KEY]: encoded });
      const { api } = loadApi(async () => ({
        sessions: populated ? [SERVER_CHAT] : [],
        archived: [],
      }));
      const chat = await chatStoreFixture({}, { api, unloaded: true });

      isolatePersistenceTimers(sub, chat);
      await chat._load();
      assert.equal(chat.sessions[0].id, populated ? SERVER_CHAT.id : 'legacy');

      if (populated) {
        await chat.ensureChatMessages(SERVER_CHAT.id);
      }

      assert.deepEqual(chat.sessions[0].messages, SERVER_CHAT.messages);
      assert.equal(storage.values.get(LEGACY_KEY), populated ? encoded : undefined);
    });
  }
});
