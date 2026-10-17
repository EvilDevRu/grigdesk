import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTripoClient } from '../../server/src/lib/tripo/client.ts';
import { createTripoStudio } from '../../server/src/lib/tripo/studio.ts';
import { RIG_V1 } from '../../server/src/lib/tripo/catalog.ts';
import { START_CONTEXT, ProviderFailure } from '../../server/src/lib/studio3d/provider.ts';
import { fakeTaskId, startFakeTripo } from './helpers/fakeTripo.js';
import { makeGlb } from './helpers/studio3dGlb.js';

test('TC-24 загрузка не читает symlink/hardlink и остаётся на открытом inode при подмене', async (t) => {
  const { fake, dir } = await fixture(t);
  const source = path.join(dir, 'source.glb');
  const linked = path.join(dir, 'linked.glb');
  const bytes = makeGlb({ triangles: 2 });

  await fs.writeFile(source, bytes);
  await fs.symlink(source, linked);

  const plain = createTripoClient({ env: fake.env, baseUrl: fake.baseUrl });

  await assert.rejects(plain.upload(linked));
  await fs.unlink(linked);
  await fs.link(source, linked);
  await assert.rejects(plain.upload(linked));
  await fs.unlink(linked);
  assert.equal(fake.uploads.length, 0);

  let observed = null;
  const client = createTripoClient({
    env: fake.env,
    baseUrl: fake.baseUrl,
    fetchImpl: async (_url, options) => {
      await fs.rename(source, `${source}.old`);
      await fs.writeFile(source, 'чужие байты после подмены');
      observed = Buffer.from(await options.body.get('file').arrayBuffer());

      return Response.json({ code: 0, data: { file_token: 'fixture' } });
    }
  });

  await assert.rejects(client.upload(source));
  assert.deepEqual(observed, bytes);
});

test('TC-25 cancelReads обрывает бесплатное ожидание headers даже у неисправного fetch', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const client = createTripoClient({
    env: { TRIPO_API_KEY: 'fixture-key' },
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 300,
    fetchImpl: async () => {
      entered();

      return new Promise(() => {});
    },
    sleep: async () => {}
  });
  const pending = client.balance();

  await started;
  
  const before = performance.now();

  client.cancelReads();
  await assert.rejects(pending);
  assert.equal(performance.now() - before < 150, true);
});

/**
 * Поддельный Tripo и клиент к нему. Паузы повторов мгновенные: сценарии проверяют
 * число попыток, а не время.
 */
async function fixture(t) {
  const fake = await startFakeTripo();
  const client = createTripoClient({
    env: fake.env,
    baseUrl: fake.baseUrl,
    sleep: async () => {}
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-tripo-client-'));

  t.after(async () => {
    await fake.close();
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  });

  return {
    fake,
    client,
    dir
  };
}

// Ожидание отказа исполнителя с нужным видом ошибки и признаком отправки.
async function rejectsWith(promise, kind, submitted) {
  await assert.rejects(promise, (error) => {
    return error instanceof ProviderFailure && error.error.kind === kind && error.submitted === submitted;
  });
}

test('TC-01 без ключа клиент не ходит в сеть и отвечает «нужен ключ»', async (t) => {
  const { fake } = await fixture(t);
  const client = createTripoClient({
    env: {},
    baseUrl: fake.baseUrl
  });

  assert.equal(client.available(), false);
  await rejectsWith(client.balance(), 'auth', false);
  assert.equal(fake.requests.length, 0);
});

test('TC-02 создание задачи: номер из ответа, отказ сервера — точно не принят', async (t) => {
  const { fake, client } = await fixture(t);
  const id = await client.createTask('/v3/generation/text-to-model', { prompt: 'кот' });

  assert.equal(id, fakeTaskId(1));
  assert.equal(fake.tasks.get(id).type, 'text_to_model');

  fake.respondOnce('POST', /text-to-model/, 403, {
    code: 2010,
    message: 'Insufficient credits'
  });
  await rejectsWith(client.createTask('/v3/generation/text-to-model', { prompt: 'кот' }), 'credits', false);

  fake.respondOnce('POST', /text-to-model/, 429, {
    code: 2000,
    message: 'limit'
  }, { 'Retry-After': '7' });
  await assert.rejects(client.createTask('/v3/generation/text-to-model', {}), (error) => {
    return error.error.kind === 'busy' && error.error.retryAfterMs === 7000;
  });
});

test('TC-03 обрыв связи при создании: исход неизвестен и повтора нет', async (t) => {
  const { fake, client } = await fixture(t);

  fake.dropOnce('POST', /text-to-model/);
  await rejectsWith(client.createTask('/v3/generation/text-to-model', { prompt: 'кот' }), 'network', null);
  assert.equal(fake.requests.filter((item) => item.path.endsWith('text-to-model')).length, 1);
});

test('TC-04 чтения повторяются при сбое и 5xx, но не бесконечно', async (t) => {
  const { fake, client } = await fixture(t);

  fake.dropOnce('GET', /balance/);
  fake.respondOnce('GET', /balance/, 502, { code: 1000 });

  assert.deepEqual(await client.balance(), {
    available: 100,
    reserved: 0
  });

  for (let index = 0; index < 3; index += 1) {
    fake.respondOnce('GET', /usage/, 503, { code: 1000 });
  }

  await rejectsWith(client.usage(), 'server', false);
});

test('TC-05 опрос пакетом: задачи, пропавшие номера и история трат', async (t) => {
  const { fake, client } = await fixture(t);
  const id = await client.createTask('/v3/animations/rig', {});

  fake.progress(id, 40, 12);
  fake.setUsage([{
    task_id: id,
    type: 'animate_rig',
    credits_consumed: 25,
    created_at: '2026-10-11'
  }]);

  const listed = await client.listTasks([id, fakeTaskId(99)]);

  assert.equal(listed.tasks[0].progress, 40);
  assert.equal(listed.tasks[0].etaSeconds, 12);
  assert.deepEqual(listed.missed, [fakeTaskId(99)]);
  assert.equal((await client.usage())[0].credits, 25);
  assert.equal((await client.getTask(id)).state, 'running');
});

test('TC-06 загрузка: модель уходит файлом, .gltf и большие картинки — отказ без сети', async (t) => {
  const { fake, client, dir } = await fixture(t);
  const glb = path.join(dir, 'hero.glb');
  const gltf = path.join(dir, 'hero.gltf');

  await fs.writeFile(glb, makeGlb({ triangles: 3 }));
  await fs.writeFile(gltf, '{}');

  assert.equal(await client.upload(glb), 'file_1');
  assert.equal(fake.uploads[0].name, 'hero.glb');
  await rejectsWith(client.upload(gltf), 'input', false);
  assert.equal(fake.uploads.length, 1);
});

test('TS-01 исполнитель: номер задачи, где можно, загрузка, где нужно', async (t) => {
  const { fake, dir } = await fixture(t);
  const studio = createTripoStudio({
    env: fake.env,
    baseUrl: fake.baseUrl,
    sleep: async () => {}
  });
  const file = path.join(dir, 'low.glb');

  await fs.writeFile(file, makeGlb({ triangles: 2 }));

  const captured = studio.snapshot();

  fake.tasks.set(fakeTaskId(7), {
    task_id: fakeTaskId(7),
    type: 'multiview_to_model',
    status: 'success'
  });

  const native = await studio.plan({
    operation: 'rig',
    values: { model: RIG_V1 },
    context: START_CONTEXT,
    inputs: [{
      role: 'primary',
      native: {
        taskId: fakeTaskId(7),
        taskType: 'multiview_to_model',
        accountKey: captured.accountKey
      },
      file: {
        path: file,
        name: 'low.glb'
      }
    }],
  });
  const uploaded = await studio.plan({
    operation: 'rig',
    values: { model: RIG_V1 },
    context: START_CONTEXT,
    inputs: [{
      role: 'primary',
      native: null,
      file: {
        path: file,
        name: 'low.glb'
      }
    }],
  });
  const again = await studio.plan({
    operation: 'rig-check',
    values: {},
    context: START_CONTEXT,
    inputs: [{
      role: 'primary',
      native: null,
      file: {
        path: file,
        name: 'low.glb'
      }
    }],
  });

  assert.equal(fake.uploads.length, 0);

  const nativePrepared = await studio.prepare(native[0], captured);
  const uploadedPrepared = await studio.prepare(uploaded[0], captured);
  const againPrepared = await studio.prepare(again[0], captured);

  assert.equal(nativePrepared.payload.body.input, fakeTaskId(7));
  assert.equal(uploadedPrepared.payload.body.input, 'file_1');
  assert.equal(againPrepared.payload.body.input, 'file_1');
  assert.equal(fake.uploads.length, 1);
});

test('TS-02 шаг только для версий Tripo отказывает до любых трат', async (t) => {
  const { fake, dir } = await fixture(t);
  const studio = createTripoStudio({
    env: fake.env,
    baseUrl: fake.baseUrl
  });
  const file = path.join(dir, 'rig.glb');

  await fs.writeFile(file, makeGlb({ joints: 3 }));

  const planned = studio.plan({
    operation: 'animate',
    values: { animations: ['preset:biped:walk'] },
    context: START_CONTEXT,
    inputs: [{
      role: 'primary',
      native: null,
      file: {
        path: file,
        name: 'rig.glb'
      }
    }],
  });

  await rejectsWith(studio.prepare(planned[0], studio.snapshot()), 'input', false);
  assert.equal(fake.requests.length, 0);
});

test('TS-03 движения: по задаче на движение, отправка возвращает номер', async (t) => {
  const { fake } = await fixture(t);
  const studio = createTripoStudio({
    env: fake.env,
    baseUrl: fake.baseUrl
  });
  const captured = studio.snapshot();

  fake.tasks.set(fakeTaskId(5), {
    task_id: fakeTaskId(5),
    type: 'animate_rig',
    status: 'success'
  });

  const planned = await studio.plan({
    operation: 'animate',
    values: {
      animations: ['preset:biped:walk', 'preset:biped:idle'],
      out_format: 'glb'
    },
    context: { ...START_CONTEXT, params: { model: RIG_V1 } },
    inputs: [{
      role: 'primary',
      native: {
        taskId: fakeTaskId(5),
        taskType: 'animate_rig',
        accountKey: captured.accountKey
      },
      file: null
    }],
  });
  const prepared = await studio.prepare(planned[0], captured);
  const sent = await studio.send(prepared, captured);

  assert.deepEqual(planned.map((task) => [task.label, task.values.animations]), [
    ['Ходьба', ['preset:biped:walk']],
    ['Покой', ['preset:biped:idle']],
  ]);
  assert.deepEqual(sent, {
    taskId: fakeTaskId(1),
    taskType: 'animate_retarget'
  });
  assert.equal(fake.tasks.get(fakeTaskId(1)).input.animation, 'preset:biped:walk');
});

test('FIX-02 повреждённый 2xx и неизвестный отказ после POST не разрешают повтор', async (t) => {
  const { fake, client } = await fixture(t);
  const bodies = [null, {}, { code: 0 }, { code: 0, data: {} }, { code: 92345 }];

  for (const body of bodies) {
    fake.respondOnce('POST', /text-to-model/, 200, body);
    await assert.rejects(client.createTask('/v3/generation/text-to-model', {}), (error) => {
      return error instanceof ProviderFailure && error.submitted === null;
    });
  }

  assert.equal(fake.requests.filter((item) => item.path.endsWith('text-to-model')).length, bodies.length);
});

test('FIX-02 deadline включает вечное body и отменяет запрос', async () => {
  let signal;
  let calls = 0;
  const client = createTripoClient({
    env: { TRIPO_API_KEY: 'fixture-key' },
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 30,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      calls += 1;

      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"code":0,"data":'));
        }
      }));
    }
  });
  const result = client.createTask('/v3/generation/text-to-model', {});
  const bounded = Promise.race([
    result,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('body зависло')), 200)),
  ]);

  await assert.rejects(bounded, (error) => {
    return error instanceof ProviderFailure && error.submitted === null;
  });
  assert.equal(Boolean(signal?.aborted), true);
  assert.equal(calls, 1);
});

test('FIX-02 JSON ограничен четырьмя МиБ, секреты не появляются в ошибке', async () => {
  const client = createTripoClient({
    env: { TRIPO_API_KEY: 'fixture-secret-marker' },
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)),
  });

  await assert.rejects(client.createTask('/v3/generation/text-to-model', {}), (error) => {
    return error instanceof ProviderFailure
      && error.submitted === null
      && !JSON.stringify(error).includes('fixture-secret-marker');
  });
});

test('FIX-08 TC-06 действительно проверяет картинку больше двадцати МиБ', async (t) => {
  const { fake, client, dir } = await fixture(t);
  const file = path.join(dir, 'large.png');

  await fs.writeFile(file, Buffer.alloc(20 * 1024 * 1024 + 1));
  await rejectsWith(client.upload(file), 'input', false);
  assert.equal(fake.requests.length, 0);
});

test('FIX-07 невалидный баланс не превращается в ноль или доступные деньги', async (t) => {
  const { fake, client } = await fixture(t);
  const malformed = [
    { balance: '20', frozen: 0 },
    { balance: 20, frozen: -1 },
    { balance: null, frozen: 0 },
  ];

  for (const balance of malformed) {
    fake.setBalance(balance);
    assert.equal(await client.balance(), null);
  }

  fake.setBalance({ balance: 0, frozen: 25 });
  assert.deepEqual(await client.balance(), { available: 0, reserved: 25 });
  fake.setBalance({ balance: 12.34, frozen: 25.5 });
  assert.deepEqual(await client.balance(), { available: 12.34, reserved: 25.5 });
});

test('FIX-05 plan чистый: входы загружаются только prepare', async (t) => {
  const { fake, dir } = await fixture(t);
  const studio = createTripoStudio({ env: fake.env, baseUrl: fake.baseUrl });
  const file = path.join(dir, 'source.glb');

  await fs.writeFile(file, makeGlb());

  const planned = await studio.plan({
    operation: 'rig-check',
    values: {},
    context: {
      ...START_CONTEXT,
      kind: 'model',
      format: 'glb'
    },
    inputs: [{
      role: 'primary',
      native: null,
      file: { path: file, name: 'source.glb' }
    }],
  });

  assert.equal(fake.requests.length, 0);
  assert.equal(typeof planned[0].childId, 'string');
  assert.equal(planned[0].childId.length > 0, true);

  const prepared = await studio.prepare(planned[0], studio.snapshot());

  assert.equal(fake.uploads.length, 1);
  assert.equal(prepared.payload.body.input, 'file_1');
});

test('FIX-05 регион между upload/send не переносит заказ в другой аккаунт', async (t) => {
  const { fake, dir } = await fixture(t);
  const env = { ...fake.env };
  const studio = createTripoStudio({ env, baseUrl: fake.baseUrl });
  const file = path.join(dir, 'source.glb');

  await fs.writeFile(file, makeGlb());

  const snapshot = studio.snapshot();
  const planned = await studio.plan({
    operation: 'rig-check',
    values: {},
    context: {
      ...START_CONTEXT,
      kind: 'model',
      format: 'glb'
    },
    inputs: [{
      role: 'primary',
      native: null,
      file: { path: file, name: 'source.glb' }
    }],
  });
  const prepared = await studio.prepare(planned[0], snapshot);

  env.TRIPO_REGION = 'cn';

  assert.equal(studio.isCurrent(snapshot), false);
  await assert.rejects(studio.send(prepared, snapshot), (error) => {
    return error instanceof ProviderFailure && error.submitted === false;
  });
  assert.equal(fake.requests.filter((item) => item.path === '/v3/animations/rig-check').length, 0);
});

test('FIX-05 сохранённый второй клип отправляет своё движение без planIndex', async (t) => {
  const { fake } = await fixture(t);
  const studio = createTripoStudio({ env: fake.env, baseUrl: fake.baseUrl });
  const snapshot = studio.snapshot();
  const id = await createTripoClient({ env: fake.env, baseUrl: fake.baseUrl })
    .createTask('/v3/animations/rig', {});

  fake.complete(id);

  const planned = await studio.plan({
    operation: 'animate',
    values: { animations: ['preset:biped:walk', 'preset:biped:idle', 'preset:biped:run'] },
    context: {
      ...START_CONTEXT,
      kind: 'rigged',
      params: { model: RIG_V1 }
    },
    inputs: [{
      role: 'primary',
      native: {
        taskId: id,
        taskType: 'animate_rig',
        accountKey: snapshot.accountKey
      },
      file: null
    }],
  });
  const saved = JSON.parse(JSON.stringify(planned[1]));
  const prepared = await studio.prepare(saved, snapshot);
  const sent = await studio.send(prepared, snapshot);

  assert.equal(fake.tasks.get(sent.taskId).input.animation, 'preset:biped:idle');
  assert.equal(saved.childId, planned[1].childId);
  assert.notEqual(planned[0].childId, planned[1].childId);
});

test('FIX-05 токен зависит от sha256 и аккаунта даже при прежнем mtime', async (t) => {
  const { fake, dir } = await fixture(t);
  const input = path.join(dir, 'model.glb');
  const source = makeGlb({ size: [1, 1, 1] });
  const studio = createTripoStudio({ env: fake.env, baseUrl: fake.baseUrl });

  await fs.writeFile(input, source);

  const original = await fs.stat(input);
  const request = {
    operation: 'rig-check',
    values: {},
    inputs: [{
      role: 'primary',
      native: null,
      file: { path: input, name: 'model.glb' }
    }],
    context: {
      ...START_CONTEXT,
      kind: 'model',
      format: 'glb'
    }
  };
  const planned = studio.plan(request);

  await studio.prepare(planned[0], studio.snapshot());
  await studio.prepare(planned[0], studio.snapshot());
  assert.equal(fake.uploads.length, 1);

  await fs.writeFile(input, makeGlb({ size: [2, 1, 1] }));
  await fs.utimes(input, original.atime, original.mtime);
  await studio.prepare(planned[0], studio.snapshot());
  assert.equal(fake.uploads.length, 2);

  fake.env.TRIPO_REGION = 'cn';
  await studio.prepare(planned[0], studio.snapshot());
  assert.equal(fake.uploads.length, 3);
});

test('FIX-05 истёкший native ID использует файл, native-only прекращается до POST', async (t) => {
  const { fake, dir } = await fixture(t);
  const input = path.join(dir, 'model.glb');
  const studio = createTripoStudio({ env: fake.env, baseUrl: fake.baseUrl });
  const snapshot = studio.snapshot();
  const missing = fakeTaskId(99);

  await fs.writeFile(input, makeGlb());

  const inputs = [{
    role: 'primary',
    native: {
      taskId: missing,
      taskType: 'animate_rig',
      accountKey: snapshot.accountKey
    },
    file: { path: input, name: 'model.glb' }
  }];
  const fileStep = studio.plan({
    operation: 'retexture',
    values: {},
    inputs,
    context: {
      ...START_CONTEXT,
      kind: 'rigged',
      format: 'glb'
    }
  });
  const prepared = await studio.prepare(fileStep[0], snapshot);

  assert.equal(prepared.payload.body.input, 'file_1');

  const nativeStep = studio.plan({
    operation: 'animate',
    values: { animations: ['preset:biped:walk'] },
    inputs,
    context: {
      ...START_CONTEXT,
      kind: 'rigged',
      format: 'glb',
      params: { model: RIG_V1 }
    }
  });

  await assert.rejects(studio.prepare(nativeStep[0], snapshot), (error) => {
    return error instanceof ProviderFailure && error.submitted === false && error.error.kind === 'input';
  });
  assert.equal(fake.requests.filter((item) => item.path.endsWith('/retarget')).length, 0);
});
