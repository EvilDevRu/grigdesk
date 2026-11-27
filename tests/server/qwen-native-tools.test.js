import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen Preview.2: модель получает только проверенные нативные инструменты', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await adapter.run(runInput(fixture, 'shared-model(openai)'));

  const advertised = new Set(fixture.requests.flatMap((request) =>
    (request.tools ?? []).map((entry) => entry.function.name)));

  assert.deepEqual([...advertised].sort(), [
    'Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'WebFetch', 'Write',
  ]);
});

test('Qwen Preview.2: Bash и Agent не получают фонового допуска даже без подтверждений', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const target = path.join(fixture.workspace, 'background-effect');
  const toolRequests = [];

  fixture.actions.push({
    name: 'Bash',
    args: { command: `printf BAD > '${target}'`, run_in_background: true },
  }, {
    name: 'Agent',
    args: {
      description: 'Проверить фоновую задачу',
      prompt: 'Выполни локальную проверку.',
      subagent_type: 'general-purpose',
      run_in_background: true,
    },
  });

  const outcome = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    onPermission(presentation) {
      toolRequests.push(presentation.name);

      return { allow: true };
    },
  }));

  assert.match(outcome.reply, /Ответ настоящего CLI/);
  assert.equal(fixture.actions.length, 0);
  assert.deepEqual(toolRequests, []);
  assert.ok(fixture.requests.some((request) => request.messages.some((message) =>
    message.role === 'tool' && /cancel|deny|denied/i.test(String(message.content)))));
  await assert.rejects(access(target), { code: 'ENOENT' });
});

for (const [mode, allow, exists, explicit] of [
  ['default', false, false, true],
  ['default', true, true, true],
  ['auto', true, true, false],
  ['plan', true, false, null],
  ['yolo', false, true, null],
]) {
  test(`Qwen Preview.2: решение по записи в режиме ${mode}, ответ ${allow}`, async (t) => {
    const fixture = await qwenNativeFixture(t);
    const adapter = await qwenAdapter({ runnable: true });
    const target = path.join(fixture.workspace, 'effect');
    const approvals = [];

    fixture.actions.push({ name: 'Write', args: { file_path: target, content: 'Запись Preview.2' } });

    const outcome = await adapter.run(runInput(fixture, 'shared-model(openai)', {
      permissionMode: mode,
      onPermission(presentation) {
        approvals.push(presentation.requiresExplicitUser);

        return { allow };
      },
    }));

    assert.match(outcome.reply, /Ответ настоящего CLI/);
    assert.equal(fixture.actions.length, 0);
    assert.deepEqual(approvals, explicit === null ? [] : [explicit]);

    if (exists) {
      assert.equal(await readFile(target, 'utf8'), 'Запись Preview.2');
    } else {
      await assert.rejects(access(target), { code: 'ENOENT' });
    }
  });
}

test('Qwen Preview.2: чтение в режиме плана доступно без записи', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const source = path.join(fixture.workspace, 'readable');

  await writeFile(source, 'PLAN_READ_PROBE');
  fixture.actions.push({ name: 'Read', args: { file_path: source } });

  await adapter.run(runInput(fixture, 'shared-model(openai)', { permissionMode: 'plan' }));

  assert.equal(fixture.actions.length, 0);
  assert.match(JSON.stringify(fixture.requests), /PLAN_READ_PROBE/);
});
