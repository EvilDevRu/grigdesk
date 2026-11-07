import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import dockerModule from '../../server/src/modules/docker/index.ts';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  closed = [];

  send(value) {
    this.sent.push(value);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed.push({ code, reason });
    this.emit('close');
  }

  message(value) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

function logHandle(tty = false) {
  const handle = {
    tty,
    res: new EventEmitter(),
    aborted: 0,
    abort() {
      handle.aborted += 1;
    },
  };

  return handle;
}

function execHandle() {
  const socket = new EventEmitter();
  const handle = {
    socket,
    writes: [],
    sizes: [],
    closed: 0,
    resize(cols, rows) {
      handle.sizes.push([cols, rows]);
    },
    close() {
      handle.closed += 1;
    },
  };
  socket.write = (data) => handle.writes.push(data);

  return handle;
}

/**
 * Подставляем только транспорт, чтобы проверять настоящие обработчики модуля
 * без подключения к Docker и без изменения контейнеров на машине.
 */
async function fixture(t, overrides = {}) {
  const routes = new Map();
  const sockets = [];
  const logs = [];
  const sessions = [];
  const service = {
    logStream: async () => {
      const handle = logHandle();
      logs.push(handle);
      return handle;
    },
    execStart: async () => {
      const handle = execHandle();
      sessions.push(handle);
      return handle;
    },
    statsOnce: async () => null,
    ...overrides,
  };
  const fastify = {
    addHook() {},
    get(path, options, handler) {
      if (options.websocket) {
        routes.set(path, handler);
      }
    },
    post() {},
    delete() {},
  };

  await dockerModule(fastify, { service });
  t.after(() => sockets.forEach((socket) => socket.close()));

  return {
    logs,
    sessions,
    connect(channel, query = { id: 'container' }) {
      const socket = new FakeSocket();
      sockets.push(socket);

      return {
        socket,
        ready: routes.get(`/api/docker/${channel}`)(socket, { query }),
      };
    },
  };
}

function dockerFrame(stream, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);

  return Buffer.concat([header, body]);
}

test('поток логов собирает разрезанные кадры и сбрасывает пакет перед концом', async (t) => {
  const { connect, logs } = await fixture(t);
  const { socket, ready } = connect('logs');
  await ready;

  const frames = Buffer.concat([dockerFrame(1, 'готово\n'), dockerFrame(2, 'ошибка\n')]);
  logs[0].res.emit('data', frames.subarray(0, 11));
  logs[0].res.emit('data', frames.subarray(11));
  assert.equal(socket.sent.length, 0);
  logs[0].res.emit('end');

  assert.deepEqual(socket.sent.map((raw) => JSON.parse(raw)), [
    {
      t: 'log',
      lines: [
        { stream: 'stdout', text: 'готово\n' },
        { stream: 'stderr', text: 'ошибка\n' },
      ],
    },
    { t: 'end' },
  ]);
});

test('поток TTY передаёт текст и сообщает ошибку демона', async (t) => {
  const stream = logHandle(true);
  const { connect } = await fixture(t, { logStream: async () => stream });
  const { socket, ready } = connect('logs');
  await ready;

  stream.res.emit('data', Buffer.from('\u001b[32mготово'));
  stream.res.emit('end');
  stream.res.emit('error', new Error('поток оборван'));

  assert.deepEqual(JSON.parse(socket.sent[0]), {
    t: 'log',
    lines: [{ stream: 'stdout', text: '\u001b[32mготово' }],
  });
  assert.deepEqual(JSON.parse(socket.sent[2]), {
    t: 'error',
    message: 'поток оборван',
  });
});

for (const [channel, limit] of [['logs', 6], ['exec', 4], ['stats', 4]]) {
  test(`${channel}: error и close освобождают только одно место лимита`, async (t) => {
    const { connect, logs, sessions } = await fixture(t);
    const opened = [];

    for (let index = 0; index < limit; index += 1) {
      const connection = connect(channel);
      await connection.ready;
      opened.push(connection.socket);
    }

    opened[0].emit('error', new Error('соединение оборвалось'));
    opened[0].close();

    const replacement = connect(channel);
    await replacement.ready;
    assert.equal(replacement.socket.readyState, 1);

    const extra = connect(channel);
    await extra.ready;
    assert.equal(extra.socket.closed[0].code, 1013);

    if (channel === 'logs') {
      assert.equal(logs[0].aborted, 1);
    }
    if (channel === 'exec') {
      assert.equal(sessions[0].closed, 1);
    }
  });
}

for (const channel of ['logs', 'exec']) {
  test(`${channel}: закрытая во время подготовки вкладка освобождает новый ресурс`, async (t) => {
    const handle = channel === 'logs' ? logHandle() : execHandle();
    const pending = Promise.withResolvers();
    const method = channel === 'logs' ? 'logStream' : 'execStart';
    const { connect } = await fixture(t, { [method]: () => pending.promise });
    const { socket, ready } = connect(channel);

    socket.close();
    pending.resolve(handle);
    await ready;

    assert.equal(channel === 'logs' ? handle.aborted : handle.closed, 1);
    assert.equal(socket.sent.length, 0);
  });
}

for (const [channel, limit] of [['logs', 6], ['exec', 4]]) {
  test(`${channel}: параллельная подготовка учитывает лимит и освобождает место при отказе`, async (t) => {
    const pending = [];
    const method = channel === 'logs' ? 'logStream' : 'execStart';
    const { connect } = await fixture(t, {
      [method]: () => {
        const operation = Promise.withResolvers();
        pending.push(operation);
        return operation.promise;
      },
    });
    const connections = Array.from({ length: limit }, () => connect(channel));
    const extra = connect(channel);
    await extra.ready;

    assert.equal(pending.length, limit);
    assert.equal(extra.socket.closed[0].code, 1013);

    pending[0].reject(null);
    await connections[0].ready;
    assert.equal(connections[0].socket.closed[0].code, 1011);
    assert.deepEqual(JSON.parse(connections[0].socket.sent[0]), {
      t: 'error',
      message: 'Ошибка Docker',
    });

    const replacement = connect(channel);
    assert.equal(pending.length, limit + 1);

    for (const operation of pending.slice(1)) {
      operation.resolve(channel === 'logs' ? logHandle() : execHandle());
    }
    await Promise.all([...connections.map((connection) => connection.ready), replacement.ready]);
    assert.equal(replacement.socket.readyState, 1);
  });
}

test('exec игнорирует некорректный JSON, сохраняет ввод, resize и сырые байты', async (t) => {
  const { connect, sessions } = await fixture(t);
  const { socket, ready } = connect('exec', { id: 'container', cols: '90', rows: '25' });
  await ready;
  const session = sessions[0];

  for (const value of [null, [], 42, { t: 'in', d: 12 }, { t: 'watch', ids: ['x'] }]) {
    socket.message(value);
  }
  socket.emit('message', Buffer.from('{'));
  socket.message({ t: 'in', d: 'pwd\r' });
  socket.message({ t: 'resize', cols: 120, rows: 40 });
  socket.message({ t: 'resize', cols: 'не число', rows: 0 });
  socket.message({ t: 'resize', cols: { toString: null }, rows: [40] });

  const output = Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0xff]);
  session.socket.emit('data', output);

  assert.deepEqual(session.writes, ['pwd\r']);
  assert.deepEqual(session.sizes, [[90, 25], [120, 40], [90, 25], [90, 25]]);
  assert.equal(socket.sent[0], output);
});

test('stats ограничивает список и пропускает остановленный контейнер', async (t) => {
  const requested = [];
  const { connect } = await fixture(t, {
    statsOnce: async (id) => {
      requested.push(id);
      if (id === 'broken') {
        throw new Error('контейнер остановлен');
      }
      return { cpuPercent: 2 };
    },
  });
  const { socket, ready } = connect('stats');
  await ready;

  for (const value of [
    null,
    [],
    { t: 'in', d: 'x' },
    { t: 'watch', ids: false },
    { t: 'watch', ids: [null, 42, { toString: null }] },
  ]) {
    socket.message(value);
  }
  assert.equal(requested.length, 0);

  socket.message({ t: 'watch', ids: ['broken', ...Array.from({ length: 45 }, (_, i) => `c${i}`)] });
  await setImmediate();

  assert.equal(requested.length, 40);
  const message = JSON.parse(socket.sent[0]);
  assert.equal(message.t, 'stats');
  assert.equal(Object.keys(message.items).length, 39);
  assert.equal(message.items.broken, undefined);
  assert.equal(typeof message.at, 'string');
});

test('stats не отправляет запоздавший срез закрытой вкладке', async (t) => {
  const pending = Promise.withResolvers();
  const { connect } = await fixture(t, { statsOnce: () => pending.promise });
  const { socket, ready } = connect('stats');
  await ready;

  socket.message({ t: 'watch', ids: ['container'] });
  socket.close();
  pending.resolve({ cpuPercent: 2 });
  await setImmediate();

  assert.equal(socket.sent.length, 0);
});
