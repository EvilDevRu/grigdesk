import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { STEP_THINK_LIMIT } from '../../server/src/lib/chat/streamSteps.ts';
import { classifyTurnFailure } from '../../server/src/lib/chat/turnFailures.ts';
import { DSH_TURN_FAILURE_RULES } from '../../server/src/lib/deepseek/turnFailureRules.ts';
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
async function runWire(
  t,
  frames,
  reason = { kind: 'completed' },
  { snapshot = { type: 'snapshot', records: [] } } = {},
) {
  const app = Fastify();
  const subscriptions = new Map();
  const broadcast = [];
  const messages = [];
  const progress = [];
  const metadata = [];

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
        ? snapshot
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
    onProgress: (tokens, info = {}) => progress.push({ tokens, ...info }),
    onRunMetadata: (value) => metadata.push(value),
    startServer: async () => ({ client, stop: async () => {} }),
  }).catch((error) => error);

  return {
    result,
    broadcast,
    messages,
    progress,
    metadata,
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

  assert.deepEqual(broadcast.map((step) => [step.k, step.k === 'tool' ? step.name : step.text]), [
    ['think', 'Первый блок.'],
    ['text', 'Ответ.'],
    ['think', 'Перед инструментом.'],
    ['tool', 'Read'],
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

/**
 * `tool/call` в форме настоящего DSH: имя инструмента и аргументы модели строкой JSON.
 * Пару вызову даёт `callId`, по нему же итог находит свою строку ленты.
 */
function toolCall(callId, name, args) {
  return wireEvent('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: JSON.stringify(args),
  });
}

/**
 * `tool/result` в форме настоящего DSH: id вызова лежит в source сообщения и в блоке
 * tool-result, исход — в `isError` блока. Верхних `toolCallId` и `isError` у сообщения нет.
 */
function toolResult(callId, content, isError = false) {
  return wireEvent('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: `result-${callId}`,
      role: 'user',
      source: {
        kind: 'tool',
        callId,
      },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content,
        ...(isError ? { isError: true } : {}),
      }],
    },
  });
}

test('web: вызов и итог инструмента DSH дают одну пару с именем, заголовком и исходом', async (t) => {
  const { result, broadcast } = await runWire(t, [
    toolCall('call-1', 'bash', {
      command: 'ls -la\necho готово',
      description: 'Список файлов',
    }),
    toolCall('call-2', 'read', { file_path: 'docs/task.md' }),
    toolResult('call-1', [{ type: 'text', text: 'нет доступа' }], true),
    toolResult('call-2', [{ type: 'text', text: 'первая\nвторая' }]),
  ]);
  const tools = broadcast.filter((step) => step.k === 'tool');
  const results = broadcast.filter((step) => step.k === 'res');

  assert.deepEqual(tools.map((step) => [step.id, step.name, step.title]), [
    ['call-1', 'Bash', 'ls -la'],
    ['call-2', 'Read', 'task.md'],
  ]);
  assert.deepEqual(results.map((step) => [step.id, step.ok, step.text, step.lines]), [
    ['call-1', false, 'нет доступа', 1],
    ['call-2', true, 'первая\nвторая', 2],
  ]);
  assert.deepEqual(result.steps, broadcast);
});

test('web: шаг текста носит id блока ответа, под которым реплика сохранена', async (t) => {
  const attemptId = 'fixture-session:1';
  const { result, broadcast, messages } = await runWire(t, [
    attemptFrame('start', attemptId),
    textDelta('Пр', attemptId),
    textDelta('очитал задание.', attemptId),
    textEnd('Прочитал задание.', attemptId),
  ]);
  const texts = broadcast.filter((step) => step.k === 'text');
  const saved = result.steps.filter((step) => step.k === 'text');

  assert.equal(texts.length, 1, 'один шаг на блок ответа');
  assert.equal(texts[0].id, storageMessageId(`${attemptId}-0`));
  assert.ok(messages.every((event) => event.assistantMessageId === texts[0].id));
  assert.equal(result.assistantMessageId, texts[0].id);
  assert.deepEqual(saved.map((step) => [step.id, step.text]), [[texts[0].id, 'Прочитал задание.']]);
});

test('web: DSH называет модель сессии и ответа — запуск получает подтверждённую модель', async (t) => {
  const model = JSON.stringify(['zai', 'glm-5.3']);
  const { result, metadata } = await runWire(t, [
    textEnd('Готово.', 'attempt-1'),
    wireEvent('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Готово.' }],
        source: {
          kind: 'model',
          provider: 'zai',
          model: 'glm-5.3',
        },
      },
      stream: [],
    }),
  ], { kind: 'completed' }, {
    snapshot: {
      type: 'snapshot',
      records: [],
      projections: {
        values: {
          modelSelection: {
            lastUsed: null,
            next: {
              provider: 'zai',
              model: 'glm-5.3',
              reasoningEffort: 'high',
            },
          },
        },
      },
    },
  });

  assert.deepEqual(metadata, [
    { actualModelId: model, modelSource: 'session' },
    { actualModelId: model, modelSource: 'response' },
  ]);
  assert.equal(result.actualModel, model);
});

test('web: без названной модели подтверждения нет, а ход идёт как прежде', async (t) => {
  const { result, metadata } = await runWire(t, [textEnd('Готово.', 'attempt-1')]);

  assert.deepEqual(metadata, []);
  assert.equal(result.reply, 'Готово.');
  assert.equal('actualModel' in result, false);
});

test('web: счётчик токенов складывает расход всех запросов хода', async (t) => {
  const { progress } = await runWire(t, [
    attemptFrame('start', 'attempt-1'),
    textDelta('abc', 'attempt-1'),
    streamChunk({
      type: 'usage',
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
      },
    }, 'attempt-1'),
    attemptFrame('end', 'attempt-1', { outcome: { kind: 'committed' } }),
    attemptFrame('start', 'attempt-2'),
    thought('д'.repeat(30), 0, 'attempt-2'),
    streamChunk({
      type: 'text-delta',
      index: 1,
      text: 'x'.repeat(30),
    }, 'attempt-2'),
    streamChunk({
      type: 'usage',
      usage: {
        inputTokens: 1300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 200,
        outputTokens: 250,
      },
    }, 'attempt-2'),
  ]);

  // Размер контекста — весь вход запроса: DSH делит его на некешированную часть и кеш.
  assert.deepEqual(progress.map((entry) => [entry.tokens, entry.tokensIsEstimate, entry.contextTokens]), [
    [1, true, undefined],
    [100, false, 1000],
    [120, true, undefined],
    [350, false, 6500],
  ]);
});

// ── Сигнал сбоя DSH и признак реальной работы (этап 6 плана) ──
// Ход узнаёт об автопродолжении из явных полей результата, а не из текста ошибки.
// Код причины и признак работы приходят из настоящего результата serverTurn.

test('web: код причины из turn/end.reason.error доходит до реестра', async (t) => {
  const { result } = await runWire(
    t,
    [thought('Думаю…')],
    { kind: 'error', error: { code: 'TRANSPORT', message: 'Connection error.' } },
  );

  assert.equal(result.deliveryFailure, true);
  assert.deepEqual(result.turnFailure, {
    code: 'TRANSPORT',
    message: 'Connection error.',
  });
  assert.equal(result.turnRecovery.canContinue, true, 'окончательный исход принятого turn');
  assert.equal(result.turnRecovery.madeProgress, true, 'размышление — работа модели');
  assert.equal(result.sessionId, 'fixture-session');
  assert.equal(classifyTurnFailure(result.turnFailure, DSH_TURN_FAILURE_RULES).kind, 'network');
});

test('web: статус и код лимита, перегрузки и контекста доходят до реестра', async (t) => {
  const cases = [
    {
      code: 'RATE_LIMIT',
      status: 429,
      kind: 'rate_limited',
    },
    {
      code: 'SERVER',
      status: 503,
      kind: 'server_error',
    },
    { code: 'CONTEXT_WINDOW_EXCEEDED', kind: 'context_overflow' },
    { code: 'QUOTA', kind: 'usage_limit' },
    { code: 'AUTH', kind: 'auth' },
  ];

  for (const item of cases) {
    const { result } = await runWire(
      t,
      [],
      {
        kind: 'error',
        error: {
          code: item.code,
          ...(item.status ? { status: item.status } : {}),
          message: `${item.code} случился`,
        },
      },
    );
    const verdict = classifyTurnFailure(result.turnFailure, DSH_TURN_FAILURE_RULES);

    assert.equal(verdict.kind, item.kind, item.code);
    assert.equal(result.turnRecovery.canContinue, true, `${item.code}: исход окончателен`);
  }
});

test('web: инструмент и текст подтверждают работу, пустой ход — нет', async (t) => {
  const transport = { kind: 'error', error: { code: 'TRANSPORT', message: 'обрыв' } };
  const worked = await runWire(t, [
    wireEvent('tool/call', {
      name: 'read_file',
      arguments: '{}',
      callId: 'call-1',
    }),
  ], transport);

  assert.equal(worked.result.turnRecovery.madeProgress, true, 'инструмент — работа');

  const spoke = await runWire(t, [textDelta('Сейчас посмотрю.')], transport);

  assert.equal(spoke.result.turnRecovery.madeProgress, true, 'текст модели — работа');

  // Пустой вывод без единого события работы: сбой не подтверждает сам себя.
  const idle = await runWire(t, [], transport);

  assert.equal(idle.result.turnRecovery.madeProgress, false, 'служебные события работой не являются');
  assert.equal(idle.result.turnRecovery.canContinue, true, 'но исход окончателен');
});

test('web: остановка и прерванный ход не получают разрешения продолжать', async (t) => {
  for (const reason of [{ kind: 'interrupted' }, { kind: 'aborted' }]) {
    const { result } = await runWire(t, [], reason);

    assert.equal(result.stopped, true, reason.kind);
    assert.equal(result.turnRecovery, undefined, `${reason.kind}: Р2 не подтверждён`);
  }
});
