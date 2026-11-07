import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify from '../../server/node_modules/fastify/fastify.js';

import { createReleaseServices } from '../../server/src/lib/releaseServices.ts';
import systemModule from '../../server/src/modules/system/index.ts';
import { auditStage } from '../../server/scripts/sea/stage.mts';
import { writeReleaseManifest } from '../../server/src/lib/releaseManifest.ts';

/**
 * Новый R без git и без D фиксирует ошибки до любых source-эффектов.
 * Единственные исходные файлы фикстуры — VERSION и проверяемый manifest.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-update-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'VERSION'), '1.2.3');

  const files = await auditStage(root, { required: ['VERSION'] });

  await writeReleaseManifest(root, {
    version: '1.2.3',
    runtime: {
      node: '24.21.0',
      abi: '137',
      platform: 'linux',
      arch: 'x64',
    },
    files,
  });

  return {
    root,
    rootDir: root,
    statePath: path.join(root, 'missing-data/update.json'),
  };
}

test('SEA-UPDATE-01: версия пакета без git, remote-check и recovery не создают состояние', async (t) => {
  const config = await fixture(t);
  const services = createReleaseServices({ ...config, kind: 'packaged' });
  const before = await readdir(config.root);

  services.releases.start();
  await services.updates.recover();

  const status = await services.releases.getStatus();
  const checked = await services.releases.checkRemote();

  assert.equal(status.running.version, '1.2.3');
  assert.equal(status.updateCapability.kind, 'package');
  assert.match(status.updateCapability.message, /Установите новый пакет GrigDesk/);
  assert.equal(status.canInstallRelease, false);
  assert.equal(status.canApplyCheckout, false);
  assert.equal(checked.running.version, '1.2.3');
  assert.equal(await services.updates.getJob(), null);
  assert.deepEqual(await readdir(config.root), before);
  services.releases.stop();
});

test('SEA-UPDATE-02: прямые apply/update получают ранний отказ и не создают job', async (t) => {
  const config = await fixture(t);
  const { updates } = createReleaseServices({ ...config, kind: 'packaged' });

  for (const call of [
    () => updates.startApply({ expectedCheckoutSha: 'bad', allowDirty: true }),
    () => updates.startUpdate({ expectedCheckoutSha: 'bad', targetTag: 'bad' }),
  ]) {
    await assert.rejects(call, { code: 'packaged_update_requires_package', statusCode: 409 });
  }

  assert.deepEqual((await readdir(config.root)).sort(), ['VERSION', 'release.json']);
});

test('SEA-UPDATE-03: сервер отвергает source-мутации до injected эффектов и восстановления', async (t) => {
  const config = await fixture(t);
  const effects = [];
  const record = (name) => async () => effects.push(name);
  const app = Fastify();

  t.after(() => app.close());
  await app.register(systemModule, {
    config: {
      rootDir: config.root,
      grigDeskUpdateStatePath: config.statePath,
      port: 9999,
      cliTokenPath: path.join(config.root, 'token'),
    },
    runtimeKind: () => 'packaged',
    system: { read: async () => ({}) },
    releases: {
      getStatus: async () => ({}),
      checkRemote: record('git'),
      start: record('timer'),
      stop: () => {},
    },
    updates: {
      startApply: record('apply'),
      startUpdate: record('update'),
      recover: record('recover'),
      assertIdle: record('idle'),
      getJob: async () => null,
    },
    webRebuilder: record('npm'),
  });

  for (const url of ['/api/system/apply', '/api/system/update', '/api/system/web-rebuild']) {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: {
        expectedCheckoutSha: 'a'.repeat(40),
        ...(url.endsWith('/update') ? { targetTag: 'v1.2.4' } : {}),
      },
    });

    assert.equal(response.statusCode, 409, url);
    assert.equal(response.json().error, 'packaged_update_requires_package', url);
  }

  // Packaged-модуль тоже запускает recover и фоновый таймер канала.
  assert.deepEqual(effects, ['recover', 'timer']);
  assert.equal((await readFile(path.join(config.root, 'VERSION'), 'utf8')), '1.2.3');
});
