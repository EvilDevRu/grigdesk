import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { autoDecision } from '../../server/src/lib/chat/autoApprove.ts';
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
  const decisions = [];

  await mkdir(sibling);
  fixture.actions.push(
    { name: 'Write', args: { file_path: own, content: 'native main' } },
    { name: 'Write', args: { file_path: additional, content: 'native second' } },
    { name: 'Bash', args: { command: `ls '${sibling}'` } },
    { name: 'Bash', args: { command: `printf native-shell > '${shell}'` } },
  );

  const result = await adapter.run(runInput(fixture, model, {
    permissionMode: 'auto',
    extraDirs: [sibling],
    signal: AbortSignal.timeout(45000),
    onPermission: async (question) => {
      const decision = autoDecision(question);

      assert.equal(question.requiresExplicitUser, false);
      decisions.push(decision.verdict);

      return { allow: decision.verdict === 'allow' };
    },
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(await readFile(own, 'utf8'), 'native main');
  assert.equal(await readFile(additional, 'utf8'), 'native second');
  assert.equal(await readFile(shell, 'utf8'), 'native-shell');
  assert.deepEqual(decisions, ['allow', 'allow', 'allow', 'allow']);
  assert.ok(fixture.requests.some((request) => JSON.stringify(request.messages).includes(sibling)),
    'Native workspace должен сообщить модели дополнительный путь');

  const manual = path.join(sibling, 'manual.txt');

  fixture.actions.push({ name: 'Write', args: { file_path: manual, content: 'manual approval' } });
  await adapter.run(runInput(fixture, model, {
    permissionMode: 'default',
    sessionId: result.sessionId,
    extraDirs: [sibling],
    signal: AbortSignal.timeout(20000),
    onPermission: async (question) => {
      assert.equal(question.requiresExplicitUser, true);
      questions += 1;

      return { allow: true };
    },
  }));
  assert.equal(questions, 1, 'Спрашивать сохраняет отдельное поведение при resume');
  assert.equal(await readFile(manual, 'utf8'), 'manual approval');
});

test('Qwen native: Авто отдаёт опасную команду на решение человека', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const target = path.join(fixture.workspace, 'blocked');
  const questions = [];

  await writeFile(target, 'preserved');
  fixture.actions.push({ name: 'Bash', args: { command: `rm -r '${target}'` } });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'auto',
    signal: AbortSignal.timeout(25000),
    onPermission: async (question) => {
      const decision = autoDecision(question);

      questions.push(decision);

      return { allow: decision.verdict === 'allow' };
    },
  }));

  assert.equal(questions.length, 1);
  assert.equal(questions[0].verdict, 'ask');
  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(await readFile(target, 'utf8'), 'preserved');
});

test('Qwen native: отсутствие callback Авто оставляет shell закрытым', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const target = path.join(fixture.workspace, 'unavailable');

  fixture.actions.push({ name: 'Bash', args: { command: `printf BAD > '${target}'` } });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'auto',
    signal: AbortSignal.timeout(25000),
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(fixture.actions.length, 0);
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
    { name: 'Bash', args: { command: `cat '${env}' > '${report}'` } },
    { name: 'Write', args: { file_path: path.join(second, 'escape/outside'), content: 'BAD' } },
    { name: 'Bash', args: { command: `printf BAD > '${target}'` } },
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
