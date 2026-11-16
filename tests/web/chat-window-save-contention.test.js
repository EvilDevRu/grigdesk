import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { readChat, sampleChat } from '../server/helpers/chat-list.js';
import { waitFor } from '../server/helpers/chat-turns.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';
import { chatNotifications } from './helpers/chat-store.js';

/**
 * Четыре независимых клиента работают с настоящим файловым сервером.
 * Остальные окна меняют шапку перед PUT телефона, воспроизводя несколько stale подряд.
 */
async function contentionFixture(t, races = 7) {
  const original = sampleChat('window-contention', {
    effort: '',
    messages: Array.from({ length: 121 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `Сообщение ${index}`,
      pid: `original-${index}`,
      steps: [{ k: 'text', text: `Шаг ${index}` }],
    })),
  });
  const world = await serverWorld(t, [original]);
  const peers = [await world.open(), await world.open(), await world.open()];
  const network = windowApi(world.app);
  const phone = await world.open(network);

  await phone.chat.ensureChatMessages(original.id);

  const live = phone.chat.session(original.id);
  const put = network.api.put;
  const acknowledgements = [];
  let attempts = 0;

  network.api.put = async (url, body) => {
    if (url !== '/api/chat/store/chat/window') {
      return put(url, body);
    }

    if (attempts < races) {
      const peer = peers[attempts % peers.length];

      peer.chat.session(original.id).title = `Чужая правка ${attempts + 1}`;
      await peer.chat._writeChat(original.id);
    }

    attempts += 1;

    const response = await put(url, body);

    acknowledgements.push(response);

    return response;
  };

  return {
    ...phone,
    original,
    live,
    world,
    acknowledgements,
  };
}

test('WINDOW-CONTENTION: фоновая запись переживает серию гонок четырёх клиентов', async (t) => {
  const view = await contentionFixture(t);
  const { chat, live, original, world } = view;
  const final = {
    role: 'assistant',
    text: 'Новый итог',
    pid: 'local-final',
    steps: [],
  };

  live.messages.push(final);
  live.draft = 'Черновик телефона';
  chat.setEffort(original.id, 'high');

  const response = await chat._writeChat(original.id);
  const during = await readChat(world, original);

  assert.equal(response.stale, true);
  assert.equal(chat.saveError, null, 'подтверждённая история не объявляется потерянной');
  assert.equal(chat._dirty(live), true, 'непринятый effort остаётся в очереди');
  assert.equal(during.effort, '');
  assert.equal(during.draft, 'Черновик телефона');
  assert.equal(during.messages.at(-1).pid, final.pid);

  await waitFor(() => !chat._dirty(live), { what: 'автоматическое согласование после семи гонок' });

  const saved = await readChat(world, original);

  assert.deepEqual(saved.messages, [...original.messages, final]);
  assert.equal(saved.effort, 'high');
  assert.equal(saved.draft, 'Черновик телефона');
  assert.equal(view.acknowledgements.filter((ack) => ack.stale).length, 7);
  assert.equal(view.acknowledgements.at(-1).stale, false);
  assert.equal(chatNotifications().some((entry) => entry[2] === 'chat-save-error'), false);
  assert.ok(view.calls.filter((call) => call.method === 'PUT'
    && call.url === '/api/chat/store/chat/window').every((call) => call.body.chat.messages.length <= 41));
  assert.equal(view.calls.some((call) => call.method === 'PUT'
    && call.url === '/api/chat/store/chat'), false);

  const writes = view.acknowledgements.length;

  chat._persist(true);
  await delay(400);
  assert.equal(view.acknowledgements.length, writes, 'после согласования лишние PUT прекращаются');
});

test('WINDOW-CONTENTION-DISPOSE: отложенная запись прекращается вместе с клиентом', async (t) => {
  const view = await contentionFixture(t, 20);

  view.live.draft = 'Черновик до закрытия';
  await view.chat._writeChat(view.original.id);
  assert.equal(view.acknowledgements.length, 2);
  view.chat.$dispose();
  await delay(1200);
  assert.equal(view.acknowledgements.length, 2);
});

test('WINDOW-CONTENTION-FAILURE: настоящий отказ после stale остаётся видимым', async (t) => {
  const view = await contentionFixture(t, 2);
  const put = view.api.put;

  view.api.put = async (url, body) => {
    if (url === '/api/chat/store/chat/window' && view.acknowledgements.length >= 2) {
      throw Object.assign(new Error('Хранилище временно недоступно'), { status: 503 });
    }

    return put(url, body);
  };
  view.live.draft = 'Не терять при отказе';
  await view.chat._writeChat(view.original.id);
  await waitFor(() => view.chat.saveError, { what: 'оповещение настоящего отказа' });
  assert.equal(view.chat.saveError, 'Хранилище временно недоступно');
  assert.equal(view.live.draft, 'Не терять при отказе');
  assert.equal(view.chat._dirty(view.live), true);
  assert.equal(chatNotifications().filter((entry) => entry[2] === 'chat-save-error').length, 1);
});
