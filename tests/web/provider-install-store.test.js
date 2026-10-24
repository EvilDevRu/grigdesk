import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { clientFixture, closeClientBrowser, card, job, snapshot } from './helpers/providerInstallFixture.js';
import { deferred, installFixture, start, completed } from '../server/helpers/providerInstallFixture.js';

after(closeClientBrowser);

test('отмена подтверждения не отправляет POST', async (t) => {
  const { store, calls } = await clientFixture(t, { confirm: false });

  await store.requestInstall(card.id, 'update');
  assert.equal(calls.confirmations.length, 1);
  assert.match(JSON.stringify(calls.confirmations[0]), /Claude фикстуры/u);
  assert.ok(JSON.stringify(calls.confirmations[0]).includes(card.installation.updateCommand));
  assert.equal(calls.posts.length, 0);
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
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].url, '/api/providers/claude/update/start');
  assert.ok(calls.posts[0].body == null || Object.keys(calls.posts[0].body).length === 0);
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
  assert.equal(calls.posts.length, 1);
  read.resolve(snapshot(job(), 5));
  await pending;
  assert.ok(calls.gets.includes('/api/providers/installations/current'));
  assert.equal(store.snapshot.active.id, 'fixture-job-1');
  assert.equal(providers.updating, 'claude');
  assert.equal(calls.posts.length, 1);
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
