import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';

import {
  installFixture, current, start, completed, until, cookie,
} from './helpers/providerInstallFixture.js';

test('start отвечает 202 до окончания и GET возвращает тот же job', async (t) => {
  const { app, config, gate, calls } = await installFixture(t);
  const response = await start(app);

  assert.equal(response.statusCode, 202, response.body);

  const snapshot = response.json();
  const saved = JSON.parse(await readFile(config.providerInstallStatePath, 'utf8'));

  assert.equal(snapshot.active.status, 'running');
  assert.equal(saved.active.id, snapshot.active.id, 'ACK предшествовал durable running');
  assert.equal((await current(app)).active.id, snapshot.active.id);
  assert.equal(calls.commands.length, 1);
  gate.resolve();
  assert.equal((await completed(app)).recent.claude.id, snapshot.active.id);
});

test('два клиента и legacy update разделяют lock', async (t) => {
  const { app, gate, calls } = await installFixture(t);
  const first = await start(app);

  assert.equal(first.statusCode, 202, first.body);

  for (const url of ['/api/providers/claude/update/start', '/api/providers/claude/update']) {
    const second = await app.inject({
      method: 'POST',
      url
    });

    assert.equal(second.statusCode, 409, second.body);
  }

  assert.equal(calls.commands.length, 1);
  gate.resolve();
  await completed(app);

  const legacy = await app.inject({
    method: 'POST',
    url: '/api/providers/claude/update'
  });

  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.deepEqual(legacy.json(), {
    ok: true,
    before: '2.0.0',
    after: '2.0.0',
    changed: false,
    output: 'готово',
  });
  assert.equal(calls.commands.length, 2);
});

test('auth отвергает до adapters/models/runner', async (t) => {
  const { app, calls } = await installFixture(t, { auth: true });

  for (const url of [
    '/api/providers/installations/current',
    '/api/providers/claude/install/start',
    '/api/providers/claude/update/start',
  ]) {
    const result = await app.inject({
      method: url.endsWith('current') ? 'GET' : 'POST',
      url
    });

    assert.equal(result.statusCode, 401, result.body);
  }

  assert.equal(calls.adapters, 0);
  assert.equal(calls.models.length, 0);
  assert.equal(calls.commands.length, 0);

  const allowed = await app.inject({
    url: '/api/providers/installations/current',
    headers: { cookie }
  });

  assert.equal(allowed.statusCode, 200, allowed.body);
});

test('команда из body не исполняется', async (t) => {
  const { app, calls, marker } = await installFixture(t);
  const response = await start(app, 'claude', 'update', { command: 'маркер' });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(calls.commands.length, 0);
  assert.equal((await current(app)).active, null);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('start отвергает любые поля тела до допуска команды', async (t) => {
  for (const operation of ['install', 'update']) {
    await t.test(operation, async (scenario) => {
      const { app, calls, gate } = await installFixture(scenario, { installed: operation === 'update' });

      for (const payload of [
        { command: 'маркер' }, { argv: [] }, { env: { PATH: '/fixture' } }, { cwd: '/fixture' },
      ]) {
        const result = await start(app, 'claude', operation, payload);

        assert.equal(result.statusCode, 400, `${JSON.stringify(payload)}: ${result.body}`);
        assert.equal(calls.commands.length, 0);
        assert.equal((await current(app)).active, null);
      }

      const empty = await start(app, 'claude', operation, {});

      assert.equal(empty.statusCode, 202, empty.body);
      gate.resolve();
      await completed(app);

      if (operation === 'install') {
        const repeated = await start(app, 'claude', operation);

        assert.equal(repeated.statusCode, 409, 'Install не обходит запрет обновления');
      }

      const withoutBody = await installFixture(scenario, { installed: operation === 'update' });
      const absent = await start(withoutBody.app, 'claude', operation);

      assert.equal(absent.statusCode, 202, absent.body);
      withoutBody.gate.resolve();
    });
  }
});

test('managed и contained update отказаны до spawn', async (t) => {
  const fixture = await installFixture(t);

  for (const id of ['deepseek', 'glm']) {
    fixture.adapters.set(id, {
      ...fixture.provider,
      id,
      distribution: () => ({
        kind: 'binary',
        managed: true,
        label: 'Поставка'
      }),
    });

    for (const operation of ['install', 'update']) {
      const response = await start(fixture.app, id, operation);

      assert.equal(response.statusCode, 400, response.body);
    }
  }

  fixture.adapters.set('kimi', {
    ...fixture.provider,
    id: 'kimi',
    installation: () => ({
      ...fixture.descriptor,
      update: null
    }),
  });

  const contained = await start(fixture.app, 'kimi');
  const installed = await start(fixture.app, 'kimi', 'install');
  const unknown = await start(fixture.app, 'missing');

  assert.equal(contained.statusCode, 400, contained.body);
  assert.equal(installed.statusCode, 409, installed.body);
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(fixture.calls.commands.length, 0);
});

test('progress не перечитывает реестр', async (t) => {
  const { app, calls, gate } = await installFixture(t);
  const response = await start(app);

  assert.equal(response.statusCode, 202, response.body);
  await until(() => calls.commands.length, (length) => length === 1);

  const models = calls.models.length;
  const registryEvents = calls.events.filter((entry) => entry.event === 'providers-update').length;
  const runOptions = calls.commands[0].options;

  for (let index = 0; index < 40; index += 1) {
    runOptions.onStdout?.(`строка ${index}\n`);
  }

  await until(() => calls.events, (events) => events.some((entry) =>
    entry.event === 'provider-install' && entry.data.active?.outputTail.includes('строка 39')));
  assert.equal(calls.models.length, models);
  assert.equal(calls.events.filter((entry) => entry.event === 'providers-update').length, registryEvents);
  gate.resolve();
  await completed(app);

  const snapshots = calls.events.filter((entry) => entry.event === 'provider-install');

  assert.ok(snapshots.length < 40, 'Поток не объединяется перед публикацией');
  assert.ok(snapshots.every((entry, index) => index === 0
    || entry.data.revision > snapshots[index - 1].data.revision));
  assert.doesNotMatch(JSON.stringify(snapshots), /"(?:env|pid|worker|credential)":/u);
});
