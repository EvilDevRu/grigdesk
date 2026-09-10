import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const CONTAINER = {
  id: 'demo-shell',
  shortId: 'demo-shell',
  name: 'demo-shell-1',
  image: 'alpine:latest',
  imageId: 'image-demo',
  command: 'sh',
  createdAt: null,
  state: 'running',
  status: 'Up',
  health: '',
  ports: [],
  networks: [],
  mounts: [],
  sizeRw: null,
  compose: null,
};

/**
 * Потоки и терминал подменяют только внешние устройства. Компоненты, декодеры
 * сообщений и элементы управления остаются настоящими.
 */
function createRuntime() {
  const runtime = {
    sockets: [],
    terminals: [],
    observers: [],
  };

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      runtime.sockets.push(this);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    receive(data) {
      this.onmessage?.({ data });
    }

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  class FakeTerminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.writes = [];
      runtime.terminals.push(this);
    }

    loadAddon() {}

    open(host) {
      this.host = host;
    }

    onData(listener) {
      this.inputListener = listener;
    }

    input(data) {
      this.inputListener?.(data);
    }

    write(data) {
      this.writes.push(data);
    }

    reset() {
      this.writes = [];
    }

    focus() {}

    dispose() {
      this.disposed = true;
    }
  }

  class FakeFitAddon {
    fit() {}
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      runtime.observers.push(this);
    }

    observe() {}

    disconnect() {}
  }

  return {
    ...runtime,
    FakeWebSocket,
    FakeTerminal,
    FakeFitAddon,
    FakeResizeObserver,
  };
}

/**
 * Каждый сценарий получает собственные сокеты и восстанавливает глобальные
 * конструкторы после размонтирования, чтобы проверки не зависели друг от друга.
 */
async function mountStream(t, name) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/docker');
  const runtime = createRuntime();
  const originals = new Map(['WebSocket', 'ResizeObserver'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]));

  globalThis.__dockerStreamsRuntime = runtime;
  Object.defineProperty(globalThis, 'WebSocket', {
    value: runtime.FakeWebSocket,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: runtime.FakeResizeObserver,
    configurable: true,
    writable: true,
  });

  let wrapper;

  t.after(() => {
    wrapper?.unmount();
    delete globalThis.__dockerStreamsRuntime;

    for (const [key, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });

  const component = await compileVue(webFile(`src/views/docker/${name}.vue`), {
    stubs: {
      '../../shared/apiClient.ts': (
        'export const api = { wsUrl: (path) => `ws://cockpit.test${path}` };'
      ),
      '@xterm/xterm': 'export const Terminal = globalThis.__dockerStreamsRuntime.FakeTerminal;',
      '@xterm/addon-fit': 'export const FitAddon = globalThis.__dockerStreamsRuntime.FakeFitAddon;',
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  wrapper = mount(component, {
    props: { container: structuredClone(CONTAINER) },
    attachTo: browser.document.querySelector('#mount'),
  });

  await flushPromises();

  return { wrapper, runtime, flushPromises };
}

test('логи переживают повреждённые кадры и сохраняют поиск и завершение потока', async (t) => {
  const { wrapper, runtime, flushPromises } = await mountStream(t, 'DockerLogs');
  const socket = runtime.sockets[0];

  socket.open();
  socket.receive(JSON.stringify({
    t: 'log',
    lines: [
      { stream: 'stdout', text: '<b>готово</b>\n' },
      { stream: 'stderr', text: 'предупреждение\n' },
    ],
  }));
  await flushPromises();

  assert.deepEqual(wrapper.findAll('.docker-logs__line').map((line) => line.text()), [
    '<b>готово</b>',
    'предупреждение',
  ]);
  assert.equal(wrapper.find('b').exists(), false, 'вывод контейнера остаётся текстом');
  assert.equal(wrapper.findAll('.is-stderr').length, 1);

  for (const malformed of [
    'не JSON',
    'null',
    JSON.stringify({ t: 'log', lines: [{ stream: 'stdout', text: { unexpected: true } }] }),
    new Uint8Array([1, 2, 3]).buffer,
  ]) {
    assert.doesNotThrow(() => socket.receive(malformed));
  }

  socket.receive(JSON.stringify({ t: 'log', lines: [{ stream: 'stdout', text: 'следующая строка' }] }));
  await flushPromises();

  assert.equal(wrapper.findAll('.docker-logs__line').length, 3);
  assert.equal(wrapper.get('.docker-logs__status').text(), 'поток открыт');

  await wrapper.get('input[type="search"]').setValue('следующая');

  assert.equal(wrapper.findAll('.docker-logs__line').length, 1);
  assert.equal(wrapper.get('.docker-logs__line').text(), 'следующая строка');

  socket.receive(JSON.stringify({ t: 'end' }));
  await flushPromises();

  assert.equal(wrapper.get('.docker-logs__status').text(), 'поток закрыт');
  assert.equal(wrapper.get('.docker-logs__line').text(), 'следующая строка');
});

test('отказ потока логов показывается строкой ошибки и сохраняется после закрытия', async (t) => {
  const { wrapper, runtime, flushPromises } = await mountStream(t, 'DockerLogs');
  const socket = runtime.sockets[0];

  socket.open();
  socket.receive(JSON.stringify({ t: 'error', message: ['не строка'] }));
  socket.receive(JSON.stringify({ t: 'error', message: 'контейнер недоступен' }));
  socket.close();
  await flushPromises();

  assert.equal(wrapper.get('.docker-logs__status').text(), 'ошибка');
  assert.equal(wrapper.findAll('.docker-logs__line').length, 1);
  assert.equal(wrapper.get('.docker-logs__line.is-stderr').text(), 'контейнер недоступен');
});

test('терминал сохраняет байты и текст, а проверенный отказ показывает как ошибку', async (t) => {
  const { wrapper, runtime, flushPromises } = await mountStream(t, 'DockerExec');
  const socket = runtime.sockets[0];
  const terminal = runtime.terminals[0];
  const bytes = new Uint8Array([0, 27, 91, 51, 49, 109, 208, 144, 255]);
  const ordinaryJson = JSON.stringify({ result: 'готово', count: 2 });
  const invalidError = JSON.stringify({ t: 'error', message: ['обычный текст'] });

  socket.open();
  socket.receive(bytes.buffer);
  socket.receive('$ echo готово\r\n');
  socket.receive(ordinaryJson);
  socket.receive(invalidError);
  await flushPromises();

  assert.equal(socket.binaryType, 'arraybuffer');
  assert.deepEqual(terminal.writes, [bytes, '$ echo готово\r\n', ordinaryJson, invalidError]);
  assert.match(wrapper.get('.docker-exec__status').text(), /оболочка открыта/u);

  socket.receive(JSON.stringify({ t: 'error', message: 'оболочка недоступна' }));
  socket.close();
  await flushPromises();

  assert.match(terminal.writes.at(-1), /оболочка недоступна/u);
  assert.equal(wrapper.get('.docker-exec__status').text(), 'не удалось запустить оболочку');
});

test('терминал передаёт ввод и изменённый размер только открытому соединению', async (t) => {
  const { runtime } = await mountStream(t, 'DockerExec');
  const socket = runtime.sockets[0];
  const terminal = runtime.terminals[0];
  const observer = runtime.observers[0];

  terminal.input('до подключения');

  assert.deepEqual(socket.sent, []);

  socket.open();
  terminal.input('echo готово\r');
  terminal.cols = 132;
  terminal.rows = 43;
  observer.callback();
  observer.callback();

  assert.deepEqual(socket.sent, [
    { t: 'resize', cols: 80, rows: 24 },
    { t: 'in', d: 'echo готово\r' },
    { t: 'resize', cols: 132, rows: 43 },
  ]);

  socket.close();
  terminal.input('после закрытия');
  terminal.cols = 100;
  observer.callback();

  assert.equal(socket.sent.length, 3, 'закрытое соединение не получает ввод или размер');
});
