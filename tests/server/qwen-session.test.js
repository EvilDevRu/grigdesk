import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  QWEN_TEST_PNG, qwenAdapter, qwenFixture, qwenImage, runInput, until,
} from '../helpers/qwenFixture.mjs';

for (const stop of [false, true]) {
  test(`Qwen: текст → картинка → текст сохраняет память, остановка=${stop}`, async (t) => {
    const fixture = await qwenFixture(t);
    const adapter = await qwenAdapter({ runnable: true });
    const attachment = await qwenImage(fixture);
    const alias = path.join(fixture.root, 'attachment-link');
    const second = path.join(fixture.root, 'second');
    const controller = new AbortController();
    const model = 'shared-model(openai)';

    await mkdir(second);
    await symlink(attachment.root, alias);
    t.after(() => controller.abort());

    const first = await adapter.run(runInput(fixture, model, {
      attachmentsDir: attachment.root,
      extraDirs: [second],
    }));

    await fixture.fake({ hold: stop, readMasks: [attachment.file] });

    const running = adapter.run(runInput(fixture, model, {
      attachmentsDir: alias,
      attachmentPaths: [path.join(alias, path.basename(attachment.file))],
      extraDirs: [alias, second],
      sessionId: first.sessionId,
      signal: controller.signal,
    }));
    const outcome = running.then((value) => ({ value }), (error) => ({ error }));

    if (stop) {
      await until(async () => (await fixture.records())
        .filter((entry) => entry.frame?.method === 'session/prompt').length === 2, 'prompt с картинкой');
      controller.abort();
    }

    const imageTurn = await outcome;

    if (stop) {
      assert.equal(imageTurn.error?.stopped, true);
      assert.equal(imageTurn.error.sessionId, first.sessionId);
    } else {
      assert.equal(imageTurn.error, undefined);
      assert.equal(imageTurn.value.sessionId, first.sessionId);
    }

    await fixture.fake({ readMasks: [attachment.file] });

    const resumed = await adapter.run(runInput(fixture, model, {
      attachmentsDir: attachment.root,
      extraDirs: [second],
      sessionId: first.sessionId,
    }));
    const records = await fixture.records();
    const prompts = records.filter((entry) => entry.frame?.method === 'session/prompt');
    const masks = records.filter((entry) => entry.event === 'mask');

    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(resumed.reply, 'Новый ответ');
    assert.equal(records.filter((entry) => entry.frame?.method === 'session/new').length, 1);
    assert.equal(records.filter((entry) => entry.frame?.method === 'session/load').length, 2);
    assert.equal(prompts.length, 3);
    assert.equal(prompts[1].frame.params.prompt[1].data, QWEN_TEST_PNG.toString('base64'));
    assert.equal(masks.length, 2);
    assert.ok(masks.every((entry) => entry.code === 'ENOENT'), 'Папка вложений не монтируется в CLI');
  });
}

for (const ignoreCancel of [false, true]) {
  test(`Qwen: остановка ждёт запись памяти в пределах срока, ignoreCancel=${ignoreCancel}`, {
    timeout: 10000,
  }, async (t) => {
    const fixture = await qwenFixture(t);
    const adapter = await qwenAdapter({ runnable: true });
    const controller = new AbortController();

    await fixture.fake({
      hold: true,
      cancelDelayMs: 150,
      ignoreCancel,
    });
    t.after(() => controller.abort());

    const running = adapter.run(runInput(fixture, 'shared-model(openai)', { signal: controller.signal }));
    const outcome = running.then((value) => ({ value }), (error) => ({ error }));

    await until(async () => (await fixture.records())
      .some((entry) => entry.frame?.method === 'session/prompt'), 'активный prompt');

    const started = performance.now();

    controller.abort();

    const stopped = await outcome;
    const records = await fixture.records();

    assert.equal(stopped.error?.stopped, true);
    assert.equal(records.some((entry) => entry.event === 'cancel-flushed'), !ignoreCancel);
    assert.ok(performance.now() - started < 5000, 'Неотзывчивый CLI не блокирует остановку');
  });
}

test('Qwen: остановленная сессия со старой привязкой вложений продолжает прежнюю память', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const attachment = await qwenImage(fixture);
  const second = path.join(fixture.root, 'second');
  const controller = new AbortController();
  const model = 'shared-model(openai)';

  await mkdir(second);
  await fixture.fake({ hold: true });
  t.after(() => controller.abort());

  // Без attachmentsDir runtime повторяет старую формулу: папка доставки входит в binding.
  // Прочие корни и профиль совпадают с будущим текстовым продолжением.
  const running = adapter.run(runInput(fixture, model, {
    extraDirs: [second, attachment.root],
    signal: controller.signal,
  }));
  const outcome = running.then((value) => ({ value }), (error) => ({ error }));

  await until(async () => (await fixture.records())
    .some((entry) => entry.frame?.method === 'session/prompt'), 'старый prompt');
  controller.abort();

  const stopped = await outcome;

  assert.equal(stopped.error?.stopped, true);
  assert.ok(stopped.error.sessionId);
  await fixture.fake({ readMasks: [attachment.file] });

  for (const withImage of [false, true, false]) {
    const resumed = await adapter.run(runInput(fixture, model, {
      attachmentsDir: attachment.root,
      extraDirs: withImage ? [second, attachment.root] : [second],
      attachmentPaths: withImage ? [attachment.file] : [],
      sessionId: stopped.error.sessionId,
    }));

    assert.equal(resumed.sessionId, stopped.error.sessionId);
    assert.equal(resumed.reply, 'Новый ответ');
  }

  const records = await fixture.records();

  assert.equal(records.filter((entry) => entry.frame?.method === 'session/new').length, 1);
  assert.equal(records.filter((entry) => entry.frame?.method === 'session/load').length, 3);
  assert.ok(records.filter((entry) => entry.event === 'mask').every((entry) => entry.code === 'ENOENT'));

  for (const changed of [
    { chatKey: 'other-chat' },
    { cwd: second },
    { extraDirs: [] },
    { sessionId: randomUUID() },
  ]) {
    await assert.rejects(adapter.run(runInput(fixture, model, {
      attachmentsDir: attachment.root,
      extraDirs: [second],
      sessionId: stopped.error.sessionId,
      ...changed,
    })), /identity сессии/);
  }

  process.env.QWEN_TEST_KEY = 'synthetic-changed-key';
  await assert.rejects(adapter.run(runInput(fixture, model, {
    attachmentsDir: attachment.root,
    extraDirs: [second],
    sessionId: stopped.error.sessionId,
  })), /identity сессии/);
  assert.equal((await fixture.records()).length, records.length, 'Чужая память не запускает CLI');
});
