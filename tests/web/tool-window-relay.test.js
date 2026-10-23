import assert from 'node:assert/strict';
import test from 'node:test';
import { featureModule, tick, hostFixture } from './helpers/tool-window-harness.js';
import {
  coordinatorFixture,
  channelPair,
  instance,
  origin,
  scope
} from './helpers/tool-window-coordinator.js';

/**
 * Child исполняет настоящий receiver и передаёт intent панели только через enqueue.
 * Consume приходит отдельно: подтверждение доставки ещё не означает выполнение команды.
 */
async function receiverFixture(t) {
  const product = await featureModule('src/shared/tools/toolWindowRelay.ts');
  const channels = channelPair();
  const enqueued = [];
  const receiver = product.createToolWindowReceiver({

    origin,

    scope,

    target: { kind: 'tool', id: 'code' },

    instance,

    channel: channels.child,

    importState: async () => { },

    enqueue: (intent) => enqueued.push(intent),

  });

  t.after(() => receiver.dispose());

  return {
    receiver,
    channels,
    enqueued

  };
}

test('TW-R01: ready, очередь двух команд, duplicate до/после consume не повторяет enqueue', async (t) => {
  const f = await coordinatorFixture(t);
  const child = await receiverFixture(t);
  const one = {
    type: 'open-file',
    project: 'demo',
    repo: 'demo',
    root: '/fixture',
    path: 'a.ts',
    line: 7

  };
  const two = {
    ...one,
    path: 'b.ts',
    line: 11

  };
  const opening = f.coordinator.detach('code');

  await tick();
  await f.coordinator.activateIfDetached('code', one);
  await f.coordinator.activateIfDetached('code', two);
  assert.equal(f.channels.main.posted.filter((message) => message.type === 'command').length, 0);
  await f.ready();
  await opening;

  const init = f.channels.main.posted.find((message) => message.type === 'init');

  child.channels.child.onmessage({ data: init });
  await tick();

  const command = f.channels.main.posted.find((message) => message.type === 'command');

  assert.ok(command);
  child.channels.child.onmessage({ data: command });
  child.channels.child.onmessage({ data: command });
  await tick();
  assert.equal(child.enqueued.length, 1);
  assert.equal(child.enqueued[0].path, 'a.ts');
  assert.equal(child.channels.child.posted.some((message) => message.type === 'consumed'), false);
  child.receiver.consume(command.seq);
  await tick();
  child.channels.child.onmessage({ data: command });
  await tick();
  assert.equal(child.enqueued.length, 1);
  await f.receive('consumed', { seq: command.seq });

  const commands = f.channels.main.posted.filter((message) => message.type === 'command');

  assert.deepEqual(commands.map((message) => message.intent.path), ['a.ts', 'b.ts']);
  assert.ok(commands[1].seq > commands[0].seq);
});

test(
  'TW-R02: unknown/потерянный ack/stale scope/dispose не повторяют POST или локальную команду',
  async (t) => {
  const f = await coordinatorFixture(t, {
    native: { open: async () => ({ status: 'unknown' }), status: async () => [{ id: 'code', instance }] },
  });

  const opening = f.coordinator.detach('code');

  await tick();
  await f.ready();
  await opening;
  await f.coordinator.activateIfDetached('code', {
    type: 'open-file',
    path: 'a.ts',
    line: 7

  });

  const before = structuredClone(f.channels.main.posted);

  await f.receive('consumed', { instance: 'old-instance', seq: 1 });
  await f.receive('return', {
    scope: 'other-client',
    seq: 2,
    state: {}

  });
  assert.deepEqual(f.channels.main.posted, before);
  assert.equal(f.mounted.has('code'), false);
  assert.equal(f.nativeCalls.filter(([method]) => method === 'open').length, 1);
  assert.equal(f.nativeCalls.some(([method]) => method === 'status'), true);
  assert.deepEqual(f.dock.intents.code || [], []);
  assert.equal(f.events.some((event) => Array.isArray(event) && event[0] === 'mount:code'), false);
  f.coordinator.dispose();
  await f.receive('return', { seq: 2, state: {} });
  assert.equal(f.mounted.has('code'), false);
});

test('TW-CTX01: main capture принимает только безопасный контекст текущей instance', async (t) => {
  const f = await coordinatorFixture(t);
  const opening = f.coordinator.detach('code');

  await tick();
  await f.ready();
  await opening;
  await f.receive('context', {
    context: {

      project: 'demo',
      repository: 'demo',
      context: 'task',
      tab: 'files',
      file: 'src/a.ts',
      line: 7,

      root: '/private',
      text: 'секрет',
      commitMessage: 'черновик',
      password: 'пароль',

    }
  });

  const capture = () => f.context.capture({ path: '/chats' });

  assert.deepEqual(capture().promptContext.details.toolWindow.code, {

    id: 'code',
    presentation: 'window',
    project: 'demo',
    repository: 'demo',

    context: 'task',
    tab: 'files',
    file: 'src/a.ts',
    line: 7,

  });
  await f.receive('context', { context: { file: 'src/b.ts', line: 13 } });
  assert.equal(capture().promptContext.details.toolWindow.code.file, 'src/b.ts');
  await f.coordinator.closed({ id: 'code', instance: 'old-instance' });
  assert.equal(capture().promptContext.details.toolWindow.code.line, 13);
  assert.equal(capture().routingScope, null);
  await f.coordinator.closed({ id: 'code', instance });
  assert.equal(capture().promptContext.details?.toolWindow, undefined);
});

test('TW-CTX02: локальные Терминал/3D не вытесняют контекст оконного Кода', async (t) => {
  const host = await hostFixture(t);
  const f = await coordinatorFixture(t, { pinia: host.pinia });
  const warnings = [];
  const original = console.warn;

  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = original;
  });
  host.dock.open('code');
  await host.settle();
  host.contexts.code({ file: 'src/a.ts', line: 7 });

  const opening = f.coordinator.detach('code');

  await tick();
  await f.ready();
  await opening;
  await f.receive('context', {
    context: {
      file: 'src/a.ts',
      line: 7,
      root: '/private',
      text: 'secret'

    }
  });

  for(const id of ['terminal', 'studio3d']) {
    host.dock.open(id);
    await host.settle();
    host.contexts[id]({ id });
    await host.settle();

    const captured = f.context.capture({ path: '/chats' });

    assert.equal(captured.promptContext.details.tool.id, id);
    assert.equal(captured.promptContext.details.toolWindow.code.file, 'src/a.ts');
    assert.equal(captured.promptContext.details.toolWindow.code.line, 7);
    await f.receive('context', { context: { file: 'src/b.ts', line: 9 } });
    assert.equal(f.context.capture({ path: '/chats' }).promptContext.details.tool.id, id);
    await f.receive('context', { context: { file: 'src/a.ts', line: 7 } });
  }

  assert.equal(warnings.some((warning) => warning.includes('duplicate_source')), false);
  await f.coordinator.closed({ id: 'code', instance });
  assert.equal(f.context.capture({ path: '/chats' }).promptContext.details.tool.id, 'studio3d');
  assert.equal(f.context.capture({ path: '/chats' }).promptContext.details.toolWindow, undefined);
});
