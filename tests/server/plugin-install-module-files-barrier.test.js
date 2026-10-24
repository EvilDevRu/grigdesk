import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createPluginRepo } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';
import { moduleRelease, prepareModule } from './helpers/pluginModuleFixture.js';

for (const file of ['panel.js', 'panel.css', 'ru.json']) {
  test(`AC10-UI-FILES-LOCAL: api1 обнаруживает ручную правку ${file}`, async (t) => {
    const repo = await createPluginRepo(t);
    const release = moduleRelease('1.0.0', 'web/ui');

    release.manifest = { api: 1, web: 'web' };
    release.files['web/index.html'] = '<title>Демо</title>';
    await repo.release('1.0.0', release);
    await repo.release('1.1.0', { ...release, files: moduleRelease('1.1.0', 'web/ui').files });

    let now = Date.now();
    const { service, pluginsDir } = await serviceFixture(t, { now: () => new Date(now) });
    const initial = await prepareModule(service, repo.url, { version: '1.0.0' });

    assert.equal((await service.apply(initial.id, initial.reviewToken)).status, 'done');
    assert.equal((await service.describe('demo')).localChanges, false);

    const target = path.join(pluginsDir, 'demo/web/ui', file);

    await writeFile(target, 'Ручные байты');
    now += 60_000;
    assert.equal((await service.describe('demo')).localChanges, true);
    await service.startUpdate('demo');
    await service.whenIdle();

    const failed = await service.currentJob();

    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'local_changes');
    assert.equal(await readFile(target, 'utf8'), 'Ручные байты');
  });
}
