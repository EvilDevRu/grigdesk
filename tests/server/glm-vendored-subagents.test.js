import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { glmSubagentFixture as fixture } from '../helpers/glmSubagents.mjs';

for (const mode of ['spawn', 'fork', 'parallel']) {
  test(`ELF ${mode}: контекст и ветка критика`, { timeout: 120000 }, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.run();

    assert.equal(result.reply, 'Ответ корня');
    assert.equal(await fs.readFile(f.marker, 'utf8'), 'child-effect');
    assert.ok(f.children.every((request) => request.model === 'glm-5.3'));
    assert.ok(f.children.every((request) =>
      JSON.stringify(request.messages).includes('GLM_CHILD_PROJECT_RULE')));

    const calls = result.steps.filter((step) => step.k === 'tool' && step.name === 'Write');

    assert.equal(calls.length, mode === 'parallel' ? 2 : 1);
    assert.equal(new Set(calls.map((step) => step.id)).size, calls.length);
    assert.deepEqual(calls.map((step) => step.parent).sort(), mode === 'parallel'
      ? ['root-delegation', 'root-delegation-second'] : ['root-delegation']);
    assert.ok(calls.every((call) => result.steps.some((step) => step.k === 'res' && step.id === call.id)));
  });
}
for (const mode of ['background', 'child-question', 'escalation']) {
  test(`ELF ${mode}: ребёнок не расширяет права`, { timeout: 120000 }, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.run();

    assert.equal(result.reply, 'Ответ корня');
    assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
    assert.equal(f.permissions.length, 0);
    assert.equal(f.children.length > 0, mode !== 'background');
  });
}

test('ELF: корневой вопрос подтверждает execution', { timeout: 120000 }, async (t) => {
  const f = await fixture(t, 'root-question');
  const result = await f.run();

  assert.equal(result.reply, 'Ответ корня');
  assert.equal(f.permissions.length, 1);
  assert.equal(f.permissions[0].raw.grigdeskGlm.callId, 'root-question-call');
});
test('настоящий GLM: стоп во время дочернего запроса завершает дерево', { timeout: 120000 }, async (t) => {
  const f = await fixture(t, 'stop');

  await assert.rejects(f.run(), (error) => error.stopped === true);
  assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
});

for (const args of [
  { run_in_background: 'false' },
  { provider: 'foreign' },
  { model: 'foreign' },
  { reasoning_effort: 'low' },
]) {
  test(`GLM отклоняет параметры делегирования ${JSON.stringify(args)} до дочернего запроса`,
    { timeout: 90_000 }, async (t) => {
      const f = await fixture(t, 'spawn', { delegationArgs: args });
      const result = await f.run();

      assert.equal(result.reply, 'Ответ корня');
      assert.equal(f.children.length, 0);
      assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
    });
}

test('GLM foreground false, совместимый resume и сохранённые child steps не повторяют старую работу',
  { timeout: 90_000 }, async (t) => {
    const f = await fixture(t, 'spawn', { delegationArgs: { run_in_background: false } });
    const first = await f.run();
    const calls = f.children.length;
    const second = await f.run({ sessionId: first.sessionId, message: 'Подтверди полученный итог' });

    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.reply, 'Ответ корня');
    assert.equal(f.children.length, calls);
    assert.equal(second.steps.some((step) => step.parent), false);

    const restored = JSON.parse(JSON.stringify(first.steps));

    assert.ok(restored.some((step) => step.parent === 'root-delegation' && step.k === 'res'));
  });

test('GLM допускает глубину три; четвёртый ребёнок не делает запрос, связи вложенных steps сохранены',
  { timeout: 90_000 }, async (t) => {
    const { glmToolCall, glmTextReply } = await import('../helpers/glmProductionFixture.mts');
    const depths = [];
    const f = await fixture(t, 'nested', {
      respond: (payload) => {
        const users = payload.messages.filter((message) => message.role === 'user');
        const level = Number(JSON.stringify(users).match(/GLM_LEVEL_(\d+)/u)?.[1] ?? 0);

        depths.push(level);

        if (payload.messages.some((message) => message.role === 'tool')) {
          return glmTextReply(level ? 'Итог вложенного критика' : 'Ответ корня');
        }

        return glmToolCall('subagent', {
          description: 'Вложенный критик', prompt: `GLM_LEVEL_${level + 1}`,
        }, 'same-delegation');
      }
    });
    const result = await f.run();
    const calls = result.steps.filter((step) => step.k === 'tool' && step.name === 'subagent');

    assert.deepEqual([...new Set(depths)].sort(), [0, 1, 2, 3]);
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls.map((step) => step.id)).size, 4);
    assert.ok(calls.filter((step) => step.parent).every((step) => calls.some((p) => p.id === step.parent)));
    assert.ok(result.steps.some((step) => step.parent && step.k === 'res' && step.ok === false));
    assert.equal(result.reply, 'Ответ корня');
  });

for (const background of [false, true]) {
  test(`GLM stop bash ребёнка background=${background} отменяет отложенную запись`,
    { timeout: 90_000 }, async (t) => {
    const { glmToolCall, glmTextReply } = await import('../helpers/glmProductionFixture.mts');
    const f = await fixture(t, 'shell', {
      respond: (payload) => {
        const child = JSON.stringify(payload.messages).includes('GLM_CHILD_TASK');

        if (payload.messages.some((message) => message.role === 'tool')) {
          return background && child ? new Promise(() => {}) : glmTextReply('Готово');
        }

        return child ? glmToolCall('bash', {
          command: 'echo started > started.txt; sleep 30; echo late > child.txt',
          description: 'Долгая команда',
          run_in_background: background,
        }) : glmToolCall('subagent', { description: 'Критик', prompt: 'GLM_CHILD_TASK' });
      }
    });
    const result = f.run();
    // Подписка на rejection ставится до abort, чтобы остановка не стала unhandled rejection.
    const rejected = assert.rejects(result, (error) => error.stopped === true);
    const started = `${f.cwd}/started.txt`;

    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (await fs.access(started).then(() => true, () => false)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(await fs.access(started).then(() => true, () => false), true);
    f.controller.abort();
    await rejected;
    assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
  });
}

for (const kind of ['outside', 'symlink', 'ssh', 'db']) {
  test(`ELF child ${kind}: граница проекта и прямых команд сохраняется`,
    { timeout: 90_000 }, async (t) => {
      const { glmToolCall, glmTextReply } = await import('../helpers/glmProductionFixture.mts');
      const f = await fixture(t, kind, {
        respond: (payload) => {
          if (payload.messages.some((message) => message.role === 'tool')) {
            return glmTextReply('Итог');
          }
          if (!JSON.stringify(payload.messages).includes('GLM_CHILD_TASK')) {
            return glmToolCall('subagent', { description: 'Критик', prompt: 'GLM_CHILD_TASK' });
          }
          if (kind === 'ssh' || kind === 'db') {
            return glmToolCall('bash', {
              command: `${kind === 'ssh' ? 'ssh forbidden' : 'mysql -h db.example'}; echo x > child.txt`,
              description: 'Запрещённая команда',
            });
          }

          return glmToolCall('write', {
            file_path: kind === 'outside' ? `${f.root}/outside.txt` : `${f.cwd}/escape/outside.txt`,
            content: 'effect',
          });
        }
      });

      await fs.symlink(f.root, `${f.cwd}/escape`);
      await f.run();
      assert.equal(f.permissions.length, 0);
      assert.equal(await fs.access(`${f.root}/outside.txt`).then(() => true, () => false), false);
      assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
    });
}
