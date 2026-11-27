import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runQwenTurn } from '../../server/src/lib/qwen/runtime.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import {
  QWEN_TEST_PNG, qwenAdapter, qwenFixture, qwenImage, runInput, until,
} from '../helpers/qwenFixture.mjs';

for (const stop of [false, true]) {
  test(`Qwen Preview.2: текст → картинка → текст сохраняет память, остановка=${stop}`, async (t) => {
    const fixture = await qwenNativeFixture(t);
    const adapter = await qwenAdapter({ runnable: true });
    const attachment = await qwenImage(fixture);
    const alias = path.join(fixture.root, 'attachment-link');
    const second = path.join(fixture.root, 'second');
    const marker = path.join(second, 'attachment-visibility.txt');
    const controller = new AbortController();
    const model = 'shared-model(openai)';
    const original = 'Первая реплика до сообщения с картинкой';
    const imagePrompt = 'Реплика пользователя с изображением';
    const finalPrompt = 'Продолжение после сообщения с изображением';

    fixture.settings.modelProviders.openai[0].generationConfig.contextWindowSize = 200_000;
    fixture.settings.modelProviders.openai[0].generationConfig.modalities = { image: true };
    await fixture.writeSettings(fixture.settings);
    await mkdir(second);
    await symlink(attachment.root, alias);
    t.after(() => controller.abort());

    const first = await adapter.run(runInput(fixture, model, {
      message: original,
      attachmentsDir: attachment.root,
      extraDirs: [second],
    }));
    const beforeImage = fixture.requests.length;

    if (stop) {
      fixture.actions.push({
        hold: true,
        when: (body) => JSON.stringify(body.messages).includes(imagePrompt),
      });
    }

    const running = adapter.run(runInput(fixture, model, {
      message: imagePrompt,
      attachmentsDir: alias,
      attachmentPaths: [path.join(alias, path.basename(attachment.file))],
      extraDirs: [alias, second],
      sessionId: first.sessionId,
      signal: controller.signal,
    }));
    const outcome = running.then((value) => ({ value }), (error) => ({ error }));

    if (stop) {
      assert.equal(await Promise.race([fixture.held.then(() => 'held'), outcome]), 'held');
      controller.abort();
    }

    const imageTurn = await outcome;
    const imageRequests = JSON.stringify(fixture.requests.slice(beforeImage));

    if (stop) {
      assert.equal(imageTurn.error?.stopped, true);
      assert.equal(imageTurn.error.sessionId, first.sessionId);
    } else {
      assert.equal(imageTurn.error, undefined);
      assert.equal(imageTurn.value.sessionId, first.sessionId);
    }

    assert.ok(imageRequests.includes(QWEN_TEST_PNG.toString('base64')));
    fixture.actions.push({
      name: 'Bash',
      args: { command: `test ! -e '${attachment.file}' && printf hidden > '${marker}'` },
      when: (body) => JSON.stringify(body.messages).includes(finalPrompt),
    });

    const beforeResume = fixture.requests.length;
    const resumed = await adapter.run(runInput(fixture, model, {
      message: finalPrompt,
      attachmentsDir: attachment.root,
      extraDirs: [second],
      sessionId: first.sessionId,
      permissionMode: 'yolo',
    }));
    const text = JSON.stringify(fixture.requests.slice(beforeResume));

    assert.equal(resumed.sessionId, first.sessionId);
    assert.match(resumed.reply, /Ответ настоящего CLI/);
    assert.ok(text.includes(original) && text.includes(imagePrompt));
    assert.equal(await readFile(marker, 'utf8'), 'hidden');
  });
}

for (const ignoreCancel of [false, true]) {
  test(`Qwen Preview.2: ожидание записи памяти после отмены, ignoreCancel=${ignoreCancel}`, {
    timeout: 10000,
  }, async (t) => {
    const fixture = await qwenFixture(t, { prepareFake: false });
    const controller = new AbortController();
    const model = 'shared-model(openai)';
    let settlePrompt;
    let acknowledged = false;
    let closed = false;

    const running = runQwenTurn(runInput(fixture, model, { signal: controller.signal }), {
      /**
       * Имитирует задержку подтверждения ACP после отмены. Реальная память
       * отдельного процесса проверяется в сценариях с установленным Preview.2.
       */
      async openTransport(_config, _snapshot, options) {
        await mkdir(options.home, { recursive: true });

        return {
          async close() {
            closed = true;
          },
          client: {
            request(method) {
              if (method === 'session/new') {
                return Promise.resolve({
                  sessionId: 'synthetic-cancel-session',
                  configOptions: [{
                    id: 'model',
                    type: 'select',
                    currentValue: options.nativeModelId,
                  }],
                });
              }

              assert.equal(method, 'session/prompt');

              return new Promise((resolve) => {
                settlePrompt = resolve;
              });
            },
            notify(method) {
              assert.equal(method, 'session/cancel');

              if (!ignoreCancel) {
                setTimeout(() => {
                  acknowledged = true;
                  settlePrompt({ stopReason: 'cancelled' });
                }, 150);
              }
            },
          },
        };
      },
    });
    const stopped = assert.rejects(running, (error) => error.stopped === true);

    await until(() => settlePrompt, 'активный prompt');

    const started = performance.now();

    controller.abort();
    await stopped;
    assert.equal(acknowledged, !ignoreCancel);
    assert.equal(closed, true);
    assert.ok(performance.now() - started < 5000, 'Неотзывчивый CLI не блокирует остановку');
  });
}

test('Qwen Preview.2 привязывает память к выданному чату, корням и доступу', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const second = path.join(fixture.root, 'second');
  const model = 'shared-model(openai)';

  await mkdir(second);

  const first = await adapter.run(runInput(fixture, model, { extraDirs: [second] }));
  const before = fixture.requests.length;

  for (const changed of [
    { chatKey: 'other-chat' },
    { cwd: second },
    { extraDirs: [] },
    { sessionId: randomUUID() },
  ]) {
    await assert.rejects(adapter.run(runInput(fixture, model, {
      extraDirs: [second],
      sessionId: first.sessionId,
      ...changed,
    })), /identity сессии/);
  }

  process.env.QWEN_TEST_KEY = 'synthetic-changed-key';
  await assert.rejects(adapter.run(runInput(fixture, model, {
    extraDirs: [second],
    sessionId: first.sessionId,
  })), /identity сессии/);
  assert.equal(fixture.requests.length, before);
});
