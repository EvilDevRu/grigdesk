import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createPermissionQueue } from '../../server/src/lib/chat/permissionQueue.ts';

async function managerFactory() {
  try {
    const module = await import('../../server/src/lib/db/sessionManager.ts');
    return module.createDbSessionManager || module.default;
  } catch (error) {
    assert.fail(`server-owned DB lifecycle ещё не реализован: ${error.message}`);
  }
}

test('закрытие SSH-сессии рвёт все связанные DB-подключения и ожидания', async () => {
  const sshSessions = new EventEmitter();
  const channels = [];
  sshSessions.get = (id) => ({
    id,
    projectId: 'project-a',
    generation: 1,
    alive: true,
  });
  const openForward = async () => {
    const channel = new EventEmitter();
    channel.closed = false;
    channel.close = () => {
      channel.closed = true;
    };
    channel.destroy = channel.close;
    channels.push(channel);
    return channel;
  };
  sshSessions.forwardOut = openForward;
  sshSessions.openForward = openForward;
  sshSessions.subscribe = (listener) => {
    sshSessions.on('change', listener);
    return () => sshSessions.off('change', listener);
  };
  const queue = createPermissionQueue({ timeoutMs: 24 * 60 * 60 * 1000 });
  const closed = [];
  const cancelled = [];
  let handles = 0;
  const create = await managerFactory();
  const manager = create({
    sshSessions,
    permissionQueue: queue,
    engines: {
      get: () => ({
        id: 'mysql',
        async open() {
          handles += 1;
          const id = `handle-${handles}`;
          return {
            close() {
              closed.push(id);
            },
          };
        },
        cancel(_handle, run) {
          cancelled.push(run.id);
        },
      }),
    },
  });
  const firstVia = await manager.open({
    profile: {
      id: 'profile-via-a', projectId: 'project-a', label: 'Через bastion A', role: 'read',
      engine: 'mysql', host: 'db.internal', port: 3306, user: 'reader', database: 'orders',
      prod: true, via: 'ssh',
    },
    password: Buffer.from('secret'),
    sshSessionId: 'ssh-a',
  });
  const secondVia = await manager.open({
    profile: {
      id: 'profile-via-b', projectId: 'project-a', label: 'Через bastion B', role: 'read',
      engine: 'mysql', host: 'analytics.internal', port: 9000, user: 'reader',
      database: 'events', prod: true, via: 'ssh',
    },
    password: Buffer.from('secret'),
    sshSessionId: 'ssh-a',
  });
  await manager.open({
    profile: {
      id: 'profile-other-ssh', projectId: 'project-a', label: 'Другой bastion', role: 'read',
      engine: 'mysql', host: 'db.internal', port: 3306, user: 'reader', database: 'orders',
      prod: false, via: 'ssh',
    },
    password: Buffer.from('secret'),
    sshSessionId: 'ssh-b',
  });
  await manager.open({
    profile: {
      id: 'profile-direct', projectId: 'project-a', label: 'Прямая', role: 'read',
      engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'reader', database: 'local',
      prod: false, via: 'direct',
    },
    password: Buffer.from('secret'),
  });
  manager.trackRun(firstVia.id, { id: 'run-a' });
  manager.trackRun(secondVia.id, { id: 'run-b' });
  const firstPending = queue.enqueue({
    origin: 'db',
    sessionId: firstVia.id,
    presentation: { query: 'SELECT 1' },
  });
  const secondPending = queue.enqueue({
    origin: 'db',
    sessionId: secondVia.id,
    presentation: { query: 'SELECT 2' },
  });
  sshSessions.emit('lost', { session: { id: 'ssh-a' }, reason: 'session_lost' });
  sshSessions.emit('change', {
    type: 'lost', session: { id: 'ssh-a' }, reason: 'session_lost',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual({
    sessions: manager.list().map((session) => session.label),
    closed: closed.sort(),
    channelStates: channels.map((channel) => channel.closed),
    cancelled: cancelled.sort(),
    approvals: [await firstPending.result, await secondPending.result],
  }, {
    sessions: ['Другой bastion', 'Прямая'],
    closed: ['handle-1', 'handle-2'],
    channelStates: [true, true, false],
    cancelled: ['run-a', 'run-b'],
    approvals: [
      { allow: false, error: 'session_lost' },
      { allow: false, error: 'session_lost' },
    ],
  });
});

test('движок получает фабрику служебных каналов, и закрытие сессии снимает их все', async () => {
  const sshSessions = new EventEmitter();
  const channels = [];
  const openForward = async (id, request) => {
    const channel = new EventEmitter();
    channel.closed = false;
    channel.target = `${request.host}:${request.port}`;
    channel.close = () => {
      channel.closed = true;
    };
    channel.destroy = channel.close;
    channels.push(channel);
    return channel;
  };
  sshSessions.get = (id) => ({ id, projectId: 'project-a', generation: 1, alive: true });
  sshSessions.forwardOut = openForward;
  sshSessions.subscribe = (listener) => {
    sshSessions.on('change', listener);
    return () => sshSessions.off('change', listener);
  };
  const received = {};
  const create = await managerFactory();
  const manager = create({
    sshSessions,
    permissionQueue: createPermissionQueue({ timeoutMs: 1000 }),
    engines: {
      get: () => ({
        id: 'mysql',
        async open({ stream, openStream }) {
          received.worker = stream;
          received.factory = typeof openStream;
          received.service = typeof openStream === 'function' ? await openStream() : null;
          return { close() {} };
        },
        cancel() {},
      }),
    },
  });
  const session = await manager.open({
    profile: {
      id: 'profile-a', projectId: 'project-a', label: 'Аналитика', role: 'read',
      engine: 'mysql', host: 'db.internal', port: 3306, user: 'reader', via: 'ssh',
    },
    password: Buffer.from('secret'),
    sshSessionId: 'ssh-a',
  });
  await manager.close(session.id, 'closed_by_human');

  assert.deepEqual({
    factory: received.factory,
    distinct: received.worker !== received.service && Boolean(received.service),
    opened: channels.length,
    closed: channels.map((channel) => channel.closed),
  }, {
    factory: 'function',
    distinct: true,
    opened: 2,
    closed: [true, true],
  });
});
