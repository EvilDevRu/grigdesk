import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { studioBrowserFixture } from './helpers/studio3dPluginBackground.js';
import {
  studioIntegrationTest, studioUntil,
} from '../server/helpers/studio3dPluginFixture.js';

/**
 * Прежняя durable запись сохраняет настоящий quote и fingerprint исходной формы.
 * Создание через реальный IDB adapter не загружает background или panel entry.
 */
async function pendingRecord(f, overrides = {}) {
  const quote = await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Куб из старого окна' },
  });

  assert.equal(quote.statusCode, 200, quote.body);

  const result = quote.json();
  const snapshot = {
    provider: 'tripo',
    operation: 'text-to-model',
    values: result.validation.values,
    expectedPrice: result.quote.total,
    name: 'Куб из старого окна',
    libraryId: f.libraryId,
  };
  const key = overrides.key ?? randomUUID();
  const owner = overrides.owner ?? f.authStore.clientScope;
  const fingerprint = f.product.inspector.storage.studioFingerprint({
    owner,
    kind: 'run',
    modelId: undefined,
    versionId: undefined,
    request: snapshot,
  });

  return {
    key,
    owner,
    libraryId: f.libraryId,
    fingerprint,
    at: Date.now(),
    kind: 'run',
    ...overrides,
    request: { ...snapshot, idempotencyKey: key },
  };
}

function integration(name, callback) {
  return studioIntegrationTest(test, name, callback, { timeout: 20000 });
}

integration('S3D-BG cold /chats: real IDB, GET404→прежний UUID/POST без panel import', async (t) => {
  const f = await studioBrowserFixture(t, { panel: false });
  const record = await pendingRecord(f);

  await f.storage.put(record);
  assert.deepEqual(f.counts(), { panel: 0, background: 0 });
  await f.login();
  await f.ready();
  await studioUntil(() => f.storage.list(record.owner), (rows) => rows.length === 0);

  const job = f.requests.findIndex((row) => row.path.includes(`/jobs/${record.key}?`));
  const posts = f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/run'));
  const post = f.requests.findIndex((row) => row === posts[0]);

  assert.ok(job >= 0);
  assert.ok(post > job);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body), record.request);
  assert.deepEqual(f.counts(), { panel: 0, background: 1 });
  assert.equal(f.sources.length, 1);
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);

  const durable = await f.call('GET', `/jobs/${record.key}?libraryId=${record.libraryId}`);

  assert.equal(durable.statusCode, 200);
  assert.equal(durable.json().intentId, record.key);
  await f.server.studio3d.context.jobs.tick();
  assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 1);
});

integration('S3D-BG known UUID: cold recovery читает существующий job, ноль повторных POST', async (t) => {
  const f = await studioBrowserFixture(t, { panel: false });
  const record = await pendingRecord(f);
  const accepted = await f.call('POST', '/run', record.request);

  assert.equal(accepted.statusCode, 202, accepted.body);
  await f.server.studio3d.context.jobs.tick();
  await f.storage.put(record);
  await f.login();
  await f.ready();
  await studioUntil(() => f.storage.list(record.owner), (rows) => rows.length === 0);
  assert.equal(f.requests.some((row) => row.path.includes(`/jobs/${record.key}?`)), true);
  assert.equal(f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/run')).length, 0);
  assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 1);
  assert.equal(f.counts().panel, 0);
});

for (const scenario of ['owner', 'disabled', 'expired']) {
  integration(`S3D-BG admission ${scenario}: browser pending не создаёт платный запрос`, async (t) => {
    const f = await studioBrowserFixture(t, { panel: false });
    const record = await pendingRecord(f, scenario === 'expired' ? { at: Date.now() - 600001 } : {});
    const notices = [];
    const off = f.host.ui.subscribeToasts((rows) => notices.splice(0, notices.length, ...rows));

    t.after(off);
    await f.storage.put(record);

    if (scenario === 'disabled') {
      assert.equal((await f.setEnabled(false)).statusCode, 200);
    }

    await f.login(scenario === 'owner' ? 'owner B' : record.owner);

    if (scenario !== 'disabled') {
      await f.ready();
    }

    if (scenario === 'expired') {
      await studioUntil(() => f.storage.list(record.owner), (rows) => rows.length === 0);
      assert.ok(notices.length > 0);
    } else {
      await f.settle();
      assert.deepEqual(await f.storage.list(record.owner), [record]);
    }

    assert.equal(f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/run')).length, 0);
    assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 0);
    assert.equal(f.counts().panel, 0);

    if (scenario === 'owner') {
      assert.equal(f.requests.some((row) => row.path.includes(`/jobs/${record.key}?`)), false);
    }

    if (scenario === 'disabled') {
      assert.equal(f.counts().background, 0);
    }
  });
}

integration('S3D-BG cold+панель+submit разделяют один service и прежний durable UUID', async (t) => {
  const f = await studioBrowserFixture(t);
  const record = await pendingRecord(f);
  const barrier = Promise.withResolvers();

  await f.storage.put(record);
  f.hook(async (request) => {
    if (request.path.includes(`/jobs/${record.key}?`)) {
      await barrier.promise;
    }
  });

  try {
    await f.login();
    await studioUntil(async () => f.requests.some((row) =>
      row.path.includes(`/jobs/${record.key}?`)), Boolean);
    assert.equal(f.counts().panel, 0);

    const panel = await f.acquire();
    const { libraryId, idempotencyKey, ...input } = record.request;
    const sending = f.service().submit(libraryId, 'run', input, idempotencyKey);

    barrier.resolve();
    await sending;
    await studioUntil(() => f.storage.list(record.owner), (rows) => rows.length === 0);
    assert.deepEqual(f.counts(), { panel: 1, background: 1 });
    assert.equal(f.sources.length, 1);
    assert.equal(f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/run')).length, 1);
    panel.release();
    assert.equal(f.service().librarySnapshot().admitted, true);
  } finally {
    barrier.resolve();
  }
});

/**
 * Настройки проходят настоящий settings store и транзакцию HTTP plugin API.
 * Поколение сервера остаётся тем же: меняется отдельная библиотечная эпоха service.
 */
async function switchLibrary(f, libraryDir, previous) {
  const generation = f.plugins.byId('studio3d').runtimeGeneration;
  const result = await f.plugins.saveSettings('studio3d', {
    ...f.plugins.byId('studio3d').values,
    libraryDir,
  });

  assert.equal(result.ok, true, JSON.stringify(result));

  const snapshot = await studioUntil(async () => f.service().librarySnapshot(),
    (value) => value.admitted && value.libraryId !== previous);

  assert.equal(f.plugins.byId('studio3d').runtimeGeneration, generation);

  return snapshot;
}

integration('S3D-BG real settings A→B→A сохраняют immutable pending A и исходный UUID', async (t) => {
  const f = await studioBrowserFixture(t, { panel: false });
  const record = await pendingRecord(f);

  await f.storage.put(record);
  f.hook((request) => request.path.includes(`/jobs/${record.key}?`)
    ? Response.json({ error: 'fixture_temporary' }, { status: 500 }) : undefined);
  await f.login();
  await f.ready();
  await studioUntil(async () => f.requests.some((row) => row.path.includes(`/jobs/${record.key}?`)), Boolean);

  const first = f.service().librarySnapshot();
  const second = await switchLibrary(f, path.join(f.root, 'library-b'), record.libraryId);

  assert.ok(second.libraryEpoch > first.libraryEpoch);
  assert.deepEqual(await f.storage.list(record.owner), [record]);
  assert.equal(f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/run')).length, 0);

  const quoted = await f.call('POST', '/quote', {
    libraryId: second.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Новый заказ B' },
  });

  assert.equal(quoted.statusCode, 200, quoted.body);

  const body = quoted.json();
  const requestB = {
    provider: 'tripo',
    operation: 'text-to-model',
    values: body.validation.values,
    expectedPrice: body.quote.total,
    name: 'Новый заказ B',
  };
  const keyB = randomUUID();

  await f.service().submit(second.libraryId, 'run', requestB, keyB);
  assert.deepEqual(await f.storage.list(record.owner), [record]);
  await f.server.studio3d.context.jobs.tick();
  await f.server.studio3d.context.jobs.settle();

  const countBeforeStale = f.requests.filter((row) => row.method === 'POST'
    && row.path.endsWith('/run')).length;

  await assert.rejects(f.service().submit(record.libraryId, 'run', requestB),
    (error) => {
      assert.equal(error.code, 'stale_library', JSON.stringify({
        status: error.status,
        code: error.code,
        body: error.body,
      }));

      return true;
    });
  assert.equal(f.requests.filter((row) => row.method === 'POST'
    && row.path.endsWith('/run')).length, countBeforeStale);
  assert.deepEqual(await f.storage.list(record.owner), [record]);
  // B должен стать idle, прежде чем владелец явно возвращает библиотеку A.
  // Принятое задание завершаем только через fake provider, повторной оплаты нет.
  const taskB = [...f.fake.tasks.keys()][0];

  f.fake.complete(taskB, { output: {}, credits: requestB.expectedPrice });
  await f.server.studio3d.context.jobs.tick();
  await f.server.studio3d.context.jobs.settle();
  await studioUntil(async () => f.server.studio3d.context.jobs.busy(), (busy) => busy === false);
  f.hook(null);
  await switchLibrary(f, '', second.libraryId);
  await studioUntil(() => f.storage.list(record.owner), (rows) => rows.length === 0);

  const postsA = f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/run')
    && JSON.parse(row.init.body).libraryId === record.libraryId);

  assert.equal(postsA.length, 1);
  assert.deepEqual(JSON.parse(postsA[0].init.body), record.request);
});

for (const returnToA of [false, true]) {
  integration(`S3D-BG late state A после ${returnToA ? 'A→B→A' : 'A→B'} сохраняет seq`, async (t) => {
    const f = await studioBrowserFixture(t, { panel: false });

    await f.login();
    await f.ready();

    const initial = f.service().librarySnapshot();
    const responseA = (await f.call('GET', '/state')).json();
    const started = Promise.withResolvers();
    const barrier = Promise.withResolvers();
    let held = true;

    f.hook(async (request) => {
      if (request.path.endsWith('/state') && held) {
        held = false;
        started.resolve();
        await barrier.promise;

        return Response.json(responseA);
      }
    });

    const old = f.service().refreshLibrary().catch(() => {});

    try {
      await started.promise;

      const second = await switchLibrary(f, path.join(f.root, 'library-b'), initial.libraryId);

      if (returnToA) {
        await switchLibrary(f, '', second.libraryId);
      }

      const current = structuredClone(f.service().librarySnapshot());

      assert.ok(current.libraryEpoch > initial.libraryEpoch);
      assert.ok(current.requestSeq > initial.requestSeq);
      barrier.resolve();
      await old;
      await f.settle();
      assert.deepEqual(f.service().librarySnapshot(), current);
      assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 0);
    } finally {
      barrier.resolve();
      await old;
    }
  });
}

integration('S3D-BG stale_library до settings SSE: IDB прежняя, заказ не повторяется', async (t) => {
  const f = await studioBrowserFixture(t, { panel: false });
  const draft = await pendingRecord(f);

  await f.login();
  await f.ready();

  const broadcast = f.server.sse.broadcast;
  let saved;

  f.hook(async (request) => {
    if (request.method === 'POST' && request.path.endsWith('/run')) {
      saved = JSON.stringify(await f.storage.list(draft.owner));
      f.server.sse.broadcast = () => {};

      try {
        const changed = await f.plugin('PUT', '/settings', {
          values: {
            ...f.plugins.byId('studio3d').values,
            libraryDir: path.join(f.root, 'library-b'),
          },
        });

        assert.equal(changed.statusCode, 200, changed.body);
      } finally {
        f.server.sse.broadcast = broadcast;
      }
    }
  });

  const { libraryId, idempotencyKey, ...input } = draft.request;

  await assert.rejects(f.service().submit(libraryId, 'run', input, idempotencyKey),
    (error) => error.code === 'stale_library');
  await studioUntil(async () => f.service().librarySnapshot(),
    (value) => value.admitted && value.libraryId !== libraryId);
  assert.equal(JSON.stringify(await f.storage.list(draft.owner)), saved);
  assert.equal(f.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/run')).length, 1);
  assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 0);
});

for (const operation of ['job', 'run']) {
  integration(`S3D-BG late ${operation} 4xx A после settings B не меняет storage`, async (t) => {
    const f = await studioBrowserFixture(t, { panel: false });
    const record = await pendingRecord(f);
    const started = Promise.withResolvers();
    const barrier = Promise.withResolvers();

    if (operation === 'job') {
      await f.storage.put(record);
    }

    f.hook(async (request) => {
      const target = operation === 'job' ? request.path.includes(`/jobs/${record.key}?`)
        : request.method === 'POST' && request.path.endsWith('/run');

      if (target) {
        started.resolve();
        await barrier.promise;

        return Response.json({ error: 'fixture_rejected', message: 'Поздний отказ A' }, { status: 404 });
      }
    });

    let sending;

    try {
      await f.login();
      await f.ready();

      if (operation === 'run') {
        const { libraryId, idempotencyKey, ...input } = record.request;

        sending = f.service().submit(libraryId, 'run', input, idempotencyKey).catch(() => {});
      }

      await started.promise;

      const saved = JSON.stringify(await f.storage.list(record.owner));

      await switchLibrary(f, path.join(f.root, 'library-b'), record.libraryId);
      barrier.resolve();
      await sending;
      await f.settle();
      assert.equal(JSON.stringify(await f.storage.list(record.owner)), saved);
      assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 0);
    } finally {
      barrier.resolve();
      await sending;
    }
  });
}
