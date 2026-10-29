import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import {
  jsonRequest,
  listFixture,
  putPending,
  sampleChat,
} from './helpers/chat-list.js';

test('LEGACY-FULL: полная выдача сохраняет историю, мету и возможности', async (t) => {

  const active = sampleChat('compat-active', { customField: { preserved: true } });

  const archived = sampleChat('compat-archive', {
    archived: true,
    closedAt: 200,
  });

  const observed = [];

  const fixture = await listFixture(t, [active, archived], {
    extraRoutes: async (app) => {
      app.addHook('onResponse', async (request) => {
        observed.push(request.url);
      });
    },
    prefs: { chatAutoCompactWindow: 71 },
  });

  await fs.writeFile(path.join(fixture.config.chatsDir, 'meta.json'), JSON.stringify({
    activeId: active.id,
    defEffort: 'high',
    defMode: 'plan',
  }));

  const data = await jsonRequest(fixture.app, 'GET', '/api/chat/store');

  assert.deepEqual(data.sessions[0].messages, active.messages);
  assert.deepEqual(data.sessions[0].customField, active.customField);
  assert.deepEqual(data.archived[0].messages, archived.messages);
  assert.equal(data.activeId, active.id);
  assert.equal(data.defEffort, 'high');
  assert.equal(data.defMode, 'plan');
  assert.deepEqual(observed, ['/api/chat/store'], 'серверный hook пригоден для замера');
  assert.equal(data.turnProtocol, 1);
  assert.equal(data.inTurnProtocol, 1);
  assert.equal(data.workdirProtocol, 1);
  assert.equal(data.historyStepReuseProtocol, 1);
  assert.equal(data.compactWindow, 71);
  assert.equal(typeof data.speech.revision, 'string');
});

test('LEGACY-IMPORT: старый файл переносится один раз без дублей', async (t) => {

  const active = sampleChat('legacy-active');

  const archived = sampleChat('legacy-archive', { archived: true });

  const fixture = await listFixture(t, [], {
    legacy: {
      sessions: [active],
      archived: [archived],
      activeId: active.id,
    },
  });

  for (let pass = 0; pass < 2; pass += 1) {

    const data = await jsonRequest(fixture.app, 'GET', '/api/chat/store');

    assert.deepEqual(data.sessions.map((chat) => chat.id), [active.id]);
    assert.deepEqual(data.archived.map((chat) => chat.id), [archived.id]);
    assert.deepEqual(data.sessions[0].messages, active.messages);
    assert.equal(data.activeId, active.id);
  }

  await fs.access(`${fixture.config.chatStoreLegacyPath}.migrated`);
});

test('LEGACY-PENDING: прежние GET и ACK сохраняют полный протокол', async (t) => {

  const fixture = await listFixture(t);

  const entry = {
    id: 'compat-pending',
    chatKey: 'compat-chat',
    reply: 'Итог',
    at: Date.now(),
    steps: [{
      k: 'text',
      text: 'Шаг',
    }],
  };

  await putPending(fixture, entry);

  const file = path.join(fixture.config.chatsDir, 'pending', `${entry.id}.json`);

  const before = await fs.readFile(file, 'utf8');

  const data = await jsonRequest(fixture.app, 'GET', '/api/chat/pending');

  assert.deepEqual(data.pending, [entry]);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await jsonRequest(fixture.app, 'DELETE', `/api/chat/pending/${entry.id}`), {
    ok: true,
  });
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('LEGACY-NONEMPTY: новый чат до первого read сохраняет приоритет над legacy-копией', async (t) => {
  const fixture = await listFixture(t);

  await fixture.app.close();

  const legacyPath = path.join(fixture.root, 'legacy.json');
  const created = sampleChat('created-before-read');
  const store = new ChatHistoryStore({ chatsDir: fixture.config.chatsDir, legacyPath });

  await fs.writeFile(legacyPath, JSON.stringify({ sessions: [sampleChat('old-copy')] }));
  await store.saveOne(created);

  const state = await store.read();

  assert.deepEqual(state.sessions.map((chat) => chat.id), [created.id]);
  await fs.access(legacyPath);
});
