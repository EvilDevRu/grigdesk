import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pluginInstallStoreFixture,
  deferredInstallResponse,
  flushInstallRequests,
} from './helpers/pluginInstallStoreFixture.js';
import { webInstallJob, webInstallInfo } from './helpers/pluginInstallFixtures.js';
import { ApiError } from '../../web/src/shared/apiClient.ts';

const ROOT = '/api/plugin-installs';
const INPUT = ' https://EXAMPLE.invalid/demo.git/ ';
const SOURCE = { kind: 'git', url: 'https://example.invalid/demo.git' };
const VERSION = {
  version: '1.1.0',
  tag: 'v1.1.0',
  sha: 'a'.repeat(40),
};

test('ST1: поиск POST, canonical URL отдельно от input key, очистка и decoder failure', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const wait = deferredInstallResponse(t);

  fixture.handlers.set('POST ' + ROOT + '/versions', () => wait.promise);
  store.versions = [VERSION];

  const pending = store.listVersions(INPUT);

  assert.deepEqual(store.versions, []);
  assert.equal(store.versionsLoading, true);
  assert.equal(store.versionsInputKey, INPUT.trim());
  assert.deepEqual(fixture.calls[0].body, { url: INPUT.trim() });
  wait.resolve({ source: SOURCE, versions: [VERSION] });
  await pending;
  assert.equal(store.versionsUrl, SOURCE.url);
  assert.deepEqual(store.versions, [VERSION]);
  assert.equal(store.versionsLoading, false);

  fixture.handlers.set('POST ' + ROOT + '/versions', () => ({ source: SOURCE, versions: [null] }));
  await store.listVersions(INPUT);
  assert.equal(store.versions.length, 0);
  assert.match(store.versionsError, /некорректные данные/u);
  assert.equal(store.versionsUrl, '');
});

test('ST2: install omits пустую version, bind expectedId и единственный polling timeout', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const running = webInstallJob('running');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  fixture.handlers.set('POST ' + ROOT + '/jobs', () => ({ job: running }));
  fixture.handlers.set('POST ' + ROOT + '/versions', () => ({ source: SOURCE, versions: [VERSION] }));
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: running, recoveryError: null }));
  await store.listVersions(INPUT);
  await store.startInstall(INPUT, '', false);
  assert.equal(fixture.calls.filter((call) => call.url === ROOT + '/jobs').length, 1);
  assert.deepEqual(fixture.calls.find((call) => call.url === ROOT + '/jobs').body, { url: SOURCE.url });
  assert.equal(store.job.id, running.id);
  t.mock.timers.tick(1000);
  await flushInstallRequests();
  assert.equal(fixture.calls.filter((call) => call.method === 'GET').length, 1);

  const other = fixture.newStore();

  await other.startInstall(SOURCE.url, '1.1.0', true, 'demo');
  assert.deepEqual(fixture.calls.filter((call) => call.url === ROOT + '/jobs').at(-1).body, {
    url: SOURCE.url,
    version: '1.1.0',
    replaceModified: true,
    expectedId: 'demo',
  });
});

test('ST3: update передаёт version/force и запирает повтор до ответа', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const wait = deferredInstallResponse(t);

  fixture.handlers.set('POST ' + ROOT + '/plugins/demo/update', () => wait.promise);

  const pending = store.startUpdate('demo', '1.1.0', true);

  assert.equal(store.busy, true);
  assert.deepEqual(fixture.calls[0].body, { version: '1.1.0', replaceModified: true });
  await store.startUpdate('demo', '1.1.0', true);
  assert.equal(fixture.calls.length, 1);
  wait.resolve({ job: webInstallJob('ready', 'update') });
  await pending;
  assert.equal(store.busy, false);
  assert.equal(store.job.kind, 'update');
});

test('ST4: active продолжают poll, остальные прекращают; done обновляет каталог один раз', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();

  t.mock.timers.enable({ apis: ['setTimeout'] });

  for (const status of [
    'running', 'applying', 'ready', 'failed', 'cancelled', 'interrupted', 'recovery_required',
  ]) {
    const job = webInstallJob(status);

    fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job, recoveryError: null }));
    await store.loadJob();

    const reads = fixture.calls.length;

    t.mock.timers.tick(1000);
    await flushInstallRequests();
    assert.equal(fixture.calls.length - reads, ['running', 'applying'].includes(status) ? 1 : 0);
  }

  const done = webInstallJob('done', 'update');

  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: done, recoveryError: null }));
  await store.loadJob();
  await store.loadJob();
  assert.equal(fixture.loads, 1);
  t.mock.timers.tick(20000);
  await flushInstallRequests();
  assert.equal(store.job.id, done.id);
  assert.equal(fixture.loads, 1);
});

test('ST5: apply отправляет token, done refresh; известные 409 сохраняют ready', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const ready = webInstallJob();

  store.job = ready;
  fixture.handlers.set('POST ' + ROOT + '/jobs/' + ready.id + '/apply', () => ({
    job: {
      ...webInstallJob('done'),
      id: ready.id,
      revision: 2,
    },
  }));
  await store.apply();
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].body, { reviewToken: ready.reviewToken });
  assert.equal(store.job.status, 'done');
  assert.equal(fixture.loads, 1);

  for (const code of ['plugin_busy', 'plugin_stop_required', 'local_changes', 'preview_stale']) {
    store.job = ready;
    fixture.handlers.set('POST ' + ROOT + '/jobs/' + ready.id + '/apply', () => {
      throw new ApiError('Причина: ' + code, 409, { error: code, message: 'Причина: ' + code });
    });
    await store.apply();
    assert.equal(store.job.status, 'ready');
    assert.equal(store.job.reviewToken, ready.reviewToken);
    assert.equal(store.error, 'Причина: ' + code);
    assert.equal(store.busy, false);
  }
});

test('ST6: cancel меняет поколение, поздний running GET не отменяет terminal', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const running = webInstallJob('running');
  const wait = deferredInstallResponse(t);

  store.job = running;
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => wait.promise);
  fixture.handlers.set('POST ' + ROOT + '/jobs/' + running.id + '/cancel', () => ({
    job: {
      ...webInstallJob('cancelled'),
      id: running.id,
      revision: 2,
    },
  }));

  const poll = store.pollJob();

  await store.cancel();
  assert.equal(store.job.status, 'cancelled');
  wait.resolve({ job: running, recoveryError: null });
  await poll;
  assert.equal(store.job.status, 'cancelled');
  assert.equal(store.job.revision, 2);
  assert.deepEqual(fixture.calls.at(-1).body, {});
});

test('ST7: rollback сохраняет UUID/revision/previousDigest до POST и принимает Job', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const plugin = { id: 'demo', install: webInstallInfo() };

  fixture.handlers.set('POST ' + ROOT + '/plugins/demo/rollback', (call) => {
    const saved = JSON.parse([...fixture.storage.values()][0]);

    assert.equal(saved.pluginId, plugin.id);
    assert.deepEqual(saved.body, call.body);
    assert.match(call.body.requestId, /^[a-f0-9-]{36}$/u);
    assert.equal(call.body.expectedRevision, plugin.install.revision);
    assert.equal(call.body.expectedPreviousDigest, plugin.install.previous.payloadDigest);

    return { job: webInstallJob('done', 'rollback') };
  });
  await store.rollback(plugin);
  assert.equal(fixture.calls.length, 1);
  assert.equal(store.job.kind, 'rollback');
  assert.equal(store.job.status, 'done');
  assert.equal(fixture.storage.size, 0);
  assert.equal(fixture.loads, 1);
});

test('ST8: check single flight и finally reload даже при отказе', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const wait = deferredInstallResponse(t);

  fixture.handlers.set('POST ' + ROOT + '/check', () => wait.promise);

  const first = store.checkUpdates();
  const second = store.checkUpdates();

  assert.equal(store.checking, true);
  assert.equal(fixture.calls.length, 1);
  wait.resolve({ plugins: { demo: webInstallInfo() } });
  await Promise.all([first, second]);
  assert.equal(store.checking, false);
  assert.equal(fixture.loads, 1);
  fixture.handlers.set('POST ' + ROOT + '/check', () => {
      throw new Error('Нет связи');
    });
  await store.checkUpdates();
  assert.equal(store.checking, false);
  assert.equal(store.error, 'Нет связи');
  assert.equal(fixture.loads, 2);
});

test('ST9: actual failureText принимает ApiError, Error и брошенную строку', async (t) => {
  const fixture = pluginInstallStoreFixture(t);

  for (const [cause, expected] of [
    [new ApiError('Занят плагин', 409, { error: 'plugin_busy' }), 'Занят плагин'],
    [new Error('Нет сети'), 'Нет сети'],
    ['Отказ строкой', 'Отказ строкой'],
  ]) {
    const store = fixture.newStore();

    fixture.handlers.set('POST ' + ROOT + '/jobs', () => {
      throw cause;
    });
    await store.startInstall(SOURCE.url, '1.1.0');
    assert.equal(store.error, expected);
    assert.equal(store.busy, false);
  }
});

test('ST10: slow poll один, dispose abort, поздний ответ не действует, stores не делят timers', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const first = fixture.newStore();
  const second = fixture.newStore();
  const waits = [];

  t.mock.timers.enable({ apis: ['setTimeout'] });
  first.job = webInstallJob('running');
  second.job = webInstallJob('running');
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => {
    const wait = deferredInstallResponse(t);

    waits.push(wait);

    return wait.promise;
  });

  const a = first.pollJob();
  const b = first.pollJob();

  t.mock.timers.tick(10000);
  await flushInstallRequests();
  assert.equal(fixture.calls.length, 1);

  const c = second.pollJob();

  assert.equal(fixture.calls.length, 2);
  first.$dispose();
  assert.equal(fixture.calls[0].options.signal.aborted, true);
  assert.equal(fixture.calls[1].options.signal.aborted, false);
  waits[0].resolve({ job: webInstallJob('done'), recoveryError: null });
  waits[1].resolve({ job: second.job, recoveryError: null });
  await Promise.all([a, b, c]);
  assert.equal(first.job.status, 'running');
  assert.equal(fixture.loads, 0);
  t.mock.timers.tick(1000);
  await flushInstallRequests();
  assert.equal(fixture.calls.length, 3);
  waits[2].resolve({ job: webInstallJob('ready'), recoveryError: null });
  await flushInstallRequests();
});

test('ST11: versions A/B наоборот, ввод изменился — принимается только B и старый выбор запрещён',
  async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const a = deferredInstallResponse(t);
  const b = deferredInstallResponse(t);
  const secondUrl = 'https://second.invalid/demo.git';

  fixture.handlers.set('POST ' + ROOT + '/versions', (call) =>
    call.body.url === INPUT.trim() ? a.promise : b.promise);

  const first = store.listVersions(INPUT);
  const second = store.listVersions(secondUrl);

  b.resolve({ source: { kind: 'git', url: secondUrl }, versions: [VERSION] });
  await second;
  a.resolve({ source: SOURCE, versions: [] });
  await first;
  assert.equal(store.versionsUrl, secondUrl);
  assert.equal(store.versionsInputKey, secondUrl);
  assert.deepEqual(store.versions, [VERSION]);
  store.invalidateVersions('https://third.invalid/demo.git');
  assert.deepEqual(store.versions, []);
  await store.startInstall('https://third.invalid/demo.git', VERSION.version);
  assert.equal(fixture.calls.some((call) => call.url === ROOT + '/jobs'), false);
});

test('ST12: поздний poll до apply, меньшая revision и старый job после нового start игнорируются',
  async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const ready = webInstallJob('ready', 'update', { revision: 5 });
  const done = {
      ...webInstallJob('done', 'update'),
      id: ready.id,
      revision: 7,
    };
  const wait = deferredInstallResponse(t);

  store.job = ready;
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => wait.promise);
  fixture.handlers.set('POST ' + ROOT + '/jobs/' + ready.id + '/apply', () => ({ job: done }));

  const old = store.pollJob();

  await store.apply();
  wait.resolve({ job: ready, recoveryError: null });
  await old;
  assert.equal(store.job.status, 'done');
  assert.equal(fixture.loads, 1);
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: ready, recoveryError: null }));
  await store.loadJob();
  assert.equal(store.job.revision, 7);
  assert.equal(store.job.status, 'done');

  const delayed = deferredInstallResponse(t);
  const running = webInstallJob('running');

  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => delayed.promise);
  fixture.handlers.set('POST ' + ROOT + '/jobs', () => ({ job: running }));

  const beforeStart = store.pollJob();

  await store.startInstall(SOURCE.url, '1.1.0');
  delayed.resolve({ job: done, recoveryError: null });
  await beforeStart;
  assert.equal(store.job.id, running.id);
  assert.equal(store.job.status, 'running');
  assert.equal(fixture.loads, 1);
});

test('ST13: lost apply подтверждается GET исходного id, pendingAction запирает ready до ошибки',
  async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const ready = webInstallJob();
  const post = deferredInstallResponse(t);
  const read = deferredInstallResponse(t);

  store.job = ready;
  fixture.handlers.set('POST ' + ROOT + '/jobs/' + ready.id + '/apply', () => post.promise);
  fixture.handlers.set('GET ' + ROOT + '/jobs/' + ready.id, () => read.promise);

  const applying = store.apply();

  assert.equal(store.pendingAction, 'apply');
  assert.equal(store.busy, true);
  await store.apply();
  assert.equal(fixture.calls.length, 1);
  post.reject(new TypeError('HTTP ответ потерян после commit'));
  await flushInstallRequests();
  assert.equal(store.reconciling, true);
  assert.equal(store.job.status, 'ready');
  assert.equal(fixture.calls.at(-1).url, ROOT + '/jobs/' + ready.id);
  read.resolve({ job: {
      ...webInstallJob('done'),
      id: ready.id,
      revision: 2,
    }, recoveryError: null });
  await applying;
  assert.equal(store.job.status, 'done');
  assert.equal(store.reconciling, false);
  assert.equal(store.pendingAction, null);
  assert.equal(fixture.loads, 1);
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 1);
});

test('ST14: lost start читает current и восстанавливает созданный job без второго POST', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const running = webInstallJob('running');

  fixture.handlers.set('POST ' + ROOT + '/jobs', () => {
      throw new TypeError('Ответ не дошёл');
    });
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: running, recoveryError: null }));
  await store.startInstall(SOURCE.url, '1.1.0');
  assert.equal(store.job.id, running.id);
  assert.equal(store.job.status, 'running');
  assert.equal(store.reconciling, false);
  assert.equal(store.pendingAction, null);
  assert.deepEqual(fixture.calls.map((call) => call.method), ['POST', 'GET']);
});

test('ST15: lost rollback и новая вкладка сохраняют body/requestId, replay даёт receipt без второго эффекта',
  async (t) => {
    const fixture = pluginInstallStoreFixture(t);
    const first = fixture.newStore();
    const plugin = { id: 'demo', install: webInstallInfo() };
    const done = webInstallJob('done', 'rollback', { revision: 5 });
    let effects = 0;
    let savedBody;

    fixture.handlers.set('POST ' + ROOT + '/plugins/demo/rollback', (call) => {
      effects += 1;
      savedBody = call.body;

      throw new TypeError('Ответ потерян после durable receipt');
    });
    await first.rollback(plugin);
    assert.equal(first.reconciling, true);
    assert.equal(fixture.storage.size, 1);
    first.$dispose();

    const second = fixture.newStore();

    fixture.handlers.set('POST ' + ROOT + '/plugins/demo/rollback', (call) => {
      assert.deepEqual(call.body, savedBody);

      return { job: done };
    });
    await second.loadJob();
    assert.equal(second.job?.id, done.id);
    assert.equal(second.job.kind, 'rollback');
    assert.equal(second.reconciling, false);
    assert.equal(fixture.storage.size, 0);
    assert.equal(effects, 1);
    assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 2);
  });

test('ST16: прежний receipt либо явный revision conflict разрешают старое намерение без нового UUID',
  async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const intent = {
    pluginId: 'demo',
    body: {
      requestId: crypto.randomUUID(),
      expectedRevision: 3,
      expectedPreviousDigest: 'b'.repeat(64),
    },
  };
  const receipt = webInstallJob('done', 'rollback', { revision: 4 });

  for (const conflict of [true, false]) {
    fixture.storage.set('grigdesk-plugin-install-rollback', JSON.stringify(intent));
    fixture.handlers.set('POST ' + ROOT + '/plugins/demo/rollback', (call) => {
      assert.deepEqual(call.body, intent.body);

      if (conflict) {
        throw new ApiError('Установка уже изменилась.', 409, { error: 'local_changes' });
      }

      return { job: receipt };
    });

    const store = fixture.newStore();

    await store.loadJob();
    assert.equal(store.reconciling, false);
    assert.equal(fixture.storage.has('grigdesk-plugin-install-rollback'), false);

    if (conflict) {
      assert.equal(store.error, 'Установка уже изменилась.');
      assert.equal(store.job, null);
    } else {
      assert.equal(store.job.id, receipt.id);
      assert.equal(store.job.revision, 4);
    }

    store.$dispose();
  }

  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(fixture.loads, 2);
});

test('ST17: unread terminal сохраняется, forget только явный terminal; новая revision видна', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const first = fixture.newStore();
  const done = webInstallJob('done');

  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: done, recoveryError: null }));
  await first.loadJob();
  await first.loadJob();
  assert.equal(first.job.id, done.id);
  first.forgetJob();
  assert.equal(first.job, null);

  const second = fixture.newStore();

  await second.loadJob();
  assert.equal(second.job, null);
  done.revision += 1;
  await second.loadJob();
  assert.equal(second.job.revision, done.revision);

  for (const status of ['running', 'applying', 'ready', 'recovery_required']) {
    const active = webInstallJob(status);

    second.job = active;
    second.forgetJob();
    assert.equal(second.job?.id, active.id);
  }
});

test('ST18: видимый network failure, backoff до10с/reset и остановка polling при401/403', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const running = webInstallJob('running');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: running, recoveryError: null }));
  await store.loadJob();
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => {
      throw new TypeError('Связь потеряна');
    });
  t.mock.timers.tick(1000);
  await flushInstallRequests();
  assert.equal(store.error, 'Связь потеряна');

  for (const delay of [2000, 4000, 8000, 10000, 10000]) {
    const before = fixture.calls.length;

    t.mock.timers.tick(delay - 1);
    await flushInstallRequests();
    assert.equal(fixture.calls.length, before);
    t.mock.timers.tick(1);
    await flushInstallRequests();
    assert.equal(fixture.calls.length, before + 1);
  }

  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: running, recoveryError: null }));
  t.mock.timers.tick(10000);
  await flushInstallRequests();

  const before = fixture.calls.length;

  t.mock.timers.tick(999);
  await flushInstallRequests();
  assert.equal(fixture.calls.length, before);
  t.mock.timers.tick(1);
  await flushInstallRequests();
  assert.equal(fixture.calls.length, before + 1);
  assert.equal(store.error, null);
  store.$dispose();

  for (const status of [401, 403]) {
    const guarded = fixture.newStore();

    fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: running, recoveryError: null }));
    await guarded.loadJob();
    fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => {
      throw new ApiError('Нужен вход', status, {});
    });
    t.mock.timers.tick(1000);
    await flushInstallRequests();

    const after = fixture.calls.length;

    assert.equal(guarded.error, 'Нужен вход');
    t.mock.timers.tick(30000);
    await flushInstallRequests();
    assert.equal(fixture.calls.length, after);
    guarded.$dispose();
  }
});

test('ST19: health приjob:null и malformed current блокируют все мутации, прежняя карточка цела',
  async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const health = { code: 'recovery_required', message: 'Копии требуют восстановления.' };

  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: null, recoveryError: health }));
  await store.loadJob();
  assert.deepEqual(store.recoveryError, health);
  await store.startInstall(SOURCE.url, '1.1.0');
  await store.startUpdate('demo', '1.1.0');
  await store.rollback({ id: 'demo', install: webInstallInfo() });
  await store.checkUpdates();
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 0);

  const ready = webInstallJob();

  store.job = ready;
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({
    job: { ...ready, reviewToken: null },
    recoveryError: null,
  }));
  await store.loadJob();
  assert.match(store.error, /некорректные данные/u);
  assert.equal(store.recoveryError.code, 'protocol_error');
  assert.equal(store.job.id, ready.id);
  assert.equal(store.job.reviewToken, ready.reviewToken);
  await store.apply();
  await store.cancel();
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 0);
});

test('ST20: current B не подменяет outcome A; вытесненная история честно unknown и refresh без retry',
  async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const b = webInstallJob('running');

  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: b, recoveryError: null }));

  for (const unavailable of [false, true]) {
    const store = fixture.newStore();
    const a = webInstallJob();
    const beforePosts = fixture.calls.filter((call) => call.method === 'POST').length;
    const beforeLoads = fixture.loads;

    store.job = a;
    fixture.handlers.set('POST ' + ROOT + '/jobs/' + a.id + '/apply', () => {
      throw new TypeError('Ответ A потерян');
    });
    fixture.handlers.set('GET ' + ROOT + '/jobs/' + a.id, () => {
      if (unavailable) {
        throw new ApiError('Задание не найдено', 404, { error: 'job_not_found' });
      }

      return { job: {
      ...webInstallJob('done'),
      id: a.id,
      revision: 2,
    }, recoveryError: null };
    });
    await store.apply();
    assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, beforePosts + 1);
    assert.equal(fixture.calls.some((call) => call.url.endsWith('/jobs/current')), false);
    assert.equal(store.job.id, a.id);
    assert.equal(fixture.loads, beforeLoads + 1);

    if (unavailable) {
      assert.match(store.error, /результат.*недоступен/iu);
      assert.equal(store.job.status, 'ready');
      assert.equal(store.reconciling, true);
      await store.cancel();
      assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, beforePosts + 1);
    } else {
      assert.equal(store.job.status, 'done');
    }

    store.$dispose();
  }
});

test('ST21: late rollback после dispose сохраняет durable intent и не публикует карточку', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const wait = deferredInstallResponse(t);

  fixture.handlers.set('POST ' + ROOT + '/plugins/demo/rollback', () => wait.promise);

  const pending = store.rollback({ id: 'demo', install: webInstallInfo() });

  assert.equal(fixture.storage.size, 1);
  store.$dispose();
  assert.equal(fixture.calls[0].options.signal.aborted, true);
  wait.resolve({ job: webInstallJob('done', 'rollback') });
  await pending;
  assert.equal(fixture.storage.size, 1);
  assert.equal(store.job, null);
  assert.equal(fixture.loads, 0);
});

test('ST22: check callers ждут единый outcome; dispose отменяет чтение и не обновляет каталог', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const wait = deferredInstallResponse(t);
  let secondFinished = false;

  fixture.handlers.set('POST ' + ROOT + '/check', () => wait.promise);

  const first = store.checkUpdates();
  const second = store.checkUpdates().then(() => {
    secondFinished = true;
  });

  await flushInstallRequests();
  assert.equal(secondFinished, false);
  store.$dispose();
  assert.equal(fixture.calls[0].options.signal.aborted, true);
  wait.resolve({ plugins: { demo: webInstallInfo() } });
  await Promise.all([first, second]);
  assert.equal(fixture.loads, 0);
  assert.equal(store.error, null);
});

test('ST23: известный rollback409 снимает intent, apply500 сверяется как неизвестный outcome', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();

  fixture.handlers.set('POST ' + ROOT + '/plugins/demo/rollback', () => {
    throw new ApiError('Плагин занят.', 409, { error: 'plugin_busy' });
  });
  await store.rollback({ id: 'demo', install: webInstallInfo() });
  assert.equal(fixture.storage.size, 0);
  assert.equal(store.error, 'Плагин занят.');
  assert.equal(store.pendingAction, null);

  const ready = webInstallJob();

  store.job = ready;
  fixture.handlers.set('POST ' + ROOT + '/jobs/' + ready.id + '/apply', () => {
    throw new ApiError('Внутренняя ошибка.', 500, { error: 'internal' });
  });
  fixture.handlers.set('GET ' + ROOT + '/jobs/' + ready.id, () => ({
    job: {
      ...webInstallJob('done'),
      id: ready.id,
      revision: 3,
    },
    recoveryError: null,
  }));
  await store.apply();
  assert.equal(store.job.status, 'done');
  assert.equal(fixture.loads, 1);
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 2);
});

test('ST24: reopen при pending apply читает A по id, current B не принимается до ответа', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const a = webInstallJob();
  const b = webInstallJob('running');
  const wait = deferredInstallResponse(t);

  store.job = a;
  fixture.handlers.set('POST ' + ROOT + '/jobs/' + a.id + '/apply', () => wait.promise);
  fixture.handlers.set('GET ' + ROOT + '/jobs/current', () => ({ job: b, recoveryError: null }));
  fixture.handlers.set('GET ' + ROOT + '/jobs/' + a.id, () => ({
    job: {
      ...webInstallJob('applying'),
      id: a.id,
      revision: 2,
    },
    recoveryError: null,
  }));

  const applying = store.apply();

  await store.loadJob();
  assert.equal(store.job.id, a.id);
  assert.equal(store.pendingAction, 'apply');
  assert.equal(fixture.calls.some((call) => call.url.endsWith('/jobs/current')), false);
  wait.resolve({ job: {
      ...webInstallJob('done'),
      id: a.id,
      revision: 3,
    } });
  await applying;
  assert.equal(store.job.status, 'done');
  assert.equal(fixture.loads, 1);
});

test('CAT-W4: SHA выбранного каталожного релиза входит в install и update body', async (t) => {
  const fixture = pluginInstallStoreFixture(t);
  const store = fixture.newStore();
  const sha = 'a'.repeat(40);

  fixture.handlers.set('POST ' + ROOT + '/jobs', () => ({ job: webInstallJob('ready') }));
  fixture.handlers.set('POST ' + ROOT + '/plugins/demo/update',
    () => ({ job: webInstallJob('ready', 'update') }));
  await store.startInstall(SOURCE.url, '1.1.0', false, 'demo', sha);
  assert.equal(fixture.calls.at(-1).body.expectedSha, sha);
  await store.startUpdate('demo', '1.1.0', false, sha);
  assert.equal(fixture.calls.at(-1).body.expectedSha, sha);
});
