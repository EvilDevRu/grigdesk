import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  configureSseRelay,
  resetSseForTests,
  setSseEnabled,
  sseSubscribe,
} from '../../web/src/composables/useSse.ts';

/**
 * Подменный канал хранит отправленное и даёт тесту доставить сообщение.
 * Настоящий BroadcastChannel Node держал бы процесс теста живым.
 */
function fakeChannel(made) {
  const channel = {
    onmessage: null,
    posted: [],
    closed: false,
    postMessage(value) {
      this.posted.push(value);
    },
    close() {
      this.closed = true;
    },
  };

  made.push(channel);

  return channel;
}
/**
 * Поддельный EventSource фиксирует каждое соединение и его обработчики.
 * Уборка возвращает настоящий глобал и сбрасывает роль ретрансляции.
 */
function installEventSource(t) {
  const original = globalThis.EventSource;
  const sources = [];

  globalThis.EventSource = class {
    listeners = new Map();
    constructor() {
      sources.push(this);
    }
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    close() {
      this.closed = true;
    }
  };
  t.after(() => {
    resetSseForTests();
    globalThis.EventSource = original;
  });

  return sources;
}

test('SR-01: главный документ доставляет событие себе и ретранслирует его карточкам', (t) => {
  const sources = installEventSource(t);
  const channels = [];
  const received = [];

  configureSseRelay('source', () => fakeChannel(channels));
  sseSubscribe((name, data) => received.push({ name, data }));
  assert.equal(sources.length, 1);
  sources[0].listeners.get('task-shelf-changed')({ data: '{"taskId":"42"}' });
  sources[0].listeners.get('chat-step')({ data: '{"chatKey":"c1"}' });
  assert.deepEqual(received, [
    { name: 'task-shelf-changed', data: { taskId: '42' } },
    { name: 'chat-step', data: { chatKey: 'c1' } },
  ]);
  assert.equal(channels.length, 1);
  assert.deepEqual(channels[0].posted, [{
    version: 1,
    name: 'task-shelf-changed',
    data: { taskId: '42' },
  }]);
});
test('SR-02: окно карточки не открывает EventSource и принимает только точную форму', (t) => {
  const sources = installEventSource(t);
  const channels = [];
  const received = [];
  const deliver = (data) => channels.at(-1).onmessage({ data });

  configureSseRelay('mirror', () => fakeChannel(channels));
  sseSubscribe((name, data) => received.push({ name, data }));
  sseSubscribe(() => {
  });
  assert.equal(sources.length, 0);
  assert.equal(channels.length, 1);
  deliver({
    version: 1,
    name: 'task-shelf-changed',
    data: { taskId: '42' },
  });
  deliver({
    version: 1,
    name: 'execute',
    data: {},
  });
  deliver({
    version: 1,
    name: 'chat-step',
    data: {},
  });
  deliver({
    version: 2,
    name: 'hello',
    data: {},
  });
  deliver({
    version: 1,
    name: 'hello',
    data: {},
    script: 'bad',
  });
  deliver(['hello']);
  assert.deepEqual(received, [{ name: 'task-shelf-changed', data: { taskId: '42' } }]);
  assert.deepEqual(channels[0].posted, []);
  setSseEnabled(false);
  assert.equal(channels[0].closed, true);
  assert.equal(channels[0].onmessage, null);
  setSseEnabled(true);
  assert.equal(channels.length, 2);
  assert.equal(sources.length, 0);
  deliver({
    version: 1,
    name: 'hello',
    data: { bootId: 'boot-aaaaaaaaaaaaaaaa' },
  });
  assert.deepEqual(received.at(-1), { name: 'hello', data: { bootId: 'boot-aaaaaaaaaaaaaaaa' } });
});
test('SR-03: без роли ретрансляции поток вкладки прежний и канал не создаётся', (t) => {
  const sources = installEventSource(t);
  let made = 0;

  configureSseRelay('off', () => {
    made += 1;

    return fakeChannel([]);
  });
  sseSubscribe(() => {
  });
  sources[0].listeners.get('hello')({ data: '{}' });
  assert.equal(sources.length, 1);
  assert.equal(made, 0);
});
test('SR-04: вход приложения задаёт роль до журнала окна', async () => {
  const source = await readFile(new URL('../../web/src/main.ts', import.meta.url), 'utf8');
  const configured = source.indexOf('configureSseRelay(SSE_RELAY_ROLES[currentDesktopMode()]);');

  assert.notEqual(configured, -1);
  assert.equal(configured < source.indexOf('createWebLogRuntime({'), true);
  assert.match(source, /main: 'source'/);
  assert.match(source, /surface: 'mirror'/);
  assert.match(source, /page: 'off'/);
});

test('PD-relay: deleted доходит в mirror, page сохраняет один поток', (t) => {
  const sources = installEventSource(t);
  const channels = [];
  const received = [];
  const data = {
    id: 'demo',
    revision: 3,
    kind: 'deleted'
  };

  configureSseRelay('source', () => fakeChannel(channels));
  sseSubscribe((name, value) => received.push({ name, data: value }));
  sources[0].listeners.get('projects-changed')({ data: JSON.stringify(data) });
  assert.equal(sources.length, 1);
  assert.deepEqual(received, [{ name: 'projects-changed', data }]);
  assert.equal(channels.length, 1, 'projects-changed должен ретранслироваться в канал окон');
  assert.deepEqual(channels[0].posted, [{
    version: 1,
    name: 'projects-changed',
    data
  }]);

  const packet = channels[0].posted[0];

  resetSseForTests();
  sources.length = 0;
  received.length = 0;
  configureSseRelay('mirror', () => fakeChannel(channels));
  sseSubscribe((name, value) => received.push({ name, data: value }));

  const deliver = (value) => channels.at(-1).onmessage({ data: value });

  deliver(packet);
  deliver({ ...packet, version: 99 });
  deliver({ ...packet, name: 'execute' });
  deliver({ ...packet, extra: true });
  assert.deepEqual(received, [{ name: 'projects-changed', data }]);
  assert.equal(sources.length, 0);
});
