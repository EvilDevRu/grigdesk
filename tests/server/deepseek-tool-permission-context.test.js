import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolPermissionContexts,
  createDeepSeekToolPermissionObserver,
} from '../../server/src/lib/deepseek/toolPermissionContext.ts';
import { createScopedRemote } from '../../server/src/lib/deepseek/scopedRemote.ts';

const request = {
  agentId: 'root',
  callId: 'call',
  toolName: 'write',
};
const event = {
  type: 'tool/call',
  seq: 4,
  data: {
    turn: 1,
    callId: 'call',
    name: 'write',
    arguments: '{"file_path":"a","content":"ok"}',
  },
};

test('оба порядка доставки возвращают тот же полный контекст', async () => {
  for (const first of ['approval', 'event']) {
    const contexts = new ToolPermissionContexts('root');

    if (first === 'event') {
      contexts.note(event);
    }

    const pending = contexts.wait(request);

    if (first === 'approval') {
      contexts.note(event);
    }

    assert.deepEqual(await pending, { title: 'write', rawInput: { file_path: 'a', content: 'ok' } });
    contexts.dispose();
  }
});

test('чужой agent, конфликт имени и завершённый вызов не получают контекст', async () => {
  const contexts = new ToolPermissionContexts('root');

  contexts.note(event);
  await assert.rejects(contexts.wait({ ...request, agentId: 'child' }));
  await assert.rejects(contexts.wait({ ...request, toolName: 'bash' }));
  contexts.note({ type: 'tool/result', data: { callId: 'call' } });
  await assert.rejects(contexts.wait(request));
  contexts.dispose();
});

test('отмена и исчезнувшее событие завершают ожидание без выдуманных args', async () => {
  const contexts = new ToolPermissionContexts('root', 5);
  const abort = new AbortController();
  const pending = contexts.wait(request, abort.signal);

  abort.abort();
  await assert.rejects(pending);
  await assert.rejects(contexts.wait(request), /контекст/iu);
  contexts.dispose();
});

test('повтор callId не переносит прежнее разрешение в новый turn', async () => {
  const contexts = new ToolPermissionContexts('root');

  contexts.note(event);
  contexts.note({ type: 'tool/result', data: { callId: 'call' } });
  contexts.note({ ...event, data: {
    ...event.data,
    turn: 2,
    arguments: '{}',
  } });
  await assert.rejects(contexts.wait(request));
  contexts.dispose();
});

test('конфликт того же sequence и nested tool/result не оставляют старые args', async () => {
  const contexts = new ToolPermissionContexts('root');

  contexts.note(event);
  contexts.note({ ...event, data: { ...event.data, arguments: '{"content":"other"}' } });
  await assert.rejects(contexts.wait(request));
  contexts.dispose();

  const nested = new ToolPermissionContexts('root');

  nested.note(event);
  nested.note({ type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call' } } } });
  await assert.rejects(nested.wait(request));
  nested.dispose();
});

test('таймер контекста не ограничивает человека; cancel отменяет поздний allow', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const observer = createDeepSeekToolPermissionObserver('root', 'default');
  const statuses = [];
  const responses = [];
  let questions = 0;
  let release;
  const human = new Promise((resolve) => {
    release = resolve;
  });
  const remote = createScopedRemote({
    client: { answerEvent: async (...args) => {
      responses.push(args);
    } },
    signal: new AbortController().signal,
    source: 'DeepSeek',
    approve: observer.approve,
    onPermission: async () => {
      questions += 1;

      return human;
    },
    onAwaiting: (value) => statuses.push(value),
    onFailure: (error) => assert.fail(error),
  });

  observer.observe({ type: 'event', event });
  remote.observe({ type: 'ready', clientId: 'connection' });
  remote.observe({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'permission',
    agentId: 'root',
    request: { callId: 'call', toolName: 'write' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions, 1);
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1), true);
  assert.equal(responses.length, 0);
  remote.observe({ type: 'cancel', eventId: 'permission' });
  release({ allow: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1), false);
  assert.equal(responses.length, 0);
  remote.close();
  observer.close();
});
