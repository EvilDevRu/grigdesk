import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { deepSeekProductionChatFixture } from '../helpers/deepseekChatParity.mjs';

/**
 * Mock выбирает инструмент, но его исполнение, approval и sandbox остаются настоящими.
 * Следующий ответ завершает ход после наблюдаемого результата инструмента.
 */
function call(name, args, id = 'permission-fixture-call') {
  return {
    deltas: [{ role: 'assistant', tool_calls: [{
      index: 0,
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }] }],
    finishReason: 'tool_calls',
  };
}

for (const allow of [false, true]) {
  test(`настоящий default write ждёт человека, allow=${allow}`, { timeout: 900_000 }, async (t) => {
    let target;
    const fixture = await deepSeekProductionChatFixture(t, {
      respond: async (_payload, index) => index === 0
        ? call('write', { file_path: target, content: 'approved-content' })
        : { deltas: [{ role: 'assistant', content: 'finished' }] },
    }, { outsideTemp: true });

    target = path.join(fixture.cwd, 'created.txt');

    let questions = 0;

    await fixture.run({ permissionMode: 'default', onPermission: async (presentation) => {
      questions += 1;
      await assert.rejects(fs.stat(target), { code: 'ENOENT' });
      assert.equal(presentation.requiresExplicitUser, true);
      assert.equal(presentation.canRemember, false);
      assert.equal(presentation.input.details, 'approved-content');

      return { allow };
    } });

    assert.equal(questions, 1);

    if (allow) {
      assert.equal(await fs.readFile(target, 'utf8'), 'approved-content');
    } else {
      await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    }
  });
}

test('настоящий auto пишет обычный файл без вопросов, readonly не пишет', {
  timeout: 900_000,
}, async (t) => {
  for (const mode of ['auto', 'read-only']) {
    await t.test(mode, async (scenario) => {
      let target;
      const fixture = await deepSeekProductionChatFixture(scenario, {
        respond: async (_payload, index) => index === 0
          ? call('write', { file_path: target, content: 'automatic-content' })
          : { deltas: [{ role: 'assistant', content: 'finished' }] },
      }, { outsideTemp: true });

      target = path.join(fixture.cwd, 'automatic.txt');
      await fixture.run({ permissionMode: mode, onPermission: async () => {
        assert.fail('Обычная запись auto и запрещённая запись readonly не показывают вопрос');
      } });

      if (mode === 'auto') {
        assert.equal(await fs.readFile(target, 'utf8'), 'automatic-content');
      } else {
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
      }
    });
  }
});

test('настоящий shell различает auto, default и read-only для поиска и обычной записи', {
  timeout: 900_000,
}, async (t) => {
  for (const mode of ['auto', 'default', 'read-only']) {
    await t.test(mode, async (scenario) => {
      let command;
      const fixture = await deepSeekProductionChatFixture(scenario, {
        respond: async (_payload, index) => index === 0
          ? call('bash', { command, description: 'Поиск и запись в рабочей папке' })
          : { deltas: [{ content: 'finished' }] },
      }, { outsideTemp: true });
      const target = path.join(fixture.cwd, 'shell-marker');
      let questions = 0;

      await fs.writeFile(path.join(fixture.cwd, 'source.txt'), 'renameProfile: search-found\n');
      command = `cd '${fixture.cwd}' && rg -n 'renameProfile|profile\\.name' . | head -40`
        + ' && printf automatic > shell-marker';

      await fixture.run({ permissionMode: mode, onPermission: async () => {
        questions += 1;
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });

        return { allow: true };
      } });

      assert.equal(questions, mode === 'default' ? 1 : 0);

      if (mode === 'read-only') {
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
      } else {
        assert.equal(await fs.readFile(target, 'utf8'), 'automatic');
        assert.match(JSON.stringify(fixture.mock.payloads[1].messages), /source\.txt:1:renameProfile/);
      }
    });
  }
});

test('настоящий auto shell сохраняет границу записи и один вопрос для явной эскалации', {
  timeout: 900_000,
}, async (t) => {
  for (const allow of [undefined, false, true]) {
    await t.test(String(allow), async (scenario) => {
      let target;
      const fixture = await deepSeekProductionChatFixture(scenario, {
        respond: async (_payload, index) => index === 0
          ? call('bash', {
            command: `printf outside > '${target}'`,
            description: 'Запись вне рабочей папки',
            ...(allow === undefined ? {} : {
              sandbox_permissions: 'danger-full-access',
              justification: 'Проверка явного разрешения внешней записи',
            }),
          })
          : { deltas: [{ content: 'finished' }] },
      }, { outsideTemp: true });
      let questions = 0;

      target = path.join(fixture.projectRoot, 'shell-outside');

      await fixture.run({ permissionMode: 'auto', onPermission: async () => {
        questions += 1;
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });

        return { allow };
      } });

      assert.equal(questions, allow === undefined ? 0 : 1);

      if (allow === true) {
        assert.equal(await fs.readFile(target, 'utf8'), 'outside');
      } else {
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
      }
    });
  }
});

test('default bash не создаёт marker до решения человека', {
  timeout: 900_000,
}, async (t) => {
  let target;
  const fixture = await deepSeekProductionChatFixture(t, {
    respond: async (_payload, index) => index === 0
      ? call('bash', {
        command: `printf blocked > '${target}'; rm -rf synthetic`,
        description: 'Создать тестовый marker и рекурсивно удалить каталог',
      })
      : { deltas: [{ role: 'assistant', content: 'finished' }] },
  }, { outsideTemp: true });

  target = path.join(fixture.cwd, 'shell-marker');

  let questions = 0;

  await fixture.run({ permissionMode: 'default', onPermission: async (presentation) => {
    questions += 1;
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    assert.match(presentation.input.command, /printf blocked/u);

    return { allow: false };
  } });

  assert.equal(questions, 1);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

for (const allow of [false, true]) {
  test(`настоящая эскалация задаёт один вопрос до эффекта, allow=${allow}`, {
    timeout: 900_000,
  }, async (t) => {
    let target;
    const fixture = await deepSeekProductionChatFixture(t, {
      respond: async (_payload, index) => index === 0
        ? call('write', {
          file_path: target,
          content: 'outside-approved',
          sandbox_permissions: 'danger-full-access',
          justification: 'Тест записи в соседний каталог',
        }) : { deltas: [{ role: 'assistant', content: 'finished' }] },
    }, { outsideTemp: true });

    target = path.join(fixture.projectRoot, 'outside.txt');

    let questions = 0;

    await fixture.run({ permissionMode: 'auto', onPermission: async (presentation) => {
      questions += 1;
      assert.equal(presentation.input.sandbox_permissions, 'danger-full-access');
      await assert.rejects(fs.stat(target), { code: 'ENOENT' });

      return { allow };
    } });

    assert.equal(questions, 1);

    if (allow) {
      assert.equal(await fs.readFile(target, 'utf8'), 'outside-approved');
    } else {
      await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    }
  });
}

test('две native эскалации требуют двух решений и не расширяют standing sandbox', {
  timeout: 900_000,
}, async (t) => {
  let targets;
  const fixture = await deepSeekProductionChatFixture(t, {
    respond: async (_payload, index) => index < 3
      ? call('write', {
        file_path: targets[index],
        content: `outside-${index}`,
        ...(index < 2 ? {
          sandbox_permissions: 'danger-full-access',
          justification: 'Синтетическая разовая запись за cwd',
        } : {}),
      }, `escalation-${index}`) : { deltas: [{ content: 'finished' }] },
  }, { outsideTemp: true });

  targets = [0, 1, 2].map((index) => path.join(fixture.projectRoot, `outside-${index}.txt`));

  let questions = 0;

  await fixture.run({ permissionMode: 'auto', onPermission: async () => {
    questions += 1;
    await assert.rejects(fs.stat(targets[questions - 1]), { code: 'ENOENT' });

    return { allow: true };
  } });
  assert.equal(questions, 3);
  assert.equal(await fs.readFile(targets[0], 'utf8'), 'outside-0');
  assert.equal(await fs.readFile(targets[1], 'utf8'), 'outside-1');
  await assert.rejects(fs.stat(targets[2]), { code: 'ENOENT' });
});

test('read-only исключает project MCP до startup и после resume, auto возвращает его', {
  timeout: 900_000,
}, async (t) => {
  const fixture = await deepSeekProductionChatFixture(t, {});
  const script = path.resolve(import.meta.dirname, '../fixtures/deepseek-harness/toolPermissionMcp.mjs');
  const marker = path.join(fixture.cwd, 'mcp-calls');
  const mcpServers = [{
    name: 'startup-test',
    command: process.execPath,
    args: [script, marker, 'ping'],
    env: [],
  }];

  await fixture.run({ permissionMode: 'read-only', mcpServers });
  await assert.rejects(fs.stat(`${marker}.started`), { code: 'ENOENT' });

  const first = await fixture.run({ permissionMode: 'auto', mcpServers });

  assert.equal(await fs.readFile(`${marker}.started`, 'utf8'), 'started\n');
  await fixture.run({
    sessionId: first.sessionId,
    permissionMode: 'read-only',
    mcpServers,
  });
  assert.equal(await fs.readFile(`${marker}.started`, 'utf8'), 'started\n');
  assert.ok(!fixture.mock.payloads.at(-1).tools.some((entry) => (
    entry.function.name.includes('startup-test')
  )));
  await fixture.run({
    sessionId: first.sessionId,
    permissionMode: 'auto',
    mcpServers,
  });
  assert.equal(await fs.readFile(`${marker}.started`, 'utf8'), 'started\nstarted\n');
});

test('настоящий edit различает default, auto и read-only по эффекту', {
  timeout: 900_000,
}, async (t) => {
  for (const mode of ['default', 'auto', 'read-only']) {
    await t.test(mode, async (scenario) => {
      let target;
      const fixture = await deepSeekProductionChatFixture(scenario, {
        respond: async (_payload, index) => index === 0
          ? call('read', { file_path: target }, 'before-edit') : index === 1 ? call('edit', {
            file_path: target,
            old_string: 'before',
            new_string: 'after',
          })
          : { deltas: [{ content: 'finished' }] },
      }, { outsideTemp: true });

      target = path.join(fixture.cwd, 'edit.txt');
      await fs.writeFile(target, 'before');

      let questions = 0;

      await fixture.run({ permissionMode: mode, onPermission: async (presentation) => {
        questions += 1;
        assert.equal(await fs.readFile(target, 'utf8'), 'before');
        assert.deepEqual(presentation.input.diff, { old: 'before', new: 'after' });

        return { allow: true };
      } });
      assert.equal(questions, mode === 'default' ? 1 : 0);
      assert.equal(await fs.readFile(target, 'utf8'), mode === 'read-only' ? 'before' : 'after');
    });
  }
});

test('native auto shell может удалить файл внутри workspace, readonly не запускает shell', {
  timeout: 900_000,
}, async (t) => {
  for (const mode of ['auto', 'read-only']) {
    await t.test(mode, async (scenario) => {
      let target;
      const fixture = await deepSeekProductionChatFixture(scenario, {
        respond: async (_payload, index) => index === 0
          ? call('bash', { command: `rm -rf '${target}'`, description: 'Удалить синтетическую цель' })
          : { deltas: [{ content: 'finished' }] },
      }, { outsideTemp: true });

      target = path.join(fixture.cwd, 'delete-me.txt');

      const preserved = path.join(fixture.cwd, 'preserved.txt');

      await fs.writeFile(target, 'synthetic');
      await fs.writeFile(preserved, 'preserved');
      await fixture.run({ permissionMode: mode, onPermission: async () => {
        assert.fail('Native workspace-write не классифицирует удаление внутри workspace');
      } });
      assert.equal(await fs.readFile(preserved, 'utf8'), 'preserved');

      if (mode === 'auto') {
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
      } else {
        assert.equal(await fs.readFile(target, 'utf8'), 'synthetic');
      }
    });
  }
});

test('служебный MCP использует action-матрицу без внешнего дублирования вопроса', {
  timeout: 900_000,
}, async (t) => {
  for (const mode of ['default', 'auto', 'read-only']) {
    await t.test(mode, async (scenario) => {
      const actions = ['list', 'exec', 'invented'];
      const fixture = await deepSeekProductionChatFixture(scenario, {
        respond: async (_payload, index) => index < actions.length
          ? call('mcp__grigdesk-work__supervised_ssh', { action: actions[index] }, `work-${index}`)
          : { deltas: [{ content: 'finished' }] },
      });
      const script = path.resolve(import.meta.dirname, '../fixtures/deepseek-harness/toolPermissionMcp.mjs');
      const marker = path.join(fixture.root, 'work-calls');

      await fixture.run({
        permissionMode: mode,
        workTools: { descriptors: [{ name: 'supervised_ssh' }] },
        mcpServers: [{
          name: 'grigdesk-work',
          command: process.execPath,
          args: [script, marker, 'supervised_ssh'],
          env: [],
        }],
        onPermission: async () => assert.fail('Внешняя карточка не дублирует действующий брокер'),
      });

      const dispatched = (await fs.readFile(marker, 'utf8')).trim().split('\n').map(JSON.parse);

      assert.deepEqual(dispatched, mode === 'read-only' ? [{ action: 'list' }]
        : [{ action: 'list' }, { action: 'exec' }]);
    });
  }
});

test('read-only сохраняет чтение, todo, цель и один собственный вопрос человеку', {
  timeout: 900_000,
}, async (t) => {
  let source;
  const operations = [
    () => call('read', { file_path: source }, 'internal-read'),
    () => call('todo_write', { todos: [{ content: 'Синтетическая задача', status: 'pending' }] }, 'todo'),
    () => call('create_goal', { objective: 'Синтетическая цель' }, 'goal'),
    () => call('ask_user_question', { questions: [{
      id: 'choice',
      question: 'Синтетический выбор?',
    }] }, 'question'),
  ];
  const fixture = await deepSeekProductionChatFixture(t, {
    respond: async (_payload, index) => operations[index]?.()
      || { deltas: [{ content: 'finished' }] },
  });

  source = path.join(fixture.cwd, 'source.txt');
  await fs.writeFile(source, 'read-only-source');

  let questions = 0;

  await fixture.run({
    permissionMode: 'read-only',
    message: 'Создай синтетическую цель и список задач, прочитай файл и задай вопрос.',
    onPermission: async (presentation) => {
      questions += 1;
      assert.equal(presentation.isQuestion, true);

      return { rawAnswers: [{ text: 'approved-choice' }] };
    },
  });

  const results = fixture.mock.payloads.at(-1).messages.filter((entry) => entry.role === 'tool');
  const serialized = JSON.stringify(results);

  assert.equal(questions, 1);
  assert.equal(results.length, operations.length);
  assert.match(serialized, /read-only-source/u);
  assert.match(serialized, /Updated todo list: 1 pending/u);
  assert.match(serialized, /Синтетическая цель/u);
  assert.match(serialized, /approved-choice/u);
  assert.equal(await fs.readFile(source, 'utf8'), 'read-only-source');
});

test('остановка ожидающего native approval игнорирует поздний allow', {
  timeout: 900_000,
}, async (t) => {
  let target;
  const fixture = await deepSeekProductionChatFixture(t, {
    respond: async (_payload, index) => index === 0
      ? call('write', { file_path: target, content: 'late-content' })
      : { deltas: [{ role: 'assistant', content: 'finished' }] },
  }, { outsideTemp: true });
  const controller = new AbortController();
  let questions = 0;

  target = path.join(fixture.cwd, 'late.txt');

  const running = fixture.run({ signal: controller.signal, onPermission: async () => {
    questions += 1;
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    return { allow: true };
  } });

  await assert.rejects(running, (error) => error.stopped === true);
  assert.equal(questions, 1);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('resume с широкими persisted overrides получает выбранную policy до model assembly', {
  timeout: 900_000,
}, async (t) => {
  const fixture = await deepSeekProductionChatFixture(t, {});
  const first = await fixture.run({ permissionMode: 'auto' });
  const resumed = await fixture.run({
    sessionId: first.sessionId,
    permissionMode: 'read-only',
    startServer: async (options) => {
      const directory = path.dirname(options.overlayPath);
      const plugin = path.join(directory, 'seed-overrides.mjs');
      const overlay = path.join(directory, 'seed-overlay.yml');

      await fs.writeFile(plugin, `export const name = 'seed-overrides';
export function apply(ctx) {
  ctx.on('agent/session-start', ({agent}) => {
    agent.session.append('sandbox/mode', {mode: 'danger-full-access'});
    agent.session.append('approval/policy', {policy: 'never'});
  });
}\n`);
      await fs.writeFile(overlay, await fs.readFile(options.overlayPath, 'utf8')
        + `\n- insert:\n    - id: seed-overrides\n      name: ${JSON.stringify(plugin)}\n`);

      return fixture.startServer({ ...options, overlayPath: overlay });
    },
  });
  const readonlyMessages = JSON.stringify(fixture.mock.payloads.at(-1).messages);

  assert.equal(resumed.sessionId, first.sessionId);
  assert.match(readonlyMessages, /Current DSH file policy: read-only/u);
  assert.doesNotMatch(readonlyMessages, /Current DSH file policy: danger-full-access/u);
  assert.doesNotMatch(readonlyMessages, /Approval prompts are disabled in this session/u);
  await fixture.run({ sessionId: first.sessionId, permissionMode: 'auto' });

  const automaticMessages = JSON.stringify(fixture.mock.payloads.at(-1).messages);

  assert.ok(automaticMessages.lastIndexOf('Current DSH file policy: workspace-write')
    > automaticMessages.lastIndexOf('Current DSH file policy: read-only'));
});
