import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { PassThrough } from 'node:stream';

import { requireFromServer, writeHttpPlugin } from './helpers/pluginInstallHttpFixture.js';

import { runtimeFixture, settle } from './helpers/pluginRuntimeFixture.js';

for (const callback of [false, true]) {
  test(`LEG-0${callback ? 2 : 1}: прежние options и native root decorators`, async (t) => {
    const f = await runtimeFixture(t, [{ id: 'demo', callback }]);
    const record = f.probe.get('demo');
    const options = record.options;

    assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);
    assert.equal(options.config, f.config);
    assert.equal(options.prefs, f.prefs);
    assert.equal(options.plugin.id, 'demo');
    assert.equal(options.plugin.dir, `${f.config.userPluginsDir}/demo`);
    assert.equal(options.prefix, '/api/ext/demo');
    assert.equal(options.dataDir, `${f.config.userPluginsDataDir}/demo`);
    assert.equal(typeof options.lifecycle, 'object');
    assert.equal(record.scope.sse, f.app.sse);
    assert.equal(record.scope.studio3d, f.app.studio3d);
    assert.equal(record.scope.projects, f.app.projects);
    assert.equal(Boolean(record.done), callback);
  });
}

test('AUTH-01: session, CLI/internal, API/static и encoded API после off/on', async (t) => {
  const f = await runtimeFixture(t, [{ id: 'demo', web: true }]);

  for (const enabled of [true, false, true]) {
    assert.equal((await f.toggle('demo', enabled)).statusCode, 200);

    for (const url of ['/api/ext/demo/x', '/api/ext/demo/web/', '/api/ext/%64emo/x']) {
      assert.equal((await f.request('GET', url, undefined, {})).statusCode, 401);
    }

    if (!enabled) {
      continue;
    }

    assert.equal((await f.request('GET', '/api/ext/demo/human')).statusCode, 200);
    assert.equal((await f.request('GET', '/api/ext/demo/web/')).statusCode, 200);

    for (const headers of [
      { 'x-grigdesk-token': 'runtime-cli' },
      { 'x-grigdesk-internal': 'runtime-internal' },
    ]) {
      assert.equal((await f.request('GET', '/api/ext/demo/human', undefined, headers)).statusCode, 403);
    }
  }
});

test('LEG-03: выключение сохраняет loaded, отдельный router даёт lease через onClose', async (t) => {
  const f = await runtimeFixture(t);

  assert.equal((await f.toggle('demo', false)).statusCode, 200);
  assert.equal(f.port.runtime.isLoaded('demo'), true);

  const lease = await f.port.runtime.prepareReplace('demo', new AbortController().signal);

  await lease.finish('reverted');
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 404);
  assert.equal((await f.toggle('demo', true)).statusCode, 200);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);
});

for (const kind of ['hooks', 'legacy', 'static']) {
  test(`LIVE-01: ${kind}, API/страница off/on и уведомления реальной смены`, async (t) => {
    const calls = [];
    const hooks = kind === 'hooks' ? {
      onEnable: () => calls.push('enable'),
      onDisable: () => calls.push('disable'),
    } : {};
    const f = await runtimeFixture(t, [{
      id: 'demo',
      web: true,
      staticOnly: kind === 'static',
      hooks,
    }]);
    const urls = ['/api/ext/demo/web/', ...(kind === 'static' ? [] : ['/api/ext/demo/x'])];

    for (const url of urls) {
      assert.equal((await f.request('GET', url)).statusCode, 200);
    }

    for (const enabled of [false, false, true, true]) {
      const response = await f.toggle('demo', enabled);

      assert.equal(response.statusCode, 200);
      await settle();

      for (const url of urls) {
        const page = await f.request('GET', url);

        assert.equal(page.statusCode, enabled ? 200 : 404, url);

        if (!enabled) {
          assert.deepEqual(page.json(), { error: 'plugin_disabled', message: 'Плагин выключен.' });
        }
      }

      assert.equal((await f.card('demo')).needsRestart, false);
    }

    assert.deepEqual(calls, kind === 'hooks' ? ['disable', 'enable'] : []);
  });
}

/**
 * Настоящий TCP socket сохраняет auth и lifetime, как браузерный WebSocket.
 * injectWS не задаёт request.raw.socket, необходимый общему auth guard.
 */
async function socketAttempt(f) {
  const WebSocket = requireFromServer('ws');

  if (!f.app.server.listening) {
    await f.app.listen({ port: 0, host: '127.0.0.1' });
  }

  const address = `ws://127.0.0.1:${f.app.server.address().port}`;
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/api/ext/demo/socket`, {
    headers: f.session,
  });

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, status: 101 }));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve({ socket, status: response.statusCode });
    });
  });
}

test('LIVE-01: выключение сохраняет открытый WS, новый upgrade закрыт', async (t) => {
  const f = await runtimeFixture(t);
  const first = await socketAttempt(f);

  try {
    assert.equal(first.status, 101);
    assert.equal((await f.toggle('demo', false)).statusCode, 200);
    assert.equal(first.socket.readyState, 1);

    const second = await socketAttempt(f);

    second.socket.terminate();
    assert.equal(second.status, 404);
    assert.equal(first.socket.readyState, 1);
    await f.toggle('demo', true);
  } finally {
    first.socket.terminate();
  }
});

test('LIVE-02: dormant не импортируется, первое on сразу подключает сервер без рестарта', async (t) => {
  const f = await runtimeFixture(t, [{ id: 'demo' }], { prefs: { plugins: { demo: false } } });

  assert.equal(await f.imported('demo'), false);
  assert.equal((await f.card('demo')).needsRestart, false);

  const on = await f.toggle('demo', true);

  assert.equal(on.statusCode, 200);
  assert.equal(on.json().needsRestart, false);
  assert.equal(f.prefs.read().plugins.demo, true);
  assert.equal(await f.imported('demo'), true);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);
  assert.equal((await f.card('demo')).needsRestart, false);
  assert.equal((await f.toggle('demo', false)).json().needsRestart, false);
  assert.equal((await f.card('demo')).needsRestart, false);
});

test('LIVE-03: reverted replacement сохраняет off и loaded', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    hooks: { prepareReplace: async () => ({ async finish() {} }) },
  }]);

  await f.toggle('demo', false);

  const lease = await f.port.runtime.prepareReplace('demo', new AbortController().signal);

  await lease.finish('reverted');
  assert.equal(f.port.runtime.isLoaded('demo'), true);

  const response = await f.request('GET', '/api/ext/demo/x');

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'plugin_disabled');
  await f.toggle('demo', true);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);
});

for (const outcome of ['installed', 'blocked']) {
  test(`LIVE-04: ${outcome} сохраняет запись prefs, старый validator не вызывается`, async (t) => {
    let changes = 0;
    const f = await runtimeFixture(t, [{
      id: 'demo',
      manifest: { settings: [{
        key: 'name',
        type: 'text',
        default: 'до',
      }] },
      hooks: {
        prepareReplace: async () => ({ async finish() {} }),
        prepareChange: () => {
          changes += 1;

          throw new Error('Старый runtime не должен проверять новую версию');
        },
      },
    }]);
    const lease = await f.port.runtime.prepareReplace('demo', new AbortController().signal);

    await lease.finish(outcome);
    assert.equal((await f.toggle('demo', false)).statusCode, 200);
    assert.equal(f.prefs.read().plugins.demo, false);
    assert.equal((await f.settings('demo', { values: { name: 'после' } })).statusCode, 200);
    assert.equal(f.prefs.read().pluginSettings.demo.name, 'после');
    await f.toggle('demo', true);

    const response = await f.request('GET', '/api/ext/demo/x');

    assert.equal(response.statusCode, outcome === 'installed' ? 409 : 503);
    assert.equal(response.json().error,
      outcome === 'installed' ? 'plugin_restart_required' : 'recovery_required');
    assert.equal(changes, 0);

    if (outcome === 'installed') {
      assert.equal((await f.card('demo')).needsRestart, true);
    }
  });
}

test('LIVE-05: несовместимый api не обещает исправление перезапуском', async (t) => {
  const f = await runtimeFixture(t, [{ id: 'demo', manifest: { api: 99 } }]);

  assert.equal((await f.card('demo')).needsRestart, false);
  assert.equal(await f.imported('demo'), false);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 404);
});

test('HOT-ISOLATION: ошибка другого сервера не мешает загрузке включённой новой версии', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'broken',
    files: { 'server.js': 'export default async function plugin() { throw new Error("fixture"); }' },
  }], { prefs: { plugins: { broken: true, added: true } } });

  await writeHttpPlugin(f.config.userPluginsDir, 'added', {}, {
    'server.js': 'export default async function plugin(app) { app.get("/x", async () => ({ ok: true })); }',
  });
  await f.port.runtime.refresh();

  assert.equal((await f.card('broken')).needsRestart, true);
  assert.equal((await f.card('added')).needsRestart, false);
  assert.equal((await f.request('GET', '/api/ext/added/x')).statusCode, 200);
});

test('HOT-LOAD: первое on удерживает конкурентов, затем принимает multipart с исходным auth', async (t) => {
  let entered;
  let release;
  const registered = new Promise((resolve) => entered = resolve);
  const hold = new Promise((resolve) => release = resolve);
  const f = await runtimeFixture(t, [{
    id: 'demo',
    files: { 'server.js': [
      'export default async function plugin(app, options) {',
      '  const probe = app.runtimeProbe.get(options.plugin.id);',
      '  probe.entered();',
      '  await probe.hold;',
      '  app.post("/upload", async (request) => {',
      '    const file = await request.file();',
      '    return { body: (await file.toBuffer()).toString(), auth: request.authKind };',
      '  });',
      '}',
    ].join('\n') },
  }], { prefs: { plugins: { demo: false } } });

  Object.assign(f.probe.get('demo'), { entered, hold });

  const enabling = f.toggle('demo', true);

  try {
    await registered;
    assert.equal((await f.toggle('demo', false)).statusCode, 409);
    assert.equal((await f.settings('demo', { values: {} })).statusCode, 409);
    await assert.rejects(f.port.runtime.prepareReplace('demo', new AbortController().signal), {
      code: 'plugin_busy',
    });
    assert.equal(f.prefs.read().plugins.demo, false);
  } finally {
    release();
  }

  assert.equal((await enabling).json().needsRestart, false);

  const payload = '--fixture\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n'
    + 'Content-Type: text/plain\r\n\r\nФайл\r\n--fixture--\r\n';
  const response = await f.request('POST', '/api/ext/demo/upload', Buffer.from(payload), {
    ...f.session,
    'content-type': 'multipart/form-data; boundary=fixture',
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { body: 'Файл', auth: 'session' });
});

test('HOT-DRAIN: dispatch удерживает настоящий response до onClose и восстановления router', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    files: { 'server.js': [
      'export default async function plugin(app, options) {',
      '  const probe = app.runtimeProbe.get(options.plugin.id);',
      '  app.addHook("onClose", async () => probe.closed = true);',
      '  app.get("/x", async () => ({ ok: true }));',
      '  app.get("/held", async (_request, reply) => {',
      '    reply.type("text/plain").send(probe.stream);',
      '    probe.stream.write("held\\n");',
      '  });',
      '}',
    ].join('\n') },
  }]);
  const probe = f.probe.get('demo');

  probe.stream = new PassThrough();

  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const response = await new Promise((resolve, reject) => {
    http.get(`${address}/api/ext/demo/held`, { headers: f.session }, resolve).on('error', reject);
  });

  response.resume();

  const pending = f.port.runtime.prepareReplace('demo', new AbortController().signal);

  try {
    assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 409);
    assert.equal(probe.closed, undefined);
  } finally {
    probe.stream.end();
    await (await pending).finish('reverted');
  }

  assert.equal(probe.closed, true);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);
});
