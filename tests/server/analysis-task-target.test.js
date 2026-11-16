import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';

import { FactoryTaskSources, factoryTicketHash } from '../../server/src/lib/factoryTaskSources.ts';
import { selectTracker, trackerCalls } from './helpers/trackerFixture.js';
import { controlDriver, generationHeader, saveMulti } from './helpers/trackerMulti.js';
import { analysisSourceFixture, completed } from './helpers/analysisSource.js';

/**
 * Проверяет отсутствие незаявленных чтений и перебора досок по журналам пакетов.
 * accountIdentity разрешён для подтверждения владельца, task/probe — только выбранной цели.
 */
async function taskCalls(fx, driver) {
  return (await trackerCalls(fx.config, driver))
    .filter((call) => ['taskDetail', 'taskPageData', 'probeTaskNumber'].includes(call.method));
}

test('SOURCE-WORKER-01: HTTP source A доезжает через очередь до настоящего worker', async (t) => {
  const fx = await analysisSourceFixture(t);

  await controlDriver(fx, 'fixture-a', { comments: [{ text: 'Комментарий A' }] });
  await controlDriver(fx, 'fixture-b', { comments: [{ text: 'Комментарий B' }] });

  const settings = await readFile(fx.config.trackerSettingsPath, 'utf8');
  const response = await fx.request('POST', '/api/tasks/42/analyze', { source: fx.a.source },
    generationHeader(fx.a));

  assert.equal(response.statusCode, 200, response.body);

  const detail = await completed(fx, fx.a.source);

  assert.equal(detail.status.state, 'done', JSON.stringify(detail.status));
  assert.equal(detail.analysis.summary, 'Оценка A', 'Worker должен читать A, хотя default — B');
  assert.match(fx.prompts[0], /fixture-a/);
  assert.match(fx.prompts[0], /Комментарий A/);
  assert.doesNotMatch(fx.prompts[0], /fixture-b|Комментарий B/);
  assert.deepEqual((await taskCalls(fx, 'fixture-a')).map((call) => call.method),
    ['taskDetail', 'taskPageData']);
  assert.deepEqual(await taskCalls(fx, 'fixture-b'), []);
  assert.equal(await readFile(fx.config.trackerSettingsPath, 'utf8'), settings);
});

test('SOURCE-PROJECT-01: профиль registry доступен только доказанному источнику', async (t) => {
  const fx = await analysisSourceFixture(t);
  const proof = {
    attempt: `a_${'1'.repeat(32)}`,
    queueDispatchId: 'd5f1c2b3-1234-4567-890a-123456789abc',
    ticketHash: factoryTicketHash({ task: '42', title: 'Задача B' }),
  };

  await new FactoryTaskSources(fx.config.factoryTaskSourcesPath).put({
    taskId: '42',
    source: fx.b.source,
    dispatchId: proof.queueDispatchId,
    ticketHash: proof.ticketHash,
    attempt: proof.attempt,
  });
  fx.analyzer.factoryState = {
    readRegistry: async () => ({ registry: { PROFILE: 'beta' } }),
    readTrustedTicketProof: async () => proof,
  };

  assert.equal(await fx.analyzer._taskProject('42', { source: fx.a.source }), null,
    'Чужая verified B42 не доказывает проект A42');
  assert.equal(await fx.analyzer._taskProject('42', { source: fx.b.source }), 'beta');

  proof.ticketHash = 'f'.repeat(64);
  assert.equal(await fx.analyzer._taskProject('42', { source: fx.b.source }), null);
});

test('SOURCE-REFUSALS-01: формат, владелец и адресное поколение проверяются до enqueue', async (t) => {
  for (const value of [null, '', 'fixture-a', 'fixture-a@not-a-scope']) {
    await t.test(`неверный source ${JSON.stringify(value)}`, async (st) => {
      const fx = await analysisSourceFixture(st, { held: true });
      const response = await fx.request('POST', '/api/tasks/42/analyze', { source: value });

      assert.equal(response.statusCode, 400, response.body);
      assert.equal(fx.analyzer._jobs.size, 0);
    });
  }

  for (const mode of ['unknown', 'disabled', 'owner', 'generation', 'aliases']) {
    await t.test(mode, async (st) => {
      const fx = await analysisSourceFixture(st, { held: true });
      let source = fx.a.source;
      let headers = generationHeader(fx.a);
      let expected = 409;
      let payload;

      if (mode === 'unknown') {
        source = `missing-driver@${'a'.repeat(64)}`;
        expected = 404;
      } else if (mode === 'disabled') {
        const changed = await saveMulti(fx, ['fixture-b'], 'fixture-b');

        assert.equal(changed.statusCode, 200, changed.body);
      } else if (mode === 'owner') {
        source = `fixture-a@${'f'.repeat(64)}`;
      } else if (mode === 'generation') {
        headers = { 'x-grigdesk-tracker-generation': String(fx.a.generation + 100) };
      } else {
        payload = { source, taskSource: fx.b.source };
        expected = 400;
      }

      const response = await fx.request('POST', '/api/tasks/42/analyze', payload || { source }, headers);

      assert.equal(response.statusCode, expected, response.body);
      assert.equal(fx.analyzer._jobs.size, 0);
      assert.deepEqual(await taskCalls(fx, 'fixture-b'), []);
    });
  }
});

test('SOURCE-REFUSALS-01: alias и source-less default сохраняют контракт, own недоступен', async (t) => {
  await t.test('alias адресует включённую A', async (st) => {
    const fx = await analysisSourceFixture(st);
    const response = await fx.request('POST', '/api/tasks/42/analyze', { taskSource: fx.a.source });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await completed(fx, fx.a.source)).analysis?.summary, 'Оценка A');
  });
  await t.test('без source остаётся B', async (st) => {
    const fx = await analysisSourceFixture(st);

    assert.equal((await fx.request('POST', '/api/tasks/42/analyze', {})).statusCode, 200);
    assert.equal((await completed(fx, fx.b.source)).analysis?.summary, 'Оценка B');
  });
  await t.test('исторический own недоступен без обращения к драйверам', async (st) => {
    const fx = await analysisSourceFixture(st, { held: true });

    assert.equal((await fx.request('POST', '/api/tasks/100000000099/analyze', {
      source: 'grigdesk',
    })).statusCode, 404);
    assert.equal((await fx.request('POST', '/api/tasks/100000000001/analyze', {
      taskSource: 'grigdesk',
    })).statusCode, 404);
    assert.equal(fx.analyzer._jobs.size, 0);
    assert.deepEqual(await taskCalls(fx, 'fixture-a'), []);
    assert.deepEqual(await taskCalls(fx, 'fixture-b'), []);
  });
});

test('SOURCE-REFUSALS-01: смена default в очереди не меняет A, смена owner запрещает модель', async (t) => {
  for (const ownerChanged of [false, true]) {
    await t.test(ownerChanged ? 'владелец изменён' : 'default изменён', async (st) => {
      const fx = await analysisSourceFixture(st, { held: true });

      await selectTracker(fx, 'fixture-a');

      const response = await fx.request('POST', '/api/tasks/42/analyze', { source: fx.a.source });

      assert.equal(response.statusCode, 200, response.body);
      await selectTracker(fx, 'fixture-b');

      if (ownerChanged) {
        await fx.runtime.writeSettings({ drivers: ['fixture-a', 'fixture-b'], default: 'fixture-b' }, {
          'fixture-a': { endpoint: 'https://other-owner.fixture' },
        });
      }

      fx.analyzer._active = 0;
      fx.analyzer.pluginToggled(true);

      const detail = await completed(fx, fx.a.source);

      assert.equal(detail.status?.state, ownerChanged ? 'failed' : 'done');
      assert.equal(fx.prompts.length, ownerChanged ? 0 : 1);

      if (!ownerChanged) {
        assert.equal(detail.analysis?.summary, 'Оценка A');
      }

      assert.deepEqual(await taskCalls(fx, 'fixture-b'), []);
    });
  }
});

test('SOURCE-WORKER-01: отказ детали без fallback, comments best effort', async (t) => {
  for (const mode of ['detailError', 'pageError']) {
    await t.test(mode, async (st) => {
      const fx = await analysisSourceFixture(st);

      await controlDriver(fx, 'fixture-a', { [mode]: 'Доска A недоступна' });

      const response = await fx.request('POST', '/api/tasks/42/analyze', { source: fx.a.source });

      assert.equal(response.statusCode, 200, response.body);

      const detail = await completed(fx, fx.a.source);

      assert.equal(detail.status.state, mode === 'detailError' ? 'failed' : 'done');
      assert.equal(fx.prompts.length, mode === 'detailError' ? 0 : 1);

      if (mode === 'pageError') {
        assert.equal(detail.analysis.summary, 'Оценка A');
      }

      assert.deepEqual(await taskCalls(fx, 'fixture-b'), []);
    });
  }
});

test('SOURCE-REFUSALS-01: повреждённый архив own не влияет на внешнюю оценку', async (t) => {
  const fx = await analysisSourceFixture(t);
  const archive = path.join(fx.config.stateDir, 'tasks.json');
  const bytes = '{повреждённый документ';

  await writeFile(archive, bytes);

  const response = await fx.request('POST', '/api/tasks/42/analyze', {});

  assert.equal(response.statusCode, 200, response.body);

  const detail = await completed(fx, fx.b.source);

  assert.equal(detail.status.state, 'done');
  assert.equal(detail.analysis.summary, 'Оценка B');
  assert.equal(await readFile(archive, 'utf8'), bytes);
  assert.equal(fx.prompts.length, 1);
  assert.deepEqual(await taskCalls(fx, 'fixture-a'), []);
  assert.deepEqual((await taskCalls(fx, 'fixture-b')).map((call) => call.method),
    ['taskDetail', 'taskPageData']);
});

test('SOURCE-REFUSALS-01: legacy порт без forDriver не подменяет явную доску default', async (t) => {
  const fx = await analysisSourceFixture(t, { held: true });

  fx.analyzer.tracker = {
    taskDetail: (...args) => fx.tracker.taskDetail(...args),
    taskPageData: (...args) => fx.tracker.taskPageData(...args),
  };

  const explicit = await fx.analyzer.analyze('42', { source: fx.a.source });

  assert.equal(explicit.ok, false, 'Адресная оценка требует адресного фасада, fallback запрещён');
  assert.deepEqual(await taskCalls(fx, 'fixture-b'), []);
  assert.equal(fx.prompts.length, 0);

  const legacy = await fx.analyzer.analyze('43');

  assert.equal(legacy.ok, true, 'Прежний standalone порт работает без source');
  assert.equal((await fx.analyzer.get('43')).analysis.summary, 'Оценка B');
});
