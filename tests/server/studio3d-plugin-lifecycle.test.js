import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { acquireKernelFileLock } from '../../server/src/lib/kernelLock.ts';
import { nodeExecutable } from '../../server/src/lib/runtimePaths.ts';
import {
  hasStudioDevelopment, studioIntegrationTest, studioPluginFixture, studioProduct,
  studioUntil, uploadStudioModel,
} from './helpers/studio3dPluginFixture.js';
import { fakeTaskId } from './helpers/fakeTripo.js';
import { makeGlb } from './helpers/studio3dGlb.js';

const { parseStudio3d } = hasStudioDevelopment
  ? await studioProduct('shared/studio3d/studio3dContracts.ts') : {};
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=',
  'base64');

/**
 * Определение integration сохраняет обычный core CI без внешнего дерева плагина.
 * Переданный env с неверным путём падает в helper, а локальные ворота требуют ноль skip.
 */
function integrationTest(name, callback, options) {
  return studioIntegrationTest(test, name, callback, options);
}

/**
 * Quote и run проходят настоящий внешний router и сессионный auth.
 * Fake provider принимает один платный POST; uuid и полное тело задаёт пользовательский запрос.
 */
async function acceptOrder(f) {
  const quoted = parseStudio3d.quote((await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Изолированная модель' },
  })).json());
  const request = {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: quoted.validation.values,
    expectedPrice: quoted.quote.total,
  };
  const accepted = await f.call('POST', '/run', request);

  assert.equal(accepted.statusCode, 202, accepted.body);
  await f.runtime().context.jobs.tick();

  return { request, accepted: parseStudio3d.run(accepted.json()) };
}

integrationTest('S3D-LOADER prefix, GLB upload, binary preview, Range/HEAD и экспорт в проект', async (t) => {
  const f = await studioPluginFixture(t);
  const uploaded = await uploadStudioModel(f);

  assert.equal(uploaded.statusCode, 200, uploaded.body);

  const input = parseStudio3d.upload(uploaded.json());
  const createdResponse = await f.call('POST', '/models', {
    libraryId: f.libraryId,
    uploadId: input.uploadId,
    name: 'Фикстура загрузчика',
  });

  assert.equal(createdResponse.statusCode, 200, createdResponse.body);

  const created = parseStudio3d.createdModel(createdResponse.json());
  const detail = parseStudio3d.model((await f.call('GET', `/models/${created.model.id}`)).json());
  const file = detail.versions[0].files[0];

  assert.match(file.url, /^\/api\/ext\/studio3d\/files\//);
  assert.equal(file.url.includes('/api/studio3d'), false);

  const route = file.url.replace('/api/ext/studio3d', '');
  const whole = await f.call('GET', route);
  const range = await f.call('GET', route, undefined, 'session', { range: 'bytes=0-3' });
  const head = await f.call('HEAD', route, undefined, 'session', { range: 'bytes=-8' });

  assert.equal(whole.statusCode, 200);
  assert.deepEqual(whole.rawPayload, makeGlb());
  assert.equal(range.statusCode, 206);
  assert.equal(range.rawPayload.toString(), 'glTF');
  assert.equal(head.statusCode, 206);
  assert.equal(head.rawPayload.length, 0);
  assert.equal(head.headers.etag, whole.headers.etag);
  assert.equal(head.headers['content-length'], '8');

  const versionRoute = `/models/${created.model.id}/versions/${created.version.id}`;
  const preview = await f.call('POST', `${versionRoute}/preview?libraryId=${f.libraryId}`, PNG,
    'session', { 'content-type': 'image/png' });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.match(parseStudio3d.version(preview.json()).preview, /^\/api\/ext\/studio3d\/files\//);

  const save = await f.call('POST', `${versionRoute}/save`, {
    libraryId: f.libraryId,
    projectId: 'fixture-project',
    repoKey: 'main',
    folder: 'models',
    fileName: 'loader.glb',
  });

  assert.equal(save.statusCode, 200, save.body);
  assert.deepEqual(await fs.readFile(path.join(f.repo, 'models/loader.glb')), makeGlb());
  assert.equal((await f.server.inject({ url: '/api/studio3d/state',
    headers: { cookie: 'grigdesk_sid=fixture-session' } })).statusCode, 404);
});

integrationTest('S3D-LOADER protected пути отвергаются до marker/lock/prefs', async (t) => {
  const f = await studioPluginFixture(t);
  const before = structuredClone(f.prefsStore.value);
  const old = f.runtime().context;
  const workerUrl = f.runtime().context.library.analysis.workerUrl;
  const generation = path.dirname(path.dirname(fileURLToPath(workerUrl)));
  const packageAlias = path.join(f.root, 'package-alias');
  const generationAlias = path.join(f.root, 'generation-alias');

  await fs.symlink(f.pluginDir, packageAlias);
  await fs.symlink(generation, generationAlias);

  const candidates = [
    path.join(f.pluginDir, 'library'),
    path.join(packageAlias, 'library'),
    f.pluginsDir,
    path.join(generation, 'library'),
    path.join(generationAlias, 'library'),
    f.fixtureRoot,
    path.join(f.config.stateDir, 'new-library'),
  ];

  for (const libraryDir of candidates) {
    const result = await f.plugin('PUT', '/settings', { values: { libraryDir } });

    assert.equal(result.statusCode, 409, `${libraryDir}: ${result.body}`);
    assert.deepEqual(f.prefsStore.value, before);
    assert.equal(f.runtime().context, old);
    assert.equal((await f.call('GET', '/state')).json().libraryId, f.libraryId);
    await assert.rejects(fs.stat(path.join(libraryDir, '.library.json')));
    await assert.rejects(fs.stat(path.join(libraryDir, '.owner.lock')));
  }

  await assert.rejects(fs.stat(path.join(f.pluginDir, 'library')));
  await assert.rejects(fs.stat(path.join(generation, 'library')));
  await assert.rejects(fs.stat(f.config.stateDir));
});

/**
 * Второй настоящий Node держит kernel flock на той же библиотеке весь lifetime.
 * Процесс закрывается только собственным stdin, аварийный cleanup убивает лишь его PID.
 */
async function holdLibrary(t, f) {
  const libraryUrl = pathToFileURL(path.join(process.env.STUDIO3D_DEVELOPMENT_DIR,
    'src/lib/studio3d/library.ts')).href;
  const lockUrl = new URL('../../server/src/lib/kernelLock.ts', import.meta.url).href;
  const code = [
    `import {createLibrary} from ${JSON.stringify(libraryUrl)};`,
    `import {acquireKernelFileLock} from ${JSON.stringify(lockUrl)};`,
    `const library=createLibrary({dir:${JSON.stringify(f.config.studio3dDir)},`,
    'acquireLock:acquireKernelFileLock});',
    'await library.ensure();',
    'console.log(JSON.stringify({libraryId:library.libraryId}));',
    'process.stdin.once("data",async()=>{await library.close();process.exit(0)});',
    'process.stdin.resume();',
  ].join('\n');
  const child = spawn(nodeExecutable(), ['--input-type=module', '--eval', code], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
  });
  let errors = '';
  const closed = new Promise((resolve) => child.once('close', resolve));

  child.stderr.on('data', (bytes) => {
     errors += bytes;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await closed;
  });

  const opened = await new Promise((resolve, reject) => {
    let text = '';

    child.stdout.on('data', (bytes) => {
      text += bytes;

      if (text.includes('\n')) {
        resolve(JSON.parse(text.split('\n')[0]));
      }
    });
    child.once('error', reject);
    child.once('close', (code) => reject(new Error(`Holder ${code}: ${errors}`)));
  });

  return {
    child,
    closed,
    libraryId: opened.libraryId
  };
}

integrationTest('S3D-LOADER второй процесс держит flock; release сохраняет UUID', async (t) => {
  const f = await studioPluginFixture(t, { enabled: false });
  const held = await holdLibrary(t, f);
  const blocked = await f.setEnabled(true);

  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(f.prefsStore.value.plugins.studio3d, false);

  held.child.stdin.write('release\n');
  await held.closed;

  const enabled = await f.setEnabled(true);

  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal((await f.call('GET', '/state')).json().libraryId, held.libraryId);
});

integrationTest('S3D-LOADER busy off завершает заказ один раз и освобождает flock', async (t) => {
  const f = await studioPluginFixture(t);
  const context = f.runtime().context;
  const { request } = await acceptOrder(f);

  assert.equal(f.fake.tasks.size, 1);
  assert.equal((await f.setEnabled(false)).statusCode, 200);
  assert.equal(f.runtime().context, context);

  f.fake.complete(fakeTaskId(1), { output: {}, credits: request.expectedPrice });
  await context.jobs.tick();
  await context.jobs.settle();
  await studioUntil(() => f.runtime().context, (value) => value === null);

  const lock = await acquireKernelFileLock({
    lockPath: path.join(f.config.studio3dDir, '.owner.lock'),
    mode: 'exclusive',
    timeoutMs: 100,
  });

  await lock.release();
  assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 1);
  assert.equal((await f.setEnabled(true)).statusCode, 200);
  assert.equal((await f.call('GET', '/state')).json().libraryId, f.libraryId);
});

integrationTest('S3D-LOADER unknown удерживает библиотеку и запрещает replacement', async (t) => {
  const f = await studioPluginFixture(t);

  f.fake.dropOnce('POST', /text-to-model/);

  const { request } = await acceptOrder(f);
  const unknown = await f.runtime().context.jobs.job(request.idempotencyKey);

  assert.equal(unknown.children[0].status, 'unknown');
  assert.equal((await f.setEnabled(false)).statusCode, 200);
  assert.notEqual(f.runtime().context, null);
  assert.equal(Boolean(await f.probe.lifecycle.busyReason()), true);
  await assert.rejects(f.probe.runtimePort.prepareReplace('studio3d', new AbortController().signal),
    (error) => error.code === 'plugin_busy');
  assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 1);
});

integrationTest('S3D-LOADER timeout откатывает поздний prepared context без prefs', async (t) => {
  const f = await studioPluginFixture(t);
  const original = f.probe.lifecycle.prepareChange;
  const before = structuredClone(f.prefsStore.value);
  const old = f.runtime().context;
  const directory = path.join(f.root, 'late-settings');
  let release;
  let entered;
  const held = new Promise((resolve) => {
     release = resolve;
  });
  const ready = new Promise((resolve) => {
     entered = resolve;
  });

  f.probe.lifecycle.prepareChange = async (...args) => {
    const transition = await original(...args);

    entered();
    await held;

    return transition;
  };
  t.after(() => release());

  const changing = f.plugin('PUT', '/settings', { values: { libraryDir: directory } });

  await ready;

  const response = await changing;

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'plugin_change_timeout');
  assert.deepEqual(f.prefsStore.value, before);
  assert.equal(f.runtime().context, old);
  release();
  await studioUntil(async () => {
    try {
      const lock = await acquireKernelFileLock({
        lockPath: path.join(directory, '.owner.lock'), timeoutMs: 10,
      });

      await lock.release();

      return true;
    } catch {
      return false;
    }
  }, Boolean);
  assert.equal((await f.call('GET', '/state')).json().libraryId, f.libraryId);
}, { timeout: 20000 });

integrationTest('S3D-LOADER restart сохраняет UUID/стоимость без нового POST', async (t) => {
  const first = await studioPluginFixture(t);
  const context = first.runtime().context;
  const queued = await acceptOrder(first);

  first.fake.dropOnce('POST', /text-to-model/);

  const unknown = await acceptOrder(first);
  const terminal = await acceptOrder(first);

  first.fake.complete(fakeTaskId(2), { output: {}, credits: 15 });
  await context.jobs.tick();
  await context.jobs.settle();

  const records = await context.intents.list();
  const identity = (rows) => rows.map((record) => ({
    id: record.intentId,
    accountKey: record.accountKey,
    children: record.children.map((child) => ({
      id: child.childId,
      stage: child.stage,
      status: child.status,
      taskId: child.taskId,
      estimated: child.estimated,
      actual: child.actual,
    })),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const before = identity(records);
  const tasks = [...first.fake.tasks].map(([id, task]) => [id, structuredClone(task)]);

  assert.equal(records.some((record) => record.intentId === queued.request.idempotencyKey
    && record.children[0].taskId === fakeTaskId(1)), true);
  assert.equal(records.some((record) => record.intentId === unknown.request.idempotencyKey
    && record.children[0].status === 'unknown'), true);
  assert.equal(records.some((record) => record.intentId === terminal.request.idempotencyKey
    && record.children[0].actual === 15), true);
  await first.server.close();

  const second = await studioPluginFixture(t, {
    existingRoot: first.fixtureRoot,
    seed({ fake }) {
      for (const [id, task] of tasks) {
        fake.tasks.set(id, task);
      }
    },
  });

  assert.equal(second.libraryId, first.libraryId);
  await second.runtime().context.jobs.tick();
  await second.runtime().context.jobs.settle();
  assert.deepEqual(identity(await second.runtime().context.intents.list()), before);
  assert.equal(second.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 0);
  assert.equal(second.fake.requests.some((row) => row.path === '/v3/tasks/list'), true);
  await second.server.close();
});

integrationTest('S3D-LOADER опасный saved path не создаёт другую пустую библиотеку', async (t) => {
  const f = await studioPluginFixture(t, {
    allowUnavailable: true,
    settings: ({ pluginDir }) => ({ libraryDir: path.join(pluginDir, 'saved-library') }),
  });

  await studioUntil(() => f.runtime().unavailable, Boolean);

  const state = parseStudio3d.state((await f.call('GET', '/state')).json());
  const unsafe = path.join(f.pluginDir, 'saved-library');

  assert.equal(state.library.ok, false);
  assert.equal(state.library.dir, unsafe);
  assert.equal(Boolean(state.library.error), true);
  assert.equal(f.prefsStore.value.pluginSettings.studio3d.libraryDir, unsafe);
  assert.equal(f.runtime().context, null);
  await assert.rejects(fs.stat(unsafe));
  await assert.rejects(fs.stat(f.config.studio3dDir));
});

integrationTest('S3D-LOADER remove/reinstall fixture сохраняет UUID и финансовый журнал', async (t) => {
  const f = await studioPluginFixture(t);
  const { request } = await acceptOrder(f);

  f.fake.fail(fakeTaskId(1), { code: 2018 });
  await f.runtime().context.jobs.tick();
  await f.runtime().context.jobs.settle();

  const before = await f.runtime().context.intents.list();
  const oldRuntime = f.runtime();
  const lease = await f.probe.runtimePort.prepareReplace('studio3d', new AbortController().signal);

  await lease.finish('installed');
  await fs.rm(f.pluginDir, { recursive: true });
  await f.probe.runtimePort.refresh();
  assert.equal((await f.call('GET', '/state')).statusCode, 404);
  assert.equal((await fs.stat(f.config.studio3dDir)).isDirectory(), true);
  await f.rebuildPackage();
  await f.probe.runtimePort.refresh();
  await studioUntil(() => f.call('GET', '/state'), (response) => response.statusCode === 200
    && response.json().library.ok);

  const after = await f.runtime().context.intents.list();

  assert.notEqual(f.runtime(), oldRuntime);
  assert.equal((await f.call('GET', '/state')).json().libraryId, f.libraryId);
  assert.deepEqual(after.map((record) => ({ id: record.intentId, children: record.children })),
    before.map((record) => ({ id: record.intentId, children: record.children })));
  assert.equal(after[0].intentId, request.idempotencyKey);
  assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 1);
});

integrationTest('S3D-LOADER encoded paid routes: cli/internal закрыты, session разрешена', async (t) => {
  const f = await studioPluginFixture(t);
  const routes = ['/ru%6E', '/batches/ru%6E', '/models/fixture/versions/v01-fixture/retr%79',
    '/jobs/fixture/children/fixture/reconcil%65', '/jobs/fixture/children/fixture/close-unknow%6E'];

  for (const auth of ['cli', 'internal']) {
    for (const route of routes) {
      const denied = await f.call('POST', route, {}, auth);

      assert.equal(denied.statusCode, 403, `${auth}: ${route}`);
      assert.equal(denied.json().error, 'human_session_required');
    }
  }

  assert.equal(f.fake.requests.filter((row) => row.method === 'POST').length, 0);

  for (const route of routes) {
    const response = await f.call('POST', route, {});

    assert.notEqual(response.statusCode, 401, route);
    assert.notEqual(response.statusCode, 403, route);
  }

  assert.equal(f.fake.tasks.size, 0);
});

integrationTest('S3D-LOADER onClose ждёт child.close до удаления собственной ESM копии', async (t) => {
  const f = await studioPluginFixture(t);
  const context = f.runtime().context;
  const { inspectGlbFile } = await studioProduct('lib/studio3d/analysisProcess.ts');
  const input = path.join(f.repo, 'shutdown.glb');
  const slowWorker = path.join(f.root, 'slow-worker.mjs');
  const worker = fileURLToPath(context.library.analysis.workerUrl);
  const generation = path.dirname(path.dirname(worker));
  const caller = new AbortController();
  let child;
  let childClosedBeforeRemoval = false;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });

  await fs.writeFile(input, makeGlb());
  await fs.writeFile(slowWorker, 'setInterval(() => {}, 1000);\n');

  const operation = inspectGlbFile(input, context.analysis.deps({
    signal: caller.signal,
    /**
     * Настоящий core Node и путь generation проверяются до подмены только тестового script.
     * Долгий собственный child удерживает close barrier; production worker здесь не изменяется.
     */
    spawnImpl(command, args, options) {
      assert.equal(command, f.environment().nodeExecutable);
      assert.equal(args[1], worker);

      child = spawn(command, [args[0], slowWorker, ...args.slice(2)], options);
      child.once('close', () => {
        childClosedBeforeRemoval = existsSync(generation);
      });
      started();

      return child;
    },
  })).catch((error) => error);

  await entered;

  const lease = await f.probe.runtimePort.prepareReplace('studio3d', new AbortController().signal);

  assert.equal((await operation).code, 'aborted');
  assert.equal(caller.signal.aborted, false);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(childClosedBeforeRemoval, true);
  await assert.rejects(fs.stat(generation));
  await lease.finish('reverted');
  await studioUntil(() => f.call('GET', '/state'), (response) => response.statusCode === 200
    && response.json().library.ok);
  assert.equal((await f.call('GET', '/state')).json().libraryId, f.libraryId);
});
