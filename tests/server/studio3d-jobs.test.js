import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseStudio3d } from '../../shared/studio3d/studio3dContracts.ts';
import { createLibrary, versionProjection } from '../../server/src/lib/studio3d/library.ts';
import { createIntents, requestFingerprint } from '../../server/src/lib/studio3d/intents.ts';
import { createJobs } from '../../server/src/lib/studio3d/jobs.ts';
import { createTripoStudio } from '../../server/src/lib/tripo/studio.ts';
import { RIG_V1 } from '../../server/src/lib/tripo/catalog.ts';
import { createLocalStudio } from '../../server/src/lib/studio3d/local.ts';
import { downloadToFile } from '../../server/src/lib/studio3d/download.ts';
import { fakeTaskId, startFakeTripo } from './helpers/fakeTripo.js';
import { makeGlb, pngHeader, pngImage } from './helpers/studio3dGlb.js';

/**
 * Worker получает fake API, часы и таймеры; ручной tick не зависит от времени сети.
 * Входы и журнал принадлежат /tmp, состояние живого плагина не читается.
 */
async function fixture(t, options = {}) {
  const fake = await startFakeTripo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-jobs-'));
  let clock = Date.parse('2026-10-11T10:00:00Z');
  const library = createLibrary({
    dir,
    now: () => clock,
    ...options.library
  });

  await library.ensure();

  const provider = createTripoStudio({
    env: fake.env,
    baseUrl: fake.baseUrl,
    sleep: async () => {},
    now: () => clock
  });
  const intents = createIntents({ library, ...options.intentHooks });
  const events = [];
  const dependencies = {
    library,
    intents,
    providers: [provider, createLocalStudio()],
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
    broadcast: (name, data) => events.push({ name, data }),
    download: (request) => downloadToFile({
      ...request,
      fetchImpl: fetch,
      sleep: async () => {}
    }),
    ...options.jobs
  };
  const jobs = createJobs(dependencies);

  t.after(async () => {
    await jobs.stop();
    await library.close();
    await fake.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  return {
    fake,
    dir,
    library,
    provider,
    intents,
    jobs,
    events,
    dependencies,
    advance: (ms) => {
      clock += ms;
    }
  };
}

/**
 * Цена берётся из независимого каталога исполнителя, UUID обозначает нажатие.
 * Менять price/payload в тестах можно без сохранения неверного намерения.
 */
function textRequest(f, overrides = {}) {
  const values = f.provider.validate('text-to-model', { prompt: 'Синтетический персонаж' }, {
    kind: null,
    format: null,
    stats: null,
    params: null,
    nativeTaskType: null,
    rigCheck: null,
    views: []
  }).values;

  return {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values,
    expectedPrice: f.provider.quote('text-to-model', values, {}).total,
    name: 'Тестовый персонаж',
    ...overrides
  };
}

/**
 * Ожидание гонки ограничено сроком: регрессия удержания даёт понятный отказ
 * теста, а не бесконечный прогон до внешнего timeout сторожа памяти.
 */
async function withinLimit(promise, label, ms = 10_000) {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Не дождались за ${ms} мс: ${label}`)), ms);
  });

  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Строки пачки повторяют одиночный text-to-model и различаются только prompt.
 * Цена строки берётся из того же каталога, что и у одиночного заказа.
 */
function batchRows(base, prompts) {
  return prompts.map((prompt) => ({
    provider: base.provider,
    operation: base.operation,
    values: { ...base.values, prompt },
    name: prompt,
    project: null,
    category: null,
    expectedPrice: base.expectedPrice
  }));
}

test('JB-02/03 цена и ошибки параметров не создают намерение, версию или POST', async (t) => {
  const f = await fixture(t);

  await assert.rejects(f.jobs.run(textRequest(f, { expectedPrice: 999 })),
    (error) => error.code === 'price_changed');
  await assert.rejects(f.jobs.run(textRequest(f, { values: { prompt: '' } })),
    (error) => error.code === 'validation_failed');
  assert.equal((await f.intents.list()).length, 0);
  assert.equal((await f.library.listModels()).entries.length, 0);
  assert.equal(f.fake.tasks.size, 0);
});

/**
 * Parent создаётся с настоящим GLB и явным provenance этого fake аккаунта.
 * Внешний task зарегистрирован отдельно, чтобы preflight действительно проверял доступ.
 */
async function parentVersion(f, kind = 'model') {
  const model = await f.library.createModel({ name: 'Исходный объект' });
  const taskId = fakeTaskId(80);
  const type = kind === 'rigged' ? 'animate_rig' : 'text_to_model';
  const version = await f.library.addVersion(model.id, {
    kind,
    status: 'ready',
    provider: 'tripo',
    params: kind === 'rigged' ? { model: RIG_V1 } : {},
    task: {
      provider: 'tripo',
      id: taskId,
      type
    },
    accountKey: f.provider.snapshot().accountKey
  });

  await f.library.writeVersionFile(model.id, version.id, 'model.glb', makeGlb({ triangles: 2 }),
    { role: 'model' });
  f.fake.tasks.set(taskId, {
    task_id: taskId,
    type,
    status: 'success',
    output: {}
  });

  return { model, version: (await f.library.readModel(model.id)).versions[0] };
}

/**
 * Production resolver читает DTO загрузки из собственных файлов /tmp.
 * После 202 тест может удалить upload и проверить независимый snapshot.
 */
async function imageUpload(f) {
  const uploadId = 'upload-fixture';
  const folder = path.join(f.dir, '.uploads', uploadId);
  const bytes = pngHeader(4, 4);

  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'input.png'), bytes);
  await fs.writeFile(path.join(folder, 'upload.json'), JSON.stringify({
    libraryId: f.library.libraryId,
    uploadId,
    name: 'input.png',
    kind: 'image',
    size: bytes.length,
    stats: null,
    width: 4,
    height: 4
  }));

  return { uploadId, role: 'primary' };
}

test('JB-01/20 загрузка после 202 независима от upload TTL и replay', async (t) => {
  const f = await fixture(t);
  const upload = await imageUpload(f);
  const request = textRequest(f, {
    operation: 'image-to-model',
    values: {},
    expectedPrice: 30,
    uploads: [upload]
  });
  const accepted = await f.jobs.run(request);

  parseStudio3d.run(accepted);
  await fs.rm(path.join(f.dir, '.uploads', upload.uploadId), { recursive: true });
  await f.jobs.tick();
  assert.equal(f.fake.uploads.length, 1);
  assert.equal(f.fake.tasks.size, 1);
  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal(f.fake.uploads.length, 1);
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-05/15 подтверждённый отказ и новый retry сохраняют оценку и новую сестру', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);
  const accepted = await f.jobs.run(request);

  await f.jobs.tick();
  f.fake.fail(fakeTaskId(1), { code: 2018 });
  await f.jobs.tick();

  const job = await f.jobs.job(request.idempotencyKey);

  assert.equal(job.children[0].status, 'failed');
  assert.equal(job.children[0].error.kind, 'complex');
  assert.match(job.children[0].error.message, /Кредиты вернулись/);
  
  const input = {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    expectedPrice: request.expectedPrice
  };
  const retry = await f.jobs.retry(request.idempotencyKey, job.children[0].childId, input);

  assert.equal(retry.model.id, accepted.model.id);
  assert.notEqual(retry.versions[0].id, accepted.versions[0].id);
  assert.equal((await f.library.readModel(retry.model.id)).versions.length, 2);
  await f.jobs.tick();
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length, 2);
});

test('JB-07/19 pool=1 удерживает вторую картинку до завершения первой', async (t) => {
  const f = await fixture(t);
  const values = { prompt: 'Синтетический силуэт' };
  const price = f.provider.quote('text-to-image',
    f.provider.validate('text-to-image', values, {}).values, {}).total;
  const first = textRequest(f, {
    operation: 'text-to-image',
    values,
    expectedPrice: price
  });
  const second = { ...first, idempotencyKey: randomUUID() };

  await f.jobs.run(first);
  f.advance(1);
  await f.jobs.run(second);
  await Promise.all([f.jobs.tick(), f.jobs.tick()]);
  assert.equal(f.fake.tasks.size, 1);
  assert.equal((await f.jobs.job(second.idempotencyKey)).children[0].status, 'waiting');
  f.fake.fail(fakeTaskId(1), { code: 2018 });
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 2);
});

test('JB-38 закрытие принятой пропавшей картинки освобождает пул второй', async (t) => {
  const f = await fixture(t);
  const values = f.provider.validate('text-to-image', { prompt: 'Силуэт' }, {}).values;
  const first = textRequest(f, {
    operation: 'text-to-image',
    values,
    expectedPrice: f.provider.quote('text-to-image', values, {}).total
  });
  const second = { ...first, idempotencyKey: randomUUID() };

  await f.jobs.run(first);
  f.advance(1);
  await f.jobs.run(second);
  await f.jobs.tick();
  f.fake.tasks.delete(fakeTaskId(1));
  await f.jobs.tick();
  await f.jobs.tick();
  await f.jobs.tick();

  const record = await f.intents.get(first.idempotencyKey);

  assert.equal(record.children[0].missedPolls, 3);
  assert.match(record.children[0].waitReason, /после трёх проверок/);
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-image')).length, 1);
  await f.jobs.closeUnknown(first.idempotencyKey, record.children[0].childId, f.library.libraryId);

  const closed = await f.jobs.job(first.idempotencyKey);

  assert.equal(closed.children[0].status, 'unresolved');
  assert.equal(closed.children[0].paymentState, 'unknown');
  await f.jobs.tick();
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-image')).length, 2);
});

test('JB-39 удалённый готовый клип не останавливает соседний клип и независимый заказ', async (t) => {
  const f = await fixture(t);
  const parent = await parentVersion(f, 'rigged');
  const animation = textRequest(f, {
    operation: 'animate',
    modelId: parent.model.id,
    versionId: parent.version.id,
    values: { animations: ['preset:biped:walk', 'preset:biped:run'] },
    expectedPrice: 20
  });
  const independent = textRequest(f);
  const accepted = await f.jobs.run(animation);

  f.advance(1);
  await f.jobs.run(independent);
  await f.jobs.tick();
  f.fake.setFile('clip.glb', makeGlb());
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('clip.glb') }, credits: 10 });
  await f.jobs.tick();
  await f.jobs.settle();
  await f.library.deleteVersion(parent.model.id, accepted.versions[0].id);
  f.fake.complete(fakeTaskId(2), { output: { model_url: f.fake.cdnUrl('clip.glb') }, credits: 10 });
  f.fake.complete(fakeTaskId(3), { output: { model_url: f.fake.cdnUrl('clip.glb') }, credits: 30 });
  await f.jobs.tick();
  await f.jobs.settle();

  const model = await f.library.readModel(parent.model.id);
  const second = model.versions.find((version) => version.id === accepted.versions[1].id);

  assert.equal(second.status, 'ready');
  assert.equal((await f.jobs.job(independent.idempotencyKey)).children[0].status, 'ready');
  assert.equal(model.versions.some((version) => version.id === accepted.versions[0].id), false);
});

test('JB-40 ошибка проекции одной записи не останавливает независимый заказ', async (t) => {
  const f = await fixture(t);
  const first = textRequest(f);
  const second = textRequest(f);
  const accepted = await f.jobs.run(first);

  f.advance(1);
  await f.jobs.run(second);
  await f.jobs.tick();

  const updateVersion = f.library.updateVersion.bind(f.library);

  f.library.updateVersion = async (modelId, ...args) => {
    if (modelId === accepted.model.id) {
      throw Object.assign(new Error('fixture projection failure'), { code: 'EACCES' });
    }

    return updateVersion(modelId, ...args);
  };
  f.fake.setFile('model.glb', makeGlb());
  f.fake.complete(fakeTaskId(2), { output: { model_url: f.fake.cdnUrl('model.glb') }, credits: 30 });
  await f.jobs.tick();
  await f.jobs.settle();
  assert.equal((await f.jobs.job(second.idempotencyKey)).children[0].status, 'ready');
});

test('JB-41 resume после ответа POST не откатывает принятый заказ по старому снимку', async (t) => {
  let signalResponse;
  let releaseResponse;
  const responded = new Promise((resolve) => {
    signalResponse = resolve;
  });
  const held = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const f = await fixture(t, {
    jobs: {
      fault: async (boundary) => {
        if (boundary === 'after-send') {
          signalResponse();
          await held;
        }
      }
    }
  });
  const request = textRequest(f);

  await f.jobs.run(request);

  const sending = f.jobs.tick();

  await responded;

  const list = f.intents.list.bind(f.intents);
  let captured = false;

  f.intents.list = async () => {
    const snapshot = await list();

    if (!captured && snapshot.some((record) => record.children[0]?.stage === 'submitting')) {
      captured = true;
      releaseResponse();
      await sending;
    }

    return snapshot;
  };
  await f.jobs.resume();

  const record = await f.intents.get(request.idempotencyKey);

  assert.equal(captured, true);
  assert.equal(record.children[0].stage, 'accepted');
  assert.equal(record.children[0].status, 'queued');
  assert.equal(record.children[0].taskId, fakeTaskId(1));
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-42 семь ждущих позиций разделяют баланс 30 секунд и не переписывают файлы', async (t) => {
  let countWrites = false;
  let writes = 0;
  const f = await fixture(t, {
    library: {
      beforePersist: async () => {
        if (countWrites) {
          writes += 1;
        }
      }
    }
  });

  f.fake.setBalance({ balance: 0, frozen: 0 });

  for (let index = 0; index < 7; index += 1) {
    await f.jobs.run(textRequest(f));
  }

  await f.jobs.tick();

  const balanceCalls = () => f.fake.requests.filter((item) => item.path.endsWith('/account/balance')).length;

  assert.equal(balanceCalls(), 1);
  countWrites = true;
  f.advance(3000);
  await f.jobs.tick();
  assert.equal(balanceCalls(), 1);
  assert.equal(writes, 0);
  f.advance(30_000);
  await f.jobs.tick();
  assert.equal(balanceCalls(), 2);
  assert.equal(writes, 0);
});

test('JB-09 второй и третий clips сохраняют собственные values после 429', async (t) => {
  const f = await fixture(t);
  const parent = await parentVersion(f, 'rigged');
  const request = textRequest(f, {
    operation: 'animate',
    modelId: parent.model.id,
    versionId: parent.version.id,
    values: { animations: ['preset:biped:walk', 'preset:biped:idle', 'preset:biped:run'] },
    expectedPrice: 30
  });
  const accepted = await f.jobs.run(request);

  assert.equal(accepted.versions.length, 3);
  assert.equal(accepted.versions.every((version) => version.parent === parent.version.id), true);
  f.fake.respondOnce('POST', /retarget/, 429, { code: 2000 }, { 'Retry-After': '7' });
  await f.jobs.tick();
  f.advance(8000);
  await f.jobs.tick();

  const sent = f.fake.requests.filter((item) => item.path.endsWith('/retarget') && item.body);

  assert.deepEqual(sent.map((item) => item.body.animation).sort(),
    ['preset:biped:walk', 'preset:biped:walk', 'preset:biped:idle', 'preset:biped:run'].sort());
  
  const queued = await f.jobs.job(request.idempotencyKey);

  assert.equal(queued.children.every((child) => child.status === 'queued'), true);
  f.fake.setFile('clip.glb', makeGlb());
  f.fake.complete(queued.children[0].taskId,
    { output: { model_url: f.fake.cdnUrl('clip.glb') }, credits: 10 });
  f.fake.fail(queued.children[1].taskId, { code: 2018 });
  f.fake.complete(queued.children[2].taskId,
    { output: { model_url: f.fake.cdnUrl('clip.glb') }, credits: 10 });
  await f.jobs.tick();
  await f.jobs.settle();

  const finished = await f.jobs.job(request.idempotencyKey);

  assert.deepEqual(finished.children.map((child) => child.status), ['ready', 'failed', 'ready']);
});

test('JB-24 два unknown клипа одного intent адресуются независимыми childId', async (t) => {
  const f = await fixture(t);
  const parent = await parentVersion(f, 'rigged');
  const request = textRequest(f, {
    operation: 'animate',
    modelId: parent.model.id,
    versionId: parent.version.id,
    values: { animations: ['preset:biped:walk', 'preset:biped:idle'] },
    expectedPrice: 20
  });

  await f.jobs.run(request);
  f.fake.dropOnce('POST', /retarget/);
  f.fake.dropOnce('POST', /retarget/);
  await f.jobs.tick();

  const job = await f.jobs.job(request.idempotencyKey);

  assert.deepEqual(job.children.map((child) => child.status), ['unknown', 'unknown']);
  await f.jobs.closeUnknown(job.intentId, job.children[0].childId, f.library.libraryId);
  f.fake.tasks.set(fakeTaskId(91), {
    task_id: fakeTaskId(91),
    type: 'animate_retarget',
    status: 'queued'
  });
  await f.jobs.reconcile(job.intentId, job.children[1].childId, {
    libraryId: f.library.libraryId,
    taskId: fakeTaskId(91)
  });

  const resolved = await f.jobs.job(job.intentId);

  assert.deepEqual(resolved.children.map((child) => child.status), ['unresolved', 'queued']);
  assert.equal(resolved.children[0].taskId, null);
  assert.equal(resolved.children[1].taskId, fakeTaskId(91));
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/retarget')).length, 2);
});

test('JB-11/13 queued после restart скачивает результат с обновлённой ссылкой без нового POST', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  await f.jobs.stop();
  f.fake.setFile('renew.glb', makeGlb());
  f.fake.cdnFault('renew.glb', { kind: '403' });
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('renew.glb') }, credits: 30 });

  const resumed = createJobs({ ...f.dependencies, intents: createIntents({ library: f.library }) });

  t.after(() => resumed.stop());
  await resumed.resume();
  await resumed.tick();
  await resumed.settle();
  assert.equal((await resumed.job(request.idempotencyKey)).children[0].status, 'ready');
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length, 1);
});

test('JB-22 restart до send сохраняет порядок строк сохранённого batch snapshot', async (t) => {
  const f = await fixture(t);
  const base = textRequest(f);
  const rows = ['Первый', 'Второй', 'Третий'].map((prompt) => ({
    provider: base.provider,
    operation: base.operation,
    values: { ...base.values, prompt },
    name: prompt,
    project: null,
    category: null,
    expectedPrice: base.expectedPrice
  }));
  const quote = await f.jobs.quoteBatch({ libraryId: f.library.libraryId, rows });

  await f.jobs.runBatch({
    libraryId: f.library.libraryId,
    idempotencyKey: '00000000-0000-4000-8000-000000000077',
    snapshot: quote.snapshot,
    snapshotHash: quote.snapshotHash
  });
  await f.jobs.stop();

  const resumed = createJobs({ ...f.dependencies, intents: createIntents({ library: f.library }) });

  t.after(() => resumed.stop());
  await resumed.resume();
  await resumed.tick();

  const prompts = f.fake.requests.filter((item) => item.path.endsWith('/text-to-model'))
    .map((item) => item.body.prompt);

  assert.deepEqual(prompts, ['Первый', 'Второй', 'Третий']);
});

test('JB-10 проверка скелета имеет durable child без новой версии и переживает restart', async (t) => {
  const f = await fixture(t);
  const parent = await parentVersion(f);
  const request = textRequest(f, {
    operation: 'rig-check',
    values: {},
    expectedPrice: 0,
    modelId: parent.model.id,
    versionId: parent.version.id
  });
  const response = await f.jobs.run(request);

  assert.equal(response.versions.length, 0);
  assert.equal(response.checkJobId, request.idempotencyKey);
  assert.equal((await f.library.readModel(parent.model.id)).versions[0].rigCheck.status, 'pending');
  await f.jobs.tick();
  await f.jobs.stop();

  const resumed = createJobs({ ...f.dependencies, intents: createIntents({ library: f.library }) });

  t.after(() => resumed.stop());
  f.fake.complete(fakeTaskId(1), { output: { riggable: true, rig_type: 'biped' }, credits: 0 });
  await resumed.resume();
  await resumed.tick();

  const version = (await f.library.readModel(parent.model.id)).versions[0];

  parseStudio3d.version(versionProjection(version, f.library.libraryId, () => 'fixture'));
  assert.equal(version.rigCheck.status, 'ready');
  assert.equal((await f.library.readModel(parent.model.id)).versions.length, 1);
});

test('JB-12 локальный worker сохраняет новую бесплатную GLB версию', async (t) => {
  const f = await fixture(t);
  const parent = await parentVersion(f);
  const request = textRequest(f, {
    provider: 'local',
    operation: 'rotate',
    values: { turn: 'y90' },
    expectedPrice: 0,
    modelId: parent.model.id,
    versionId: parent.version.id
  });

  await f.jobs.run(request);
  await f.jobs.tick();

  const version = (await f.jobs.run(request)).versions[0];

  assert.equal(version.status, 'ready');
  assert.equal(version.cost.free, true);
  assert.equal(version.files[0].name, 'model.glb');
  assert.equal(f.fake.requests.length, 0);
});

test('JB-14 missed не означает отказ или refund и поздний poll восстанавливает результат', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  
  const task = f.fake.tasks.get(fakeTaskId(1));

  f.fake.tasks.delete(fakeTaskId(1));
  await f.jobs.tick();
  await f.jobs.tick();
  await f.jobs.tick();
  
  const child = (await f.jobs.job(request.idempotencyKey)).children[0];

  assert.equal(child.status, 'queued');
  assert.notEqual(child.paymentState, 'refunded');
  f.fake.tasks.set(fakeTaskId(1), task);
  f.fake.progress(fakeTaskId(1), 50, 12);
  f.advance(60_001);
  await f.jobs.tick();
  assert.equal((await f.jobs.run(request)).versions[0].progress, 50);
});

test('JB-21 смена доступа после prepare и durable submitting закрывает POST', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);
  const original = f.provider.prepare;
  let current = true;
  const isCurrent = f.provider.isCurrent;

  f.provider.isCurrent = (captured) => current && isCurrent(captured);
  f.provider.prepare = async (...args) => {
    const prepared = await original(...args);

    current = false;

    return prepared;
  };
  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 0);
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].status, 'waiting');
  current = true;
  f.provider.prepare = original;
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-24 два unknown child разрешаются раздельно; close сохраняет расход и поздний reconcile',
  async (t) => {
  const f = await fixture(t);
  const first = textRequest(f);
  const second = textRequest(f);

  await f.jobs.run(first);
  await f.jobs.run(second);
  f.fake.dropOnce('POST', /text-to-model/);
  f.fake.dropOnce('POST', /text-to-model/);
  await f.jobs.tick();
  
  const childId = (await f.jobs.job(first.idempotencyKey)).children[0].childId;

  await f.jobs.closeUnknown(first.idempotencyKey, childId, f.library.libraryId);
  assert.equal((await f.jobs.job(first.idempotencyKey)).children[0].status, 'unresolved');
  assert.equal((await f.jobs.spending())[0].unknownCount, 2);
  f.fake.tasks.set(fakeTaskId(90), {
    task_id: fakeTaskId(90),
    type: 'text_to_model',
    status: 'queued'
  });
  await f.jobs.reconcile(first.idempotencyKey, childId, {
    libraryId: f.library.libraryId, taskId: fakeTaskId(90)
  });
  await assert.rejects(f.jobs.reconcile(second.idempotencyKey, childId, {
    libraryId: f.library.libraryId, taskId: fakeTaskId(90)
  }), (error) => error.code === 'task_already_linked');
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length, 2);
});

test('JB-22 batch целиком проверяется до POST и сохраняет unknown второй строки при restart', async (t) => {
  const f = await fixture(t);
  const base = textRequest(f);
  const rows = Array.from({ length: 3 }, (_, index) => ({
    provider: base.provider,
    operation: base.operation,
    values: base.values,
    name: `Строка ${index + 1}`,
    project: null,
    category: null,
    expectedPrice: base.expectedPrice
  }));
  const quote = await f.jobs.quoteBatch({ libraryId: f.library.libraryId, rows });
  const request = {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    snapshot: quote.snapshot,
    snapshotHash: quote.snapshotHash
  };
  const wrong = structuredClone(request);

  wrong.snapshot.rows[2].expectedPrice = 999;
  await assert.rejects(f.jobs.runBatch(wrong));
  assert.equal(f.fake.tasks.size, 0);
  assert.equal((await f.intents.list()).length, 0);
  
  const accepted = parseStudio3d.batchRun(await f.jobs.runBatch(request));

  assert.equal(accepted.children.length, 3);
  f.fake.respondOnce('POST', /text-to-model/, 200, { code: 0, data: { task_id: fakeTaskId(1) } });
  f.fake.dropOnce('POST', /text-to-model/);
  await f.jobs.tick();
  
  const outcomes = await f.jobs.batch(request.idempotencyKey);

  assert.deepEqual(outcomes.children.map((child) => child.status), ['queued', 'unknown', 'waiting']);
  await f.jobs.stop();
  
  const resumed = createJobs({ ...f.dependencies, intents: createIntents({ library: f.library }) });

  t.after(() => resumed.stop());
  await resumed.resume();
  await resumed.tick();
  
  const replay = parseStudio3d.batchRun(await resumed.runBatch(request));

  assert.deepEqual(replay.children.map((child) => child.intentId),
    accepted.children.map((child) => child.intentId));
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length, 2);
  
  const unknown = await resumed.job(outcomes.children[1].intentId);

  await resumed.closeUnknown(unknown.intentId, unknown.children[0].childId, f.library.libraryId);
  assert.equal((await resumed.batch(request.idempotencyKey)).children[2].status, 'failed');
  // Один child остаётся unresolved, другой известен как принятый резерв.
  // Резерв не увеличивает число заказов с неизвестным списанием.
  assert.equal((await resumed.spending())[0].unknownCount, 1);
});

test('JB-22 смешанные единицы пачки отвергаются до журнала и POST', async (t) => {
  const f = await fixture(t);
  const base = textRequest(f);
  const quote = f.provider.quote;
  const tokens = {
    one: 'токен',
    few: 'токена',
    many: 'токенов'
  };

  f.provider.quote = (operation, values, context) => {
    const result = quote(operation, values, context);

    return values.prompt === 'Вторая' ? { ...result, unit: tokens } : result;
  };
  await assert.rejects(f.jobs.quoteBatch({
    libraryId: f.library.libraryId,
    rows: batchRows(base, ['Первая', 'Вторая'])
  }), (error) => error.code === 'mixed_units');
  assert.equal((await f.intents.list()).length, 0);
  assert.equal(f.fake.tasks.size, 0);
});

test('JB-22 новая цена строки приостанавливает неотправленных соседей, принятая докачивается',
  async (t) => {
    const f = await fixture(t);
    const base = textRequest(f);
    const quoted = await f.jobs.quoteBatch({
      libraryId: f.library.libraryId,
      rows: batchRows(base, ['Первый', 'Второй', 'Третий'])
    });
    const request = {
      libraryId: f.library.libraryId,
      idempotencyKey: randomUUID(),
      snapshot: quoted.snapshot,
      snapshotHash: quoted.snapshotHash
    };
    const accepted = await f.jobs.runBatch(request);
    const quote = f.provider.quote;
    const prompts = () => f.fake.requests.filter((item) => item.path.endsWith('/text-to-model'))
      .map((item) => item.body.prompt);

    f.provider.quote = (operation, values, context) => {
      const result = quote(operation, values, context);

      return values.prompt === 'Второй' ? { ...result, total: result.total + 5 } : result;
    };
    await f.jobs.tick();
    assert.deepEqual(prompts(), ['Первый']);
    assert.equal((await f.jobs.job(accepted.children[1].intentId)).children[0].waitReason, 'price_changed');
    assert.equal((await f.jobs.job(accepted.children[2].intentId)).children[0].waitReason,
      'Пачка приостановлена — разберите исход или подтвердите новую цену.');
    f.fake.setFile('model.glb', makeGlb({ triangles: 2 }));
    f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('model.glb') }, credits: 30 });
    await f.jobs.tick();
    await f.jobs.settle();

    const outcomes = await f.jobs.batch(request.idempotencyKey);

    assert.deepEqual(outcomes.children.map((child) => child.status), ['ready', 'waiting', 'waiting']);
    assert.deepEqual(prompts(), ['Первый']);
  });

test('JB-22 два одинаковых runBatch объединяются в один parent и одну подготовку', async (t) => {
  const f = await fixture(t);
  const base = textRequest(f);
  const rows = batchRows(base, ['Первый', 'Второй', 'Третий']);
  const quoted = await f.jobs.quoteBatch({ libraryId: f.library.libraryId, rows });
  const request = {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    snapshot: quoted.snapshot,
    snapshotHash: quoted.snapshotHash
  };
  const available = f.provider.available;
  let checks = 0;

  f.provider.available = async () => {
    checks += 1;

    return available();
  };

  const [first, second] = await Promise.all([f.jobs.runBatch(request), f.jobs.runBatch(request)]);
  const records = await f.intents.list();

  assert.deepEqual(second, first);
  assert.equal(records.filter((record) => record.kind === 'batch').length, 1);
  assert.equal(records.length, 1 + rows.length);
  assert.equal(checks, rows.length, 'acceptance пачки выполнена один раз');
});

test('JB-25 terminal inputs GC сохраняет ключ/расход и объясняет недоступный retry', async (t) => {
  const f = await fixture(t);
  const upload = await imageUpload(f);
  const request = textRequest(f, {
    operation: 'image-to-model',
    values: {},
    expectedPrice: 30,
    uploads: [upload]
  });

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.fail(fakeTaskId(1), { code: 2018 });
  await f.jobs.tick();
  f.advance(8 * 86_400_000);
  await f.jobs.cleanup();
  
  const job = await f.jobs.job(request.idempotencyKey);

  assert.equal(job.children[0].retryAvailable, false);
  assert.match(job.children[0].retryReason, /истёк/);
  assert.equal((await f.intents.list()).length, 1);
  await f.jobs.run(request);
  assert.equal(f.fake.tasks.size, 1);
  await assert.rejects(fs.stat(path.join(f.intents.directory(request.idempotencyKey), 'inputs')));
});

for (const boundary of ['after-intent', 'after-projection', 'before-send', 'after-send', 'after-task-id']) {
  test(`JB-18 crash ${boundary} сохраняет ID и не повторяет возможный POST`, async (t) => {
    let faulted = false;
    const f = await fixture(t, { jobs: {
      fault: async (current) => {
        if (!faulted && current === boundary) {
          faulted = true;
          
          throw new Error('fixture-crash');
        }
      }
    } });
    const request = textRequest(f);

    await f.jobs.run(request).catch((error) => {
      assert.match(error.message, /fixture-crash/);
    });
    await f.jobs.tick().catch((error) => {
      assert.match(error.message, /fixture-crash/);
    });

    assert.equal(faulted, true, `Точка сбоя ${boundary} достигнута`);
    
    const persisted = await f.intents.get(request.idempotencyKey);
    const postCount = f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length;

    await f.jobs.stop();
    
    const resumed = createJobs({
      ...f.dependencies,
      fault: undefined,
      intents: createIntents({ library: f.library })
    });

    t.after(() => resumed.stop());
    await resumed.resume();
    await resumed.tick();
    
    const restored = await resumed.run(request);

    assert.equal(restored.model.id, persisted.modelId);
    assert.equal(restored.versions[0].id, persisted.children[0].version.id);
    assert.equal((await f.library.readModel(restored.model.id)).versions.length, 1);
    
    if (['before-send', 'after-send'].includes(boundary)) {
      assert.equal(restored.versions[0].status, 'unknown');
      assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length, postCount);
    } else {
      assert.equal(f.fake.tasks.size, 1);
    }
  });
}

test('JB-18 crash после done до SSE не меняет успешный durable исход', async (t) => {
  let faulted = false;
  const f = await fixture(t, { jobs: { fault: async (boundary) => {
    if (boundary === 'after-done') {
      faulted = true;

      throw new Error('fixture-crash');
    }
  } } });
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.setFile('model.glb', makeGlb({ triangles: 2 }));
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('model.glb') }, credits: 30 });
  await f.jobs.tick();
  await f.jobs.settle().catch(() => {});

  assert.equal(faulted, true, 'Точка after-done достигнута');
  
  const persisted = await f.intents.get(request.idempotencyKey);

  assert.equal(persisted.children[0].stage, 'done');
  assert.equal(persisted.children[0].status, 'ready');
  await f.jobs.stop();
  
  const resumed = createJobs({
    ...f.dependencies,
    fault: undefined,
    intents: createIntents({ library: f.library })
  });

  t.after(() => resumed.stop());
  await resumed.resume();
  await resumed.tick();
  await resumed.tick();
  assert.equal(f.events.filter((event) => event.data.terminal).length, 1);
});

test('JB-18 crash after-download необязательного preview выходит наружу без публикации', async (t) => {
  let downloads = 0;
  const f = await fixture(t, { jobs: { fault: async (boundary) => {
    if (boundary !== 'after-download') {
      return;
    }

    downloads += 1;

    if (downloads === 2) {
      throw new Error('fixture-crash');
    }
  } } });
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.setFile('model.glb', makeGlb({ triangles: 2 }));
  f.fake.setFile('preview.png', await pngImage(3, 3));
  f.fake.complete(fakeTaskId(1), {
    output: {
      pbr_model_url: f.fake.cdnUrl('model.glb'),
      rendered_image_url: f.fake.cdnUrl('preview.png')
    },
    credits: 35
  });
  await f.jobs.tick();
  await assert.rejects(f.jobs.settle(), /fixture-crash/);
  assert.equal(downloads, 2, 'Точка after-download пройдена для модели и preview');

  const persisted = await f.intents.get(request.idempotencyKey);

  assert.equal(persisted.children[0].stage, 'accepted');
  assert.equal(persisted.children[0].status, 'downloading');
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-18 batch crash после parent fsync восстанавливает все прежние row IDs', async (t) => {
  let faulted = false;
  const f = await fixture(t, { jobs: { fault: async (boundary) => {
    if (boundary === 'after-batch-intent') {
      faulted = true;

      throw new Error('fixture-crash');
    }
  } } });
  const base = textRequest(f);
  const quote = await f.jobs.quoteBatch({ libraryId: f.library.libraryId,
    rows: Array.from({ length: 3 }, (_, index) => ({
      provider: 'tripo',
      operation: base.operation,
      values: base.values,
      name: `Строка ${index}`,
      project: null,
      category: null,
      expectedPrice: base.expectedPrice
    })) });
  const request = {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    snapshot: quote.snapshot,
    snapshotHash: quote.snapshotHash
  };

  await assert.rejects(f.jobs.runBatch(request));

  assert.equal(faulted, true, 'Точка after-batch-intent достигнута');
  
  const parent = await f.intents.get(request.idempotencyKey);
  const ids = parent.batch.rows.map((row) => row.template.modelId);

  assert.equal((await f.library.listModels()).entries.length, 0);
  await f.jobs.stop();
  
  const resumed = createJobs({
    ...f.dependencies,
    fault: undefined,
    intents: createIntents({ library: f.library })
  });

  t.after(() => resumed.stop());
  await resumed.resume();
  
  const restored = await resumed.runBatch(request);

  assert.deepEqual(restored.children.map((row) => row.modelId), ids);
  await resumed.tick();
  assert.equal(f.fake.tasks.size, 3);
});

test('JB-19 цена после prepare требует нового нажатия даже когда старая цена вернулась', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);
  const quote = f.provider.quote;
  const prepare = f.provider.prepare;

  f.provider.prepare = async (...args) => {
    const result = await prepare(...args);

    f.provider.quote = (...parameters) => ({ ...quote(...parameters), total: request.expectedPrice + 5 });

    return result;
  };
  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 0);
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].waitReason, 'price_changed');
  f.provider.quote = quote;
  f.provider.prepare = prepare;
  await f.jobs.tick();
  await f.jobs.run(request);
  assert.equal(f.fake.tasks.size, 0);
});

test('JB-21 последний допуск после fsync submitting останавливает send при disable', async (t) => {
  let f;
  let changed = false;

  f = await fixture(t, { intentHooks: { afterWrite: async (record) => {
    if (!changed && record.children[0]?.stage === 'submitting') {
      changed = true;
      f.jobs.admission.configure({ enabled: false });
    }
  } } });
  
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 0);
  assert.equal((await f.intents.get(request.idempotencyKey)).children[0].stage, 'prepared');
  f.jobs.admission.configure({ enabled: true });
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-10 две разные одновременные проверки одного parent дают один durable заказ', async (t) => {
  const f = await fixture(t);
  const parent = await parentVersion(f);
  const request = textRequest(f, {
    operation: 'rig-check',
    values: {},
    expectedPrice: 0,
    modelId: parent.model.id,
    versionId: parent.version.id
  });
  const results = await Promise.allSettled([f.jobs.run(request),
    f.jobs.run({ ...request, idempotencyKey: randomUUID() })]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await f.intents.list()).length, 1);
  await f.jobs.tick();
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/rig-check')).length, 1);
});

test('JB-13/23 paid success с ошибкой CDN допускает только free redownload и сохраняет расход', async (t) => {
  const f = await fixture(t, { jobs: { download: (request) => downloadToFile({
    ...request,
    attempts: 1,
    fetchImpl: fetch,
    sleep: async () => {}
  }) } });
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.setFile('model.glb', makeGlb({ triangles: 2 }));
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('model.glb') }, credits: 35 });
  f.fake.cdnFault('model.glb', { kind: 'drop', after: 16 });
  await f.jobs.tick();
  await f.jobs.settle();
  
  const failed = (await f.jobs.job(request.idempotencyKey)).children[0];

  assert.equal(failed.status, 'failed');
  assert.equal(failed.actual, 35);
  assert.equal(failed.paymentState, 'charged');
  assert.equal(failed.retryAvailable, false);
  assert.doesNotMatch(failed.error.message, /вернулись/);
  await f.jobs.redownload(request.idempotencyKey, failed.childId, f.library.libraryId);
  await f.jobs.settle();
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].status, 'ready');
  
  const modelId = (await f.jobs.run(request)).model.id;

  await f.library.deleteModel(modelId);
  assert.equal((await f.jobs.spending())[0].actual, 35);
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-20 stop отменяет свой CDN поток, сохраняя accepted для recovery', async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, { jobs: { download: async (request) => {
    started();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 400);

      request.signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('fixture-aborted'));
      }, { once: true });
    });
    
    throw new Error('fixture-ended');
  } } });
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('model.glb') }, credits: 30 });
  await f.jobs.tick();
  await entered;
  
  const before = performance.now();

  await f.jobs.stop();
  assert.equal(performance.now() - before < 250, true);
  
  const persisted = await f.intents.get(request.idempotencyKey);

  assert.equal(persisted.children[0].stage, 'accepted');
  assert.equal(persisted.children[0].status, 'downloading');
});

test('JB-19 собственный резерв защищает от задержки обновления available без двойного frozen', async (t) => {
  const f = await fixture(t);
  const first = textRequest(f);
  const second = textRequest(f);

  f.fake.setBalance({ balance: first.expectedPrice + 10, frozen: 100 });
  await Promise.all([f.jobs.run(first), f.jobs.run(second)]);
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 1);
  
  const statuses = await Promise.all([f.jobs.job(first.idempotencyKey), f.jobs.job(second.idempotencyKey)]);

  assert.deepEqual(statuses.map((job) => job.children[0].status).sort(), ['queued', 'waiting']);
  // available уже уменьшился на первый заказ и пополнился до новой суммы.
  // Подтверждённый terminal poll освобождает reserve без повторного вычитания frozen.
  f.fake.fail(fakeTaskId(1), { code: 2018 });
  f.fake.setBalance({ balance: second.expectedPrice, frozen: 100 });
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 2);
});

test('JB-19 чужой аккаунт не уменьшает баланс, свой принятый резерв вычитается один раз', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  f.fake.setBalance({ balance: 100, frozen: 0 });
  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 1);
  assert.equal((await f.intents.get(request.idempotencyKey)).children[0].stage, 'accepted');

  assert.equal(request.expectedPrice, 20);

  const balance = { available: 100, reserved: 0 };
  const other = { ...f.provider.snapshot(), accountKey: 'fixture-other-account' };

  assert.deepEqual(await f.jobs.balanceView(f.provider, other, balance), { available: 100, reserved: 0 });
  assert.deepEqual(await f.jobs.balanceView(f.provider, f.provider.snapshot(), balance), {
    available: 80,
    reserved: 20
  });
});

test('JB-21 цена меняется во время fsync submitting — последний допуск не делает POST', async (t) => {
  let f;
  let changed = false;

  f = await fixture(t, { intentHooks: { afterWrite: async (record) => {
    if (!changed && record.children[0]?.stage === 'submitting') {
      changed = true;
      
      const quote = f.provider.quote;

      f.provider.quote = (...args) => ({ ...quote(...args), total: record.confirmedPrice + 5 });
    }
  } } });
  
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 0);
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].waitReason, 'price_changed');
});

test('JB-21 snapshot меняется после prepare — перед POST повторно сверяется открытый fd', async (t) => {
  let f;

  f = await fixture(t, { jobs: { fault: async (boundary, record) => {
    if (boundary === 'before-send') {
      await fs.writeFile(f.intents.inputPath(record.intentId, record.inputs[0].name), 'подмена снимка');
    }
  } } });
  
  const upload = await imageUpload(f);
  const request = textRequest(f, {
    operation: 'image-to-model',
    values: {},
    expectedPrice: 30,
    uploads: [upload]
  });

  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal(f.fake.uploads.length, 1);
  assert.equal(f.fake.tasks.size, 0);
});

test('JB-19 новая цена подтверждается новым UUID и закрывает только неотправленный child', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  await f.jobs.run(request);
  
  const quote = f.provider.quote;

  f.provider.quote = (...args) => ({ ...quote(...args), total: request.expectedPrice + 5 });
  await f.jobs.tick();
  
  const job = await f.jobs.job(request.idempotencyKey);
  const input = {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    expectedPrice: request.expectedPrice + 5
  };
  const confirmed = await f.jobs.retry(request.idempotencyKey, job.children[0].childId, input);

  assert.notEqual(confirmed.intentId, request.idempotencyKey);
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].status, 'failed');
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 1);
  await f.jobs.run(request);
  await f.jobs.retry(request.idempotencyKey, job.children[0].childId, input);
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-17/25 двадцать одинаковых нажатий, replay и удаление не оплачивают повторно', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.jobs.run(request)));

  responses.forEach((response) => parseStudio3d.run(response));
  assert.equal(new Set(responses.map((response) => response.model.id)).size, 1);
  assert.equal(responses[0].versions[0].status, 'waiting');
  assert.equal(f.fake.tasks.size, 0);
  await Promise.all([f.jobs.tick(), f.jobs.tick(), f.jobs.tick()]);
  assert.equal(f.fake.tasks.size, 1);
  await assert.rejects(f.jobs.run({ ...request, name: 'Иное нажатие' }),
    (error) => error.code === 'idempotency_conflict');
  await assert.rejects(f.jobs.run({ ...request, libraryId: randomUUID() }),
    (error) => error.code === 'stale_library');
});

test('JB-17 run и batch с одним UUID конфликтуют до durable записи и не держат admission', async (t) => {
  for (const firstKind of ['run', 'batch']) {
    const f = await fixture(t);
    const base = textRequest(f);
    const rows = batchRows(base, ['Первая', 'Вторая']);
    const quoted = await f.jobs.quoteBatch({ libraryId: f.library.libraryId, rows });
    const batch = {
      libraryId: f.library.libraryId,
      idempotencyKey: base.idempotencyKey,
      snapshot: quoted.snapshot,
      snapshotHash: quoted.snapshotHash
    };
    const available = f.provider.available;
    let entered;
    let release;
    let armed = true;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    // Первый await provider.available() стоит до buildIntent, copy и admission lock:
    // удержание здесь не даёт durable записи, которая сама вернула бы конфликт.
    f.provider.available = async () => {
      if (armed) {
        armed = false;
        entered();
        await gate;
      }

      return available();
    };

    const first = firstKind === 'run' ? f.jobs.run(base) : f.jobs.runBatch(batch);
    const outcome = first.then(() => null, (error) => error);

    try {
      assert.equal(await withinLimit(Promise.race([reached.then(() => true), outcome.then(() => false)]),
        `${firstKind} дошёл до provider.available`), true);
      assert.equal(f.jobs.admission.pendingCount(), 1);
      await assert.rejects(withinLimit(firstKind === 'run' ? f.jobs.runBatch(batch) : f.jobs.run(base),
        'отказ второго вида запроса'), (error) => error.code === 'idempotency_conflict');
      assert.equal(f.jobs.admission.pendingCount(), 1);
      assert.equal((await f.intents.list()).length, 0);
    } finally {
      release();
    }

    assert.equal(await withinLimit(outcome, `${firstKind} завершился`), null);
    assert.equal(f.jobs.admission.pendingCount(), 0);
    f.provider.available = available;

    const records = await f.intents.list();

    assert.equal(records.length, firstKind === 'run' ? 1 : 1 + rows.length);
    assert.equal(records.filter((record) => record.kind === 'batch').length, firstKind === 'run' ? 0 : 1);
    await f.jobs.tick();
    assert.equal(f.fake.tasks.size, firstKind === 'run' ? 1 : rows.length);
  }
});

test('JB-17 отвергнутые run и runBatch освобождают admission и UUID', async (t) => {
  const f = await fixture(t);
  const base = textRequest(f);
  const quoted = await f.jobs.quoteBatch({
    libraryId: f.library.libraryId,
    rows: batchRows(base, ['Первый', 'Второй'])
  });
  const batch = {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    snapshot: quoted.snapshot,
    snapshotHash: quoted.snapshotHash
  };
  const stale = structuredClone(batch);

  stale.snapshot.rows[1].expectedPrice = 999;
  await assert.rejects(f.jobs.run({ ...base, expectedPrice: base.expectedPrice + 1 }),
    (error) => error.code === 'price_changed');
  await assert.rejects(f.jobs.runBatch(stale), (error) => error.code === 'invalid_batch');
  assert.equal(f.jobs.admission.pendingCount(), 0);
  assert.equal((await f.intents.list()).length, 0);
  assert.equal(f.fake.tasks.size, 0);
  await f.jobs.run(base);
  await f.jobs.runBatch(batch);
  assert.equal(f.jobs.admission.pendingCount(), 0);
  assert.equal((await f.intents.list()).length, 1 + 1 + 2);
});

test('JB-04/16 успех сохраняет полные файлы, SHA и фактический расход', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);
  const response = await f.jobs.run(request);

  await f.jobs.tick();
  f.fake.progress(fakeTaskId(1), 40, 12);
  await f.jobs.tick();
  assert.equal(f.events.some((event) => event.name === 'studio-progress' &&
    event.data.progress === 40), true);
  f.fake.setFile('model.glb', makeGlb({ triangles: 2 }));
  f.fake.setFile('preview.png', await pngImage(3, 3));
  f.fake.complete(fakeTaskId(1), {
    output: {
      pbr_model_url: f.fake.cdnUrl('model.glb'),
      rendered_image_url: f.fake.cdnUrl('preview.png')
    },
    credits: 35
  });
  await f.jobs.tick();
  await f.jobs.settle();

  const current = parseStudio3d.run(await f.jobs.run(request)).versions[0];

  assert.equal(current.status, 'ready');
  assert.equal(current.cost.actual, 35);
  assert.equal(current.files.some((file) => file.role === 'preview'), true);
  assert.equal(current.cost.estimated, request.expectedPrice);
  assert.equal(current.stats.triangles, 2);
  assert.equal(current.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
  assert.equal(f.events.some((event) => event.name === 'studio-changed'), true);
  await f.library.deleteVersion(response.model.id, current.id);
  assert.equal(parseStudio3d.run(await f.jobs.run(request)).deleted, true);
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].versionId, null);

  await f.library.deleteModel(response.model.id);
  
  const tombstone = parseStudio3d.run(await f.jobs.run(request));

  assert.equal(tombstone.deleted, true);
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-06 429 оставляет child waiting до Retry-After без повторов раньше срока', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  await f.jobs.run(request);
  f.fake.respondOnce('POST', /text-to-model/, 429, { code: 2000 }, { 'Retry-After': '7' });
  await f.jobs.tick();
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].status, 'waiting');
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 0);
  f.advance(7001);
  await f.jobs.tick();
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-08 ambiguous POST остаётся unknown после десяти минут и restart', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  await f.jobs.run(request);
  f.fake.dropOnce('POST', /text-to-model/);
  await f.jobs.tick();
  f.fake.setUsage([{
    task_id: fakeTaskId(90),
    type: 'text_to_model',
    credits_consumed: 30,
    created_at: '2026-10-11T10:00:01Z'
  }]);
  f.advance(700_000);
  await f.jobs.tick();
  
  const child = (await f.jobs.job(request.idempotencyKey)).children[0];

  assert.equal(child.status, 'unknown');
  assert.equal(child.taskId, null);
  assert.equal(child.candidates.length, 1);
  await assert.rejects(f.jobs.retry(request.idempotencyKey, child.childId, {
    libraryId: f.library.libraryId,
    idempotencyKey: randomUUID(),
    expectedPrice: 30
  }));
  await f.jobs.stop();
  
  const resumed = createJobs({ ...f.dependencies, intents: createIntents({ library: f.library }) });

  t.after(() => resumed.stop());
  await resumed.resume();
  await resumed.tick();
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length, 1);
});

test('JB-35 необязательное preview не лишает оплаченный основной файл ready', async (t) => {
  const f = await fixture(t, { jobs: { download: (request) => {
    if (request.url.includes('missing-preview')) {
      throw new Error('optional-preview-unavailable');
    }

    return downloadToFile({
      ...request,
      fetchImpl: fetch,
      sleep: async () => {}
    });
  } } });
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.setFile('main.glb', makeGlb({ triangles: 2 }));
  f.fake.complete(fakeTaskId(1), { output: {
    model_url: f.fake.cdnUrl('main.glb'),
    rendered_image_url: f.fake.cdnUrl('missing-preview.webp'),
  }, credits: 35 });
  await f.jobs.tick();
  await f.jobs.settle();

  const current = parseStudio3d.run(await f.jobs.run(request)).versions[0];

  assert.equal(current.status, 'ready');
  assert.equal(current.cost.actual, 35);
  assert.equal(current.files.some((file) => file.role === 'model'), true);
  assert.equal(current.files.some((file) => file.role === 'preview'), false);
  assert.equal(f.fake.tasks.size, 1);
});

test('JB-36 обязательная битая картинка не ready; PNG под webp сохраняется как preview.png', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f, {
    operation: 'text-to-image',
    values: { prompt: 'Синтетическая картинка' },
    expectedPrice: 5
  });

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.setFile('broken.png', Buffer.from('это не картинка'));
  f.fake.complete(fakeTaskId(1), { output: { image_url: f.fake.cdnUrl('broken.png') }, credits: 5 });
  await f.jobs.tick();
  await f.jobs.settle();

  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].status, 'failed');

  const modelRequest = textRequest(f);

  await f.jobs.run(modelRequest);
  await f.jobs.tick();

  const image = await pngImage();

  f.fake.setFile('main.glb', makeGlb());
  f.fake.setFile('rendered_image.webp', image);
  f.fake.complete(fakeTaskId(2), {
    output: {
      model_url: f.fake.cdnUrl('main.glb'),
      rendered_image_url: f.fake.cdnUrl('rendered_image.webp')
    },
    credits: 30
  });
  await f.jobs.tick();
  await f.jobs.settle();

  const result = await f.jobs.run(modelRequest);
  const preview = result.versions[0].files.find((file) => file.role === 'preview');

  assert.equal(result.versions[0].status, 'ready');
  assert.equal(preview?.name, 'preview.png');
  assert.deepEqual(await fs.readFile(path.join(f.dir, result.model.id,
    result.versions[0].id, preview.name)), image);
});

test('JB-23 resume не переписывает version.json завершённых записей журнала', async (t) => {
  let countWrites = false;
  let writes = 0;
  const f = await fixture(t, {
    library: {
      beforePersist: async (file) => {
        if (countWrites && file.endsWith('/version.json')) {
          writes += 1;
        }
      }
    }
  });
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.setFile('model.glb', makeGlb({ triangles: 2 }));
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('model.glb') }, credits: 30 });
  await f.jobs.tick();
  await f.jobs.settle();

  const base = await f.intents.get(request.idempotencyKey);
  const model = await f.library.readModel(base.modelId);
  const versionJson = path.join(f.dir, base.modelId, model.versions[0].id, 'version.json');
  const seeded = JSON.parse(await fs.readFile(versionJson, 'utf8'));

  // Пользовательское поле не меняет состояние заказа и переживает восстановление.
  seeded.label = 'Сохранённое имя версии';

  await fs.writeFile(versionJson, JSON.stringify(seeded));

  const total = 2000;

  for (let index = 1; index < total; index += 1) {
    const id = randomUUID();
    const req = { ...base.request, idempotencyKey: id };
    const copy = {
      ...structuredClone(base),
      intentId: id,
      request: req,
      requestFingerprint: requestFingerprint(req),
      children: base.children.map((child) => ({
        ...structuredClone(child),
        version: child.version ? { ...structuredClone(child.version), intentId: id } : null
      }))
    };

    await f.intents.reserve(copy);
  }

  const resumed = createJobs({
    ...f.dependencies,
    intents: createIntents({ library: f.library })
  });

  t.after(() => resumed.stop());
  countWrites = true;
  await resumed.resume();

  const after = JSON.parse(await fs.readFile(versionJson, 'utf8'));

  assert.equal(after.status, 'ready');
  assert.equal(after.label, 'Сохранённое имя версии');
  assert.equal(writes, 0);
  assert.equal((await f.intents.list()).length >= total, true);
});

test('JB-37 resume восстанавливает ready из журнала поверх downloading в проекции', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  await f.jobs.run(request);
  await f.jobs.tick();
  f.fake.setFile('main.glb', makeGlb());
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('main.glb') }, credits: 30 });
  await f.jobs.tick();
  await f.jobs.settle();

  const record = await f.intents.get(request.idempotencyKey);
  const versionId = record.children[0].version.id;

  assert.equal(record.children[0].status, 'ready');
  await f.library.updateVersion(record.modelId, versionId, { status: 'downloading' });

  const resumed = createJobs({
    ...f.dependencies,
    intents: createIntents({ library: f.library })
  });

  t.after(() => resumed.stop());
  await resumed.resume();

  const entry = await f.library.readModel(record.modelId);

  assert.equal(entry.versions.find((version) => version.id === versionId).status, 'ready');
});

const ASCII_FBX = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
  FBXHeaderVersion: 1003
  FBXVersion: 7400
}
Objects:  {
  Geometry: 1, "Geometry::Fixture", "Mesh" {
    Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
    PolygonVertexIndex: *3 { a: 0,1,-3 }
  }
  Model: 2, "Model::Fixture", "Mesh" { Version: 232 }
}
Connections:  {
  C: "OO",1,2
  C: "OO",2,0
}
`;

test('JB-06b оплаченный экспорт сохраняет FBX и GLB без повторного скачивания', async (t) => {
  const f = await fixture(t);
  const parent = await parentVersion(f);
  const context = {
    kind: 'model',
    format: null,
    stats: null,
    params: null,
    nativeTaskType: null,
    rigCheck: null,
    views: []
  };
  const cases = [
    ['FBX', ASCII_FBX, 'export.fbx', '.fbx'],
    ['GLTF', makeGlb({ triangles: 2 }), 'export.glb', '.glb'],
  ];

  for (const [index, [format, bytes, fileName, ext]] of cases.entries()) {
    const values = f.provider.validate('export', { format }, context).values;
    const request = textRequest(f, {
      operation: 'export',
      modelId: parent.model.id,
      versionId: parent.version.id,
      values,
      expectedPrice: f.provider.quote('export', values, context).total
    });
    const accepted = await f.jobs.run(request);

    await f.jobs.tick();
    f.fake.setFile(fileName, bytes);
    f.fake.complete(fakeTaskId(index + 1), {
      output: { model_url: f.fake.cdnUrl(fileName) },
      credits: 5
    });
    await f.jobs.tick();
    await f.jobs.settle();

    const job = await f.jobs.job(request.idempotencyKey);

    assert.equal(job.children[0].status, 'ready', format);

    const version = (await f.library.readModel(parent.model.id))
      .versions.find((item) => item.id === accepted.versions[0].id);
    const file = version.files.find((item) => item.role === 'file');

    assert.equal(version.status, 'ready', format);
    assert.equal(file?.name.endsWith(ext), true, format);
    assert.equal(version.mainFileId, file?.id, format);
  }
});

test('JB-22 ждущую денег позицию можно отменить без оплаты и без отправки после пополнения', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  f.fake.setBalance({ balance: request.expectedPrice - 1, frozen: 0 });
  await f.jobs.run(request);
  await f.jobs.tick();

  const waiting = await f.jobs.job(request.idempotencyKey);

  assert.equal(waiting.children[0].status, 'waiting');
  assert.equal(f.fake.tasks.size, 0);

  await f.jobs.closeUnknown(request.idempotencyKey, waiting.children[0].childId,
    f.library.libraryId);

  const closed = await f.jobs.job(request.idempotencyKey);

  assert.equal(closed.children[0].status, 'failed');
  assert.equal(closed.children[0].paymentState, 'unpaid');

  f.fake.setBalance({ balance: 500, frozen: 0 });
  await f.jobs.tick();
  await f.jobs.settle();

  assert.equal(f.fake.tasks.size, 0);
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].status, 'failed');
});

test('JB-22b ожидание денег больше суток закрывает позицию само', async (t) => {
  const f = await fixture(t);
  const request = textRequest(f);

  f.fake.setBalance({ balance: request.expectedPrice - 1, frozen: 0 });
  await f.jobs.run(request);
  await f.jobs.tick();
  assert.equal((await f.jobs.job(request.idempotencyKey)).children[0].status, 'waiting');

  f.advance(24 * 60 * 60 * 1000 + 60_000);
  await f.jobs.tick();
  await f.jobs.settle();

  const job = await f.jobs.job(request.idempotencyKey);

  assert.equal(job.children[0].status, 'failed');
  assert.equal(job.children[0].waitReason, 'Не хватило средств в течение суток');
  assert.equal(job.children[0].paymentState, 'unpaid');
  assert.equal(f.fake.tasks.size, 0);
});

test('JB-poll-download: удержанный CDN не останавливает опрос другого заказа',
  { timeout: 60_000 }, async (t) => {
    let enter;
    let release;
    let released = false;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });

    t.after(() => release());

    const f = await fixture(t, { jobs: { download: async (request) => {
      enter();
      await held;

      return downloadToFile({
        ...request,
        fetchImpl: fetch,
        sleep: async () => {},
      });
    } } });
    const first = textRequest(f);
    const second = textRequest(f);

    try {
      await f.jobs.run(first);
      await withinLimit(f.jobs.tick(), 'отправка первого заказа');
      await f.jobs.run(second);
      await withinLimit(f.jobs.tick(), 'отправка второго заказа');
      assert.equal(f.fake.tasks.size, 2);
      f.fake.setFile('model.glb', makeGlb());
      f.fake.complete(fakeTaskId(1), {
        output: { model_url: f.fake.cdnUrl('model.glb') },
        credits: 30,
      });
      await withinLimit(f.jobs.tick(), 'начало скачивания');
      await withinLimit(entered, 'удержанный CDN');
      f.fake.progress(fakeTaskId(2), 40);
      await withinLimit(f.jobs.tick(), 'опрос при удержанном CDN');
      assert.equal(f.events.some((event) => event.name === 'studio-progress'
        && event.data.intentId === second.idempotencyKey && event.data.progress === 40), true);
      assert.equal(released, false);
    } finally {
      released = true;
      release();
    }

    await withinLimit(f.jobs.settle(), 'завершение скачивания');

    const record = await f.intents.get(first.idempotencyKey);

    assert.equal(record.children[0].status, 'ready');
    assert.equal(f.fake.tasks.size, 2);
  });
