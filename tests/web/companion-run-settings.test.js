// Чем уходит ход компаньона. Владелец модели и усилия — server-owned настройка
// «Настройки → Приложение → Голосовой компаньон», а не запись разговора: она одна на его
// общий и задачные чаты и на все окна, поэтому смена настройки действует со следующего хода.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture, setChatProviders } from './helpers/chat-store.js';

function companionChat(extra = {}) {
  return {
    id: 'companion-global',
    purpose: 'companion',
    logicalIdentity: 'companion:global',
    taskId: null,
    title: 'Компаньон',
    messages: [],
    schema: 2,
    revision: 3,
    model: '',
    modelRef: null,
    effort: '',
    mode: '',
    ...extra,
  };
}

/** Реестр с одной моделью, объявляющей лестницу уровней. */
function registryWith({ efforts = ['low', 'high'] } = {}) {
  return {
    modelOf(value) {
      const id = typeof value === 'object' && value ? value.model : (value || 'default-model');
      const provider = typeof value === 'object' && value?.provider ? value.provider : 'default-provider';
      return { id, model: { id, efforts }, provider: { id: provider } };
    },
  };
}

async function captureTurn(chat, id, text = 'привет') {
  const sent = [];
  apiHarness.post = async (url, body) => { sent.push({ url, body }); return { text: 'ок' }; };
  apiHarness.put = async () => ({ revision: 9 });
  await chat.send(id, text);
  return sent.find((call) => call.url === '/api/chat' || String(call.url).endsWith('/chat'));
}

test('COMP-RUN-WEB-01: ход компаньона уходит моделью и усилием из настройки, а не из записи чата', async () => {
  // В самой записи лежит модель прошлого хода — она не должна победить настройку.
  const chat = await chatStoreFixture({
    sessions: [companionChat({ modelRef: { provider: 'stale', model: 'stale-model' }, effort: 'low' })],
  });
  setChatProviders(registryWith({ efforts: ['low', 'high'] }));
  chat.companion = { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high' };

  const call = await captureTurn(chat, 'companion-global');
  assert.deepEqual(call.body.modelRef, { provider: 'claude', model: 'claude-opus-5' });
  assert.equal(call.body.model, 'claude-opus-5');
  assert.equal(call.body.effort, 'high');
  // В записи разговора остаётся ФАКТ хода: по нему рисуются чипы пузыря и подпись ответа.
  const session = chat.session('companion-global');
  assert.deepEqual(session.modelRef, { provider: 'claude', model: 'claude-opus-5' });
  assert.equal(session.effort, 'high');
});

test('COMP-RUN-WEB-02: смена настройки действует со следующего хода того же разговора', async () => {
  const chat = await chatStoreFixture({ sessions: [companionChat()] });
  setChatProviders(registryWith());
  chat.companion = { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high' };
  const first = await captureTurn(chat, 'companion-global');
  assert.equal(first.body.model, 'claude-opus-5');

  chat.companion = { modelRef: { provider: 'ollama', model: 'qwen3.6:latest' }, effort: 'low' };
  const second = await captureTurn(chat, 'companion-global', 'ещё вопрос');
  assert.equal(second.body.model, 'qwen3.6:latest');
  assert.equal(second.body.effort, 'low');
});

test('COMP-RUN-WEB-03: пустая настройка = модель по умолчанию из реестра', async () => {
  const chat = await chatStoreFixture({ sessions: [companionChat()] });
  setChatProviders(registryWith());
  chat.companion = { modelRef: null, effort: '' };

  const call = await captureTurn(chat, 'companion-global');
  assert.equal(call.body.model, 'default-model');
  assert.equal(call.body.effort, '');
});

test('COMP-RUN-WEB-04: уровня нет у выбранной модели — явный effort не отправляем', async () => {
  const chat = await chatStoreFixture({ sessions: [companionChat()] });
  // Настройка живёт долго, а лестница у модели могла смениться вместе с обновлением CLI.
  setChatProviders(registryWith({ efforts: ['low', 'medium'] }));
  chat.companion = { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'xhigh' };

  const call = await captureTurn(chat, 'companion-global');
  assert.equal(call.body.effort, '', 'CLI применит собственный актуальный дефолт');
});

test('COMP-RUN-WEB-05: обычный чат настройку компаньона не читает', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'ordinary',
      purpose: '',
      title: 'Обычный',
      messages: [],
      schema: 2,
      revision: 1,
      modelRef: { provider: 'codex', model: 'gpt-5.6' },
      effort: 'low',
      mode: '',
    }],
  });
  setChatProviders(registryWith({ efforts: ['low', 'high'] }));
  chat.companion = { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high' };

  const call = await captureTurn(chat, 'ordinary');
  assert.equal(call.body.model, 'gpt-5.6');
  assert.equal(call.body.effort, 'low');
});

test('COMP-RUN-WEB-06: селекты чата не владеют выбором компаньона', async () => {
  const chat = await chatStoreFixture({
    sessions: [companionChat({ modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high' })],
  });
  setChatProviders(registryWith());
  const before = { ...chat.session('companion-global') };

  chat.setModel('companion-global', 'sonnet');
  chat.setEffort('companion-global', 'low');

  const after = chat.session('companion-global');
  // Принятый здесь выбор пережил бы ровно до следующего хода и выглядел бы поломкой.
  assert.deepEqual(after.modelRef, before.modelRef);
  assert.equal(after.effort, before.effort);
  // Дефолты новых обычных чатов companion-разговор тоже не переписывает.
  assert.notEqual(chat.defModel, 'sonnet');
  assert.notEqual(chat.defEffort, 'low');
});

test('COMP-RUN-WEB-07: настройка приезжает вместе с историей и переживает снимок браузера', async () => {
  const chat = await chatStoreFixture();
  chat.loaded = false;
  apiHarness.get = async (url) => {
    if (url === '/api/chat/store') {
      return {
        sessions: [companionChat()],
        archived: [],
        meta: {},
        compactWindow: 200000,
        // Полупустая ссылка от старого сервера не должна дожить до хода.
        companion: { modelRef: { provider: 'claude' }, effort: 'high' },
      };
    }
    return { active: [] };
  };
  await chat.ensure();
  assert.deepEqual(chat.companion, { modelRef: null, effort: '' });
});
