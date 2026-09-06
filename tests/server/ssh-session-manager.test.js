import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

class FakeChannel extends EventEmitter {
  constructor(kind) {
    super();
    this.kind = kind;
    this.writes = [];
    this.closed = false;
  }

  write(data) {
    this.writes.push(String(data));
  }

  end() {
    this.closed = true;
    this.emit('close');
  }

  close() { this.end(); }

  destroy() { this.end(); }
}

class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.shellChannel = new FakeChannel('shell');
    this.execChannels = [];
    this.closed = false;
  }

  async shell() {
    return this.shellChannel;
  }

  async exec(command) {
    const channel = new FakeChannel('exec');
    channel.command = command;
    this.execChannels.push(channel);
    return channel;
  }

  close() {
    this.closed = true;
    this.emit('close');
  }

  end() { this.close(); }

  destroy() { this.close(); }
}

async function manager(t, extra = {}) {
  let module;
  try {
    module = await import('../../server/src/lib/ssh/session-manager.js');
  } catch (error) {
    assert.fail(`server-owned SSH-сессии ещё не реализованы: ${error.message}`);
  }
  const create = module.createSshSessionManager || module.default;
  assert.equal(typeof create, 'function', 'session-manager.js обязан экспортировать фабрику');
  const transports = [];
  const value = create({
    async connect() {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    replayBytes: 4096,
    ...extra,
  });
  t.after(() => value.closeAll?.());
  return { value, transports };
}

async function openSession(t, extra = {}) {
  const { value, transports } = await manager(t, extra);
  const session = await value.open({
    connection: {
      id: 'connection-a', projectId: 'project-a', label: 'Боевой код', role: 'code',
      host: 'server.internal', port: 22, user: 'deploy',
    },
    password: Buffer.from('SSH_PASSWORD_SENTINEL_91006'),
  });
  return { manager: value, session, transport: transports[0] };
}

test('отсоединение окна не закрывает server-owned SSH-сессию', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  const detach = value.attach(session.id, { send() {} });
  detach();

  assert.deepEqual({
    sessionCount: value.list().length,
    transportClosed: transport.closed,
  }, {
    sessionCount: 1,
    transportClosed: false,
  });
});

test('новое окно получает replay живой SSH-сессии', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  transport.shellChannel.emit('data', Buffer.from('готово\n'));
  const received = [];
  value.attach(session.id, { send: (data) => received.push(String(data)) });

  assert.equal(received.join(''), 'готово\n');
});

test('агентская команда открывает отдельный канал и не наследует shell человека', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  value.write(session.id, 'cd /srv/app\nexport FLAG=human\n');
  await value.setAgentAccess(session.id, true);
  const command = value.exec(session.id, 'pwd; printf "$FLAG"');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual({
    shellWrites: transport.shellChannel.writes,
    execCount: transport.execChannels.length,
    execCommand: transport.execChannels[0]?.command,
    sameChannel: transport.execChannels[0] === transport.shellChannel,
    promise: command instanceof Promise,
  }, {
    shellWrites: ['cd /srv/app\nexport FLAG=human\n'],
    execCount: 1,
    execCommand: 'pwd; printf "$FLAG"',
    sameChannel: false,
    promise: true,
  });
  transport.execChannels[0].emit('close', 0);
  await command;
});

test('агент не выполняет команду без явного разрешения живой сессии', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  const result = await value.exec(session.id, 'id');

  assert.deepEqual({ result, execCount: transport.execChannels.length }, {
    result: { ok: false, error: 'not_allowed' },
    execCount: 0,
  });
});

test('снятие доступа немедленно гасит агентский канал, но оставляет shell человека', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  await value.setAgentAccess(session.id, true);
  const command = value.exec(session.id, 'tail -f app.log');
  await new Promise((resolve) => setImmediate(resolve));
  await value.setAgentAccess(session.id, false);

  assert.deepEqual({
    result: await command,
    execClosed: transport.execChannels[0]?.closed,
    shellClosed: transport.shellChannel.closed,
  }, {
    result: { ok: false, error: 'access_revoked' },
    execClosed: true,
    shellClosed: false,
  });
});

test('провал команды и смерть SSH-сессии возвращаются разными типами', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  await value.setAgentAccess(session.id, true);
  const failed = value.exec(session.id, 'false');
  await new Promise((resolve) => setImmediate(resolve));
  transport.execChannels[0].emit('close', 17);
  const failedResult = await failed;
  const lost = value.exec(session.id, 'sleep 30');
  await new Promise((resolve) => setImmediate(resolve));
  transport.close();

  assert.deepEqual({ failed: failedResult, lost: await lost }, {
    failed: { ok: false, error: 'command_failed', exitCode: 17 },
    lost: { ok: false, error: 'session_lost' },
  });
});

test('пароль не возвращается из server-owned снимка сессий', async (t) => {
  const { manager: value } = await openSession(t);

  assert.equal(JSON.stringify(value.list()).includes('SSH_PASSWORD_SENTINEL_91006'), false);
});

test('явное закрытие сессии глобально закрывает транспорт', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  await value.close(session.id);

  assert.deepEqual({ sessions: value.list(), transportClosed: transport.closed }, {
    sessions: [],
    transportClosed: true,
  });
});

test('эхо агентской команды приходит в окно терминала, но не в shell-канал', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  await value.setAgentAccess(session.id, true);
  const received = [];
  value.attach(session.id, { send: (data) => received.push(String(data)) });
  const command = value.exec(session.id, 'whoami');
  await new Promise((resolve) => setImmediate(resolve));
  transport.execChannels[0].emit('data', Buffer.from('root\n'));
  transport.execChannels[0].emit('close', 0);
  await command;
  const shown = received.join('');

  assert.deepEqual({
    command: shown.includes('агент ▸ whoami'),
    output: shown.includes('root\r\n'),
    outcome: shown.includes('код 0'),
    shellWrites: transport.shellChannel.writes,
  }, {
    command: true,
    output: true,
    outcome: true,
    shellWrites: [],
  });
});

test('эхо в терминал выключается настройкой плагина', async (t) => {
  const { manager: value, session, transport } = await openSession(t, { echoEnabled: () => false });
  await value.setAgentAccess(session.id, true);
  const received = [];
  value.attach(session.id, { send: (data) => received.push(String(data)) });
  const command = value.exec(session.id, 'whoami');
  await new Promise((resolve) => setImmediate(resolve));
  transport.execChannels[0].emit('data', Buffer.from('root\n'));
  transport.execChannels[0].emit('close', 0);

  assert.deepEqual({
    received: received.join(''),
    output: (await command).output,
  }, {
    received: '',
    output: 'root\n',
  });
});

test('снятие доступа во время команды пишет причину обрыва в терминал', async (t) => {
  const { manager: value, session, transport } = await openSession(t);
  await value.setAgentAccess(session.id, true);
  const received = [];
  value.attach(session.id, { send: (data) => received.push(String(data)) });
  const command = value.exec(session.id, 'tail -f app.log');
  await new Promise((resolve) => setImmediate(resolve));
  transport.execChannels[0].emit('data', Buffer.from('строка\n'));
  await value.setAgentAccess(session.id, false);

  assert.deepEqual({
    result: (await command).error,
    terminal: received.join('').includes('прервано: access_revoked'),
  }, {
    result: 'access_revoked',
    terminal: true,
  });
});
