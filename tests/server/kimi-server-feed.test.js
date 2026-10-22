import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runKimiServerTurn } from '../../server/src/lib/kimi/serverTurn.ts';
import { kimiUsageWire } from '../helpers/kimiUsageWire.mjs';
import { compileVue, webFile } from '../web/helpers/compile-vue.js';
import { createUiBrowser } from '../web/helpers/ui-components.js';

const calls = [
  {
    toolCallId: 'command',
    name: 'Bash',
    args: { command: 'printf baseline' },
    display: { kind: 'command', description: 'Проверить команду' },
  },
  {
    toolCallId: 'read',
    name: 'ReadFile',
    args: { path: 'fixture.txt' },
    display: { kind: 'file' },
  },
  {
    toolCallId: 'edit',
    name: 'Edit',
    args: { path: 'fixture.txt' },
    display: {
      kind: 'diff',
      path: 'fixture.txt',
      before: 'старое',
      after: 'новое',
    },
  },
  {
    toolCallId: 'search',
    name: 'Grep',
    args: { pattern: 'baseline', path: 'src' },
    display: { kind: 'search', description: 'Искать baseline в src' },
  },
  {
    toolCallId: 'mcp',
    name: 'mcp__fixture__lookup',
    args: { query: 'baseline' },
    display: { description: 'Поиск baseline через MCP' },
  },
  {
    toolCallId: 'unknown',
    name: 'FixtureUnknown',
    args: { query: 'baseline' },
  },
];

const prefix = [
  { type: 'thinking.delta', delta: 'Сверяю ' },
  { type: 'agent.status.updated', contextTokens: 100 },
  { type: 'thinking.delta', delta: 'два\n' },
  { type: 'session.usage_updated', usage: { context_tokens: 101 } },
  { type: 'thinking.delta', delta: 'файла.' },
  { type: 'thinking.delta', delta: ' \n' },
];
const reply = {
  type: 'assistant.completed',
  message_id: 'reply',
  content: [{ type: 'text', text: 'Ответ на уточнение.' }],
};
const ending = { type: 'turn.ended', reason: 'completed' };

/**
 * Настоящий серверный драйвер получает искусственные кадры без модели и инструментов.
 * Даже при отказе наружу возвращаются шаги, уже доставленные через onStep.
 */
async function collect(t, script, options = {}) {
  const steps = [];
  const controller = new AbortController();
  const wire = await kimiUsageWire(t, [script]);

  t.after(() => controller.abort());

  try {
    const result = await runKimiServerTurn({
      bin: '/bin/true',
      home: '/tmp',
      message: 'Синтетическая проверка ленты',
      ...wire,
      signal: controller.signal,
      ...options,
      onStep: (step) => {
        steps.push(step);
        options.onStep?.(step);
      },
    });

    assert.deepEqual(result.steps, steps);

    return { steps, result };
  } catch (error) {
    return { steps, error };
  }
}

const thoughts = (steps) => steps.filter((step) => step.k === 'think').map((step) => step.text);

test('К1, К4, К5: все окончания сохраняют хвост ровно один раз', async (t) => {
  const endings = [
    ending,
    { type: 'turn.ended', reason: 'cancelled' },
    { type: 'turn.ended', reason: 'failed' },
    { type: 'turn.ended', reason: 'blocked' },
    { type: 'prompt.aborted' },
    { type: 'turn.step.interrupted' },
  ];

  for (const terminal of endings) {
    await t.test(JSON.stringify(terminal), async (child) => {
      const outcome = await collect(child, (send) => [...prefix, terminal, terminal].forEach(send));

      assert.deepEqual(thoughts(outcome.steps), ['Сверяю два\nфайла.']);
      assert.equal(Boolean(outcome.error), terminal !== ending);
    });
  }
});

test('К1, К5: AbortSignal и закрытие либо ошибка потока сохраняют накопленный хвост', async (t) => {
  for (const mode of ['abort', 'close', 'error']) {
    await t.test(mode, async (child) => {
      const original = globalThis.WebSocket;
      const controller = new AbortController();
      const received = Promise.withResolvers();
      let socket;

      globalThis.WebSocket = class extends original {
        constructor(...args) {
          super(...args);
          socket = this;
        }
      };

      child.after(() => {
        globalThis.WebSocket = original;
      });

      const running = collect(child, (send) => {
        prefix.forEach(send);
        send({ type: 'agent.status.updated', contextTokens: 102 });
      }, {
        signal: controller.signal,
        onProgress: (_tokens, info) => {
          if (info.contextTokens === 102) {
            received.resolve();
          }
        },
      });

      await received.promise;

      if (mode === 'abort') {
        controller.abort();
      } else if (mode === 'close') {
        socket.close();
      } else {
        socket.dispatchEvent(new Event('error'));
      }

      const outcome = await running;

      assert.ok(outcome.error);
      assert.deepEqual(thoughts(outcome.steps), ['Сверяю два\nфайла.']);
    });
  }
});

test('К1, К4: реплика, шаг, результат и спрос разделяют мысли, служебные статусы не делят', async (t) => {
  const events = [
    ...prefix,
    reply,
    { type: 'thinking.delta', delta: 'Перед вопросом.' },
    { type: 'question.requested', question_id: 'fixture-question' },
    { type: 'question.answered', question_id: 'fixture-question' },
    { type: 'thinking.delta', delta: 'Перед разрешением.' },
    { type: 'approval.requested', approval_id: 'fixture-approval' },
    { type: 'approval.resolved', approval_id: 'fixture-approval' },
    { type: 'thinking.delta', delta: 'Перед шагом.' },
    { type: 'turn.step.completed' },
    { type: 'turn.step.started' },
    { type: 'thinking.delta', delta: 'Перед результатом.' },
    {
      type: 'tool.result',
      toolCallId: 'past-call',
      output: 'Итог',
    },
    { type: 'thinking.delta', delta: 'После результата.' },
    ending,
  ];
  const outcome = await collect(t, (send) => events.forEach(send));

  assert.equal(outcome.error, undefined);
  assert.deepEqual(thoughts(outcome.steps), [
    'Сверяю два\nфайла.', 'Перед вопросом.', 'Перед разрешением.',
    'Перед шагом.', 'Перед результатом.', 'После результата.',
  ]);
  assert.deepEqual(outcome.steps.map((step) => step.k), [
    'think', 'text', 'think', 'think', 'think', 'think', 'res', 'think',
  ]);
});

test('К1, К4: принятое уточнение разделяет мысль с её продолжением и сохраняет время', async (t) => {
  const received = Promise.withResolvers();
  const ready = Promise.withResolvers();
  let sendNext;
  const running = collect(t, (send) => {
    sendNext = send;
    prefix.forEach(send);
    send({ type: 'agent.status.updated', contextTokens: 102 });
  }, {
    onInTurnReady: (port) => ready.resolve(port),
    onProgress: (_tokens, info) => {
      if (info.contextTokens === 102) {
        received.resolve();
      }
    },
  });

  const port = await ready.promise;

  await received.promise;

  const acceptedAt = Date.now();
  const delivered = await port.deliver({
    messageId: 'fixture-steer',
    text: 'Уточнение',
    sequence: 1,
  });

  assert.equal(delivered.ok, true);
  sendNext({ type: 'thinking.delta', delta: 'После уточнения.' });
  sendNext(ending);

  const outcome = await running;

  assert.equal(outcome.error, undefined);
  assert.deepEqual(thoughts(outcome.steps), ['Сверяю два\nфайла.', 'После уточнения.']);
  assert.ok(outcome.steps[0].at <= acceptedAt);
});

test('К1, К2: пустое размышление исчезает, неизвестный инструмент имеет запасную подпись', async (t) => {
  const outcome = await collect(t, (send) => [
    { type: 'thinking.delta', delta: ' \n\t' },
    {
      type: 'tool.call.started',
      toolCallId: 'anonymous',
      name: '  ',
      display: null,
      args: null,
    },
    { type: 'thinking.delta', delta: '' },
    ending,
  ].forEach(send));

  assert.equal(outcome.error, undefined);
  assert.deepEqual(thoughts(outcome.steps), []);
  assert.equal(outcome.steps[0].name, 'Инструмент');
  assert.equal(outcome.steps[0].title, 'Инструмент');
});

test('К4: уточнение разделяет мысли до ответа HTTP-доставки, включая отказ', async (t) => {
  for (const ok of [true, false]) {
    await t.test(ok ? 'доставлено' : 'отказ', async (child) => {
      const received = Promise.withResolvers();
      const during = Promise.withResolvers();
      const ready = Promise.withResolvers();
      let sendNext;
      const wire = await kimiUsageWire(child, [(send) => {
        sendNext = send;
        send({ type: 'thinking.delta', delta: 'До уточнения.' });
        send({ type: 'agent.status.updated', contextTokens: 1 });
      }]);
      const server = await wire.startServer();
      const controller = new AbortController();

      child.after(() => controller.abort());
      server.client.deliverInTurn = async () => {
        sendNext({ type: 'thinking.delta', delta: 'После уточнения.' });
        sendNext({ type: 'agent.status.updated', contextTokens: 2 });
        await during.promise;

        return {
          ok,
          state: 'forwarded',
          code: 'synthetic_rejection',
        };
      };

      const running = runKimiServerTurn({
        bin: '/bin/true',
        home: '/tmp',
        message: 'Синтетическая проверка уточнения',
        startServer: async () => server,
        signal: controller.signal,
        onInTurnReady: (port) => ready.resolve(port),
        onProgress: (_tokens, info) => {
          if (info.contextTokens === 1) {
            received.resolve();
          }

          if (info.contextTokens === 2) {
            during.resolve();
          }
        },
      });
      const port = await ready.promise;

      await received.promise;
      // Разные миллисекунды позволяют проверить реальную границу receipt.acceptedAt.
      // Барьер during гарантирует обработку WS-дельты до ответа HTTP, без гонки таймеров.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const acceptedAt = Date.now();

      await new Promise((resolve) => setTimeout(resolve, 10));
      await port.deliver({
        messageId: 'steer',
        text: 'Уточнение',
        sequence: 1,
      });
      sendNext(ending);

      const result = await running;

      assert.deepEqual(thoughts(result.steps), ['До уточнения.', 'После уточнения.']);
      assert.ok(result.steps[0].at <= acceptedAt);
      assert.ok(result.steps[1].at > acceptedAt);
    });
  }
});

test('К2, К5: путь в подробностях и diff сохраняет начальные и конечные пробелы', async (t) => {
  const path = ' fixture.txt ';
  const outcome = await collect(t, (send) => {
    for (const source of ['display', 'path', 'file_path']) {
      send({
        type: 'tool.call.started',
        toolCallId: source,
        name: 'Edit',
        args: source === 'display' ? null : { [source]: path },
        display: {
          kind: 'diff',
          before: 'до',
          after: 'после',
          ...(source === 'display' ? { path } : {}),
        },
      });
    }

    send(ending);
  });

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.steps.length, 3);

  for (const step of outcome.steps) {
    assert.equal(step.sub, path);
    assert.deepEqual(step.files, [path]);
    assert.equal(step.changes[0].path, path);
    assert.deepEqual(step.changes[0].diff, { old: 'до', new: 'после' });
  }
});

test('К1–К5: живой серверный поток, итог и JSON читаются одинаково настоящим StepList', async (t) => {
  const checkpoint = Promise.withResolvers();
  const liveSteps = [];
  let resume;
  const running = collect(t, (send) => {
    prefix.forEach(send);
    calls.forEach((call) => send({ type: 'tool.call.started', ...call }));
    send(reply);
    [...calls].reverse().forEach((call) => send({
      type: 'tool.result',
      toolCallId: call.toolCallId,
      output: `Итог ${call.toolCallId}`,
      isError: call.toolCallId === 'read',
    }));
    send({ type: 'thinking.delta', delta: 'После ' });
    send({ type: 'thinking.delta', delta: 'действий.' });
    send({ type: 'question.requested', question_id: 'fixture-question' });
    resume = () => send(ending);
  }, {
    onQuestion: () => checkpoint.resolve(),
    onStep: (step) => liveSteps.push(step),
  });

  await checkpoint.promise;

  const browser = await createUiBrowser();

  t.after(() => browser.close());

  const StepList = await compileVue(webFile('src/views/chat/StepList.vue'));
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let outcome;

  // Барьер спроса удерживает настоящий ход: это mount до turn.ended, а не смена флага после итога.
  // Шаги собираются тем же callback, который в продукте питает SSE и сохранение.
  for (const mode of ['live', 'completed', 'json']) {
    const live = mode === 'live';

    if (!live && !outcome) {
      resume();
      outcome = await running;
      assert.equal(outcome.error, undefined);
    }

    const data = live ? liveSteps : mode === 'completed' ? outcome.steps
      : JSON.parse(JSON.stringify(outcome.steps));
    const wrapper = mount(StepList, {
      props: { live, steps: data },
      attachTo: browser.document.querySelector('#mount'),
    });

    try {
      if (!live) {
        await wrapper.find('.summary-disclosure').trigger('click');
      }

      assert.equal(wrapper.findAll('.step.think').length, 2);
      assert.equal(wrapper.findAll('.step.res').length, 0);

      const rows = wrapper.findAll('.step.tool');

      assert.equal(rows.length, 6);
      assert.deepEqual(rows.map((row) => row.find('.mark').text()), ['✓', '✕', '✓', '✓', '✓', '✓']);

      for (const [index, row] of rows.entries()) {
        assert.ok(row.find('.nm').text().trim());
        assert.ok(row.find('.ttl').text().trim());
        await row.find('.head').trigger('click');
        assert.ok(row.text().includes(`Итог ${calls[index].toolCallId}`));
      }

      assert.equal(rows[0].find('.body.command').text(), 'printf baseline');
      assert.equal(rows[1].find('.path').text(), 'fixture.txt');
      assert.ok(rows[2].find('.changes').text().includes('старое'));
      assert.ok(rows[2].find('.changes').text().includes('новое'));
      assert.equal(rows[4].find('.nm').text(), 'fixture · lookup');
      assert.equal(rows[5].find('.nm').text(), 'FixtureUnknown');
    } finally {
      wrapper.unmount();
    }
  }

  assert.deepEqual(thoughts(outcome.steps), ['Сверяю два\nфайла.', 'После действий.']);
  assert.equal(outcome.steps.filter((step) => step.k === 'tool').length, 6);
});

