import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  clientFixture, closeClientBrowser, card, job, preparation, snapshot,
} from './helpers/providerInstallFixture.js';
import { deferred, installFixture, start, completed } from '../server/helpers/providerInstallFixture.js';
import { ApiError } from '../../web/src/shared/apiClient.ts';

after(closeClientBrowser);

test('отмена подтверждения не отправляет старт', async (t) => {
  const { store, calls } = await clientFixture(t, { confirm: false });

  await store.requestInstall(card.id, 'update');
  assert.equal(calls.confirmations.length, 1);
  assert.match(JSON.stringify(calls.confirmations[0]), /Claude фикстуры/u);
  assert.ok(JSON.stringify(calls.confirmations[0]).includes(card.installation.updateCommand));
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/prepare')).length, 1);
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
});

test('подтверждение показывает каталог и файлы оболочки без текста блока', async (t) => {
  const { store, calls } = await clientFixture(t, { confirm: false });

  await store.requestInstall(card.id, 'update');

  const shown = JSON.stringify(calls.confirmations[0]);

  assert.match(shown, /Каталог установки: \/home\/fixture\/.local/u);
  assert.match(shown, /Каталог добавится в PATH терминала: \.bashrc/u);
  assert.ok(!shown.includes('GrigDesk external CLI PATH'), 'текст блока показан человеку');
  assert.equal(calls.confirmations[0].details.code, card.installation.updateCommand);
});

test('202 не завершает установку', async (t) => {
  const { store, providers, calls } = await clientFixture(t);

  await store.requestInstall(card.id, 'update');
  assert.equal(store.snapshot.active.id, 'fixture-job-1');
  assert.equal(providers.updating, 'claude');
  assert.equal(providers.updateResults.claude ?? null, null);
  await store.requestInstall(card.id, 'update');
  await store.requestInstall('codex', 'update');
  assert.equal(calls.confirmations.length, 1);

  const starts = calls.posts.filter((post) => post.url.endsWith('/start'));

  assert.equal(starts.length, 1);
  assert.equal(starts[0].url, '/api/providers/claude/update/start');
  assert.deepEqual(starts[0].body, { preparationToken: 'fixture-preparation-token' });
});

test('prepare предшествует подтверждению и передаёт token в старт', async (t) => {
  const { store, calls } = await clientFixture(t);

  await store.requestInstall(card.id, 'install');

  assert.deepEqual(calls.posts.map((post) => post.url), [
    '/api/providers/claude/install/prepare',
    '/api/providers/claude/install/start',
  ]);
  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.confirmations[0].details.code.startsWith(card.installation.installCommand), true);
});

test('изменение подготовки показывается как ошибка и не запускает старт', async (t) => {
  let attempts = 0;
  const { store, calls } = await clientFixture(t, {
    prepare: async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new ApiError('Настройки изменились', 409, {
          error: 'preparation_changed',
          message: 'Настройки изменились',
        });
      }

      return preparation();
    },
  });

  await store.requestInstall(card.id, 'update');

  assert.equal(calls.confirmations.length, 0);
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
  assert.match(store.error, /изменились/iu);

  await store.requestInstall(card.id, 'update');

  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 1);
});

test('ответ другой машины не открывает подтверждение', async (t) => {
  const late = deferred();
  const { store, auth, calls } = await clientFixture(t, {
    prepare: () => late.promise,
  });
  const pending = store.requestInstall(card.id, 'update');

  auth.clientScope = 'другая-машина';
  late.resolve(preparation());
  await pending;

  assert.equal(calls.confirmations.length, 0);
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
});

test('новая Pinia восстанавливает тот же job', async (t) => {
  const remote = snapshot(job(), 8);
  const first = await clientFixture(t, { get: async () => structuredClone(remote) });

  await first.store.load();

  const second = await clientFixture(t, { get: async () => structuredClone(remote) });

  await second.store.load();
  assert.equal(second.store.snapshot.active.id, first.store.snapshot.active.id);
  assert.equal(second.providers.updating, 'claude');
  assert.equal(second.calls.posts.length, 0);
});

test('первый снимок с тремя итогами не пересобирает реестр при загрузке и reconnect', async (t) => {
  const fixture = await clientFixture(t);
  const recent = Object.fromEntries(['claude', 'codex', 'kimi'].map((providerId) => [providerId, job({
    providerId,
    id: `finished-${providerId}`,
    status: 'succeeded',
    stage: 'models',
    outcome: 'updated',
    after: '2.0.0',
    finishedAt: 1_700_000_001_000,
  })]));

  fixture.setRemote(snapshot(null, 6, recent));
  await fixture.store.load();
  await fixture.store.load();

  for (const providerId of Object.keys(recent)) {
    assert.equal(fixture.providers.updateResults[providerId].type, 'ok');
    assert.match(fixture.providers.updateResults[providerId].text, /1\.0\.0.*2\.0\.0/u);
  }

  fixture.setRemote(snapshot(null, 7, {
    ...recent,
    kimi: { ...recent.kimi, id: 'finished-without-observed-active' },
  }));
  await fixture.store.load();

  const refreshes = fixture.calls.gets.filter((url) => url === '/api/providers?refresh=1');

  assert.equal(refreshes.length, 0, 'Чтение сохранённого итога запускает пересборку моделей');
});

test('завершение увиденной активной операции перечитывает реестр ровно один раз', async (t) => {
  const fixture = await clientFixture(t);
  const active = job();
  const final = job({
    status: 'succeeded',
    stage: 'models',
    outcome: 'updated',
    after: '2.0.0',
    finishedAt: 1_700_000_001_000,
  });

  fixture.store.applySnapshot(snapshot(active, 1));
  fixture.store.applySnapshot(snapshot({ ...active, outputTail: 'ещё строка' }, 2));
  assert.equal(fixture.calls.gets.length, 0);
  fixture.store.applySnapshot(snapshot(null, 3, { claude: final }));
  fixture.store.applySnapshot(snapshot(null, 3, { claude: final }));
  fixture.setRemote(snapshot(null, 4, { claude: final }));
  await fixture.store.load();

  const refreshes = fixture.calls.gets.filter((url) => url === '/api/providers?refresh=1');

  assert.equal(refreshes.length, 1, 'Повторный снимок завершённой операции повторяет refresh');
  assert.equal(fixture.providers.updateResults.claude.type, 'ok');
  assert.equal(fixture.calls.posts.length, 0);
});

test('поздний GET не откатывает SSE', async (t) => {
  const late = deferred();
  const { store, auth } = await clientFixture(t, { get: () => late.promise });
  const loading = store.load();

  store.applySnapshot(snapshot(job({ outputTail: 'новый вывод' }), 9));
  late.resolve(snapshot(job({ outputTail: 'старый вывод' }), 2));
  await loading;
  assert.equal(store.snapshot.revision, 9);
  assert.equal(store.snapshot.active.outputTail, 'новый вывод');

  const otherMachine = deferred();
  let machineReads = 0;
  const fixture = await clientFixture(t, {
    get: async () => {
      machineReads += 1;

      return machineReads === 1 ? otherMachine.promise : snapshot(job({ id: 'new-machine' }), 1);
    },
  });
  const previous = fixture.store.load();

  fixture.auth.clientScope = 'другая-машина';
  await new Promise((resolve) => setImmediate(resolve));
  fixture.store.applySnapshot(snapshot(job({ id: 'new-machine' }), 1));
  otherMachine.resolve(snapshot(job({ id: 'old-machine' }), 99));
  await previous;
  assert.equal(fixture.store.snapshot.active.id, 'new-machine');
  auth.authenticated = false;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot.active, null);
});

test('потерянный POST сверяется GET без повторной команды', async (t) => {
  const read = deferred();
  let postAttempted = false;
  const { store, calls, providers } = await clientFixture(t, {
    post: async () => {
      postAttempted = true;

      throw new TypeError('Ответ потерян после допуска');
    },
    get: async () => {
      return postAttempted ? read.promise : snapshot();
    },
  });

  await store.load();

  const pending = store.requestInstall(card.id, 'update');

  await new Promise((resolve) => setImmediate(resolve));
  await store.requestInstall(card.id, 'update');
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 1);
  read.resolve(snapshot(job(), 5));
  await pending;
  assert.ok(calls.gets.includes('/api/providers/installations/current'));
  assert.equal(store.snapshot.active.id, 'fixture-job-1');
  assert.equal(providers.updating, 'claude');
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 1);
});

test('models warning сохраняет смену версии без обещания пересборки моделей', async (t) => {
  const server = await installFixture(t, { modelsError: true });
  const started = await start(server.app);

  assert.equal(started.statusCode, 202, started.body);
  server.gate.resolve();

  const final = (await completed(server.app)).recent.claude;
  const { store, providers, module } = await clientFixture(t);

  for (const locale of ['ru', 'en']) {
    module.setUiLocale(locale);
    store.applySnapshot(snapshot(null, locale === 'ru' ? 5 : 6, {
      claude: final,
    }));

    const result = providers.updateResults.claude;

    assert.equal(result.type, 'ok');
    assert.equal(result.changed, true);
    assert.match(result.text, /1\.0\.0.*2\.0\.0/u);
    assert.match(result.text, locale === 'ru' ? /модел.*не обнов/iu
      : /model.*(?:not|fail|unavailable)|(?:not|could|fail|unable).*model/iu);
    assert.doesNotMatch(result.text, /Список моделей пересобран|model list (?:was )?rebuilt/iu);

    if (locale === 'en') {
      assert.doesNotMatch(result.text, /[А-Яа-яЁё]/u);
    }
  }
});

/**
 * Отказ подготовки не должен выглядеть как неработающая кнопка: причина видна
 * у карточки, а окно открывает ту же причину. Старт при этом не отправляется.
 */
test('отказ подготовки виден у карточки и не запускает старт', async (t) => {
  const { store, providers, calls } = await clientFixture(t, {
    prepare: async () => {
      throw new ApiError('Подготовка недействительна', 409, {
        error: 'preparation_invalid',
        message: 'Подготовка недействительна',
      });
    },
  });

  await store.requestInstall(card.id, 'update');

  assert.equal(calls.confirmations.length, 0);
  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
  assert.equal(providers.updateResults.claude?.type, 'err');
  assert.match(providers.updateResults.claude.text, /Подготовка недействительна/u);
  assert.equal(store.visible, true);
  assert.match(store.error, /недействительна/u);
});

/**
 * Последний успешный job может быть сохранён за несколько дней до нового клика.
 * Отказ подготовки не должен подставлять его ни в окно, ни в итог карточки.
 */
test('отказ новой подготовки скрывает прежний успех Claude и Kimi', async (t) => {
  for (const providerId of ['claude', 'kimi']) {
    await t.test(providerId, async (scenario) => {
      const fixture = await clientFixture(scenario, {
        prepare: async () => {
          throw new ApiError('Маршрут подготовки не найден', 404, { error: 'not_found' });
        },
      });
      const previous = job({
        providerId,
        id: `previous-${providerId}`,
        status: 'succeeded',
        stage: 'models',
        outcome: 'updated',
        after: '2.1.310',
        finishedAt: 1_700_000_001_000,
      });

      fixture.providers.providers = [{ ...structuredClone(card), id: providerId }];
      fixture.setRemote(snapshot(null, 4, { [providerId]: previous }));
      await fixture.store.load();
      await fixture.store.requestInstall(providerId, 'install');

      assert.equal(fixture.store.selectedJob, null, 'Показан старый успешный job вместо отказа');
      assert.equal(fixture.store.selectedFailure?.operation, 'install');
      assert.equal(fixture.providers.updateResults[providerId].type, 'err');

      // Такой же GET выполняется при открытии окна и при reconnect SSE.
      // Он не подтверждает новую установку и не отменяет причину отказа.
      fixture.setRemote(snapshot(null, 5, { [providerId]: previous }));
      await fixture.store.load();

      assert.equal(fixture.store.selectedJob, null);
      assert.match(fixture.store.selectedFailure.message, /Перезапустите GrigDesk/u);
      assert.equal(fixture.providers.updateResults[providerId].type, 'err');
      assert.match(fixture.providers.updateResults[providerId].text, /Перезапустите GrigDesk/u);
      assert.equal(fixture.calls.confirmations.length, 0);
      assert.equal(fixture.calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
      assert.equal(fixture.store.snapshot.recent[providerId].id, previous.id);

      fixture.store.applySnapshot(snapshot(job({
        providerId,
        id: `next-${providerId}`,
        operation: 'install',
      }), 6, { [providerId]: previous }));

      assert.equal(fixture.store.selectedFailure, null);
      assert.equal(fixture.store.selectedJob.id, `next-${providerId}`);
    });
  }
});

/**
 * Старое окно против нового сервера — известное расхождение версий. 404 маршрута
 * подготовки переводится в прямой совет перезапустить GrigDesk, без ложного повтора.
 */
test('старый сервер без маршрута подготовки просит перезапуск', async (t) => {
  const { store, providers, calls } = await clientFixture(t, {
    prepare: async () => {
      throw new ApiError('Route POST:/api/providers/claude/update/prepare not found', 404, {
        error: 'Not Found',
        message: 'Route POST:/api/providers/claude/update/prepare not found',
      });
    },
  });

  await store.requestInstall(card.id, 'update');

  assert.equal(calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
  assert.equal(providers.updateResults.claude?.type, 'err');
  assert.match(providers.updateResults.claude.text, /Сервер ещё не обновлён/u);
  assert.match(store.error, /Перезапустите GrigDesk/u);
});

/**
 * История иногда загружается только при первом открытии окна установки.
 * Прежде неизвестный завершённый job не подтверждает старт после отказа prepare.
 */
test('первое чтение старого job не отменяет отказ подготовки той же операции', async (t) => {
  const previous = job({
    id: 'previous-unseen-update',
    status: 'succeeded',
    stage: 'models',
    outcome: 'updated',
    after: '2.1.310',
    finishedAt: 1_700_000_001_000,
  });
  const fixture = await clientFixture(t, {
    prepare: async () => {
      throw new ApiError('Подготовка недействительна', 409, {
        error: 'preparation_invalid',
        message: 'Подготовка недействительна',
      });
    },
  });

  await fixture.store.requestInstall(card.id, 'update');
  fixture.setRemote(snapshot(null, 2, { claude: previous }));
  await fixture.store.load();

  assert.equal(fixture.store.selectedJob, null);
  assert.equal(fixture.store.selectedFailure.operation, 'update');
  assert.match(fixture.store.selectedFailure.message, /Подготовка недействительна/u);
  assert.equal(fixture.providers.updateResults.claude.type, 'err');
  assert.equal(fixture.calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
});
