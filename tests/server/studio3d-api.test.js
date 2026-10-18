import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import Fastify from '../../server/node_modules/fastify/fastify.js';
import multipart from '../../server/node_modules/@fastify/multipart/index.js';
import pluginsModule from '../../server/src/modules/plugins/index.ts';

import studio3dModule from '../../server/src/modules/studio3d/index.ts';
import { DocumentReader } from '../../server/src/lib/documents/reader.ts';
import { createTripoStudio } from '../../server/src/lib/tripo/studio.ts';
import { downloadToFile } from '../../server/src/lib/studio3d/download.ts';
import { parseStudio3d } from '../../shared/studio3d/studio3dContracts.ts';
import { fakeTaskId, startFakeTripo } from './helpers/fakeTripo.js';
import { makeGlb } from './helpers/studio3dGlb.js';
import authPlugin from '../../server/src/plugins/auth.ts';
import { ProviderFailure } from '../../server/src/lib/studio3d/provider.ts';

// Настоящий PNG 1×1: декодер не принимает одну сигнатуру без пикселей.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=',
  'base64');

/**
 * Изолированный Fastify имеет свой root и session gate; production секретов нет.
 * Lifecycle доступен тесту напрямую для ручного tick и settings transaction.
 */
async function fixture(t, { enabled = true, settings = {}, realPlugins = false, realAuth = false,
  ...options } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-api-'));
  const repo = path.join(root, 'repo');
  const fake = await startFakeTripo();
  const server = Fastify({ logger: false });
  let active = enabled;
  let prefs = {
    autoImport: false,
    lowDiskGb: 10,
    libraryDir: '',
    ...settings
  };

  await fs.mkdir(repo);
  
  const prefsStore = {
    fail: false,
    value: { plugins: { studio3d: enabled }, pluginSettings: { studio3d: prefs } },
    read() {
      return this.value;
    },
    write(patch) {
      if (this.fail) {
        throw new Error('fixture-prefs-write');
      }
      
      this.value = { ...this.value, ...patch };
    },
  };

  if (!realPlugins) {
    server.decorate('pluginEnabled', (id) => id === 'studio3d' && active);
    server.decorate('pluginSettings', () => prefs);
  }
  
  server.decorate('sse', { broadcast() {} });
  
  if (realAuth) {
    await server.register(authPlugin, { authStore: {
      isConfigured: () => true, isValidSession: (id) => id === 'fixture-session',
    }, cliToken: 'fixture-cli-token' });
  } else {
    server.addHook('onRequest', async (request, reply) => {
    const kind = request.headers['x-fixture-auth'];

    if (!kind) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    request.authKind = kind;
  });
  }
  
  await server.register(multipart);

  if (realPlugins) {
    await server.register(pluginsModule, {
      config: { userPluginsDir: path.join(root, 'extensions') },
      prefs: prefsStore,
      prepareChange: (id, change) => id === 'studio3d' ? server.studio3d.prepareChange(change) : undefined,
    });
  }

  const reader = new DocumentReader({ rootProviders: [() => [{
    id: 'repo',
    label: 'Проект',
    path: repo
  }]] });
  const scopes = { chat: true, code: true };

  reader.addScopeProvider('chat', (id) => scopes.chat && id === 'fixture-chat'
    ? [{ path: path.join(root, 'chat-work'), label: 'Фикстура чата' }] : []);
  reader.addScopeProvider('code', (id) => scopes.code && id === 'fixture-project'
    ? [{ path: path.join(root, 'sandbox-worktree'), label: 'Песочница' }] : []);
  await server.register(studio3dModule, {
    config: {
      rootDir: root,
      studio3dDir: path.join(root, '3d'),
      dataStateDir: path.join(root, 'data/state'),
      mobileDir: path.join(root, 'data/mobile'),
      stateDir: path.join(root, '.state')
    },
    documentReader: reader,
    projects: () => ({
      list: async () => [{
        id: 'fixture-project',
        archived: false,
        repos: [{ key: 'main', dir: repo }]
      }],
      read: async () => ({ id: 'fixture-project', repos: [{ key: 'main', dir: repo }] })
    }),
    providers: [createTripoStudio({
      env: fake.env,
      baseUrl: fake.baseUrl,
      sleep: async () => {}
    })],
    download: (request) => downloadToFile({
      ...request,
      fetchImpl: fetch,
      sleep: async () => {}
    }),
    ...options
  });
  await server.ready();

  if (enabled) {
    // Старт библиотеки уходит в фон (AP-17): фикстура ждёт открытия контекста,
    // чтобы тесты начинались с готовой библиотекой, как в живом GrigDesk.
    for (let i = 0; i < 100 && !server.studio3d.context; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  t.after(async () => {
    await server.close();
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = (method, url, payload, auth = 'session', headers = {}) => server.inject({
    method,
    url: `/api/studio3d${url}`,
    payload,
    headers: {
      ...(auth && (realAuth ? auth === 'cli' ? { 'x-grigdesk-token': 'fixture-cli-token' }
        : { cookie: 'grigdesk_sid=fixture-session' } : { 'x-fixture-auth': auth })),
      ...headers
    }
  });

  return {
    root,
    repo,
    fake,
    server,
    scopes,
    prefsStore,
    plugin: (method, url, payload) => server.inject({
      method,
      url: `/api/plugins/studio3d${url}`,
      payload,
      headers: { 'x-fixture-auth': 'session' }
    }),
    call,
    libraryId: (await call('GET', '/state')).json().libraryId,
    change: async (values, nextEnabled = active, fail = false) => {
      const transition = await server.studio3d.prepareChange({ enabled: nextEnabled, values });

      if (fail) {
        await transition.rollback();

        throw new Error('fixture-prefs-write');
      }

      prefs = { ...prefs, ...values };
      active = nextEnabled;
      transition.commit();
      await transition.afterCommit();
    }
  };
}

/**
 * Multipart формируется без живого HTTP: Fastify inject получает тот же поток bytes.
 * Имя и Content-Type отдельно управляются для тестов подмены MIME и сигнатуры.
 */
async function upload(f, name = 'model.glb', bytes = makeGlb(), mime = 'model/gltf-binary') {
  const boundary = 'fixture-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="libraryId"\r\n\r\n` +
      `${f.libraryId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
      `filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  return f.call('POST', '/uploads', body, 'session',
    { 'content-type': `multipart/form-data; boundary=${boundary}` });
}

test('AP-01/14/15 disabled startup ничего не создаёт; auth и session gates явные', async (t) => {
  const f = await fixture(t, { enabled: false });

  assert.equal((await f.call('GET', '/state', undefined, null)).statusCode, 401);
  assert.equal((await f.call('GET', '/state')).json().error, 'plugin_disabled');
  await assert.rejects(fs.stat(path.join(f.root, '3d')));
  assert.equal(f.fake.requests.length, 0);
  await f.change({}, true);
  f.libraryId = (await f.call('GET', '/state')).json().libraryId;
  assert.equal((await f.call('POST', '/run', { libraryId: f.libraryId }, 'cli')).statusCode, 403);
});

test('AP-15 canonical protected libraryDir отклоняется до создания дочерней папки', async (t) => {
  const f = await fixture(t);
  const protectedRoot = path.join(f.root, '.state');
  const alias = path.join(f.root, 'alias');

  await fs.mkdir(protectedRoot);
  await fs.symlink(protectedRoot, alias);
  await assert.rejects(f.change({ libraryDir: path.join(alias, 'new-library') }),
    (error) => error.code === 'invalid_library_dir');
  assert.deepEqual(await fs.readdir(protectedRoot), []);
  assert.equal((await f.call('GET', '/state')).json().libraryId, f.libraryId);
});

test('AP-19 исчезнувший tmp при 200 state не закрывает библиотеку', async (t) => {
  const f = await fixture(t);
  const library = f.server.studio3d.context.library;
  const lstat = fs.lstat.bind(fs);
  let vanished = false;

  await fs.writeFile(path.join(library.dir, '.vanishing.tmp'), 'fixture');
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (String(file).endsWith('/.vanishing.tmp') && !vanished) {
      vanished = true;
      await fs.unlink(file);
    }

    return lstat(file, ...args);
  });

  const writing = (async () => {
    for (let turn = 0; turn < 200; turn += 1) {
      await library.persist(path.join(library.dir, 'race.json'), { turn });
    }
  })();

  try {
    for (let turn = 0; turn < 200; turn += 1) {
      const state = parseStudio3d.state((await f.call('GET', '/state')).json());

      assert.equal(state.library.ok, true, `state ${turn}`);
    }
  } finally {
    await writing;
  }

  assert.equal(vanished, true);
});

test('AP-20 разовая ошибка diskUsage не закрывает допуск раздела', async (t) => {
  const f = await fixture(t);
  const library = f.server.studio3d.context.library;
  const usage = library.diskUsage.bind(library);
  let fail = true;

  library.diskUsage = async () => {
    if (fail) {
      fail = false;

      throw Object.assign(new Error('fixture transient IO'), { code: 'EIO' });
    }

    return usage();
  };

  assert.equal((await f.call('GET', '/state')).json().library.ok, true);
  assert.equal((await f.call('GET', '/state')).json().library.ok, true);
});

test('AP-02/03/16 состояние и реальные upload проверяются, плохой файл не остаётся', async (t) => {
  const f = await fixture(t);
  const state = parseStudio3d.state((await f.call('GET', '/state')).json());

  assert.equal(state.library.ok, true);
  assert.deepEqual(state.providers.map((provider) => provider.id), ['tripo', 'local']);
  assert.equal(state.providers[0].balance.available, 100);
  assert.equal(parseStudio3d.upload((await upload(f)).json()).stats.triangles, 1);
  assert.equal(parseStudio3d.upload((await upload(f, 'pixel.png', PNG, 'image/png')).json()).width, 1);
  assert.equal((await upload(f, 'x.exe', PNG)).statusCode, 415);
  assert.equal((await upload(f, 'fake.png', Buffer.from('fake'), 'image/png')).statusCode, 415);
  assert.equal((await upload(f, 'pixel.png', PNG, 'image/jpeg')).statusCode, 415);
});

test('AP-04/05/13/19 offers, quote и run используют DTO и текущую libraryId', async (t) => {
  const f = await fixture(t);
  const offers = parseStudio3d.offers((await f.call('POST', '/offers', { libraryId: f.libraryId })).json());
  const quote = parseStudio3d.quote((await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Фикстура' }
  })).json());

  assert.equal(offers.offers.length > 0, true);

  const request = {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: quote.validation.values,
    expectedPrice: quote.quote.total
  };
  const result = await f.call('POST', '/run', request);

  assert.equal(result.statusCode, 202);
  
  const run = parseStudio3d.run(result.json());

  assert.equal(run.versions[0].status, 'waiting');
  await f.server.studio3d.context.jobs.tick();
  assert.equal(parseStudio3d.job((await f.call('GET', `/jobs/${run.intentId}?libraryId=${f.libraryId}`))
    .json()).children[0].status, 'queued');
  f.fake.setFile('generated.glb', makeGlb());
  f.fake.complete(fakeTaskId(1), { output: { model_url: f.fake.cdnUrl('generated.glb') }, credits: 20 });
  await f.server.studio3d.context.jobs.tick();
  await f.server.studio3d.context.jobs.settle();

  const ready = parseStudio3d.run((await f.call('POST', '/run', request)).json());
  const fileUrl = ready.versions[0].files[0].url;

  assert.equal((await f.call('GET', fileUrl.replace('/api/studio3d', ''))).statusCode, 200);
  
  const stale = await f.call('POST', '/run', { ...request, libraryId: crypto.randomUUID() });

  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'stale_library');
});

test('AP-06/07/08/09 файл создаёт отдельную модель, Range и save сверяют SHA', async (t) => {
  const f = await fixture(t);
  const input = parseStudio3d.upload((await upload(f)).json());
  const created = parseStudio3d.createdModel((await f.call('POST', '/models', {
    libraryId: f.libraryId,
    uploadId: input.uploadId,
    name: 'Свой объект'
  })).json());
  const model = parseStudio3d.model((await f.call('GET', `/models/${created.model.id}`)).json());
  const file = model.versions[0].files[0];
  const route = file.url.replace('/api/studio3d', '');

  assert.equal((await f.call('GET', route)).statusCode, 200);
  assert.equal((await f.call('GET', route, undefined, 'session', { range: 'bytes=0-3' })).statusCode, 206);
  assert.equal((await f.call('GET', route, undefined, 'session',
    { range: 'bytes=999999-' })).statusCode, 416);
  
  const saveRoute = `/models/${created.model.id}/versions/${created.version.id}/save`;
  const save = {
    libraryId: f.libraryId,
    projectId: 'fixture-project',
    repoKey: 'main',
    folder: 'models',
    fileName: 'fixture.glb'
  };

  const mislabeled = await f.call('POST', saveRoute, { ...save, fileName: 'fake.stl' });

  assert.equal(mislabeled.statusCode, 400);
  assert.equal(mislabeled.json().error, 'format_requires_export');
  assert.equal(await fs.stat(path.join(f.repo, 'models/fake.stl')).then(() => true, () => false), false);

  assert.equal((await f.call('POST', saveRoute, { ...save, folder: '../escape' })).statusCode, 400);
  assert.equal((await f.call('POST', saveRoute, save)).statusCode, 200);
  
  const exists = await f.call('POST', saveRoute, save);

  assert.equal(exists.statusCode, 409);
  assert.equal(exists.json().sha256, file.sha256);
  await fs.writeFile(path.join(f.repo, 'models/fixture.glb'), 'changed');
  assert.equal((await f.call('POST', saveRoute,
    {
      ...save,
      overwrite: true,
      expectedSha256: file.sha256
    })).statusCode, 409);
});

test('AP-11/14/17/19 viewer перепроверяет scope, соседей, identity и disable', async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.root, 'chat-work');

  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'model.gltf'), JSON.stringify({ asset: { version: '2.0' },
    buffers: [{ uri: 'data.bin', byteLength: 4 }] }));
  await fs.writeFile(path.join(dir, 'data.bin'), Buffer.from([1, 2, 3, 4]));
  
  const body = {
    libraryId: f.libraryId,
    path: path.join(dir, 'model.gltf'),
    scope: 'chat:fixture-chat'
  };

  assert.equal((await f.call('POST', '/viewer/resolve', { ...body, scope: '' })).statusCode, 403);
  
  const resolved = parseStudio3d.viewer((await f.call('POST', '/viewer/resolve', body)).json());
  const route = resolved.url.replace('/api/studio3d', '');

  assert.equal((await f.call('GET', route)).statusCode, 200);
  assert.equal((await f.call('GET', route.replace('model.gltf', 'data.bin'))).statusCode, 200);
  assert.equal((await f.call('GET', route, undefined, null)).statusCode, 401);
  assert.equal((await f.call('POST', '/models', body)).statusCode, 415);
  await fs.writeFile(path.join(dir, 'model.gltf'), 'changed');
  assert.equal((await f.call('GET', route)).statusCode, 404);
  await f.change({}, false);
  assert.equal((await f.call('GET', route)).statusCode, 404);
});

test('AP-14/17/19 scope revoke, expiry и библиотека вне GrigDesk не расширяют доступ', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  const directory = path.join(f.root, 'sandbox-worktree');
  const file = path.join(directory, 'fixture.glb');

  await fs.mkdir(directory);
  await fs.writeFile(file, makeGlb());
  assert.equal((await f.call('POST', '/viewer/resolve', { libraryId: f.libraryId,
    path: file })).statusCode, 403);
  
  const body = {
    libraryId: f.libraryId,
    path: file,
    scope: 'code:fixture-project'
  };
  const resolved = parseStudio3d.viewer((await f.call('POST', '/viewer/resolve', body)).json());
  const route = resolved.url.replace('/api/studio3d', '');

  assert.equal((await f.call('GET', route)).statusCode, 200);
  f.scopes.code = false;
  assert.equal((await f.call('GET', route)).statusCode, 404);
  assert.equal((await f.call('POST', '/models', body)).statusCode, 403);
  f.scopes.code = true;
  now += 3_600_001;
  assert.equal((await f.call('GET', route)).statusCode, 404);

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-outside-library-'));
  
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await f.change({ libraryDir: outside });
  f.libraryId = (await f.call('GET', '/state')).json().libraryId;
  
  const input = parseStudio3d.upload((await upload(f)).json());
  const created = parseStudio3d.createdModel((await f.call('POST', '/models', {
    libraryId: f.libraryId,
    uploadId: input.uploadId,
    name: 'Внешняя библиотека'
  })).json());

  const detail = parseStudio3d.model((await f.call('GET', `/models/${created.model.id}`)).json());

  assert.equal(detail.modelDirectory.startsWith(outside + path.sep), true);
  assert.equal((await f.call('GET', created.version.files[0].url.replace('/api/studio3d',
    ''))).statusCode, 200);
});

test('AP-15/18 library switch transaction rollback и busy не меняют старый контекст', async (t) => {
  const f = await fixture(t);
  const old = f.server.studio3d.context;

  await assert.rejects(f.change({ libraryDir: path.join(f.root, 'next') }, true, true), /prefs-write/);
  assert.equal(f.server.studio3d.context, old);
  assert.equal((await f.call('GET', '/state')).json().libraryId, f.libraryId);
  await f.change({ libraryDir: path.join(f.root, 'next') });
  
  const nextId = (await f.call('GET', '/state')).json().libraryId;

  assert.notEqual(nextId, f.libraryId);
  assert.equal((await f.call('POST', '/offers', { libraryId: f.libraryId })).statusCode, 409);
  f.libraryId = nextId;
  
  const quote = parseStudio3d.quote((await f.call('POST', '/quote', {
    libraryId: nextId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Фикстура' }
  })).json());

  await f.call('POST', '/run', {
    libraryId: nextId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: quote.validation.values,
    expectedPrice: quote.quote.total
  });
  await assert.rejects(f.change({ libraryDir: path.join(f.root, 'third') }),
    (error) => error.code === 'library_busy');
  assert.equal(f.server.studio3d.context.library.libraryId, nextId);
});

test('AP-05/16 ошибки цены и параметров возвращают closed payload без заказа', async (t) => {
  const f = await fixture(t);
  const request = {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Фикстура' },
    expectedPrice: 1
  };
  const changed = await f.call('POST', '/run', request);

  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error, 'price_changed');
  assert.equal(changed.json().quote.total > 1, true);

  const invalid = await f.call('POST', '/run', {
    ...request,
    values: { prompt: '' },
    expectedPrice: 30
  });

  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.json().validation.errors.some((item) => item.field === 'prompt'), true);
  assert.equal((await f.call('POST', '/quote', { ...request, extra: 'bad' })).statusCode, 400);
  assert.equal((await f.call('POST', '/offers', { libraryId: f.libraryId, uploads: {} })).statusCode, 400);
  assert.equal((await f.call('POST', '/offers', { libraryId: f.libraryId,
    versionId: 'outside' })).statusCode, 400);
  assert.equal(f.fake.requests.filter((item) => item.method === 'POST').length, 0);
});

test('AP-15/18 настоящие prefs hooks откатывают prepare и коммитят новую библиотеку', async (t) => {
  const f = await fixture(t, { realPlugins: true, enabled: false });

  assert.equal((await f.plugin('POST', '/toggle', { enabled: true })).statusCode, 200);

  const before = (await f.call('GET', '/state')).json();
  const old = f.server.studio3d.context;

  assert.equal(before.library.ok, true);
  f.prefsStore.fail = true;

  const next = path.join(f.root, 'next');
  const failure = await f.plugin('PUT', '/settings', {
    values: {
      libraryDir: next,
      autoImport: false,
      lowDiskGb: 10
    },
  });

  assert.equal(failure.statusCode, 500);
  assert.equal(f.server.studio3d.context, old);
  assert.equal((await f.call('GET', '/state')).json().libraryId, before.libraryId);
  f.prefsStore.fail = false;

  assert.equal((await f.plugin('PUT', '/settings', {
    values: {
      libraryDir: next,
      autoImport: false,
      lowDiskGb: 10
    },
  })).statusCode, 200);
  assert.notEqual((await f.call('GET', '/state')).json().libraryId, before.libraryId);
  assert.equal((await f.plugin('PUT', '/settings', { values: { libraryDir: '/' } })).statusCode, 409);
  assert.equal(f.prefsStore.value.pluginSettings.studio3d.libraryDir, next);
  assert.equal((await f.plugin('POST', '/toggle', { enabled: false })).statusCode, 200);
  assert.equal((await f.call('GET', '/state')).statusCode, 404);
});

test('AP-01/14 все ручки закрыты без auth и при выключенном плагине', async (t) => {
  const f = await fixture(t, { enabled: false, realAuth: true });
  const routes = [
    ['GET', '/state'], ['GET', '/models'], ['GET', '/models/fixture'], ['POST', '/models'],
    ['PATCH', '/models/fixture'], ['DELETE', '/models/fixture'],
    ['DELETE', '/models/fixture/versions/v01-fixture'],
    ...['lighten', 'redownload', 'retry', 'preview', 'save']
      .map((action) => ['POST', `/models/fixture/versions/v01-fixture/${action}`]),
    ['POST', '/models/fixture/versions/from-file'], ['GET', '/files/fixture/v01-fixture/model.glb'],
    ...['offers', 'quote', 'run', 'batches/quote', 'batches/run', 'uploads', 'scan', 'viewer/resolve']
      .map((url) => ['POST', `/${url}`]),
    ['GET', '/jobs/fixture'], ['GET', '/tasks'], ['POST', '/tasks/tripo/fixture/import'],
    ['POST', '/jobs/fixture/children/fixture/reconcile'],
    ['POST', '/jobs/fixture/children/fixture/close-unknown'],
    ['GET', '/viewer/file/fixture/model.glb'],
  ];

  for (const [method, url] of routes) {
    const unauthorized = await f.call(method, url, undefined, null);

    assert.equal(unauthorized.statusCode, 401, `${method} ${url} auth`);
    assert.equal(unauthorized.json().error, 'unauthorized', `${method} ${url} настоящий authPlugin`);
    assert.equal(unauthorized.headers['cache-control'], 'no-store');
    assert.equal(unauthorized.json().needsSetup, undefined);
    assert.equal((await f.call(method, url)).statusCode, 404, `${method} ${url} disabled`);
  }

  assert.equal(f.fake.requests.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, '3d')));
});

test('AP-15 lifecycle останавливает прежний importer и обновляет history без autoImport', async (t) => {
  const timers = [];
  const f = await fixture(t, {
    setHistoryTimer: (callback, delay) => {
      const timer = { callback, delay };
      
      timers.push(timer);
      
      return timer;
    },
    clearHistoryTimer: () => {},
  });
  const previous = f.server.studio3d.context.importer;
  const stop = previous.stop.bind(previous);
  let stopped = 0;

  previous.stop = async () => {
    stopped += 1;
    await stop();
  };
  await f.change({ lowDiskGb: 11 });
  assert.equal(stopped, 1);
  assert.equal(timers.length, 2);
  await timers.at(-1).callback();
  assert.equal(f.fake.requests.some((item) => item.path === '/v3/account/usage'), true);
  assert.equal(timers.at(-1).delay, 15 * 60_000);
});

test('AP-12 production authPlugin закрывает studio3d, тестовая cookie даёт session', async (t) => {
  const f = await fixture(t, { realAuth: true });

  assert.equal((await f.call('GET', '/state', undefined, null)).statusCode, 401);
  
  const authorized = await f.call('GET', '/state', undefined, null,
    { cookie: 'grigdesk_sid=fixture-session' });

  assert.equal(authorized.statusCode, 200);
  assert.equal(parseStudio3d.state(authorized.json()).library.ok, true);
});

test('AP-16 upload превышения и preview не оставляют мусор, типы не приводятся', async (t) => {
  const f = await fixture(t);
  const tooLarge = Buffer.alloc(20 * 1024 * 1024 + 1);

  PNG.copy(tooLarge);
  assert.equal((await upload(f, 'large.png', tooLarge, 'image/png')).statusCode, 413);
  assert.deepEqual(await fs.readdir(f.server.studio3d.context.library.uploadsDir()), []);
  assert.equal((await f.call('POST', '/viewer/resolve', {
    libraryId: f.libraryId, path: ['bad'],
  })).statusCode, 400);
  assert.equal((await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'local',
    operation: 'scale',
    values: { height: {} }
  })).statusCode, 400);
});

test('AP-17 GLB decoder и внешние ресурсы отклоняются до выдачи viewer token', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.repo, 'compressed.glb');

  await fs.writeFile(file, makeGlb({ extensionsUsed: ['KHR_draco_mesh_compression'] }));
  
  const response = await f.call('POST', '/viewer/resolve', { libraryId: f.libraryId, path: file });

  assert.equal(response.statusCode, 415);
  assert.equal(response.json().error, 'unsupported_decoder');
  assert.equal((await upload(f, 'compressed.glb', await fs.readFile(file))).statusCode, 415);
});

test('AP-10/19 batch и external import имеют closed DTO, child unknown требует точный адрес', async (t) => {
  const f = await fixture(t);
  const base = {
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Проверочная модель' },
    name: 'Проверочная модель',
    expectedPrice: 20,
    project: null,
    category: null
  };
  const quote = parseStudio3d.batchQuote((await f.call('POST', '/batches/quote', {
    libraryId: f.libraryId, rows: [base, { ...base, name: 'Вторая' }],
  })).json());
  const accepted = parseStudio3d.batchRun((await f.call('POST', '/batches/run', {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    snapshot: quote.snapshot,
    snapshotHash: quote.snapshotHash
  })).json());

  assert.equal(accepted.children.length, 2);
  
  const job = parseStudio3d.job((await f.call('GET', `/jobs/${accepted.children[0].intentId}`
    + `?libraryId=${f.libraryId}`)).json());

  assert.equal(job.children.length, 1);
  
  const missingChild = await f.call('POST', `/jobs/${job.intentId}/children/other/close-unknown`,
    { libraryId: f.libraryId });

  assert.equal(missingChild.statusCode, 404, missingChild.body);
  
  const foreignId = fakeTaskId(901);

  f.fake.setFile('external.glb', makeGlb());
  f.fake.tasks.set(foreignId, {
    task_id: foreignId,
    type: 'text_to_model',
    status: 'success',
    output: { model_url: f.fake.cdnUrl('external.glb') },
    credits_consumed: 18
  });
  f.fake.setUsage([{
    task_id: foreignId,
    type: 'text_to_model',
    credits_consumed: 18
  }]);
  
  const taskResponse = await f.call('GET', '/tasks?refresh=1');

  assert.equal(taskResponse.statusCode, 200, taskResponse.body);

  const tasks = parseStudio3d.tasks(taskResponse.json());

  assert.equal(tasks.external.some((item) => item.taskId === foreignId), true);
  
  const imported = parseStudio3d.imported((await f.call('POST', `/tasks/tripo/${foreignId}/import`,
    { libraryId: f.libraryId })).json());

  assert.equal(parseStudio3d.model((await f.call('GET', `/models/${imported.modelId}`)).json())
    .versions[0].status, 'ready');
  assert.equal(parseStudio3d.scan((await f.call('POST', '/scan', { libraryId: f.libraryId })).json())
    .partial, false);
});

test('AP-19 unknown закрывается и связывается вручную без второй оплаты', async (t) => {
  const f = await fixture(t);
  const quote = parseStudio3d.quote((await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Неизвестный исход' }
  })).json());
  
  f.fake.dropOnce('POST', /text-to-model/);
  
  const run = parseStudio3d.run((await f.call('POST', '/run', {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: quote.validation.values,
    expectedPrice: quote.quote.total
  })).json());

  await f.server.studio3d.context.jobs.tick();
  
  const job = parseStudio3d.job((await f.call('GET',
    `/jobs/${run.intentId}?libraryId=${f.libraryId}`)).json());
  const route = `/jobs/${run.intentId}/children/${job.children[0].childId}`;

  assert.equal(job.children[0].status, 'unknown');
  
  const closed = parseStudio3d.job((await f.call('POST', `${route}/close-unknown`,
    { libraryId: f.libraryId })).json());

  assert.equal(closed.children[0].status, 'unresolved');
  assert.equal(closed.children[0].paymentState, 'unknown');
  
  const taskId = fakeTaskId(905);
  
  f.fake.tasks.set(taskId, {
    task_id: taskId,
    type: 'text_to_model',
    status: 'queued'
  });
  
  const reconciled = parseStudio3d.job((await f.call('POST', `${route}/reconcile`,
    { libraryId: f.libraryId, taskId })).json());

  assert.equal(reconciled.children[0].taskId, taskId);
  assert.equal(f.fake.requests.filter((item) => item.path.endsWith('/text-to-model')).length, 1);
});

test('AP-18 disable во время бесплатного prepare запрещает последующий оплачиваемый POST', async (t) => {
  const f = await fixture(t);
  const provider = f.server.studio3d.context.providers[0];
  const original = provider.prepare.bind(provider);
  let release;
  let entered;
  const prepared = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  provider.prepare = async (...args) => {
    entered();
    await gate;
    
    return original(...args);
  };
  t.after(() => release());
  
  const quoted = parseStudio3d.quote((await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Проверка допуска' }
  })).json());

  await f.call('POST', '/run', {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: quoted.validation.values,
    expectedPrice: quoted.quote.total
  });
  
  const tick = f.server.studio3d.context.jobs.tick();

  await prepared;
  await f.change({}, false);
  release();
  await tick;
  await f.server.studio3d.context.jobs.settle();
  assert.equal(f.fake.requests.filter((item) => item.path.startsWith('/v3/generation/')).length, 0);
});

test('AP-24 кириллица и пробелы работают в incoming и папке сохранения', async (t) => {
  const f = await fixture(t);
  const uploaded = parseStudio3d.upload((await upload(f)).json());
  const created = parseStudio3d.createdModel((await f.call('POST', '/models', {
    libraryId: f.libraryId,
    uploadId: uploaded.uploadId,
    name: 'Исходный объект'
  })).json());
  const folder = (await f.call('GET', `/models/${created.model.id}`)).json().modelDirectory;

  await fs.writeFile(path.join(folder, 'incoming', 'Пётр высокий.glb'), makeGlb());

  const detail = (await f.call('GET', `/models/${created.model.id}`)).json();

  assert.deepEqual(detail.incoming, ['Пётр высокий.glb']);

  const imported = await f.call('POST', `/models/${created.model.id}/versions/from-file`, {
    libraryId: f.libraryId,
    incoming: 'Пётр высокий.glb'
  });

  assert.equal(imported.statusCode, 200);

  const saved = await f.call('POST', `/models/${created.model.id}/versions/${created.version.id}/save`, {
    libraryId: f.libraryId,
    projectId: 'fixture-project',
    repoKey: 'main',
    folder: 'assets/Персонажи',
    fileName: 'Пётр высокий.glb'
  });

  assert.equal(saved.statusCode, 200);
  assert.deepEqual(await fs.readFile(path.join(f.repo,
    'assets', 'Персонажи', 'Пётр высокий.glb')), makeGlb());
});

test('AP-25 превью 4 МиБ принимается, 6 МиБ отклоняется', async (t) => {
  const f = await fixture(t);
  const uploaded = parseStudio3d.upload((await upload(f)).json());
  const created = parseStudio3d.createdModel((await f.call('POST', '/models', {
    libraryId: f.libraryId,
    uploadId: uploaded.uploadId
  })).json());
  const route = `/models/${created.model.id}/versions/${created.version.id}/preview?libraryId=${f.libraryId}`;
  const image = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024 - PNG.length)]);
  const accepted = await f.call('POST', route, image, 'session', { 'content-type': 'image/png' });

  assert.equal(accepted.statusCode, 200);
  assert.equal(parseStudio3d.version(accepted.json()).files.find((file) => file.role === 'preview').size,
    image.length);

  const rejected = await f.call('POST', route, Buffer.alloc(6 * 1024 * 1024), 'session',
    { 'content-type': 'image/png' });

  assert.equal(rejected.statusCode, 413);
});

test('AP-06/08/09 модели, incoming, preview, SHA overwrite и delete работают через API', async (t) => {
  const f = await fixture(t);
  const source = path.join(f.repo, 'fixture.glb');

  await fs.writeFile(source, makeGlb());
  
  const created = parseStudio3d.createdModel((await f.call('POST', '/models', {
    libraryId: f.libraryId,
    path: source,
    name: 'Первый объект'
  })).json());
  const modelId = created.model.id;

  assert.equal((await f.call('PATCH', `/models/${modelId}`, {
    libraryId: f.libraryId,
    name: 'Синий объект',
    tags: ['sample'],
    notes: 'Проверенный файл'
  })).statusCode, 200);
  assert.equal(parseStudio3d.models((await f.call('GET', '/models?q=синий')).json()).total, 1);

  const folder = (await f.call('GET', `/models/${modelId}`)).json().modelDirectory;

  await fs.writeFile(path.join(folder, 'incoming/child.glb'), makeGlb({ triangles: 2 }));
  
  const child = parseStudio3d.version((await f.call('POST', `/models/${modelId}/versions/from-file`, {
    libraryId: f.libraryId,
    incoming: 'child.glb',
    parentVersionId: created.version.id,
    label: 'От агента'
  })).json());

  assert.equal(child.stats.triangles, 2);
  assert.equal((await f.call('DELETE', `/models/${modelId}/versions/${created.version.id}`
    + `?libraryId=${f.libraryId}`)).json().error, 'has_children');
  
  const versionRoute = `/models/${modelId}/versions/${child.id}`;
  const preview = await f.call('POST', `${versionRoute}/preview?libraryId=${f.libraryId}`, PNG, 'session',
    { 'content-type': 'image/png' });

  assert.equal(preview.statusCode, 200);
  assert.equal(parseStudio3d.version(preview.json()).preview.endsWith('.png'), true);
  
  const webp = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'image2pipe',
    '-vcodec', 'libwebp', 'pipe:1'], { input: PNG, timeout: 10_000 });
  const replaced = await f.call('POST', `${versionRoute}/preview?libraryId=${f.libraryId}`, webp, 'session',
    { 'content-type': 'image/webp' });

  assert.equal(replaced.statusCode, 200);
  assert.equal(parseStudio3d.version(replaced.json()).preview.endsWith('.webp'), true);
  assert.equal(replaced.json().files.filter((file) => file.role === 'preview').length, 1);
  assert.equal((await f.call('POST', `${versionRoute}/preview?libraryId=${f.libraryId}`,
    Buffer.alloc(5 * 1024 * 1024 + 1), 'session', { 'content-type': 'image/webp' })).statusCode, 413);

  const save = {
    libraryId: f.libraryId,
    projectId: 'fixture-project',
    repoKey: 'main',
    folder: 'models',
    fileName: 'saved.glb'
  };

  assert.equal(parseStudio3d.save((await f.call('POST',
    `${versionRoute}/save`, save)).json()).overwritten, false);
  
  const conflict = await f.call('POST', `${versionRoute}/save`, save);
  const overwrite = await f.call('POST', `${versionRoute}/save`, {
    ...save,
    overwrite: true,
    expectedSha256: conflict.json().sha256
  });

  assert.equal(overwrite.statusCode, 200);
  assert.equal(parseStudio3d.save(overwrite.json()).overwritten, true);

  const settings = await f.server.studio3d.context.library.settings();

  assert.equal(settings.saveFolders['fixture-project'].main, 'models');

  const remembered = parseStudio3d.model((await f.call('GET', `/models/${modelId}`)).json());

  assert.equal(remembered.saveFolders?.['fixture-project']?.main, 'models');
  assert.equal((await f.call('POST', `${versionRoute}/lighten`, { libraryId: f.libraryId })).statusCode, 200);
  assert.equal((await f.call('DELETE', `${versionRoute}?libraryId=${f.libraryId}`)).statusCode, 200);
  assert.equal((await f.call('DELETE', `/models/${modelId}?libraryId=${f.libraryId}`)).statusCode, 200);
  assert.equal((await f.call('GET', `/models/${modelId}`)).statusCode, 404);
});

/**
 * Настоящий authPlugin определяет платные ручки по матченному роуту Fastify.
 * Закодированная буква в адресе не должна обходить требование сессии человека.
 */
test('AP-14b настоящий authPlugin: закодированные платные ручки требуют сессию', async (t) => {
  const f = await fixture(t, { realAuth: true });
  const request = {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Фикстура' },
    expectedPrice: 30
  };
  const cli = { 'x-grigdesk-token': 'fixture-cli-token' };
  const routes = ['/ru%6E', '/batches/ru%6E', '/models/fixture/versions/v01-fixture/retr%79',
    '/jobs/fixture/children/fixture/reconcil%65', '/jobs/fixture/children/fixture/close-unknow%6E'];

  for (const route of routes) {
    const denied = await f.call('POST', route, request, null, cli);

    assert.equal(denied.statusCode, 403, route);
    assert.equal(denied.json().error, 'human_session_required', route);
  }

  for (const route of ['/run', '/batches/run']) {
    const allowed = await f.call('POST', route, request, null, { cookie: 'grigdesk_sid=fixture-session' });

    assert.notEqual(allowed.statusCode, 403, route);
    assert.notEqual(allowed.statusCode, 401, route);
  }
});

/**
 * Модель по видам из своих загрузок: роли загрузок заполняют context.views.
 * Без фронта требование вида остаётся, с фронтом и боком заказ проходит.
 */
test('AP-06b views из своих загрузок: offers, quote и run без ошибки вида', async (t) => {
  const f = await fixture(t);
  const front = (await upload(f, 'front.png', PNG, 'image/png')).json().uploadId;
  const left = (await upload(f, 'left.png', PNG, 'image/png')).json().uploadId;
  const both = [{ uploadId: front, role: 'front' }, { uploadId: left, role: 'left' }];

  const offers = parseStudio3d.offers((await f.call('POST', '/offers', {
    libraryId: f.libraryId,
    uploads: both
  })).json());
  const views = offers.offers.find((offer) => offer.operation === 'views-to-model');

  assert.equal(views?.available, true);

  const quote = await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'views-to-model',
    values: {},
    uploads: both
  });

  assert.equal(quote.statusCode, 200);
  assert.deepEqual(quote.json().validation.errors, []);

  const accepted = await f.call('POST', '/run', {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'views-to-model',
    values: {},
    uploads: both,
    expectedPrice: quote.json().quote.total
  });

  assert.equal(accepted.statusCode, 202);

  const rejected = await f.call('POST', '/run', {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'views-to-model',
    values: {},
    uploads: [{ uploadId: left, role: 'left' }],
    expectedPrice: quote.json().quote.total
  });

  assert.notEqual(rejected.statusCode, 202);
  assert.notEqual(rejected.json().error, undefined);
});

/**
 * Настоящий onReady не обязан ждать открытия библиотеки: медленный старт
 * уходит в фон, а app.ready() и весь сервер поднимаются без задержки.
 */
test('AP-17 start() дольше лимита Fastify не роняет app.ready()', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-boot-'));
  const fake = await startFakeTripo();
  const server = Fastify({ logger: false });

  t.after(async () => {
    await server.close();
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  server.decorate('pluginEnabled', (id) => id === 'studio3d');
  server.decorate('pluginSettings', () => ({}));
  server.decorate('sse', { broadcast() {} });

  const reader = new DocumentReader({ rootProviders: [] });

  await server.register(studio3dModule, {
    config: {
      rootDir: root,
      studio3dDir: path.join(root, '3d'),
      stateDir: path.join(root, '.state')
    },
    documentReader: reader,
    providers: [createTripoStudio({
      env: fake.env,
      baseUrl: fake.baseUrl,
      sleep: async () => {}
    })],
    download: (request) => downloadToFile({
      ...request,
      fetchImpl: fetch,
      sleep: async () => {}
    }),
  });

  const runtime = server.studio3d;
  const original = runtime.prepareChange.bind(runtime);
  let releaseStart = () => {};
  const gate = new Promise((resolve) => {
    releaseStart = resolve;
  });

  runtime.prepareChange = async (...args) => {
    await gate;

    return original(...args);
  };

  const outcome = await Promise.race([
    server.ready().then(() => 'ready'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);

  assert.equal(outcome, 'ready');

  releaseStart();

  for (let i = 0; i < 50 && !runtime.context; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.notEqual(runtime.context, null);
});

test('AP-05/14 502 preaccept, неизвестная цена, ключ и session gate не создают заказ', async (t) => {
  const f = await fixture(t);
  const provider = f.server.studio3d.context.providers.find((item) => item.id === 'tripo');
  const request = {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Фикстура' },
    expectedPrice: 30
  };

  for (const auth of ['cli', 'internal']) {
    for (const route of ['/run', '/batches/run', '/models/fixture/versions/v01-fixture/retry',
      '/jobs/fixture/children/fixture/reconcile', '/jobs/fixture/children/fixture/close-unknown']) {
      assert.equal((await f.call('POST', route, request, auth)).json().error, 'human_session_required');
    }
  }

  const quote = provider.quote.bind(provider);

  provider.quote = (...args) => ({
    ...quote(...args),
    total: null,
    usd: null
  });
  assert.equal((await f.call('POST', '/run', request)).json().error, 'price_unknown');
  provider.quote = quote;
  provider.available = () => false;
  assert.equal((await f.call('POST', '/run', request)).json().error, 'provider_unavailable');
  provider.available = () => true;
  provider.validate = () => { throw new ProviderFailure({
    kind: 'network',
    message: 'Безопасная ошибка фикстуры',
    detail: null
  }, false); };

  const failure = await f.call('POST', '/run', request);

  assert.equal(failure.statusCode, 502);
  assert.equal(failure.json().error, 'provider_error');
  assert.equal(failure.json().providerError.kind, 'network');
  assert.equal(f.fake.requests.filter((item) => item.method === 'POST').length, 0);
});

test('AP-02/07 state кеширует баланс, Range HEAD/suffix/If-Range сохраняют ETag', async (t) => {
  const f = await fixture(t, { statfs: async () => ({ bsize: 1024, bavail: 1 }) });
  const state = parseStudio3d.state((await f.call('GET', '/state')).json());

  assert.equal(state.library.freeBytes, 1024);
  assert.equal(state.library.lowDisk, true);
  assert.equal(f.fake.requests.filter((item) => item.path === '/v3/account/balance').length, 1);

  const created = parseStudio3d.createdModel((await f.call('POST', '/models', {
    libraryId: f.libraryId, uploadId: (await upload(f)).json().uploadId,
  })).json());
  const url = created.version.files[0].url.replace('/api/studio3d', '');
  const whole = await f.call('GET', url);
  const suffix = await f.call('GET', url, undefined, 'session', { range: 'bytes=-4' });
  const head = await f.call('HEAD', url);

  assert.equal(suffix.statusCode, 206);
  assert.equal(suffix.rawPayload.byteLength, 4);
  assert.equal(head.rawPayload.byteLength, 0);
  assert.equal(head.headers.etag, whole.headers.etag);
  assert.equal((await f.call('GET', url, undefined, 'session', {
    range: 'bytes=0-3', 'if-range': '"changed"',
  })).statusCode, 200);
  assert.equal((await f.call('GET', url, undefined, 'session', { range: 'bad' })).statusCode, 416);
  assert.equal((await f.call('GET', url.replace(/[^/]+$/, '..%2Fmodel.glb'))).statusCode, 400);
});

test('AP-10 известное списание собственного заказа считается один раз даже до poll cost', async (t) => {
  const f = await fixture(t);
  const body = {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Учёт расходов' }
  };
  const quoted = parseStudio3d.quote((await f.call('POST', '/quote', body)).json());
  const run = parseStudio3d.run((await f.call('POST', '/run', {
    ...body,
    idempotencyKey: crypto.randomUUID(),
    expectedPrice: quoted.quote.total
  })).json());

  await f.server.studio3d.context.jobs.tick();
  
  const job = parseStudio3d.job((await f.call('GET',
    `/jobs/${run.intentId}?libraryId=${f.libraryId}`)).json());

  f.fake.setUsage([{
    task_id: job.children[0].taskId,
    type: 'text_to_model',
    credits_consumed: 37,
    created_at: new Date().toISOString()
  }]);
  
  const tasks = parseStudio3d.tasks((await f.call('GET', '/tasks?refresh=1')).json());

  assert.equal(tasks.week.groups.find((group) => group.provider === 'tripo').actual, 37);
  assert.equal(tasks.week.groups.find((group) => group.provider === 'tripo').sectionActual, 37);
  assert.equal(tasks.week.groups.find((group) => group.provider === 'tripo').externalActual, 0);
  assert.equal(tasks.week.groups.find((group) => group.provider === 'tripo').reserved, 37);
  assert.equal(tasks.week.groups.find((group) => group.provider === 'tripo').unknownCount, 0);
  assert.equal(tasks.external.length, 0);
  assert.equal(tasks.active.length, 1);
  assert.equal(tasks.week.partial, true);

  const balanceView = parseStudio3d.state((await f.call('GET', '/state')).json()).providers[0].balance;

  assert.equal(balanceView.available, 63);
  assert.equal(balanceView.reserved, 37);

  const provider = f.server.studio3d.context.providers.find((item) => item.id === 'tripo');
  const reflected = await f.server.studio3d.context.jobs.balanceView(provider, provider.snapshot(),
    { available: 63, reserved: 37 });

  assert.deepEqual(reflected, { available: 63, reserved: 37 });

  f.fake.setFile('paid.glb', makeGlb());
  f.fake.complete(job.children[0].taskId, { output: { model_url: f.fake.cdnUrl('paid.glb') },
    credits: null });
  await f.server.studio3d.context.jobs.tick();
  await f.server.studio3d.context.jobs.settle();

  const completed = parseStudio3d.job((await f.call('GET',
    `/jobs/${run.intentId}?libraryId=${f.libraryId}`)).json());

  assert.equal(completed.children[0].actual, 37);
  assert.equal(completed.children[0].paymentState, 'charged');
});

test('AP-10 подтверждённая сумма удерживается до debit, а не прежняя оценка', async (t) => {
  const f = await fixture(t);
  const body = {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Резерв' }
  };
  const quoted = parseStudio3d.quote((await f.call('POST', '/quote', body)).json());
  const run = (await f.call('POST', '/run', {
    ...body,
    idempotencyKey: crypto.randomUUID(),
    expectedPrice: quoted.quote.total
  })).json();

  await f.server.studio3d.context.jobs.tick();
  
  const job = (await f.call('GET', `/jobs/${run.intentId}?libraryId=${f.libraryId}`)).json();

  f.fake.setUsage([{
    task_id: job.children[0].taskId,
    type: 'text_to_model',
    credits_consumed: 100 - quoted.quote.total + 1,
    created_at: new Date().toISOString()
  }]);
  await f.call('GET', '/tasks?refresh=1');
  await f.call('POST', '/run', {
    ...body,
    idempotencyKey: crypto.randomUUID(),
    expectedPrice: quoted.quote.total
  });
  await f.server.studio3d.context.jobs.tick();
  assert.equal(f.fake.requests.filter((item) => item.method === 'POST'
    && item.path.endsWith('/text-to-model')).length, 1);
});

test('AP-30 исчезнувшая активная папка становится library.ok=false без 500', async (t) => {
  const f = await fixture(t);

  await fs.rename(path.join(f.root, '3d'), path.join(f.root, 'lost-library'));

  const response = await f.call('GET', '/state');

  assert.equal(response.statusCode, 200);
  assert.equal(parseStudio3d.state(response.json()).library.ok, false);
});


test('S3D-DH библиотека не занимает состояние и мобильные ключи', async (t) => {
  const f = await fixture(t);

  for (const dir of ['data/state', 'data/mobile']) {
    await assert.rejects(f.change({ libraryDir: path.join(f.root, dir) }),
      (error) => error.code === 'invalid_library_dir');
  }

  await f.change({ libraryDir: path.join(f.root, 'data/3d') });
  assert.equal(f.server.studio3d.context.library.dir, path.join(f.root, 'data/3d'));
});
