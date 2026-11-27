import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenAdapter, runInput } from '../helpers/qwenFixture.mjs';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { runQwenPreviewStream } from '../helpers/qwenPreviewStream.mjs';

test('Qwen: размышление дольше 30 секунд заканчивается полным ответом', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const live = [];
  let advanced = false;

  try {
    const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
      onSessionCreated() {
        t.mock.timers.enable({ apis: ['setTimeout'] });
      },
      onStep(step) {
        live.push(step);

        if (step.k === 'think' && !advanced) {
          advanced = true;
          t.mock.timers.tick(90_000);
          t.mock.timers.reset();
        }
      },
    }));

    assert.equal(advanced, true, 'Время продвигается внутри принятого prompt');
    assert.match(result.reply, /Ответ настоящего CLI/);
    assert.deepEqual(live, result.steps);
    assert.deepEqual(live.map((step) => step.k), ['start', 'think', 'text']);
  } finally {
    t.mock.timers.reset();
  }
});

test('Qwen: ожидание разрешения дольше 30 секунд сохраняет текущий ход', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  let asked = false;

  fixture.actions.push({ name: 'Bash', args: { command: 'printf synthetic' } });

  try {
    const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
      onSessionCreated() {
        t.mock.timers.enable({ apis: ['setTimeout'] });
      },
      /**
       * Продвигаются часы уже принятого prompt, пока CLI ждёт человека.
       * До ответа возвращаются настоящие таймеры для завершения процесса.
       */
      async onPermission() {
        asked = true;
        t.mock.timers.tick(90_000);
        t.mock.timers.reset();

        return { allow: false };
      },
    }));

    assert.equal(asked, true);
    assert.match(result.reply, /Ответ настоящего CLI/);
  } finally {
    t.mock.timers.reset();
  }
});

test('Qwen: ошибка CLI после долгого размышления сохраняет свою причину и хвост', async (t) => {
  const live = [];
  let advanced = false;
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Долгое размышление' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Частичный ответ' } },
  ];

  try {
    await assert.rejects(runQwenPreviewStream(t, updates, {
      onSessionCreated() {
        t.mock.timers.enable({ apis: ['setTimeout'] });
      },
      onStep(step) {
        live.push(step);

        if (step.k === 'think' && !advanced) {
          advanced = true;
          t.mock.timers.tick(90_000);
          t.mock.timers.reset();
        }
      },
    }, new Error('synthetic stream failure')), /synthetic stream failure/);

    assert.equal(advanced, true);
    assert.equal(live.filter((step) => step.k === 'text').at(-1).text, 'Частичный ответ');
  } finally {
    t.mock.timers.reset();
  }
});

test('Qwen: остановка долгого хода отменяет позднее разрешение', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const controller = new AbortController();
  const effect = path.join(fixture.workspace, 'late-effect');

  fixture.actions.push({ name: 'Bash', args: { command: `printf synthetic > '${effect}'` } });

  try {
    await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
      signal: controller.signal,
      onSessionCreated() {
        t.mock.timers.enable({ apis: ['setTimeout'] });
      },
      /**
       * Отмена приходит после прежнего срока ожидания и до позднего allow.
       * Исходные таймеры дают штатной уборке завершить собственный процесс.
       */
      async onPermission() {
        t.mock.timers.tick(90_000);
        t.mock.timers.reset();
        controller.abort();

        return { allow: true };
      },
    })), /ход отменён/);

    await assert.rejects(access(effect), { code: 'ENOENT' });
    assert.equal(fixture.actions.length, 0);
  } finally {
    t.mock.timers.reset();
    controller.abort();
  }
});
