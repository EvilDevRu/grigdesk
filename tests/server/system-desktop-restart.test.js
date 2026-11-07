import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import systemModule from '../../server/src/modules/system/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const UPDATE_JOB_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Подменяет режим, запуск скрипта, обновление и координатор остановки.
 * Даже старый модуль получает пустой временный корень без настоящего deploy/restart.sh.
 */
async function systemHarness(t, {
  mode = 'desktop',
  connected = true,
  authKind = 'cli',
  restarting = true,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-desktop-system-'));
  const app = Fastify({ logger: false });
  const begins = [];
  const scriptRoots = [];
  const shutdown = {
    active: false,
    async begin(...args) {
      begins.push(args);
    },
  };
  const updates = {
    async getJob() {
      return null;
    },
    async assertIdle() {},
    async isRestarting(jobId) {
      return restarting && jobId === UPDATE_JOB_ID;
    },
  };

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  app.decorate('shutdown', shutdown);
  app.addHook('onRequest', async (request) => {
    request.authKind = authKind;
  });

  await app.register(systemModule, {
    system: { read: () => ({}) },
    config: {
      rootDir: root,
      grigDeskUpdateStatePath: path.join(root, 'update.json'),
    },
    releases: {
      start() {},
      stop() {},
    },
    updates,
    serverMode: () => mode,
    restartViaScript: (rootDir) => scriptRoots.push(rootDir),
    desktop: {
      connected,
      bindShutdown() {},
    },
    webRebuilder: () => new Promise(() => {}),
  });
  await app.ready();

  return {
    app,
    root,
    begins,
    scriptRoots,
    updates,
    shutdown,
  };
}

test('DP-07 /api/system/server сообщает три режима и прежнее поле systemd', async (t) => {
  for (const mode of ['desktop', 'systemd', 'manual']) {
    const { app } = await systemHarness(t, { mode });
    const response = await app.inject('/api/system/server');
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.mode, mode);
    assert.equal(body.systemd, mode === 'systemd');
    assert.equal(typeof body.pid, 'number');
    assert.equal(typeof body.uptimeSec, 'number');
  }
});

test('DP-08 рестарт приложения отвечает сразу и через 400 мс начинает слив с кодом 75', async (t) => {
  const fixture = await systemHarness(t);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/system/restart',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    mode: 'desktop',
  });
  assert.deepEqual(fixture.begins, []);
  t.mock.timers.tick(399);
  assert.deepEqual(fixture.begins, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fixture.begins, [['кнопка «Перезапустить»', 75]]);
  assert.deepEqual(fixture.scriptRoots, []);
});

test('DP-09 отключённый IPC даёт 503 и не планирует остановку', async (t) => {
  const fixture = await systemHarness(t, { connected: false });

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/system/restart',
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: 'desktop_parent_unavailable',
    message: 'Приложение GrigDesk не на связи.',
  });
  t.mock.timers.tick(400);
  assert.deepEqual(fixture.begins, []);
  assert.deepEqual(fixture.scriptRoots, []);
});

test('DP-10 ручной режим вызывает порт скрипта, systemd начинает слив без кода', async (t) => {
  for (const mode of ['manual', 'systemd']) {
    await t.test(mode, async (part) => {
      const fixture = await systemHarness(part, { mode });

      part.mock.timers.enable({ apis: ['setTimeout'] });

      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/system/restart',
      });

      assert.deepEqual(response.json(), {
        ok: true,
        mode: mode === 'systemd' ? 'systemd' : 'script',
      });
      assert.deepEqual(fixture.begins, []);
      assert.deepEqual(fixture.scriptRoots, []);
      part.mock.timers.tick(400);

      if (mode === 'systemd') {
        assert.deepEqual(fixture.begins, [['кнопка «Перезапустить»']]);
        assert.deepEqual(fixture.scriptRoots, []);
      } else {
        assert.deepEqual(fixture.scriptRoots, [fixture.root]);
        assert.deepEqual(fixture.begins, []);
      }
    });
  }
});

test('DP-11 пересборка и обновление сохраняют прежний отказ 409', async (t) => {
  const fixture = await systemHarness(t);

  assert.equal((await fixture.app.inject({
    method: 'POST',
    url: '/api/system/web-rebuild',
  })).statusCode, 202);
  assert.equal((await fixture.app.inject({
    method: 'POST',
    url: '/api/system/restart',
  })).statusCode, 409);

  const updating = await systemHarness(t);

  updating.updates.assertIdle = async () => {
    throw Object.assign(new Error('Идёт обновление.'), {
      statusCode: 409,
      code: 'update_in_progress',
    });
  };

  assert.equal((await updating.app.inject({
    method: 'POST',
    url: '/api/system/restart',
  })).statusCode, 409);
  assert.deepEqual(fixture.begins, []);
  assert.deepEqual(updating.begins, []);
  assert.deepEqual(fixture.scriptRoots, []);
  assert.deepEqual(updating.scriptRoots, []);
});

test('UP-05 update-restart требует CLI-токен', async (t) => {
  const fixture = await systemHarness(t, { authKind: 'cookie' });
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/system/update-restart',
    payload: { jobId: UPDATE_JOB_ID },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'cli_token_required');
  assert.deepEqual(fixture.begins, []);
});

test('UP-06 update-restart проверяет режим, канал и состояние задания по порядку', async (t) => {
  for (const [options, code, error] of [
    [{ mode: 'manual' }, 409, 'not_desktop_mode'],
    [{ connected: false }, 503, 'desktop_parent_unavailable'],
    [{ restarting: false }, 409, 'update_job_mismatch'],
    [{}, 409, 'update_job_mismatch'],
  ]) {
    const fixture = await systemHarness(t, options);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/system/update-restart',
      payload: {
        jobId: Object.keys(options).length ? UPDATE_JOB_ID : '22222222-2222-4222-8222-222222222222',
      },
    });

    assert.equal(response.statusCode, code);
    assert.equal(response.json().error, error);
    assert.deepEqual(fixture.begins, []);
  }
});

test('UP-07 update-restart отвечает 202 и планирует один слив с кодом 75', async (t) => {
  const fixture = await systemHarness(t);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const request = {
    method: 'POST',
    url: '/api/system/update-restart',
    payload: { jobId: UPDATE_JOB_ID },
  };
  const response = await fixture.app.inject(request);

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { ok: true });
  t.mock.timers.tick(399);
  assert.deepEqual(fixture.begins, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fixture.begins, [['обновление GrigDesk', 75]]);

  fixture.shutdown.active = true;

  const repeated = await fixture.app.inject(request);

  assert.equal(repeated.statusCode, 202);
  assert.deepEqual(repeated.json(), {
    ok: true,
    already: true,
  });
  t.mock.timers.tick(400);
  assert.equal(fixture.begins.length, 1);

  for (const payload of [{ jobId: 'bad-id' }, { jobId: UPDATE_JOB_ID, extra: true }]) {
    assert.equal((await fixture.app.inject({
      ...request,
      payload,
    })).statusCode, 400);
  }
});
