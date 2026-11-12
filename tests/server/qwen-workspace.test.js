import assert from 'node:assert/strict';
import { access, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenAdapter, qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen: дополнительные корни проходят адаптер и доступны инструментам', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const sibling = path.join(fixture.root, 'second');
  const alias = path.join(fixture.root, 'second-link');
  const effect = path.join(sibling, 'written');

  await mkdir(sibling);
  await symlink(sibling, alias);

  const validation = await adapter.validateWorkdir({
    config: fixture.config,
    cwd: fixture.workspace,
    extraDirs: [alias, sibling, fixture.workspace],
  });

  assert.equal(validation.error, undefined);
  assert.deepEqual(validation.extraDirs, [sibling]);
  await fixture.fake({
    effect,
    tool: { name: 'write_file', args: { file_path: effect, content: 'effect' } },
  });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [alias, sibling],
    permissionMode: 'yolo',
  }));

  assert.equal(result.reply, 'Новый ответ');
  assert.equal(await readFile(effect, 'utf8'), 'effect');
});

test('Qwen: Авто передаётся CLI как отдельный режим', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await adapter.run(runInput(fixture, 'shared-model(openai)', { permissionMode: 'auto' }));

  const selected = (await fixture.records()).find((entry) => entry.frame?.method === 'session/set_mode');

  assert.equal(selected.frame.params.modeId, 'auto');
});

test('Qwen: неизвестный native-режим отклоняется до prompt', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await fixture.fake({ modes: ['default', 'plan', 'yolo'] });
  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'auto',
  })), /режим прав недоступен/);
  assert.equal((await fixture.records()).some((entry) => entry.frame?.method === 'session/prompt'), false);
});

test('Qwen: native fallback Авто явно требует человека', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  let questions = 0;

  await fixture.fake({
    ask: true,
    askDeniedContinues: true,
    tool: { name: 'run_shell_command', args: { command: 'printf synthetic' } },
  });
  await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'auto',
    onPermission: async (question) => {
      questions += 1;
      assert.equal(question.requiresExplicitUser, true);

      return { allow: false };
    },
  }));

  assert.equal(questions, 1);
  assert.equal((await fixture.records()).some((entry) => entry.event === 'guard'), false);
});

test('Qwen: память привязана к набору корней, порядок и ссылки сохраняют resume', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const second = path.join(fixture.root, 'second');
  const third = path.join(fixture.root, 'third');
  const alias = path.join(fixture.root, 'second-alias');

  await mkdir(second);
  await mkdir(third);
  await symlink(second, alias);

  const first = await adapter.run(runInput(fixture, 'shared-model(openai)', { extraDirs: [second, third] }));
  const resumed = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [third, alias, second],
    sessionId: first.sessionId,
  }));

  assert.equal(resumed.sessionId, first.sessionId);
  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [second],
    sessionId: first.sessionId,
  })), /identity сессии/);

  const prompts = (await fixture.records()).filter((entry) => entry.frame?.method === 'session/prompt');

  assert.equal(prompts.length, 2);
});

test('Qwen: второй корень скрывает свои .env и .qwen, третья папка остаётся закрытой', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const second = path.join(fixture.root, 'second');
  const third = path.join(fixture.root, 'third');
  const secret = path.join(fixture.root, 'private-env');
  const env = path.join(second, '.env');
  const settings = path.join(second, '.qwen/settings.json');
  const forbidden = path.join(third, 'forbidden');

  await mkdir(second);
  await mkdir(third);
  await writeFile(secret, 'PRIVATE_SECOND_ENV');
  await symlink(secret, env);
  await mkdir(path.dirname(settings));
  await writeFile(settings, '{"private":"PRIVATE_SECOND_SETTINGS"}');
  await symlink(third, path.join(second, 'escape'));
  await fixture.fake({
    readMasks: [env, settings],
    bounds: { allowed: [path.join(second, 'shell-write')], denied: [forbidden] },
    effect: forbidden,
    tool: { name: 'write_file', args: { file_path: path.join(second, 'escape/forbidden'), content: 'BAD' } },
  });
  await adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [second],
    permissionMode: 'yolo',
  }));

  const records = await fixture.records();
  const masks = records.filter((entry) => entry.event === 'mask');

  assert.equal(masks[0].text, '{}');
  assert.equal(masks[1].code, 'ENOENT');
  assert.ok(records.some((entry) => entry.event === 'bounds' && entry.denied === true));
  assert.equal(records.find((entry) => entry.event === 'guard').allowed, false);
  assert.equal(await readFile(secret, 'utf8'), 'PRIVATE_SECOND_ENV');
  assert.match(await readFile(settings, 'utf8'), /PRIVATE_SECOND_SETTINGS/);
  assert.equal((await lstat(env)).isSymbolicLink(), true);
  await assert.rejects(access(forbidden), { code: 'ENOENT' });
});

test('Qwen: недопустимый дополнительный путь не запускает CLI', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const before = (await fixture.records()).length;
  const maskedRoot = path.join(fixture.workspace, '.qwen');

  await mkdir(maskedRoot);

  for (const directory of ['/', fixture.home, path.join(fixture.root, 'missing'), 'relative', maskedRoot]) {
    await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', { extraDirs: [directory] })));
  }

  assert.equal((await fixture.records()).length, before);
});
