import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenAdapter, qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen: размышление дольше 30 секунд заканчивается полным ответом', async (t) => {
  const fixture = await qwenFixture(t);
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
    assert.equal(result.reply, 'Новый ответ');
    assert.deepEqual(live, result.steps);
    assert.deepEqual(live.map((step) => step.k), ['start', 'think', 'text']);
  } finally {
    t.mock.timers.reset();
  }
});

test('Qwen: ожидание разрешения дольше 30 секунд сохраняет текущий ход', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  let asked = false;

  await fixture.fake({
    ask: true,
    askDeniedContinues: true,
    tool: { name: 'run_shell_command', args: { command: 'printf synthetic' } },
  });

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
    assert.equal(result.reply, 'Новый ответ');
  } finally {
    t.mock.timers.reset();
  }
});

test('Qwen: ошибка CLI после долгого размышления сохраняет свою причину и хвост', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const live = [];
  let advanced = false;

  await fixture.fake({ streamError: true });

  try {
    await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
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
    })), /synthetic stream failure/);

    assert.equal(advanced, true);
    assert.equal(live.filter((step) => step.k === 'text').at(-1).text, 'Новый ответ');
  } finally {
    t.mock.timers.reset();
  }
});

test('Qwen: остановка долгого хода отменяет позднее разрешение', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const controller = new AbortController();
  const effect = path.join(fixture.workspace, 'late-effect');

  await fixture.fake({
    ask: true,
    effect,
    tool: { name: 'run_shell_command', args: { command: 'printf synthetic' } },
  });

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
    assert.equal((await fixture.records()).some((entry) => entry.event === 'guard'), false);
  } finally {
    t.mock.timers.reset();
    controller.abort();
  }
});
