import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, runInput, selectedModel } from '../helpers/qwenFixture.mjs';

test('Qwen native: Авто пишет в два корня без вопросов', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const sibling = path.join(fixture.root, 'second');
  const own = path.join(fixture.workspace, 'own.txt');
  const additional = path.join(sibling, 'additional.txt');
  const shell = path.join(sibling, 'shell.txt');
  let questions = 0;

  await mkdir(sibling);
  fixture.actions.push(
    { name: 'write_file', args: { file_path: own, content: 'native main' } },
    { name: 'write_file', args: { file_path: additional, content: 'native second' } },
    { name: 'run_shell_command', args: { command: `ls '${sibling}'` } },
    { name: 'run_shell_command', args: { command: `printf native-shell > '${shell}'` } },
  );

  const result = await adapter.run(runInput(fixture, model, {
    permissionMode: 'auto',
    extraDirs: [sibling],
    signal: AbortSignal.timeout(45000),
    onPermission: async () => {
      questions += 1;

      return { allow: false };
    },
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(await readFile(own, 'utf8'), 'native main');
  assert.equal(await readFile(additional, 'utf8'), 'native second');
  assert.equal(await readFile(shell, 'utf8'), 'native-shell');
  assert.equal(questions, 0);
  assert.ok(fixture.classifications.length > 0, 'Shell действительно проходит native-классификатор');
  assert.ok(fixture.requests.some((request) => JSON.stringify(request.messages).includes(sibling)),
    'Native workspace должен сообщить модели дополнительный путь');

  const manual = path.join(sibling, 'manual.txt');

  fixture.actions.push({ name: 'write_file', args: { file_path: manual, content: 'manual approval' } });
  await adapter.run(runInput(fixture, model, {
    permissionMode: 'default',
    sessionId: result.sessionId,
    extraDirs: [sibling],
    signal: AbortSignal.timeout(20000),
    onPermission: async () => {
      questions += 1;

      return { allow: true };
    },
  }));
  assert.equal(questions, 1, 'Спрашивать сохраняет отдельное поведение при resume');
  assert.equal(await readFile(manual, 'utf8'), 'manual approval');
});

test('Qwen native: отказ классификатора запрещает shell', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const target = path.join(fixture.workspace, 'blocked');
  let questions = 0;

  fixture.classifierReplies.push(true, true);
  fixture.actions.push({ name: 'run_shell_command', args: { command: `printf BAD > '${target}'` } });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'auto',
    signal: AbortSignal.timeout(25000),
    onPermission: async () => {
      questions += 1;

      return { allow: true };
    },
  }));

  assert.equal(fixture.classifications.length, 2, 'Проверены быстрая и повторная оценки');
  assert.equal(questions, 0);
  assert.match(result.reply, /Ответ настоящего CLI/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});

test('Qwen native: сбой классификатора требует человека', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const target = path.join(fixture.workspace, 'unavailable');
  let questions = 0;

  fixture.classifierReplies.push(...Array(10).fill('unavailable'));
  fixture.actions.push({ name: 'run_shell_command', args: { command: `printf BAD > '${target}'` } });

  try {
    await adapter.run(runInput(fixture, 'shared-model(openai)', {
      permissionMode: 'auto',
      signal: AbortSignal.timeout(25000),
      onPermission: async (question) => {
        questions += 1;
        assert.equal(question.requiresExplicitUser, true, 'Общий auto GrigDesk не подменяет native fallback');

        return { allow: false };
      },
    }));
  } catch (error) {
    assert.equal(error.stopped, true);
    assert.ok(error.sessionId);
  }

  assert.ok(fixture.classifications.length > 0);
  assert.equal(questions, 1, 'Сбой не разрешает действие автоматически');
  await assert.rejects(access(target), { code: 'ENOENT' });
});

test('Qwen native: Авто сохраняет изоляцию третьего корня', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const second = path.join(fixture.root, 'second');
  const third = path.join(fixture.root, 'third');
  const target = path.join(third, 'outside');
  const env = path.join(second, '.env');
  const report = path.join(second, 'visible-env');

  await mkdir(second);
  await mkdir(third);
  await writeFile(env, 'PRIVATE_SECOND_ENV');
  await symlink(third, path.join(second, 'escape'));
  fixture.actions.push(
    { name: 'run_shell_command', args: { command: `cat '${env}' > '${report}'` } },
    { name: 'write_file', args: { file_path: path.join(second, 'escape/outside'), content: 'BAD' } },
    { name: 'run_shell_command', args: { command: `printf BAD > '${target}'` } },
  );
  await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'auto',
    extraDirs: [second],
    signal: AbortSignal.timeout(30000),
    onPermission: async () => ({ allow: true }),
  }));

  await assert.rejects(access(target), { code: 'ENOENT' });
  assert.equal(await readFile(report, 'utf8'), '{}');
  assert.equal(await readFile(env, 'utf8'), 'PRIVATE_SECOND_ENV');
  assert.equal(fixture.actions.length, 0, 'Все три native-инструмента действительно запрошены');
});
