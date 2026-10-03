import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { STEP_THINK_LIMIT } from '../../server/src/lib/chat/streamSteps.ts';
import { DeepSeekWebClient } from '../../server/src/lib/deepseek/serverClient.ts';
import { runDeepSeekServerTurn, storageMessageId } from '../../server/src/lib/deepseek/serverTurn.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const websocket = requireServer('@fastify/websocket');

function streamChunk(chunk, attemptId = 'attempt-1') {
  return {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId,
      chunk,
    },
  };
}

function thought(text, index = 0, attemptId = 'attempt-1') {
  return streamChunk({
    type: 'reasoning-delta',
    index,
    text,
  }, attemptId);
}

function thoughtEnd(text, index = 0, attemptId = 'attempt-1') {
  return streamChunk({
    type: 'block-end',
    index,
    block: { type: 'reasoning', text },
  }, attemptId);
}

function wireEvent(type, data = {}) {
  return { type: 'event', event: { type, data } };
}

/**
 * Настоящий web-адаптер читает синтетические кадры через HTTP и WebSocket DSH.
 * Проверяем и итоговую ленту, и каждый транслированный шаг без запуска модели.
 */
async function runWire(t, frames, reason = { kind: 'completed' }) {
  const app = Fastify();
  const subscriptions = new Map();
  const broadcast = [];
  const messages = [];

  await app.register(websocket);
  t.after(() => app.close());

  const send = (subscription, value) => {
    subscription.socket.send(JSON.stringify({
      type: 'item',
      streamId: subscription.streamId,
      value,
    }));
  };

  app.get('/', (_request, reply) => reply
    .header('set-cookie', 'fixture=valid; HttpOnly').code(303).send());
  app.post('/api/*', async (request) => {
    const body = request.body;
    let value = {};

    if (body.method === 'session/create') {
      value = { sessionId: 'fixture-session' };
    }

    if (body.method === 'session/prompt') {
      value = { accepted: true };
      queueMicrotask(() => {
        const follow = subscriptions.get('session/follow');

        send(follow, wireEvent('turn/start'));

        for (const frame of frames) {
          send(follow, frame);
        }

        send(follow, wireEvent('turn/end', { reason }));
      });
    }

    return {
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value },
    };
  });
  app.get('/api/remote.mux', { websocket: true }, (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));

      if (frame.type !== 'open') {
        return;
      }

      const subscription = { socket, streamId: frame.streamId };

      subscriptions.set(frame.endpoint, subscription);
      send(subscription, frame.endpoint === 'session/follow'
        ? { type: 'snapshot', records: [] }
        : { type: 'ready', clientId: 'fixture-client' });
    });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const client = await DeepSeekWebClient.authenticate(`${app.listeningOrigin}/?token=fixture`);
  const result = await runDeepSeekServerTurn({
    bin: '/bin/true',
    overlayPath: '/unused',
    cwd: '/tmp',
    env: {},
    message: 'Проверь ленту.',
    onStep: (step) => broadcast.push(step),
    onAssistantMessage: (event) => messages.push(event),
    startServer: async () => ({ client, stop: async () => {} }),
  }).catch((error) => error);

  return {
    result,
    broadcast,
    messages,
  };
}

test('web: сотни фрагментов дают одно размышление в ленте и трансляции', async (t) => {
  const fragments = Array.from({ length: 50 }, () => [
    'Нужно ', 'по', 'нять', ', ', 'что ', 'уже ', 'реали', 'зова', 'но', '. ',
  ]).flat();
  const text = fragments.join('');
  const frames = fragments.map((fragment) => thought(fragment));

  frames.splice(250, 0, streamChunk({ type: 'usage', usage: { outputTokens: 100 } }));
  frames.push(thoughtEnd(text), thoughtEnd(text), thought('запоздавшая дельта'));
  frames.push(streamChunk({
    type: 'block-end',
    index: 1,
    block: { type: 'text', text: 'Готово.' },
  }));

  const { result, broadcast, messages } = await runWire(t, frames);
  const expected = [text.trim()];

  assert.equal(result.reply, 'Готово.');
  assert.deepEqual(result.steps.filter((step) => step.k === 'think').map((step) => step.text), expected);
  assert.deepEqual(broadcast.filter((step) => step.k === 'think').map((step) => step.text), expected);
  assert.equal(broadcast.length, 2);
  assert.equal(result.steps.some((step) => step.truncated), false);
  assert.deepEqual(messages.map((message) => message.text), ['Готово.']);
});

test('web: границы ответа, инструмента и попытки сохраняют цельные размышления', async (t) => {
  const frames = [
    thought('Первый '),
    thought('блок'),
    thoughtEnd('Первый блок.'),
    streamChunk({
      type: 'text-delta',
      index: 1,
      text: 'Ответ.',
    }),
    thought('Перед ', 2),
    thought('инструментом.', 2),
    wireEvent('tool/call', {
      callId: 'read-1',
      name: 'read',
      arguments: '{}',
    }),
    thought('До смены попытки.', 3),
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-2' } },
    thought('Новая попытка.', 0, 'attempt-2'),
    thought('Другой блок.', 1, 'attempt-2'),
  ];
  const { result, broadcast } = await runWire(t, frames);

  assert.deepEqual(broadcast.map((step) => [step.k, step.text]), [
    ['think', 'Первый блок.'],
    ['text', 'Ответ.'],
    ['think', 'Перед инструментом.'],
    ['tool', '{}'],
    ['think', 'До смены попытки.'],
    ['think', 'Новая попытка.'],
    ['think', 'Другой блок.'],
  ]);
  assert.deepEqual(result.steps, broadcast);
});

test('web: размышление без block-end закрывается перед текстовой дельтой', async (t) => {
  const { broadcast } = await runWire(t, [
    thought('Проверил '),
    thought('файл.'),
    streamChunk({
      type: 'text-delta',
      index: 1,
      text: 'Ответ.',
    }),
  ]);

  assert.deepEqual(broadcast.map((step) => step.k), ['think', 'text']);
  assert.equal(broadcast[0].text, 'Проверил файл.');
});

test('web: пустые размышления пропускаются, длинный блок явно ограничен', async (t) => {
  const { result, broadcast } = await runWire(t, [
    thought('  \n'),
    thoughtEnd('  \n'),
    thought('я'.repeat(20_000), 1),
  ]);

  assert.equal(broadcast.length, 1);
  assert.equal(broadcast[0].text, `${'я'.repeat(STEP_THINK_LIMIT)}…`);
  assert.deepEqual(result.steps, broadcast);
});

test('web: ошибка и остановка сохраняют незакрытое размышление в трансляции', async (t) => {
  for (const reason of [
    { kind: 'error', error: { message: 'Ошибка сети' } },
    { kind: 'interrupted' },
  ]) {
    const { result, broadcast } = await runWire(t, [thought('Незавершённый '), thought('блок.')], reason);

    assert.deepEqual(broadcast.map((step) => step.text), ['Незавершённый блок.']);

    if (reason.kind === 'interrupted') {
      assert.equal(result.stopped, true);
    } else {
      assert.equal(result.deliveryFailure, true);
      assert.deepEqual(result.steps, broadcast);
    }
  }
});

function attemptFrame(type, attemptId, extra = {}) {
  return {
    type: 'assistant-stream',
    frame: {
      type,
      attemptId,
      ...extra,
    },
  };
}

function textDelta(text, attemptId = 'attempt-1') {
  return streamChunk({
    type: 'text-delta',
    index: 0,
    text,
  }, attemptId);
}

function textEnd(text, attemptId) {
  return streamChunk({
    type: 'block-end',
    index: 0,
    block: {
      type: 'text',
      text,
    },
  }, attemptId);
}

test('web: конец брошенной попытки закрывает её черновик ответа', async (t) => {
  const { result, messages } = await runWire(t, [
    attemptFrame('start', 'attempt-1'),
    textDelta('Ответ до обр'),
    attemptFrame('end', 'attempt-1', {
      outcome: {
        kind: 'abandoned',
      },
    }),
    attemptFrame('start', 'attempt-2'),
    textDelta('Полный ответ.', 'attempt-2'),
    textEnd('Полный ответ.', 'attempt-2'),
  ]);
  const cut = messages.filter((event) => event.assistantMessageId === storageMessageId('attempt-1-0'));

  assert.equal(result.reply, 'Полный ответ.');
  assert.equal(cut.at(-1).abandoned, true);
  assert.equal(cut.at(-1).text, 'Ответ до обр');
  assert.equal(cut.some((event) => event.complete), false);
});

test('web: новая попытка без кадра конца тоже бросает прежний черновик', async (t) => {
  const { messages } = await runWire(t, [
    attemptFrame('start', 'attempt-1'),
    textDelta('Первая попытка'),
    attemptFrame('start', 'attempt-2'),
    textEnd('Готово.', 'attempt-2'),
  ]);
  const cut = messages.filter((event) => event.assistantMessageId === storageMessageId('attempt-1-0'));

  assert.equal(cut.at(-1).abandoned, true);
  assert.equal(messages.filter((event) => event.abandoned).length, 1, 'завершённый ответ не бросается');
});
