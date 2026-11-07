import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createPluginEnvironment } from '../../server/src/lib/pluginEnvironment.ts';
import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import { acquireKernelFileLock } from '../../server/src/lib/kernelLock.ts';
import { studioPackageInput, studioPackageRepo } from './helpers/studio3dPackageRepo.js';
import {
  installedStudioFixture, installedUntil, installStudio, stageStudioUpdate, uploadInstalledGlb,
} from './helpers/studio3dInstalledFixture.js';
import { makeGlb } from './helpers/studio3dGlb.js';
import { fakeTaskId } from './helpers/fakeTripo.js';

const input = await studioPackageInput();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4kWL0HwAFtAJeHzr7ywAAAABJRU5ErkJggg==',
  'base64');

function packageTest(name, callback, options = {}) {
  return test(name, {
    ...options,
    skip: input === null && 'Нужен STUDIO3D_PACKAGE_DIR: absolute release export, не development.'
  }, callback);
}
/**
 * Связывает exact-export repo с настоящей isolated installer fixture.
 * Исходники P не собираются и не импортируются этим тестом.
 */

async function setup(t, options = {}) {
  const repo = await studioPackageRepo(t, input);
  const f = await installedStudioFixture(t, {
    createEnvironment: createPluginEnvironment, ...options
  });
  const boot = await f.boot();

  return {
    ...f,
    repo,
    boot,
    reboot: f.boot
  };
}

async function state(boot) {
  const response = await installedUntil(() => boot.call('GET', '/state'),
    (value) => value.statusCode === 200 && value.json().library.ok);

  return response.json();
}
/**
 * Применяет подготовленный реальным installer update по review token.
 * После него библиотека должна снова стать доступной через HTTP.
 */

async function updateAndApply(f) {
  const ready = await stageStudioUpdate(f.boot);

  assert.equal((await f.boot.service.apply(ready.id, ready.reviewToken)).status, 'done');
  await state(f.boot);

  return ready;
}
/**
 * Платный transport достигает только собственного fake API. Session создаёт UUID;
 * возвращаемое тело сохраняется для reboot и сверки единственной отправки.
 */
async function acceptCloud(f) {
  const quoted = await f.boot.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: {
      prompt: 'Только isolated package fixture'
    },
  });

  assert.equal(quoted.statusCode, 200, quoted.body);

  const quote = quoted.json();
  const request = {
    libraryId: f.libraryId,
    idempotencyKey: randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: quote.validation.values,
    expectedPrice: quote.quote.total,
  };
  const accepted = await f.boot.call('POST', '/run', request);

  assert.equal(accepted.statusCode, 202, accepted.body);
  await installedUntil(() => f.creates(), (requests) => requests.length === 1);

  return request;
}

for (const enabled of [true, false, undefined]) {
  packageTest(`PACKAGE16 install точного1.0.0 сохраняет prefs enabled=${enabled}`,
    async (t) => {
      const f = await setup(t, {
        enabled
      });

      assert.equal(f.probe.runtimePort.isLoaded('studio3d'), false);
      await installStudio(f.boot, f.repo);
      assert.deepEqual(await readFile(f.prefsPath), f.baselinePrefs);
      assert.equal(f.probe.runtimePort.isLoaded('studio3d'), enabled === true);

      const catalog = (await f.boot.request('GET', '/api/plugins')).json().plugins
        .filter((card) => card.id === 'studio3d');

      assert.equal(catalog.length, 1);
      assert.equal(catalog[0].system, false);
      assert.equal(catalog[0].enabled, enabled === true);
      assert.equal(catalog[0].values.libraryDir, f.libraryDir);
      assert.equal(catalog[0].values.lowDiskGb, 37);
      assert.equal(catalog[0].values.autoImport, false);

      if (enabled === true) {
        assert.equal((await state(f.boot)).libraryId, f.libraryId);
      }
      else {
        assert.equal((await f.boot.call('GET', '/state')).statusCode, 404);
        assert.equal(f.creates().length, 0);
      }

      assert.deepEqual(f.prefs.readStored().pluginPlacements.studio3d, {
        'provider.popover.after-bars': false
      });
    });
}

/**
 * Публичный generation URL восстанавливается из объявленного entry, без private runtime.
 * Все ui-файлы, включая shared chunks, проверяются по exact-export bytes.
 */
function payloadResources(card) {
  const declaration = input.manifest.entrypoints.web;
  const encoded = declaration.entry.split('/').map(encodeURIComponent).join('/');
  const prefix = card.entrypoints.web.entry.slice(0, -encoded.length);
  const resources = input.files.filter((file) => file.path.startsWith(declaration.dir + '/'))
    .map((file) => {
      const relative = file.path.slice(declaration.dir.length + 1);

      return [prefix + relative.split('/').map(encodeURIComponent).join('/'), file.path];
    });

  return [[card.icon, input.manifest.icon], ...resources];
}

packageTest('PACKAGE16 public icon/JS/background/CSS/ru/en защищены и совпадают с export bytes',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);

    const card = await f.boot.card();
    const resources = payloadResources(card);

    for (const [url, relative] of resources) {
      assert.equal((await f.boot.request('GET', url, undefined, null)).statusCode, 401);

      const response = await f.boot.request('GET', url);

      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      assert.deepEqual(response.rawPayload, await readFile(path.join(input.root, relative)));
    }
  });
packageTest('PACKAGE16 exact export upload/preview/HEAD/export/local ready notification без panel import',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);

    const upload = await uploadInstalledGlb(f.boot, f.libraryId);

    assert.equal(upload.statusCode, 200, upload.body);

    const created = await f.boot.call('POST', '/models', {
      libraryId: f.libraryId,
      uploadId: upload.json().uploadId,
      name: 'Package GLB',
    });

    assert.equal(created.statusCode, 200, created.body);

    const value = created.json();
    const detail = (await f.boot.call('GET', `/models/${value.model.id}`)).json();
    const file = detail.versions[0].files[0];
    const whole = await f.boot.request('GET', file.url);
    const head = await f.boot.request('HEAD', file.url, undefined, 'session', {
      range: 'bytes=-8'
    });

    assert.deepEqual(whole.rawPayload, makeGlb());
    assert.equal(head.statusCode, 206);
    assert.equal(head.headers['content-length'], '8');
    assert.equal(head.rawPayload.length, 0);

    const versionRoute = `/models/${value.model.id}/versions/${value.version.id}`;
    const preview = await f.boot.call('POST',
      `${versionRoute}/preview?libraryId=${f.libraryId}`, PNG, 'session', {
      'content-type': 'image/png'
    });

    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual((await f.boot.request('GET', preview.json().preview)).rawPayload, PNG);

    const saved = await f.boot.call('POST', `${versionRoute}/save`, {
      libraryId: f.libraryId,
      projectId: 'fixture',
      repoKey: 'main',
      folder: 'models',
      fileName: 'package.glb',
    });

    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(await readFile(path.join(f.projectDir, 'models/package.glb')), makeGlb());

    const base = {
      libraryId: f.libraryId,
      provider: 'local',
      operation: 'rotate',
      modelId: value.model.id,
      versionId: value.version.id,
      values: {
        turn: 'y90'
      }
    };
    const quote = (await f.boot.call('POST', '/quote', base)).json();
    const request = {
      ...base,
      idempotencyKey: randomUUID(),
      values: quote.validation.values,
      expectedPrice: quote.quote.total
    };

    assert.equal((await f.boot.call('POST', '/run', request)).statusCode, 202);

    const jobUrl = `/jobs/${request.idempotencyKey}?libraryId=${f.libraryId}`;
    const result = await installedUntil(() => f.boot.call('GET', jobUrl),
      (response) => response.statusCode === 200 && response.json().children[0].status === 'ready');
    const notifications = (await f.boot.request('GET', '/api/plugins/notifications')).json().plugins
      .find((plugin) => plugin.pluginId === 'studio3d').items;
    const notification = notifications.find((item) => item.dedupKey.includes(request.idempotencyKey));

    assert.ok(notification, result.body);
    assert.equal(notification.params.model, value.model.id);
    assert.equal(notification.id, `studio-${notification.params.version}`);
    assert.equal(Object.keys(notification.params).sort().join(','), 'model,version');
    assert.equal(f.creates().length, 0);
    // Actual PanelRoot consumption относится к browser части16; params assertion его не заменяет.
  });
packageTest('PACKAGE16 cli/internal/encoded paid route403, session fake POST ровно один',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);

    for (const auth of ['cli', 'internal']) {
      for (const suffix of ['/run', '/r%75n', '/batches/r%75n']) {
        assert.equal((await f.boot.call('POST', suffix, {}, auth)).statusCode, 403);
      }
    }

    assert.equal(f.creates().length, 0);

    const request = await acceptCloud(f);
    const replay = await f.boot.call('POST', '/run', request);

    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(f.creates().length, 1);
  });
packageTest('PACKAGE16 update generation/dependency/worker, rollback сохраняет UUID/prefs и POST0',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);

    const before = await f.boot.card();

    await updateAndApply(f);

    const after = await f.boot.card();
    const probe = (await f.boot.call('GET', '/fixture-generation')).json();
    const worker = fileURLToPath(probe.workerUrl);
    const ownGeneration = path.dirname(fileURLToPath(probe.entryUrl));

    assert.equal(probe.version, 'fixture-1.0.1');
    assert.equal(worker, path.join(ownGeneration, 'runtime/analysisWorker.mjs'));
    assert.notEqual(ownGeneration, path.join(f.config.userPluginsDir, 'studio3d'));
    assert.equal(probe.nodeExecutable, f.environment().nodeExecutable);
    assert.notEqual(after.entrypoints.web.entry, before.entrypoints.web.entry);
    assert.notEqual(after.entrypoints.web.background, before.entrypoints.web.background);
    assert.equal((await f.boot.request('GET', before.entrypoints.web.entry)).statusCode, 404);
    assert.equal((await f.boot.request('GET', before.entrypoints.web.background)).statusCode, 404);

    for (const [url] of payloadResources(before).filter(([url]) => url !== before.icon)) {
      assert.equal((await f.boot.request('GET', url)).statusCode, 404, url);
    }

    assert.equal(after.install.restartRequired, false);
    assert.equal((await state(f.boot)).libraryId, f.libraryId);
    assert.deepEqual(await readFile(f.prefsPath), f.baselinePrefs);

    const record = await f.boot.service.describe('studio3d');
    const reverted = await f.boot.service.rollback('studio3d', {
      requestId: randomUUID(),
      expectedRevision: record.revision,
      expectedPreviousDigest: record.previous.payloadDigest
    });

    assert.equal(reverted.status, 'done');
    assert.equal((await f.boot.call('GET', '/fixture-generation')).statusCode, 404);
    assert.equal((await state(f.boot)).libraryId, f.libraryId);
    assert.deepEqual(await readFile(f.prefsPath), f.baselinePrefs);
    assert.equal((await f.boot.request('GET', after.entrypoints.web.entry)).statusCode, 404);

    for (const [url] of payloadResources(after).filter(([url]) => url !== after.icon)) {
      assert.equal((await f.boot.request('GET', url)).statusCode, 404, url);
    }

    assert.equal(f.creates().length, 0);
  });
packageTest('PACKAGE16 active блокирует настоящий update/remove без смены digest',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);

    const request = await acceptCloud(f);

    await assert.rejects(f.boot.service.remove('studio3d'), {
      code: 'plugin_busy'
    });

    const ready = await stageStudioUpdate(f.boot);
    const before = (await f.boot.service.describe('studio3d')).payloadDigest;

    await assert.rejects(f.boot.service.apply(ready.id, ready.reviewToken), {
      code: 'plugin_busy'
    });
    assert.equal((await f.boot.service.describe('studio3d')).payloadDigest, before);
    assert.equal(f.creates().length, 1);
    // Отдельный ambiguous send проверяется в reboot-сценарии ниже, не называется active.
    const jobUrl = `/jobs/${request.idempotencyKey}?libraryId=${f.libraryId}`;

    assert.equal((await f.boot.call('GET', jobUrl)).statusCode, 200);
  });
packageTest('PACKAGE16 corrupt staging сохраняет установленный router и исходные данные',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);

    const ready = await stageStudioUpdate(f.boot);

    await writeFile(path.join(f.boot.service.workDir, 'jobs', ready.id, 'package/server.mjs'), 'изменён');
    await assert.rejects(f.boot.service.apply(ready.id, ready.reviewToken), {
      code: 'preview_stale'
    });
    assert.equal((await state(f.boot)).libraryId, f.libraryId);
    assert.equal((await f.boot.card()).version, '1.0.0');
    assert.deepEqual(await readFile(f.prefsPath), f.baselinePrefs);
  });
packageTest('PACKAGE16 boot-off→on/off, update off, removal освобождает настоящий flock',
  async (t) => {
    const f = await setup(t, {
      enabled: false
    });

    await installStudio(f.boot, f.repo);
    assert.equal(f.probe.runtimePort.isLoaded('studio3d'), false);
    assert.equal((await f.boot.toggle(true)).statusCode, 200);
    assert.equal((await state(f.boot)).libraryId, f.libraryId);
    assert.equal((await f.boot.toggle(false)).statusCode, 200);

    const ready = await stageStudioUpdate(f.boot);

    assert.equal((await f.boot.service.apply(ready.id, ready.reviewToken)).status, 'done');
    assert.equal((await f.boot.card()).enabled, false);
    assert.equal((await f.boot.toggle(true)).statusCode, 200);
    await state(f.boot);

    const worker = fileURLToPath((await f.boot.call('GET', '/fixture-generation')).json().workerUrl);
    const generation = path.dirname(path.dirname(worker));

    assert.equal((await f.boot.service.remove('studio3d')).restartRequired, false);
    assert.equal((await f.boot.call('GET', '/state')).statusCode, 404);
    assert.equal(existsSync(generation), false);
    assert.equal(f.prefs.readStored().pluginSettings.studio3d.libraryDir, f.libraryDir);

    const lock = await acquireKernelFileLock({
      lockPath: path.join(f.libraryDir, '.owner.lock'),
      mode: 'exclusive',
      timeoutMs: 100
    });

    await lock.release();
    assert.equal(JSON.parse(await readFile(path.join(f.libraryDir, '.library.json'), 'utf8')).libraryId,
      f.libraryId);
  });

for (const sending of [true, false]) {
  packageTest(`PACKAGE16 reboot durable ${sending ? 'sending' : 'accepted'} без duplicatePOST`,
    async (t) => {
      const f = await setup(t);

      await installStudio(f.boot, f.repo);
      await state(f.boot);

      const request = await acceptCloud(f);

      await f.boot.close();

      if (sending) {
        // Явный durable crash seed из настоящего принятого intent.
        // Он проверяет recovery, а не имитирует process-crash доказательство.
        const filename = path.join(f.libraryDir, '.jobs', request.idempotencyKey, 'intent.json');
        const intent = JSON.parse(await readFile(filename, 'utf8'));
        const child = intent.children[0];

        Object.assign(child, {
          stage: 'submitting',
          taskId: null,
          remote: null,
          status: 'running',
          paymentState: 'unknown',
          retryAt: null,
        });
        await writeFile(filename, JSON.stringify(intent) + '\n');
      }

      const reboot = await f.reboot();

      await state(reboot);

      const jobUrl = `/jobs/${request.idempotencyKey}?libraryId=${f.libraryId}`;
      const response = await installedUntil(() => reboot.call('GET', jobUrl),
        (value) => value.statusCode === 200 && (!sending || value.json().children[0].status === 'unknown'));

      assert.equal(response.statusCode, 200);
      assert.equal(f.creates().length, 1);
      assert.equal((await state(reboot)).libraryId, f.libraryId);

      if (sending) {
        assert.equal(response.json().children[0].status, 'unknown');

        await assert.rejects(reboot.service.remove('studio3d'), {
          code: 'plugin_busy'
        });

        const ready = await stageStudioUpdate(reboot);

        await assert.rejects(reboot.service.apply(ready.id, ready.reviewToken), {
          code: 'plugin_busy'
        });
        assert.equal(f.creates().length, 1);
      }
      else {
        assert.equal(response.json().children[0].taskId, fakeTaskId(1));
      }
    });
}

packageTest('PACKAGE16 native derived stream удерживает replacement до собственного finish',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);
    await updateAndApply(f);
    await f.boot.app.listen({
      host: '127.0.0.1', port: 0
    });

    const address = f.boot.app.server.address();
    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${address.port}/api/ext/studio3d/fixture-stream`, {
        headers: f.boot.session
      }, resolve).once('error', reject);
    });

    response.resume();

    const record = await f.boot.service.describe('studio3d');

    try {
      await assert.rejects(f.boot.service.rollback('studio3d', {
        requestId: randomUUID(),
        expectedRevision: record.revision,
        expectedPreviousDigest: record.previous.payloadDigest
      }), {
        code: 'plugin_busy'
      });
      assert.equal(response.complete, false);
      assert.equal(response.destroyed, false);
      assert.equal((await f.boot.service.describe('studio3d')).payloadDigest, record.payloadDigest);
    }
    finally {
      for (const stream of f.streams) {
        stream.end();
      }
    }

    await installedUntil(() => response.complete, Boolean);

    const restored = await f.boot.service.rollback('studio3d', {
      requestId: randomUUID(),
      expectedRevision: record.revision,
      expectedPreviousDigest: record.previous.payloadDigest
    });

    assert.equal(restored.status, 'done');
  });
packageTest('PACKAGE16 derived onClose timeout не допускает swap, поздний cleanup восстанавливает router',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);
    await updateAndApply(f);

    let release;
    let entered = false;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const record = await f.boot.service.describe('studio3d');

    f.control.beforeClose = async () => {
      entered = true;
      await barrier;
    };

    const replacing = f.boot.service.rollback('studio3d', {
      requestId: randomUUID(),
      expectedRevision: record.revision,
      expectedPreviousDigest: record.previous.payloadDigest
    });

    try {
      await installedUntil(() => entered, Boolean, 7000);
      await assert.rejects(replacing, {
        code: 'plugin_busy'
      });
      assert.equal((await f.boot.service.describe('studio3d')).payloadDigest, record.payloadDigest);
      await assert.rejects(f.boot.service.remove('studio3d'), {
        code: 'plugin_busy'
      });
    }
    finally {
      f.control.beforeClose = null;
      release();
    }

    await state(f.boot);
    assert.equal((await f.boot.call('GET', '/fixture-generation')).json().version, 'fixture-1.0.1');
    assert.equal((await state(f.boot)).libraryId, f.libraryId);
  }, {
  timeout: 120000
});
packageTest('PACKAGE16 derived onClose error не меняет установленный digest',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);
    await updateAndApply(f);

    const record = await f.boot.service.describe('studio3d');

    f.control.expectedCloseError = /fixture-close-error/;
    f.control.beforeClose = async () => {
      throw new Error('fixture-close-error');
    };
    await assert.rejects(f.boot.service.rollback('studio3d', {
      requestId: randomUUID(),
      expectedRevision: record.revision,
      expectedPreviousDigest: record.previous.payloadDigest
    }));
    assert.equal((await f.boot.service.describe('studio3d')).payloadDigest, record.payloadDigest);
    assert.equal(f.prefs.readStored().pluginSettings.studio3d.libraryDir, f.libraryDir);
  });
packageTest('PACKAGE16 derived packaged child закрыт scope до удаления собственной ESM generation',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);
    await updateAndApply(f);

    const uploaded = await uploadInstalledGlb(f.boot, f.libraryId);

    assert.equal(uploaded.statusCode, 200, uploaded.body);

    const created = await f.boot.call('POST', '/models', {
      libraryId: f.libraryId,
      uploadId: uploaded.json().uploadId,
      name: 'Owned child',
    });

    assert.equal(created.statusCode, 200, created.body);

    const value = created.json();
    const generation = path.dirname(fileURLToPath((await f.boot.call('GET', '/fixture-generation'))
      .json().entryUrl));
    const base = {
      libraryId: f.libraryId,
      provider: 'local',
      operation: 'rotate',
      modelId: value.model.id,
      versionId: value.version.id,
      values: {
        turn: 'y90'
      }
    };
    const quoted = await f.boot.call('POST', '/quote', base);

    assert.equal(quoted.statusCode, 200, quoted.body);

    const quote = quoted.json();
    const flag = path.join(f.libraryDir, '.fixture-hold-worker');

    await writeFile(flag, 'derived fixture hold; not production worker behavior\n');
    assert.equal((await f.boot.call('POST', '/run', {
      ...base,
      idempotencyKey: randomUUID(),
      values: quote.validation.values,
      expectedPrice: quote.quote.total
    })).statusCode, 202);

    const pid = await installedUntil(() => readFile(flag + '.pid', 'utf8').catch(() => ''),
      (text) => /^\d+$/.test(text));

    assert.equal(existsSync(generation), true);
    assert.equal(existsSync(`/proc/${pid}`), true);
    await f.boot.close();
    assert.equal(existsSync(`/proc/${pid}`), false, 'onClose обязан дождаться собственного child exit');
    await assert.rejects(stat(generation), {
      code: 'ENOENT'
    });

    const lock = await acquireKernelFileLock({
      lockPath: path.join(f.libraryDir, '.owner.lock'),
      mode: 'exclusive',
      timeoutMs: 100
    });

    await lock.release();
  });
// Browser16 rows6/7 остаются отдельным настоящим background/PanelRoot harness.
// Fixture hold/stream/close hooks существуют только в derived temp1.0.1, не в exact release1.0.0.

// Исторический контракт каталога: выполняется только merge, старый product runtime не запускается.
const legacyCatalogue = {
  "sourceHead": "7b2b1f9a6946610637d96cfdd3ccef3c84812426",
  "sourceSha256": {
    "server/src/lib/pluginsRegistry.ts": "d6b6311e7758e858e0e5f7d897cba79739733e30df0922368defdcc931d36c8d",
    "server/src/modules/plugins/index.ts": "8de60db675262825d5fa006d447ce26f02e645dd998ecf8761f7fb12dd1d34a8"
  },
  "contract": "catalog = [...SYSTEM, ...scanUserPlugins(userPluginsDir)]; no old runtime executed",
  "legacySystemIds": [
    "video",
    "code",
    "analysis",
    "shelf",
    "inbox",
    "telegram",
    "github",
    "ssh",
    "db",
    "docker",
    "showcase",
    "studio3d",
    "usage-forecast"
  ]
};

/**
 * Снимок сравнивает bytes каждого обычного файла библиотеки, включая lock metadata.
 * Он снимается после close всех владельцев; remove не получает право менять данные.
 */
async function libraryBytes(directory) {
  const result = {};

  /**
   * Рекурсивно собирает только собственную библиотеку после close владельцев.
   * Ссылки и специальные файлы не выдаются за сохранённые данные.
   */
  async function visit(relative) {
    const absolute = path.join(directory, relative);

    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const filename = path.posix.join(relative, entry.name);

      if (entry.isDirectory()) {
        await visit(filename);
      } else {
        assert.equal(entry.isFile(), true);
        result[filename] = createHash('sha256').update(await readFile(path.join(directory, filename)))
          .digest('hex');
      }
    }
  }

  await visit('');

  return result;
}

packageTest('PACKAGE16 §3.4 ручной откат ядра: remove dormant package даёт один старый builtin',
  async (t) => {
    const f = await setup(t);
    const originalEnabled = f.prefs.readStored().plugins.studio3d;

    await installStudio(f.boot, f.repo);
    await state(f.boot);
    await updateAndApply(f);

    const request = await acceptCloud(f);

    await f.boot.close();

    const filename = path.join(f.libraryDir, '.jobs', request.idempotencyKey, 'intent.json');
    const intent = JSON.parse(await readFile(filename, 'utf8'));
    const versionId = intent.children[0].version.id;

    // Явный durable sending seed из принятого fake record, не доказательство process crash.
    Object.assign(intent.children[0], {
      stage: 'submitting',
      taskId: null,
      remote: null,
      status: 'running',
      paymentState: 'unknown',
      retryAt: null,
    });
    await writeFile(filename, JSON.stringify(intent) + '\n');

    const recovered = await f.reboot();

    await state(recovered);

    const jobUrl = `/jobs/${request.idempotencyKey}?libraryId=${f.libraryId}`;
    const unknown = await installedUntil(() => recovered.call('GET', jobUrl),
      (response) => response.statusCode === 200 && response.json().children[0].status === 'unknown');
    const mergedBefore = [...legacyCatalogue.legacySystemIds,
    ...(await scanUserPlugins(f.config.userPluginsDir, undefined, '1.0.0')).map((item) => item.id)];

    assert.equal(mergedBefore.filter((id) => id === 'studio3d').length, 2);
    assert.equal(unknown.json().children[0].versionId, versionId);
    assert.equal(f.creates().length, 1);
    assert.equal((await recovered.toggle(false)).statusCode, 200);
    await recovered.close();

    const eventsBefore = f.events.filter((item) => item.data.event === 'fixture-installed-runtime').length;
    const dormant = await f.reboot();

    assert.equal(f.probe.runtimePort.isLoaded('studio3d'), false);
    assert.equal((await dormant.call('GET', '/state')).statusCode, 404);
    assert.equal(f.events.filter((item) => item.data.event === 'fixture-installed-runtime').length,
      eventsBefore);

    const before = await libraryBytes(f.libraryDir);

    await dormant.service.remove('studio3d');
    await dormant.service.whenIdle();

    const currentJob = await dormant.service.currentJob();
    const installed = await dormant.service.listInstalled();
    const scanned = await scanUserPlugins(f.config.userPluginsDir, undefined, '1.0.0');
    const mergedAfter = [...legacyCatalogue.legacySystemIds, ...scanned.map((item) => item.id)];

    assert.equal(currentJob === null || ['done', 'failed', 'cancelled'].includes(currentJob.status), true);
    assert.equal(installed.studio3d, undefined);
    assert.equal(existsSync(path.join(f.config.userPluginsDir, 'studio3d')), false);
    assert.equal(scanned.some((item) => item.id === 'studio3d'), false);
    assert.equal(mergedAfter.filter((id) => id === 'studio3d').length, 1);
    assert.deepEqual(await libraryBytes(f.libraryDir), before);
    assert.equal(JSON.parse(await readFile(path.join(f.libraryDir, '.library.json'), 'utf8')).libraryId,
      f.libraryId);
    assert.equal(f.creates().length, 1);
    assert.equal(f.events.filter((item) => item.data.event === 'fixture-installed-runtime').length,
      eventsBefore);
    assert.equal(originalEnabled, true);
    assert.equal(f.prefs.readStored().plugins.studio3d, false);
    assert.deepEqual(f.prefs.readStored().pluginSettings.studio3d,
      JSON.parse(f.baselinePrefs).pluginSettings.studio3d);
    // Возврат enabled — отдельное ручное действие владельца прежнего ядра.
    // Старый продуктовый runtime в этом тесте не запускается.
  });

packageTest('PACKAGE16 accepted off заканчивается один раз; update/rollback сохраняют оплаченный UUID и cost',
  async (t) => {
    const f = await setup(t);

    await installStudio(f.boot, f.repo);
    await state(f.boot);

    const request = await acceptCloud(f);

    assert.equal((await f.boot.toggle(false)).statusCode, 200);
    f.fake.complete(fakeTaskId(1), { output: {}, credits: 13 });

    const filename = path.join(f.libraryDir, '.jobs', request.idempotencyKey, 'intent.json');
    const terminal = await installedUntil(async () => JSON.parse(await readFile(filename, 'utf8')),
      (record) => record.children[0].status === 'failed' && record.children[0].actual === 13);
    const child = terminal.children[0];

    assert.equal(child.actual, 13);
    assert.equal(child.paymentState, 'charged');
    assert.equal(f.creates().length, 1);
    assert.equal((await f.boot.call('GET', '/state')).statusCode, 404);

    await installedUntil(async () => {
      try {
        const lease = await acquireKernelFileLock({
          lockPath: path.join(f.libraryDir, '.owner.lock'),
          mode: 'exclusive',
          timeoutMs: 20,
        });

        await lease.release();

        return true;
      } catch (error) {
        if (error.code !== 'FILE_LOCK_TIMEOUT') {
          throw error;
        }

        return false;
      }
    }, Boolean);

    assert.equal((await f.boot.toggle(true)).statusCode, 200);
    assert.equal((await state(f.boot)).libraryId, f.libraryId);

    const confirmedPrefs = await readFile(f.prefsPath);
    const jobUrl = `/jobs/${request.idempotencyKey}?libraryId=${f.libraryId}`;
    const before = (await f.boot.call('GET', jobUrl)).json();
    const modelUrl = `/models/${terminal.modelId}`;
    const beforeModel = (await f.boot.call('GET', modelUrl)).json();
    const cost = beforeModel.versions.find((version) => version.id === child.version.id).cost;

    assert.equal(before.intentId, request.idempotencyKey);
    assert.equal(cost.actual, 13);
    await updateAndApply(f);

    const updated = (await f.boot.call('GET', jobUrl)).json();
    const updatedModel = (await f.boot.call('GET', modelUrl)).json();

    assert.equal(updated.intentId, request.idempotencyKey);
    assert.equal(updated.children[0].actual, 13);
    assert.equal(updated.children[0].versionId, child.version.id);
    assert.deepEqual(updatedModel.versions.find((version) => version.id === child.version.id).cost, cost);

    const record = await f.boot.service.describe('studio3d');

    assert.equal((await f.boot.service.rollback('studio3d', {
      requestId: randomUUID(),
      expectedRevision: record.revision,
      expectedPreviousDigest: record.previous.payloadDigest,
    })).status, 'done');
    await state(f.boot);

    const restored = (await f.boot.call('GET', jobUrl)).json();
    const restoredModel = (await f.boot.call('GET', modelUrl)).json();

    assert.equal(restored.intentId, request.idempotencyKey);
    assert.equal(restored.children[0].versionId, child.version.id);
    assert.equal(restored.children[0].actual, 13);
    assert.deepEqual(restoredModel.versions.find((version) => version.id === child.version.id).cost, cost);
    assert.equal(f.creates().length, 1);
    assert.deepEqual(await readFile(f.prefsPath), confirmedPrefs);
    assert.deepEqual(f.prefs.readStored().pluginSettings.studio3d,
      JSON.parse(f.baselinePrefs).pluginSettings.studio3d);
    assert.deepEqual(f.prefs.readStored().pluginPlacements.studio3d,
      JSON.parse(f.baselinePrefs).pluginPlacements.studio3d);
  });
