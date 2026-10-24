import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createPluginRepo } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';
import {
  compatibleState, moduleRelease, moduleWarning, prepareModule,
} from './helpers/pluginModuleFixture.js';

for (const [hasModule, hasServer] of [[true, false], [false, false], [false, true], [true, true]]) {
  test(`AC4-MODULE-WARNING: module=${hasModule}, server=${hasServer}`, async (t) => {
    const repo = await createPluginRepo(t);
    const release = hasModule ? moduleRelease('1.0.0') : { manifest: { api: 2 }, files: {} };

    if (hasServer) {
      release.files['server.js'] = 'throw new Error("Не исполнять при подготовке");';
    }

    await repo.release('1.0.0', release);

    const { service, statePath } = await serviceFixture(t);
    const ready = await prepareModule(service, repo.url);

    assert.equal(ready.preview.hasServer, hasServer);
    assert.equal(ready.preview.hasWeb, hasModule);
    assert.equal(ready.preview.warnings.includes(moduleWarning), hasModule);
    assert.equal(ready.preview.warnings.includes('Код плагина выполняется с правами GrigDesk.'), hasServer);
    await compatibleState(statePath);
  });
}

for (const dir of ['web/ui', 'docs/ui']) {
  for (const change of ['update', 'move', 'remove']) {
    test(`AC5-MODULE-SENSITIVE: ${dir}, ${change}, включая удалённые ресурсы`, async (t) => {
      const repo = await createPluginRepo(t);
      const first = moduleRelease('1.0.0', dir);

      first.manifest.web = 'web';
      first.files[`${dir}/helper.txt`] = 'Первый helper';
      first.files['web/index.html'] = '<title>Первая страница</title>';
      first.files['docs/readme.md'] = 'Первый документ';
      await repo.release('1.0.0', first);

      const { service } = await serviceFixture(t);
      const initial = await prepareModule(service, repo.url);

      await service.apply(initial.id, initial.reviewToken);

      const nextDir = change === 'move' ? 'next-ui' : dir;
      const next = change === 'remove'
        ? { manifest: { api: 2 }, files: {} }
        : moduleRelease('1.1.0', nextDir);

      if (change !== 'update') {
        await rm(path.join(repo.work, dir), { recursive: true });
      }
      if (change !== 'remove') {
        next.files[`${nextDir}/helper.txt`] = 'Следующий helper';
      }

      next.manifest.web = 'web';
      next.files['web/index.html'] = '<title>Следующая страница</title>';
      next.files['docs/readme.md'] = 'Следующий документ';
      await repo.release('1.1.0', next);
      await service.startUpdate('demo');
      await service.whenIdle();

      const ready = await service.currentJob();

      assert.equal(ready.status, 'ready', JSON.stringify(ready.error));

      const sensitive = ready.preview.changes.sensitive;
      const dirs = change === 'move' ? [dir, nextDir] : [dir];

      for (const root of dirs) {
        for (const file of ['panel.js', 'panel.css', 'ru.json', 'en.json', 'helper.txt']) {
          assert.ok(sensitive.includes(`${root}/${file}`), `${root}/${file}`);
        }
      }

      assert.equal(sensitive.includes('web/index.html'), false);
      assert.equal(sensitive.includes('docs/readme.md'), false);
    });
  }
}

test('AC9-MODULE-FAILED-STATE: понятный manifest_invalid читается прежним disk validator', async (t) => {
  const repo = await createPluginRepo(t);
  const release = moduleRelease('1.0.0');

  release.manifest.webModule.entry = 'missing.js';
  await repo.release('1.0.0', release);

  const { service, statePath, root } = await serviceFixture(t);

  await service.startInstall({ url: repo.url });
  await service.whenIdle();

  const failed = await service.currentJob();

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'manifest_invalid');
  assert.match(failed.error.message, /webModule.*(?:ресурс|entry)/u);
  assert.equal(failed.error.message.includes(root), false);
  assert.equal(failed.error.message.includes(repo.root), false);
  assert.equal((await compatibleState(statePath)).job.error.code, 'manifest_invalid');
});
