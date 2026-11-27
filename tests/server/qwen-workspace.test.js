import assert from 'node:assert/strict';
import { access, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { qwenAdapter, runInput } from '../helpers/qwenFixture.mjs';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';

test('Qwen: дополнительные корни проходят адаптер и доступны инструментам', async (t) => {
  const fixture = await qwenNativeFixture(t);
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
  fixture.actions.push({ name: 'Write', args: { file_path: effect, content: 'effect' } });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [alias, sibling],
    permissionMode: 'yolo',
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(await readFile(effect, 'utf8'), 'effect');
});

test('Qwen: неизвестный режим отклоняется до обращения к модели', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'unknown',
  })), /неизвестный режим прав/);
  assert.equal(fixture.requests.length, 0);
});

test('Qwen: память привязана к набору корней, порядок и ссылки сохраняют resume', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const second = path.join(fixture.root, 'second');
  const third = path.join(fixture.root, 'third');
  const alias = path.join(fixture.root, 'second-alias');

  await mkdir(second);
  await mkdir(third);
  await symlink(second, alias);

  const first = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    message: 'Первая реплика для проверки повторного входа.',
    extraDirs: [second, third],
  }));
  const resumed = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [third, alias, second],
    sessionId: first.sessionId,
  }));
  const requestsBeforeDenial = fixture.requests.length;

  assert.equal(resumed.sessionId, first.sessionId);
  assert.ok(requestsBeforeDenial >= 2);
  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [second],
    sessionId: first.sessionId,
  })), /identity сессии/);

  assert.equal(fixture.requests.length, requestsBeforeDenial);
});

test('Qwen: второй корень скрывает свои .env и .qwen, третья папка остаётся закрытой', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const second = path.join(fixture.root, 'second');
  const third = path.join(fixture.root, 'third');
  const secret = path.join(fixture.root, 'private-env');
  const env = path.join(second, '.env');
  const settings = path.join(second, '.qwen/settings.json');
  const forbidden = path.join(third, 'forbidden');
  const report = path.join(second, 'visible-env');

  await mkdir(second);
  await mkdir(third);
  await writeFile(secret, 'PRIVATE_SECOND_ENV');
  await symlink(secret, env);
  await mkdir(path.dirname(settings));
  await writeFile(settings, '{"private":"PRIVATE_SECOND_SETTINGS"}');
  await symlink(third, path.join(second, 'escape'));
  fixture.actions.push(
    { name: 'Bash', args: { command: `test ! -e '${settings}' && cat '${env}' > '${report}'` } },
    { name: 'Write', args: { file_path: path.join(second, 'escape/forbidden'), content: 'BAD' } },
  );
  await adapter.run(runInput(fixture, 'shared-model(openai)', {
    extraDirs: [second],
    permissionMode: 'yolo',
  }));

  assert.equal(await readFile(report, 'utf8'), '{}');
  assert.equal(fixture.actions.length, 0);
  assert.equal(await readFile(secret, 'utf8'), 'PRIVATE_SECOND_ENV');
  assert.match(await readFile(settings, 'utf8'), /PRIVATE_SECOND_SETTINGS/);
  assert.equal((await lstat(env)).isSymbolicLink(), true);
  await assert.rejects(access(forbidden), { code: 'ENOENT' });
});

test('Qwen: домашняя папка допустима главным cwd, дополнительным корнем остаётся запрещённой', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const home = await realpath(os.homedir());

  const validation = await adapter.validateWorkdir({
    config: fixture.config,
    cwd: os.homedir(),
    extraDirs: [],
  });

  assert.equal(validation.error, undefined);
  assert.deepEqual(validation.extraDirs, []);
  await assert.rejects(adapter.validateWorkdir({
    config: fixture.config,
    cwd: fixture.workspace,
    extraDirs: [home],
  }));
});

test('Qwen: недопустимый дополнительный путь не запускает CLI', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const maskedRoot = path.join(fixture.workspace, '.qwen');

  await mkdir(maskedRoot);

  for (const directory of ['/', fixture.home, path.join(fixture.root, 'missing'), 'relative', maskedRoot]) {
    await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', { extraDirs: [directory] })));
  }

  assert.equal(fixture.requests.length, 0);
});
