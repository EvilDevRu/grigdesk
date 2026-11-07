// Интеграция16: public HTTP bytes exact export, actual host и общий IDB; без source fallback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { studioPackageInput } from '../server/helpers/studio3dPackageRepo.js';
import { installedUntil } from '../server/helpers/studio3dInstalledFixture.js';
import { installedStudioBrowserFixture } from './helpers/studio3dInstalledBrowser.js';

const input = await studioPackageInput();

/**
 * Неуказанный opt-in пропускается явно; неверный переданный export падает в studioPackageInput.
 * Все утверждения выполняются с STUDIO3D_PACKAGE_DIR и не обращаются к development дереву плагина.
 */
function integration(name, run) {
  return test(name, { skip: input ? false : 'Нужен STUDIO3D_PACKAGE_DIR', timeout: 30000 }, run);
}

/**
 * Fixture снимает настоящий quote с точной библиотекой, затем пишет прежнюю public IDB schema.
 * Низкий disk threshold задаётся явным test settings PUT, а не изменением default/prefs boot поведения.
 */
async function recordFor(f, overrides = {}) {
  const card = await f.boot.card();
  const settings = await f.boot.settings({ ...card.values, lowDiskGb: 1 });

  assert.equal(settings.statusCode, 200, settings.body);

  const response = await f.boot.call('POST', '/quote', {
    libraryId: f.fixture.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Синтетический pending из прежнего окна' },
  });

  assert.equal(response.statusCode, 200, response.body);

  const quoted = response.json();
  const key = randomUUID();
  const owner = overrides.owner ?? f.boot.authStore.clientScope;
  const snapshot = {
    provider: 'tripo',
    operation: 'text-to-model',
    values: quoted.validation.values,
    expectedPrice: quoted.quote.total,
    name: 'Прежний pending',
    libraryId: f.fixture.libraryId,
  };

  return {
    key,
    owner,
    libraryId: f.fixture.libraryId,
    kind: 'run',
    fingerprint: canonicalJson({
      owner,
      kind: 'run',
      request: snapshot,
    }),
    at: Date.now(),
    ...overrides,
    request: { ...snapshot, idempotencyKey: key },
  };
}

/**
 * SHA каждого HTTP JS ответа совпадает с исходным exact export1.0.0, а не только с локальной копией.
 * Имена извлекаются из собственного generation URL; Psource и private exports не читаются.
 */
function assertInstalledBytes(f) {
  const expected = new Map(input.files.map(file => [file.path, file.sha256]));

  for (const read of f.graphs.flatMap(graph => graph.reads)) {
    const match = /^\/api\/ext\/studio3d\/module\/[^/]+\/(.+)$/u.exec(read.url);

    assert.ok(match, read.url);

    const relative = match[1].split('/').map(decodeURIComponent).join('/');
    const payloadPath = path.posix.join(input.manifest.entrypoints.web.dir, relative);

    assert.equal(expected.has(payloadPath), true, payloadPath);
    assert.equal(read.sha256, expected.get(payloadPath), payloadPath);
  }
}

for (const scenario of ['missing', 'known', 'disabled', 'owner', 'expired']) {
  integration(`S3D-PACKAGED browser cold/chats ${scenario}: exact installed bytes и shared IDB`, async t => {
    const f = await installedStudioBrowserFixture(t, { input });
    const record = await recordFor(f, scenario === 'expired' ? { at: Date.now() - 600001 } : {});

    if (scenario === 'known') {
      const accepted = await f.boot.call('POST', '/run', record.request);

      assert.equal(accepted.statusCode, 202, accepted.body);
      await installedUntil(async () => f.fixture.creates().length, value => value === 1);
    }

    await f.storage.put(record);

    const before = await f.storage.bytes(record.owner);
    const notices = [];
    const off = f.host.ui.subscribeToasts(rows => notices.splice(0, notices.length, ...rows));

    t.after(off);
    assert.deepEqual(f.counts(), { panel: 0, background: 0 });

    if (scenario === 'disabled') {
      const disabled = await f.boot.toggle(false);

      assert.equal(disabled.statusCode, 200, disabled.body);
    }

    await f.login(scenario === 'owner' ? 'fixture-other-owner' : record.owner);

    if (scenario === 'disabled') {
      await f.settle();
      assert.equal(f.counts().background, 0);
    } else {
      await f.ready();
    }

    if (scenario === 'owner' || scenario === 'disabled') {
      await f.settle();
      assert.deepEqual(await f.storage.bytes(record.owner), before);
      assert.equal(f.requests.some(row => row.path.includes(`/jobs/${record.key}?`)), false);
    } else {
      await installedUntil(() => f.storage.list(record.owner), rows => rows.length === 0);
      assert.equal(f.requests.some(row => row.path.includes(`/jobs/${record.key}?`)), true);
    }

    const posts = f.requests.filter(row => row.method === 'POST' && row.path.endsWith('/run'));

    assert.equal(posts.length, scenario === 'missing' ? 1 : 0);

    if (scenario === 'missing') {
      await installedUntil(async () => f.fixture.creates().length, value => value === 1);
    }

    assert.equal(f.fixture.creates().length, ['missing', 'known'].includes(scenario) ? 1 : 0);
    assert.equal(f.counts().panel, 0);
    assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
    assert.equal(f.sources.filter(source => !source.closed).length, 1);
    assert.equal(f.router.currentRoute.value.path, '/chats');

    if (scenario === 'missing') {
      assert.deepEqual(JSON.parse(posts[0].body), record.request);
    }
    if (scenario === 'expired') {
      assert.equal(notices.length > 0, true);
    }
    if (scenario !== 'disabled') {
      assert.equal(f.graphs.length, 1);
      assert.equal(f.graphs[0].reads.every(row => /^[a-f0-9]{64}$/u.test(row.sha256)), true);
      assertInstalledBytes(f);
    }
  });
}

integration('S3D-PACKAGED simultaneous actual panel и cold pending разделяют один UUID/POST', async t => {
  const f = await installedStudioBrowserFixture(t, { input });
  const record = await recordFor(f);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();

  await f.storage.put(record);
  f.hook(async (request, response) => {
    if (request.path.includes(`/jobs/${record.key}?`)) {
      entered.resolve();
      await release.promise;
    }

    return response;
  });
  t.after(() => release.resolve());
  await f.login(record.owner);
  await entered.promise;

  const panel = await f.mountPanel({ tab: 'create' });

  assert.ok(panel.element.querySelector('.studio-create-panel'));
  assert.deepEqual(f.counts(), { panel: 1, background: 1 });
  release.resolve();
  await installedUntil(() => f.storage.list(record.owner), rows => rows.length === 0);

  const jobs = f.requests.filter(row => row.path.includes(`/jobs/${record.key}?`));
  const posts = f.requests.filter(row => row.method === 'POST' && row.path.endsWith('/run'));

  assert.equal(jobs.length, 1);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), record.request);
  await installedUntil(async () => f.fixture.creates().length, value => value === 1);
  assert.equal(f.fixture.creates().length, 1);
  assert.equal(f.sources.filter(source => !source.closed).length, 1);
  assert.deepEqual(f.assetErrors, []);

  const moduleUrls = f.graphs.flatMap(graph => graph.reads.map(row => row.url));

  assert.equal(new Set(moduleUrls).size, moduleUrls.length);
  assert.equal(f.styles.length > 0, true);
  assertInstalledBytes(f);
});

integration('S3D-PACKAGED settings A→B: actual UI button заказывает B, late A сохраняет IDB побайтно',
  async t => {
    const f = await installedStudioBrowserFixture(t, { input });
    const recordA = await recordFor(f);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();

    await f.storage.put(recordA);
    f.hook(async (request, response) => {
      if (request.path.includes(`/jobs/${recordA.key}?`)) {
        entered.resolve();
        await release.promise;
      }

      return response;
    });
    t.after(() => release.resolve());
    await f.login(recordA.owner);
    await entered.promise;

    const panel = await f.mountPanel({ tab: 'create' });
    const libraryB = path.join(f.fixture.root, 'library-b');
    const result = await f.plugins.saveSettings('studio3d', {
      ...f.plugins.byId('studio3d').values,
      libraryDir: libraryB,
    });

    assert.equal(result.ok, true, JSON.stringify(result));

    const stateB = await installedUntil(async () => (await f.boot.call('GET', '/state')).json(),
      state => state.library.ok && state.libraryId !== recordA.libraryId);

    await installedUntil(async () => f.requests.some(row => row.path === '/api/ext/studio3d/state'
      && row.status === 200 && JSON.parse(row.responseText).libraryId === stateB.libraryId), Boolean);
    await installedUntil(async () => panel.element.querySelector('.studio-create-panel textarea'), Boolean);

    const prompt = panel.element.querySelector('.studio-create-panel textarea');

    prompt.value = 'Новый заказ в B через actual UI';
    prompt.dispatchEvent(new f.browser.Event('input', { bubbles: true }));

    const button = await installedUntil(async () => panel.element.querySelector(
      '.studio-create-panel button[data-context="studio-price"]'), value => value && !value.disabled);

    button.click();
    await installedUntil(async () => f.requests.find(row => row.method === 'POST'
      && row.path.endsWith('/run') && row.status === 202), Boolean);

    const posts = f.requests.filter(row => row.method === 'POST' && row.path.endsWith('/run'));
    const bodyB = JSON.parse(posts[0].body);

    assert.equal(posts.length, 1);
    assert.equal(bodyB.libraryId, stateB.libraryId);
    assert.notEqual(bodyB.idempotencyKey, recordA.key);
    await installedUntil(() => f.storage.list(recordA.owner), rows => rows.length === 1
      && rows[0].key === recordA.key);

    const beforeLateA = await f.storage.bytes(recordA.owner);

    release.resolve();
    await f.settle();
    assert.deepEqual(await f.storage.bytes(recordA.owner), beforeLateA);
    assert.deepEqual(await f.storage.list(recordA.owner), [recordA]);
    assert.equal(f.requests.filter(row => row.method === 'POST' && row.path.endsWith('/run')).length, 1);
    await installedUntil(async () => f.fixture.creates().length, value => value === 1);
    assert.equal(f.fixture.creates().length, 1);
    assert.equal((await f.boot.call('GET', '/state')).json().libraryId, stateB.libraryId);
    assert.deepEqual(f.assetErrors, []);
    assertInstalledBytes(f);
  });
