import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsWindowChannel, requestIntent } from '../../web/src/shared/settingsWindowChannel.ts';
import { createSettingsWindowActions } from '../../web/src/shared/settingsWindowActions.ts';
import { createSettingsWindowBridge } from '../../web/src/shared/settingsWindowBridge.ts';
import { channelHub, flushChannel } from './helpers/settings-window-channel.js';

/**
 * Пара каналов всегда закрывается владельцем теста.
 * В журнал вызовов попадают только значения намерений этой фикстуры.
 */
function fixture(t) {
  const hub = channelHub();
  const main = createSettingsWindowChannel(hub.factory);
  const settings = createSettingsWindowChannel(hub.factory);
  const calls = [];
  const actions = createSettingsWindowActions({
    channel: settings,
    close: () => calls.push('close'),
    notify: (text) => calls.push(text),
    timeoutMs: 20,
  });

  t.after(() => {
    main.close();
    settings.close();
  });

  return {
    hub,
    main,
    settings,
    calls,
    actions
  };
}

test('SW-K01 канал пропускает только декодированное', async (t) => {
  const f = fixture(t);
  const received = [];
  const own = [];

  f.main.subscribe(() => {
    throw new Error('слушатель');
  });
  f.main.subscribe((message) => received.push(message));
  f.settings.subscribe((message) => own.push(message));
  f.settings.post({ version: 1, type: 'settings-changed' });
  await flushChannel();
  assert.equal(received.length, 1);
  assert.equal(own.length, 0);

  for (const message of [null, { version: 2, type: 'settings-changed' },
    {
      version: 1,
      type: 'settings-changed',
      extra: 1
    }]) {
    f.hub.ports[1].postMessage(message);
  }

  await flushChannel();
  assert.equal(received.length, 1);
});

test('SW-K02 закрытие освобождает порт', async (t) => {
  const f = fixture(t);

  assert.equal(f.hub.ports.length, 2);
  f.settings.close();
  f.settings.close();
  f.settings.post({ version: 1, type: 'settings-changed' });
  assert.equal(f.hub.ports[1].closed, 1);
  assert.equal(f.hub.ports[1].sent.length, 0);
  assert.equal(await requestIntent(f.settings, {
    version: 1,
    type: 'open-chat-request',
    requestId: 'closed',
    chatKey: 'chat',
  }, 20), false);
});

test('SW-K03 намерение ждёт свой ответ', async () => {
  const listeners = new Set();
  let ok = true;
  let silent = false;
  const channel = {
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    /**
     * Синхронный ответ проверяет порядок подписки относительно отправки.
     * Чужой идентификатор должен быть проигнорирован тем же слушателем.
     */
    post(message) {
      if (!silent) {
        for (const listener of listeners) {
          listener({
            version: 1,
            type: 'intent-result',
            requestId: 'other',
            ok: true
          });
          listener({
            version: 1,
            type: 'intent-result',
            requestId: message.requestId,
            ok
          });
        }
      }
    },
  };
  const message = {
    version: 1,
    type: 'open-chat-request',
    requestId: 'own',
    chatKey: 'chat',
  };

  assert.equal(await requestIntent(channel, message, 20), true);
  assert.equal(listeners.size, 0);
  ok = false;
  assert.equal(await requestIntent(channel, message, 20), false);
  silent = true;
  assert.equal(await requestIntent(channel, message, 20), false);
  assert.equal(listeners.size, 0);
});

test('SW-K04 успех намерения закрывает окно', async (t) => {
  const f = fixture(t);
  const received = [];

  f.main.subscribe((message) => {
    received.push(message);
    f.main.post({
      version: 1,
      type: 'intent-result',
      requestId: message.requestId,
      ok: true,
    });
  });
  assert.equal(await f.actions.openTerminal('npm i -g x && y login'), true);
  assert.equal(received[0].insert, 'npm i -g x && y login');
  assert.equal(await f.actions.openChat('chat'), true);
  assert.deepEqual(f.calls, ['close', 'close']);
});

test('SW-K05 отказ и тишина', async (t) => {
  const f = fixture(t);

  await f.actions.openTerminal('a\nb');
  await f.actions.openTerminal('a'.repeat(16385));
  assert.equal(f.calls.length, 2);
  assert.equal(f.hub.ports[1].sent.length, 0);
  await f.actions.openTerminal('npm install x');
  assert.equal(f.calls.length, 3);
  assert.equal(f.hub.ports[1].sent.length, 1);
  assert.equal(f.calls.includes('close'), false);
});

test('SW-K06 мост выполняет намерения один раз', async (t) => {
  const f = fixture(t);
  const calls = [];
  const results = [];
  const bridge = createSettingsWindowBridge({
    channel: f.main,
    reread: async () => { },
    openTerminal: async (insert) => {
      calls.push(insert);

      return true;
    },
    openChat: async (chatKey) => {
      calls.push(chatKey);

      throw new Error('чат');
    },
  });

  t.after(() => bridge.dispose());
  f.settings.subscribe((message) => results.push(message));
  f.settings.post({
    version: 1,
    type: 'terminal-request',
    requestId: 't',
    insert: 'command'
  });
  f.settings.post({
    version: 1,
    type: 'open-chat-request',
    requestId: 'c',
    chatKey: 'chat'
  });
  f.settings.post({ version: 1, type: 'reload-main' });
  await flushChannel();
  assert.deepEqual(calls, ['command', 'chat']);
  assert.deepEqual(results.map((result) => result.ok), [true, false]);
});

test('SW-K07 мост склеивает перечитывания', async (t) => {
  const f = fixture(t);
  const first = Promise.withResolvers();
  let calls = 0;
  const bridge = createSettingsWindowBridge({
    channel: f.main,
    reread() {
      calls += 1;

      return calls === 1 ? first.promise : Promise.resolve();
    },
    openTerminal: async () => true,
    openChat: async () => true,
    reload: () => { },
  });

  t.after(() => bridge.dispose());
  f.settings.post({ version: 1, type: 'settings-changed' });
  await flushChannel();

  for (let index = 0; index < 3; index += 1) {
    f.settings.post({ version: 1, type: 'settings-changed' });
  }

  await flushChannel();
  assert.equal(calls, 1);
  first.reject(new Error('перечитывание'));
  await flushChannel();
  assert.equal(calls, 2);
});

test('SW-K08 после dispose тишина', async (t) => {
  const f = fixture(t);
  const pending = Promise.withResolvers();
  const results = [];
  const bridge = createSettingsWindowBridge({
    channel: f.main,
    reread: () => pending.promise,
    openTerminal: () => pending.promise,
    openChat: async () => true,
    reload: () => results.push('reload'),
  });

  f.settings.subscribe((message) => results.push(message));
  f.settings.post({
    version: 1,
    type: 'terminal-request',
    requestId: 't',
    insert: 'command'
  });
  f.settings.post({ version: 1, type: 'settings-changed' });
  await flushChannel();
  bridge.dispose();
  pending.resolve(true);
  f.settings.post({ version: 1, type: 'reload-main' });
  await flushChannel();
  assert.deepEqual(results, []);
});

test('SW-K09 устаревшая команда reload-main не проходит канал', async (t) => {
  const f = fixture(t);
  const received = [];

  f.main.subscribe((message) => received.push(message));
  f.hub.ports[1].postMessage({ version: 1, type: 'reload-main' });
  await flushChannel();
  assert.deepEqual(received, []);
  assert.equal('reloadAll' in f.actions, false);
  assert.deepEqual(f.calls, []);
});
