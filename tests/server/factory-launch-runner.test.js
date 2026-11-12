// Выбор исполнителя при запуске: launch-options отдаёт каталог и дефолт профиля,
// launch валидирует runnerPrimary ДО любых побочных эффектов и прокидывает его
// движку аргументом --runner-primary сразу после --ticket-json.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ATTEMPT, factoryLaunchFixture as fixture } from './helpers/factoryLaunch.js';


const missing = (file) => access(file).then(() => false, () => true);


const LAUNCH_PAYLOAD = {
  profile: 'demo',
  route: 'feature',
  title: 'Проверка выбора исполнителя',
  description: 'Запуск с явным runnerPrimary.',
  sourceUrl: 'https://example.test/tasks/42',
  acceptanceCriteria: [],
};

test('launch-options отдаёт каталог исполнителей и дефолт профиля', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/tasks/42/launch-options' });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().runners, ['claude', 'codex']);
  assert.equal(response.json().defaultRunner, 'codex');
});

test('GET /api/factory/runners отдаёт установленных исполнителей', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/factory/runners' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { runners: ['claude', 'codex'] });
});

test('launch с runnerPrimary прокидывает --runner-primary движку после --ticket-json', async (t) => {
  const { app, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'claude' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');
  const calls = await readFile(systemdCalls, 'utf8');

  assert.match(calls, new RegExp(
    `--ticket-json \\S*t42\\.ticket\\.json --runner-primary claude `
      + `--expected-catalog-hash ${'b'.repeat(64)} --queue-dispatch-id [a-f0-9-]{36} --routes-dir`,
  ));
});

test('launch без runnerPrimary запускается по профилю, без --runner-primary', async (t) => {
  const { app, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/43/launch',
    payload: LAUNCH_PAYLOAD,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');
  const calls = await readFile(systemdCalls, 'utf8');
  assert.equal(calls.includes('--runner-primary'), false);
});

test('два start одной задачи сериализованы даже пока registry остаётся bootstrap', async (t) => {
  const { app, auth, systemdCalls } = await fixture(t, {
    publishRegistry: false,
    withAuth: true,
  });
  const first = app.inject({
    method: 'POST',
    url: '/api/tasks/46/launch',
    headers: { 'x-grigdesk-internal': auth.internalToken },
    payload: { ...LAUNCH_PAYLOAD, expectedCatalogHash: 'b'.repeat(64) },
  });
  const second = app.inject({
    method: 'POST',
    url: '/api/tasks/46/launch',
    headers: { 'x-grigdesk-token': auth.cliToken },
    payload: LAUNCH_PAYLOAD,
  });

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  assert.equal(firstResponse.json().outcome, 'started');
  assert.equal(secondResponse.statusCode, 409, secondResponse.body);
  assert.equal(secondResponse.json().error, 'run_exists');
  assert.match(secondResponse.json().message, /trusted identity/);
  const starts = (await readFile(systemdCalls, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(starts.length, 1, 'после uncertain bootstrap второй engine start запрещён');
  assert.match(starts[0], new RegExp('--expected-catalog-hash b{64}'));
});

test('launch с неустановленным runnerPrimary отказан до вызова движка', async (t) => {
  const { app, factoryCalls, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/44/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'bogus' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'bad_runner');
  assert.equal(await missing(factoryCalls), true, 'движок не вызывался');
  assert.equal(await missing(systemdCalls), true, 'прогон не запускался');
});

test('launch с битым форматом runnerPrimary отказан до вызова движка', async (t) => {
  const { app, factoryCalls, systemdCalls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/45/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'Claude!' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'bad_runner');
  assert.equal(await missing(factoryCalls), true, 'движок не вызывался');
  assert.equal(await missing(systemdCalls), true, 'прогон не запускался');
});

test('отказ runner preflight не запирает задачу: следующий запуск проходит', async (t) => {
  // Отказ относится к выбранной цепочке: task override требует только codex,
  // хотя профиль также называет claude. Движок встал fail-closed ДО создания попытки —
  // ни реестра, ни control-записи, только launch.log с типизированным маркером.
  // Раньше pending-marker после такого отказа не снимался, и задача отвечала
  // `run_exists` до перезапуска сервера, хотя запускать её было совершенно нечем.
  const { app, root } = await fixture(t, { preflightFlag: true });

  const refused = await app.inject({
    method: 'POST',
    url: '/api/tasks/47/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'codex' },
  });
  assert.equal(refused.statusCode, 500, refused.body);
  assert.equal(refused.json().error, 'runner_preflight_unavailable');
  assert.deepEqual(refused.json().runners, ['codex']);
  assert.equal(refused.json().runners.includes('claude'), false);
  assert.equal(
    await missing(path.join(root, 'state', 't47.pipeline')),
    true,
    'реестр не создан — граница side effect не пересечена',
  );

  // Человек починил профиль (или вернул CLI) и запускает снова.
  await rm(path.join(root, 'preflight-fails'), { force: true });
  await rm(path.join(root, 'state', 't47.launch.log'), { force: true });

  const retried = await app.inject({
    method: 'POST',
    url: '/api/tasks/47/launch',
    payload: { ...LAUNCH_PAYLOAD, runnerPrimary: 'codex' },
  });
  assert.notEqual(
    retried.json().error,
    'run_exists',
    'pending-marker обязан сняться: доказано, что попытки не было',
  );
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().outcome, 'launched');
});

test('runner_preflight_failed сам по себе не освобождает pending', async () => {
  // Сломанная проверка не доказывает отсутствие попытки. Её код сам по себе
  // не разрешает повтор: для отказа подготовки нужен отдельный proof до spawn
  // с отсутствием реестра, attempt и резервации после rollback.
  const source = await readFile(
    new URL('../../server/src/modules/factory/index.ts', import.meta.url),
    'utf8',
  );
  const guard = source.slice(source.indexOf('const provenPreSideEffect'));
  const clause = guard.slice(0, guard.indexOf(';'));
  assert.match(clause, /runner_preflight_unavailable/);
  assert.doesNotMatch(clause, /runner_preflight_failed/);
});

test('B24-SOURCE-01: запуск сохраняет портальную ссылку, комментарии и уточнения', async (t) => {
  const { app, config } = await fixture(t, {
    tracker: {
      sourceUrl: (id) => `https://portal.test/company/personal/user/17/tasks/task/view/${id}/`,
      async accountIdentity() {
        return { baseUrl: 'https://portal.test/', userId: 17 };
      },
      async taskPageData() {
        return { comments: [
          {
            text: 'Комментарий человека',
            author: 'Автор',
            isSystem: false
          },
          {
            text: 'Служебный комментарий',
            author: 'Система',
            isSystem: true
          },
        ] };
      },
    },
    clarifications: 'Уточнение человека',
  });
  const { sourceUrl, ...payload } = LAUNCH_PAYLOAD;
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/48/launch',
    payload
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');

  const ticket = JSON.parse(await readFile(path.join(config.ticketsDir, 't48.ticket.json'), 'utf8'));

  assert.equal(ticket.title, payload.title);
  assert.match(ticket.description, /Запуск с явным runnerPrimary/);
  assert.equal(ticket.sourceUrl, 'https://portal.test/company/personal/user/17/tasks/task/view/48/');
  assert.match(ticket.description, /Комментарий человека/);
  assert.match(ticket.description, /Уточнение человека/);
  assert.doesNotMatch(ticket.description, /Служебный комментарий/);
});

test('OWN-REMOVED-TICKET: архив own не перекрывает внешний текст, URL и комментарии', async (t) => {
  const portalCalls = [];
  const { app, config } = await fixture(t, {
    tracker: {
      sourceUrl: (id) => `https://portal.test/task/${id}`,
      async accountIdentity() {
        portalCalls.push('identity');

        return { baseUrl: 'https://portal.test', userId: 17 };
      },
      async taskPageData() {
        portalCalls.push('comments');

        return { comments: [{ text: 'Внешний комментарий', author: 'Портал' }] };
      },
    },
    clarifications: 'Ответ человека на вопрос',
    openQuestions: { questions: ['Открытый вопрос'], unknowns: ['Проверить контракт'] },
  });
  const id = '100000000001';
  const archive = path.join(path.dirname(config.stateDir), 'tasks.json');
  const bytes = JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    nextId: '100000000010',
    tasks: [{
      id,
      source: 'grigdesk',
      title: 'Архивное название',
      description: 'Архивный текст',
      projectId: 'beta',
      projectTitle: 'Проект beta',
      sourceUrl: 'http://client.test/#/board?openTask=100000000001',
      createdAt: '2026-10-24T00:00:00.000Z',
    }],
  });

  await writeFile(archive, bytes);

  const { sourceUrl, ...payload } = LAUNCH_PAYLOAD;
  const response = await app.inject({
    method: 'POST',
    url: `/api/tasks/${id}/launch`,
    payload: {
      ...payload,
      title: 'Внешнее название',
      description: 'Внешняя постановка',
    },
  });

  assert.equal(response.statusCode, 200, response.body);

  const ticket = JSON.parse(await readFile(path.join(config.ticketsDir, `t${id}.ticket.json`), 'utf8'));

  assert.equal(ticket.title, 'Внешнее название');
  assert.equal(ticket.sourceUrl, `https://portal.test/task/${id}`);
  assert.match(ticket.description, /Внешняя постановка/);
  assert.match(ticket.description, /Внешний комментарий/);
  assert.match(ticket.description, /Ответ человека на вопрос/);
  assert.match(ticket.description, /Открытый вопрос/);
  assert.doesNotMatch(ticket.description, /Архивное название|Архивный текст/);
  assert.ok(portalCalls.includes('comments'));
  assert.equal(await readFile(archive, 'utf8'), bytes);
});

/**
 * Записывает независимые оценки и уточнения через HTTP настоящего Analyzer.
 * Источники и registry разрешает multiFixture, engine остаётся локальной заглушкой.
 */
async function sourceLaunchFixture(t) {
  const {
    analysisSourceFixture, completed, eventually, sourceQuery,
  } = await import('./helpers/analysisSource.js');
  const { controlDriver } = await import('./helpers/trackerMulti.js');
  const fx = await analysisSourceFixture(t, {
    resultFor: (label) => ({ scope: { do: [`Критерий ${label}`], skip: [] } }),
  });

  for (const [context, label] of [[fx.a, 'A'], [fx.b, 'B']]) {
    await controlDriver(fx, `fixture-${label.toLowerCase()}`, {
      comments: [
        {
          text: `Комментарий ${label}`,
          author: 'Человек',
          isSystem: false,
        },
        { text: `Системный ${label}`, isSystem: true },
      ],
    });
    await fx.request('POST', '/api/tasks/42/analyze', { source: context.source });
    await completed(fx, context.source);
    await eventually(() => fx.analyzer._jobs.size, (size) => size === 0);
    await fx.request('POST', `/api/tasks/42/clarifications?${sourceQuery(context.source)}`, {
      text: `Уточнение ${label}`,
    });
  }

  const launch = await fixture(t, { sourceFixture: fx });

  return { ...launch, sourceFixture: fx };
}

/**
 * Проверяет полный тикет и подтверждённый индекс после штатного ACK.
 * Эталон URL даёт тот же синтетический драйвер, чей source пришёл в запросе.
 */
async function assertSourceLaunch(fx, payload) {
  const { sourceFixture: source } = fx;
  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');

  const ticket = JSON.parse(await readFile(path.join(fx.config.ticketsDir, 't42.ticket.json'), 'utf8'));
  const { FactoryTaskSources } = await import('../../server/src/lib/factoryTaskSources.ts');
  const record = (await new FactoryTaskSources(fx.config.factoryTaskSourcesPath).read()).entries['42'];

  assert.deepEqual(Object.keys(ticket).sort(),
    ['acceptanceCriteria', 'description', 'schema', 'sourceUrl', 'taskId', 'title'].sort());
  assert.equal(ticket.title, payload.title);
  assert.equal(ticket.sourceUrl, await source.tracker.forDriver('fixture-a').sourceUrl('42'));
  assert.match(ticket.description, /Комментарий A/);
  assert.match(ticket.description, /Уточнение A/);
  assert.match(ticket.description, /Вопрос A/);
  assert.doesNotMatch(ticket.description, /Комментарий B|Уточнение B|Вопрос B|Системный/);
  assert.equal(record.source, source.a.source);
  assert.equal(FactoryTaskSources.verified(record, await fx.factoryState.readTrustedTicketProof('42')),
    source.a.source);
  assert.equal((await readFile(fx.systemdCalls, 'utf8')).trim().split('\n').length, 1);
  assert.equal(source.runtime.catalog().default, 'fixture-b');
}

test('SOURCE-LAUNCH-01: default B, source A — свой URL, comments, вопросы и индекс', async (t) => {
  const fx = await sourceLaunchFixture(t);
  const { sourceUrl, ...payload } = LAUNCH_PAYLOAD;

  await assertSourceLaunch(fx, { ...payload, source: fx.sourceFixture.a.source });
});

test('SOURCE-LAUNCH-01: expectedLaunch сравнивает snapshot той же A, hash B отвергается', async (t) => {
  const { factorySnapshotHash } = await import('../../server/src/lib/mobile/factoryIdentity.ts');
  const { sourceQuery } = await import('./helpers/analysisSource.js');

  for (const wrongHash of [false, true]) {
    await t.test(wrongHash ? 'hash B' : 'hash A', async (st) => {
      const fx = await sourceLaunchFixture(st);
      const source = wrongHash ? fx.sourceFixture.b.source : fx.sourceFixture.a.source;
      const options = await fx.app.inject(`/api/tasks/42/launch-options?${sourceQuery(source)}`);

      assert.equal(options.statusCode, 200, options.body);

      const { sourceUrl, ...body } = LAUNCH_PAYLOAD;
      const payload = {
        ...body,
        source: fx.sourceFixture.a.source,
        expectedLaunch: factorySnapshotHash(options.json()),
      };

      if (!wrongHash) {
        await assertSourceLaunch(fx, payload);
      } else {
        const response = await fx.app.inject({
          method: 'POST',
          url: '/api/tasks/42/launch',
          payload,
        });

        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error, 'state_changed');
        assert.equal(await missing(fx.systemdCalls), true);
      }
    });
  }
});

test('SOURCE-LAUNCH-RACE-01: удержанная A переживает смену default, owner закрывает spawn', async (t) => {
  const { analysisSourceFixture, eventually } = await import('./helpers/analysisSource.js');
  const { controlDriver } = await import('./helpers/trackerMulti.js');
  const { selectTracker } = await import('./helpers/trackerFixture.js');

  for (const ownerChanged of [false, true]) {
    await t.test(ownerChanged ? 'новый owner A' : 'новый default B', async (st) => {
      const entered = Promise.withResolvers();
      const released = Promise.withResolvers();
      const source = await analysisSourceFixture(st, {
        fetch: async () => {
          entered.resolve();
          await released.promise;

          return new Response('{}');
        },
      });

      await selectTracker(source, 'fixture-a');
      await controlDriver(source, 'fixture-a', { hold: 'taskPageData' });

      const fx = await fixture(st, { sourceFixture: source });
      const { sourceUrl, ...body } = LAUNCH_PAYLOAD;
      const pending = fx.app.inject({
        method: 'POST',
        url: '/api/tasks/42/launch',
        payload: { ...body, source: source.a.source },
      });

      st.after(() => released.resolve());
      await Promise.race([
        entered.promise,
        pending.then((response) => assert.fail(`Запуск не достиг драйвера A: ${response.body}`)),
      ]);

      try {
        if (ownerChanged) {
          const selection = { drivers: ['fixture-a', 'fixture-b'], default: 'fixture-b' };
          const change = source.runtime.writeSettings(selection, {
            'fixture-a': { endpoint: 'https://new-owner.fixture' },
          });

          await eventually(
            () => source.runtime.registry.activeIds.includes('fixture-a'),
            (active) => !active,
          );
          released.resolve();
          await change;
        } else {
          await selectTracker(source, 'fixture-b');
          released.resolve();
        }

        const response = await pending;

        assert.equal(response.statusCode, ownerChanged ? 409 : 200, response.body);
        assert.equal(await missing(fx.systemdCalls), ownerChanged);

        if (ownerChanged) {
          const { FactoryTaskSources } = await import('../../server/src/lib/factoryTaskSources.ts');
          const records = await new FactoryTaskSources(fx.config.factoryTaskSourcesPath).read();

          assert.equal(records.entries['42']?.attempt, undefined);
        }
      } finally {
        released.resolve();
        await pending;
      }
    });
  }
});

test('SOURCE-RUN-COLLISION-01: A42 не получает already_running от trusted B42', async (t) => {
  const { sourceFixture: source, ...fx } = await sourceLaunchFixture(t);
  const { sourceUrl, ...body } = LAUNCH_PAYLOAD;
  const launched = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: { ...body, source: source.b.source },
  });

  assert.equal(launched.statusCode, 200, launched.body);

  const indexBefore = await readFile(fx.config.factoryTaskSourcesPath, 'utf8');
  const spawnsBefore = await readFile(fx.systemdCalls, 'utf8');
  const collision = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: { ...body, source: source.a.source },
  });

  assert.equal(collision.statusCode, 409, collision.body);
  assert.equal(collision.json().error, 'task_source_mismatch');
  assert.equal(await readFile(fx.config.factoryTaskSourcesPath, 'utf8'), indexBefore);
  assert.equal(await readFile(fx.systemdCalls, 'utf8'), spawnsBefore);

  const same = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: { ...body, source: source.b.source },
  });

  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json().outcome, 'already_running');
});

test('SOURCE-RUN-COLLISION-01: неизвестный источник существующего запуска даёт run_exists', async (t) => {
  const { sourceFixture: source, ...fx } = await sourceLaunchFixture(t);
  const { sourceUrl, ...body } = LAUNCH_PAYLOAD;
  const launched = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: { ...body, source: source.b.source },
  });

  assert.equal(launched.statusCode, 200, launched.body);
  await writeFile(fx.config.factoryTaskSourcesPath, JSON.stringify({ schemaVersion: 1, entries: {} }));

  const spawns = await readFile(fx.systemdCalls, 'utf8');
  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: { ...body, source: source.a.source },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'run_exists');
  assert.equal(await readFile(fx.systemdCalls, 'utf8'), spawns);
});
