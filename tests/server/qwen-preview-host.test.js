import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, runInput, selectedModel, until } from '../helpers/qwenFixture.mjs';

test('Qwen Preview.2 Host: свой scope, права и продолжение в том же процессе', {
  skip: !process.env.GRIGDESK_TEST_QWEN_SESSION_BUS && 'Требуется пользовательская область GrigDesk',
  timeout: 60000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const privateFile = path.join(fixture.root, 'host-outside-workspace.txt');
  const allowed = path.join(fixture.workspace, 'allowed.txt');
  const forbidden = path.join(fixture.workspace, 'forbidden.txt');
  const syntheticSsh = path.join(fixture.workspace, 'ssh');
  const approvals = [];
  const activity = [];

  await writeFile(privateFile, 'пользовательский файл хоста');
  await writeFile(syntheticSsh, `#!/bin/sh\nprintf forbidden > '${forbidden}'\n`, { mode: 0o700 });

  const input = runInput(fixture, model, {
    providerSettings: { allowHostAccess: true },
    hooks: { onActivity: (state) => activity.push(state) },
  });
  const handle = await adapter.session.open(input);

  fixture.onCleanup(() => handle.close());
  fixture.actions.push({
    name: 'Bash',
    args: { command: `test -z "$QWEN_TEST_KEY" && cat '${privateFile}' > '${allowed}'` },
  });

  const first = await handle.send({
    message: 'Прочитай файл хоста для теста.',
    async onPermission(presentation) {
      approvals.push(presentation.name);

      return { allow: true };
    },
  });
  const pid = handle.pid;

  assert.ok(pid);
  assert.match(await readFile(`/proc/${pid}/cgroup`, 'utf8'), /grigdesk-qwen-.*\.scope/u);
  assert.equal(await readFile(allowed, 'utf8'), 'пользовательский файл хоста');
  assert.deepEqual(approvals, ['Bash']);
  assert.deepEqual(activity.map(({ state }) => state), ['unknown']);

  const followup = 'Проверь запрет прямого SSH в продолжении.';

  fixture.actions.push({
    name: 'Bash',
    args: { command: `'${syntheticSsh}' synthetic-host` },
    when: (request) => JSON.stringify(request.messages.at(-1)?.content || '').includes(followup),
  });

  const second = await handle.send({
    message: followup,
    async onPermission() {
      assert.fail('Обязательный запрет срабатывает до запроса согласия');
    },
  });

  assert.match(second.reply, /Ответ настоящего CLI/);
  assert.equal(fixture.actions.length, 0);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(handle.pid, pid);
  await assert.rejects(access(forbidden), { code: 'ENOENT' });

  await handle.close();
  assert.equal(handle.alive, false);
  assert.equal(handle.pid, null);
  await assert.rejects(access(`/proc/${pid}`), { code: 'ENOENT' });

  const resumed = await adapter.session.open({ ...input, sessionId: second.sessionId });
  const offset = fixture.requests.length;

  fixture.onCleanup(() => resumed.close());

  const third = await resumed.send({ message: 'Продолжи после ручного закрытия.' });

  assert.equal(third.sessionId, first.sessionId);
  assert.match(JSON.stringify(fixture.requests.slice(offset)), /Прочитай файл хоста для теста/);
});

test('Qwen Preview.2 Host: остановка отменяет ожидающее разрешение в текущем процессе', {
  skip: !process.env.GRIGDESK_TEST_QWEN_SESSION_BUS && 'Требуется пользовательская область GrigDesk',
  timeout: 45000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const forbidden = path.join(fixture.workspace, 'late-write.txt');
  const handle = await adapter.session.open(runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
  }));
  let allow;

  fixture.onCleanup(() => handle.close());
  fixture.actions.push({
    name: 'Bash',
    args: { command: `printf 'late' > '${forbidden}'` },
  });

  const first = handle.send({
    message: 'Запроси подтверждение записи.',
    onPermission: () => new Promise((resolve) => {
      allow = resolve;
    }),
  });
  const stopped = assert.rejects(first, (error) => error.stopped === true);

  await until(() => allow, 'Пользовательское подтверждение в Preview.2 Host');

  const pid = handle.pid;

  await handle.interrupt();
  allow({ allow: true });
  await stopped;
  await assert.rejects(access(forbidden), { code: 'ENOENT' });

  const next = await handle.send({ message: 'Продолжи после остановки.' });

  assert.equal(handle.pid, pid);
  assert.match(next.reply, /Ответ настоящего CLI/);
});
