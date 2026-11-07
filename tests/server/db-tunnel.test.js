import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createSshSessionManager } from '../../server/src/lib/ssh/sessionManager.ts';
import { createSshTransport } from '../../server/src/lib/ssh/transport.ts';

class FakeClient extends EventEmitter {
  connect() {
    queueMicrotask(() => this.emit('ready'));
  }

  forwardOut(sourceHost, sourcePort, host, port, callback) {
    this.forwardArgs = { sourceHost, sourcePort, host, port };
    this.channel = new EventEmitter();
    this.channel.destroy = () => {
      this.channel.closed = true;
    };
    callback(null, this.channel);
  }

  end() {}
}

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  end() {
    this.close();
  }

  destroy() {
    this.close();
  }
}

class FakeSshTransport extends EventEmitter {
  constructor() {
    super();
    this.shellChannel = new FakeChannel();
    this.forwardChannels = [];
    this.forwardArgs = [];
  }

  async shell() {
    return this.shellChannel;
  }

  async forwardOut(options) {
    this.forwardArgs.push(options);
    const channel = new FakeChannel();
    this.forwardChannels.push(channel);
    return channel;
  }

  close() {
    this.emit('close');
  }
}

test('SSH transport открывает direct-tcpip канал без локального listener', async () => {
  const client = new FakeClient();
  const transport = createSshTransport({ createClient: () => client });
  const connection = await transport.connect({
    host: 'bastion.internal', port: 22, user: 'deploy', password: Buffer.from('secret'),
  });
  assert.equal(
    typeof connection.forwardOut,
    'function',
    'SSH transport ещё не предоставляет безопасный direct-tcpip канал',
  );
  const channel = await connection.forwardOut({ host: 'db.internal', port: 3306 });

  assert.deepEqual({
    args: client.forwardArgs,
    sameChannel: channel === client.channel,
    listener: connection.listener ?? null,
  }, {
    args: {
      sourceHost: '127.0.0.1',
      sourcePort: 0,
      host: 'db.internal',
      port: 3306,
    },
    sameChannel: true,
    listener: null,
  });
});

test('SSH manager закрывает все forward-каналы и не пишет их данные в terminal replay', async () => {
  const transport = new FakeSshTransport();
  const manager = createSshSessionManager({
    async connect() {
      return transport;
    },
  });
  const session = await manager.open({
    connection: {
      id: 'connection-a',
      projectId: 'project-a',
      label: 'Bastion',
      role: 'code',
      host: 'bastion.internal',
      port: 22,
      user: 'deploy',
    },
    password: Buffer.from('secret'),
  });
  const forward = manager.forwardOut || manager.openForward;
  assert.equal(
    typeof forward,
    'function',
    'SSH manager ещё не выдаёт scoped forward-каналы для DB-сессий',
  );
  const first = await forward.call(manager, session.id, {
    projectId: 'project-a',
    generation: session.generation,
    host: 'db.internal',
    port: 3306,
  });
  const second = await forward.call(manager, session.id, {
    projectId: 'project-a',
    generation: session.generation,
    host: 'analytics.internal',
    port: 9000,
  });
  const terminal = [];
  manager.attach(session.id, { send: (chunk) => terminal.push(String(chunk)) });
  first.emit('data', Buffer.from('DB_FORWARD_VALUE_SENTINEL'));
  second.emit('data', Buffer.from('DB_FORWARD_VALUE_SENTINEL_2'));
  await manager.close(session.id);

  assert.deepEqual({
    forwardArgs: transport.forwardArgs,
    channelStates: transport.forwardChannels.map((channel) => channel.closed),
    terminal: terminal.join(''),
  }, {
    forwardArgs: [
      { host: 'db.internal', port: 3306 },
      { host: 'analytics.internal', port: 9000 },
    ],
    channelStates: [true, true],
    terminal: '',
  });
});
