import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify from '../../server/node_modules/fastify/fastify.js';
import systemModule from '../../server/src/modules/system/index.ts';

/**
 * Маршруты получают внедрённые сервисы и отдельную папку состояния.
 * Запуск задания проверяется без сетевого канала, смены файлов и перезапуска сервера.
 */
async function appFixture(t, kind) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-route-'));
  const app = Fastify();
  const calls = [];
  const job = {
    id: 'route-job',
    kind: 'package-update',
    status: 'downloading',
  };

  t.after(async () => {
    await app.close();
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  });
  await app.register(systemModule, {
    config: {
      rootDir: root,
      grigDeskUpdateStatePath: path.join(root, 'update.json'),
      port: 9999,
      cliTokenPath: path.join(root, 'token'),
    },
    runtimeKind: () => {
      return kind;
    },
    system: {
      read: async () => {
        return {};
      },
    },
    releases: {
      getStatus: async () => {
        return { running: { version: '0.2.0' } };
      },
      checkRemote: async () => {
        calls.push('check');

        return { updateAvailable: true };
      },
      start() {},
      stop() {},
    },
    updates: {
      async recover() {},
      async getJob() {
        return job;
      },
      async startPackageUpdate(body) {
        calls.push(body);

        return job;
      },
    },
  });

  return {
    app,
    calls,
    job
  };
}

test('PUR-1: packaged POST принимает подтверждение и GET сохраняет задание', async (t) => {
  const { app, calls, job } = await appFixture(t, 'packaged');
  const body = {
    expectedVersion: '0.3.0',
    expectedArchiveSha256: 'a'.repeat(64),
  };
  const started = await app.inject({
    method: 'POST',
    url: '/api/system/package-update',
    payload: body,
  });

  assert.equal(started.statusCode, 202);
  assert.deepEqual(calls, [body]);
  assert.deepEqual(started.json().job, job);

  const status = await app.inject('/api/system/version');
  const checked = await app.inject({
    method: 'POST',
    url: '/api/system/version/check'
  });

  assert.deepEqual(status.json().job, job);
  assert.deepEqual(checked.json().job, job);
  assert.equal(checked.json().updateAvailable, true);
  assert.equal(calls.at(-1), 'check');
});

test('PUR-2: source-установка запрещает package POST до менеджера', async (t) => {
  const { app, calls } = await appFixture(t, 'source');
  const result = await app.inject({
    method: 'POST',
    url: '/api/system/package-update',
    payload: {
      expectedVersion: '0.3.0',
      expectedArchiveSha256: 'a'.repeat(64),
    },
  });

  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error, 'packaged_update_requires_package');
  assert.deepEqual(calls, []);
});
