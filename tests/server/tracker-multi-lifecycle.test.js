import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { createTrackerRuntime } from '../../server/src/lib/trackers/runtime.ts';
import { TASK_INPUT, seedTasks } from './helpers/grigdesk-tasks.js';
import { IDS, controlDriver, multiFixture, saveMulti } from './helpers/trackerMulti.js';
import { trackerCalls } from './helpers/trackerFixture.js';

for (const action of ['disable', 'remove']) {
  test(`MD-DRAIN: ${action} ждёт принятый A, закрывает новый A, пропускает B`, async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    // Журнал физического транспорта живёт вне пакета и переживает его удаление.
    // Повтор принятой мутации даст второй вызов даже после завершения drain.
    const physicalCalls = [];
    const fixture = await multiFixture(t, {
      fetch: async (url) => {
        physicalCalls.push(url);
        entered.resolve();
        await release.promise;

        return new Response('{}');
      },
    });
    const enabled = await saveMulti(fixture, IDS.slice(0, 2), 'fixture-a');

    assert.equal(enabled.statusCode, 200, enabled.body);

    await controlDriver(fixture, 'fixture-a', { hold: 'updateTask' });

    const accepted = fixture.request('PUT', '/api/tracker/fixture-a/task/42', { title: 'Принятая запись' });

    t.after(() => release.resolve());
    await Promise.race([
      entered.promise,
      accepted.then((response) => assert.fail(`Мутация не дошла до драйвера: ${response.body}`)),
    ]);

    let finished = false;
    const pending = (action === 'remove'
      ? fixture.request('POST', '/api/driver-installs/drivers/fixture-a/remove', {})
      : saveMulti(fixture, ['fixture-b'], null)).then((response) => {
      finished = true;

      return response;
    });

    try {
      const deadline = Date.now() + 5000;

      while (fixture.runtime.registry.activeIds.includes('fixture-a') && !finished
        && Date.now() < deadline) {
        await setImmediate();
      }

      assert.equal(fixture.runtime.registry.activeIds.includes('fixture-a'), false,
        'Drain должен закрыть новый допуск до ожидания принятой мутации');
      assert.equal(finished, false, 'Снятие подключения должно ждать физический вызов');
      await assert.rejects(fixture.runtime.registry.call('fixture-a', async () => 'новый'));
      assert.equal((await fixture.request('GET', '/api/tracker/fixture-b/task/42')).statusCode, 200);
      assert.equal((await fixture.request('GET', '/api/grigdesk-tasks')).statusCode, 200);
    } finally {
      release.resolve();
      await accepted;
      await pending;
    }

    assert.equal((await pending).statusCode, 200);
    assert.equal(fixture.runtime.catalog().default, 'fixture-b');
    assert.deepEqual(physicalCalls, ['https://held.fixture/updateTask']);
  });
}

test('MD-RECOVERY: removedIds A+C вычитаются из включённых до рестарта', async (t) => {
  const fixture = await multiFixture(t, { ids: IDS });
  const enabled = await saveMulti(fixture, IDS, 'fixture-a');

  assert.equal(enabled.statusCode, 200, enabled.body);
  await fixture.runtime.installs.store.mutate((state) => {
    state.removedIds = ['fixture-a', 'fixture-c'];
  });
  await fixture.runtime.close();

  for (const id of ['fixture-a', 'fixture-c']) {
    await rm(path.join(fixture.config.driversDir, id), { recursive: true });
  }

  const restarted = await createTrackerRuntime({
    ...fixture.moduleOptions,
    config: fixture.config,
    credsStore: fixture.credsStore,
  });

  try {
    assert.deepEqual(restarted.catalog().enabledIds, ['fixture-b']);
    assert.equal(restarted.catalog().default, 'fixture-b');
    assert.equal((await restarted.tracker.taskDetail('42')).title, 'fixture-b');
  } finally {
    await restarted.close();
  }
});

test('MD-HEALTH: ошибка dashboard видна в каталоге, повторный успех восстанавливает A', async (t) => {
  const fixture = await multiFixture(t);

  await controlDriver(fixture, 'fixture-b', { dashboardError: 'Сервис временно недоступен' });

  const failed = await fixture.request('GET', '/api/tracker/dashboard');
  const descriptor = fixture.runtime.catalog().drivers.find((entry) => entry.id === 'fixture-b');

  assert.ok(failed.statusCode >= 500);
  assert.equal(descriptor.status, 'unavailable');
  assert.match(descriptor.reason, /недоступен/u);

  const events = fixture.events.length;

  await fixture.request('GET', '/api/tracker/dashboard');
  assert.equal(fixture.events.length, events, 'Повтор ошибки не образует SSE-петлю');
  await controlDriver(fixture, 'fixture-b', { dashboardError: null });
  assert.equal((await fixture.request('GET', '/api/tracker/dashboard')).statusCode, 200);
  assert.notEqual(fixture.runtime.catalog().drivers.find((entry) => entry.id === 'fixture-b')
    .status, 'unavailable');
  assert.equal(fixture.events.length, events + 1);
});

test('MD-HEALTH: исключение isConfigured одного пакета не ломает каталог', async (t) => {
  const fixture = await multiFixture(t);

  await controlDriver(fixture, 'fixture-b', { configuredThrows: true });

  const response = await fixture.request('GET', '/api/trackers');

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().drivers.find((entry) => entry.id === 'fixture-b').status, 'unavailable');
  assert.ok(response.json().drivers.some((entry) => entry.id === 'own'));
});

test('MD-NUMBER: занятый номер B проверяется при default A, unknown сохраняет 503', async (t) => {
  const fixture = await multiFixture(t);
  const response = await saveMulti(fixture, IDS.slice(0, 2), 'fixture-a');

  assert.equal(response.statusCode, 200, response.body);
  await seedTasks(fixture.config, [], '100000000000');
  await controlDriver(fixture, 'fixture-b', { probe: 'exists' });

  // Первый кандидат занят в B, следующий свободен: контроль переключается по номеру.
  // Драйвер читает файл на каждом вызове, поэтому правило задаётся в самом пакете.
  const file = path.join(fixture.config.driversDir, 'fixture-b/control.json');

  await writeFile(file, JSON.stringify({ probeById: { '100000000000': 'exists' } }));

  const created = await fixture.request('POST', '/api/grigdesk-tasks', TASK_INPUT);

  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().task.id, '100000000001');
  await controlDriver(fixture, 'fixture-b', { probe: 'unknown', probeById: {} });

  const refused = await fixture.request('POST', '/api/grigdesk-tasks', TASK_INPUT);

  assert.equal(refused.statusCode, 503, refused.body);
  assert.equal(refused.json().error, 'task_number_unverified');
  assert.equal(JSON.parse(await readFile(fixture.config.grigdeskTasksPath, 'utf8')).tasks.length, 1);

  const probes = (await trackerCalls(fixture.config, 'fixture-b'))
    .filter((call) => call.method === 'probeTaskNumber').length;

  assert.equal((await saveMulti(fixture, ['fixture-a'], 'fixture-a')).statusCode, 200);
  assert.equal((await fixture.request('POST', '/api/grigdesk-tasks', TASK_INPUT)).statusCode, 201);
  assert.equal((await trackerCalls(fixture.config, 'fixture-b'))
    .filter((call) => call.method === 'probeTaskNumber').length, probes);
});
