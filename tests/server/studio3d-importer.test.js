import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseStudio3d } from '../../shared/studio3d/studio3dContracts.ts';
import { createLibrary } from '../../server/src/lib/studio3d/library.ts';
import { createImporter } from '../../server/src/lib/studio3d/importer.ts';
import { createTripoStudio } from '../../server/src/lib/tripo/studio.ts';
import { parseTripoTask } from '../../server/src/lib/tripo/catalog.ts';
import { downloadToFile } from '../../server/src/lib/studio3d/download.ts';
import { fakeTaskId, startFakeTripo } from './helpers/fakeTripo.js';
import { makeGlb, pngHeader, pngImage } from './helpers/studio3dGlb.js';

/**
 * Скану доступны только синтетические проекты, не GrigDesk и не домашняя папка.
 * Fake API и CDN позволяют доказать отсутствие сети при найденной копии.
 */
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-importer-'));
  const library = createLibrary({ dir: path.join(root, 'library') });
  const fake = await startFakeTripo();
  const provider = createTripoStudio({
    env: fake.env,
    baseUrl: fake.baseUrl,
    sleep: async () => {}
  });
  let downloads = 0;

  await library.ensure();

  const dependencies = {
    library,
    providers: [provider],
    roots: () => [root],
    now: () => Date.parse('2026-10-11T10:10:00Z'),
    download: (request) => {
      downloads += 1;

      return downloadToFile({
        ...request,
        fetchImpl: fetch,
        sleep: async () => {}
      });
    },
    ...options
  };
  const importer = createImporter(dependencies);

  t.after(async () => {
    await importer.stop();
    await library.close();
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    root,
    library,
    fake,
    provider,
    importer,
    dependencies,
    downloads: () => downloads
  };
}

/**
 * Запись соответствует raw API или официальному CLI конверту; номер синтетический.
 * Ассет записывается отдельно, preview без модели проверяется особым сценарием.
 */
async function record(f, folder, index, options = {}) {
  const directory = path.join(f.root, folder);
  const data = {
    task_id: fakeTaskId(index),
    type: options.type ?? 'text_to_model',
    status: 'success',
    input: options.input ?? { prompt: 'Синтетический объект' },
    output: options.output ?? {},
    credits_consumed: 35,
    created_at: options.noDates ? undefined : '2026-10-11T10:00:00Z',
    ...options.fields
  };

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify(options.cli
    ? { ...data, files: ['model.glb'] } : { code: 0, data }));

  if (options.model !== false) {
    await fs.writeFile(path.join(directory, 'model.glb'), makeGlb());
  }

  return data;
}

test('IM-01/02/05 scan склеивает CLI/raw, независимо копирует и повтор не дублирует', async (t) => {
  const f = await fixture(t);

  await record(f, 'petr/tripo/high', 1, { cli: true });
  await record(f, 'duplicate', 1);
  await record(f, 'node_modules/hidden', 2);
  await record(f, '.git/hidden', 3);

  const result = parseStudio3d.scan(await f.importer.scan());
  const entries = (await f.library.listModels()).entries;

  assert.equal(result.found, 2);
  assert.equal(result.imported, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].model.name, 'petr · high');
  assert.equal(entries[0].model.origin, 'import');
  assert.equal(entries[0].versions[0].cost.actual, 35);
  assert.equal(entries[0].versions[0].stats.triangles, 1);
  assert.equal(entries[0].versions[0].createdAt, '2026-10-11T10:00:00Z');
  assert.equal(entries[0].versions[0].accountKey, null);
  await fs.writeFile(path.join(f.root, 'petr/tripo/high/model.glb'), 'changed');
  
  const opened = await f.library.openVersionFile(entries[0].model.id,
    entries[0].versions[0].id, 'model.glb');

  assert.equal(opened.size > 20, true);
  await opened.handle.close();
  await f.importer.scan();
  assert.equal((await f.library.listModels()).entries.length, 1);
  assert.equal(f.downloads(), 0);
});

test('IM-03/04/10 DAG не зависит от дат и порядка, rig-check не создаёт версию', async (t) => {
  const f = await fixture(t);

  await record(f, 'a-child', 2, {
    type: 'animate_rig',
    input: {
      input: fakeTaskId(1),
      model: 'v2.0-20250506',
      rig_type: 'biped'
    },
    noDates: true
  });
  await record(f, 'z-parent', 1, { noDates: true });
  await record(f, 'check', 3, {
    type: 'animate_prerigcheck',
    input: { input: fakeTaskId(1) },
    output: { riggable: true, rig_type: 'biped' },
    model: false
  });

  await f.importer.scan();

  const entries = (await f.library.listModels()).entries;
  const parent = entries[0].versions.find((version) => version.task.id === fakeTaskId(1));
  const child = entries[0].versions.find((version) => version.task.id === fakeTaskId(2));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].versions.length, 2);
  assert.equal(child.parent, parent.id);
  assert.equal(child.params.rig_type, 'biped');
  assert.equal(parent.rigCheck.status, 'ready');
  assert.equal(parent.rigCheck.riggable, true);
});

test('IM-21 original_model_id связывает скелет и три движения с исходной моделью', async (t) => {
  const f = await fixture(t);

  await record(f, 'parent', 1);
  await record(f, 'rig', 2, {
    type: 'animate_rig',
    input: { original_model_id: fakeTaskId(1) }
  });

  for (const [offset, motion] of ['run', 'idle', 'walk'].entries()) {
    await record(f, `motion-${offset}`, offset + 3, {
      type: 'animate_retarget',
      input: {
        original_model_id: fakeTaskId(2),
        ...(offset === 1 ? { animations: [`preset:${motion}`] } : { animation: `preset:${motion}` })
      }
    });
  }

  await f.importer.scan();

  const entries = (await f.library.listModels()).entries;

  assert.equal(entries.length, 1);
  assert.equal(entries[0].versions.length, 5);

  const rig = entries[0].versions.find((version) => version.task.id === fakeTaskId(2));
  const motions = entries[0].versions.filter((version) => version.task.type === 'animate_retarget');

  assert.equal(motions.length, 3);
  assert.equal(motions.every((version) => version.parent === rig.id), true);
});

test('IM-22 PNG под webp импортируется как preview.png и image.png', async (t) => {
  const f = await fixture(t);
  const image = await pngImage();

  f.fake.setFile('rendered_image.webp', image);
  f.fake.setFile('model.glb', makeGlb());

  for (const [index, [type, role]] of [['text_to_model', 'preview'], ['text_to_image', 'image']].entries()) {
    const data = await record(f, `remote-${index}`, 40 + index, { type, model: false });

    f.fake.tasks.set(data.task_id, {
      ...data,
      output: type === 'text_to_model' ? {
        model_url: f.fake.cdnUrl('model.glb'),
        rendered_image_url: f.fake.cdnUrl('rendered_image.webp')
      } : { image_url: f.fake.cdnUrl('rendered_image.webp') }
    });

    const result = await f.importer.importTask('tripo', data.task_id);
    const version = (await f.library.readModel(result.modelId)).versions[0];
    const file = version.files.find((item) => item.role === role);

    assert.equal(version.status, 'ready');
    assert.equal(file?.name, `${role}.png`);
    assert.deepEqual(await fs.readFile(path.join(f.library.dir,
      result.modelId, version.id, file.name)), image);
  }
});

test('IM-09 explicit import дополняет unverified disk запись без native допуска', async (t) => {
  const f = await fixture(t);
  const data = await record(f, 'partial-disk', 21, { model: false });

  f.fake.setFile('model.glb', makeGlb());
  f.fake.tasks.set(data.task_id, {
    ...data, output: { model_url: f.fake.cdnUrl('model.glb') }
  });
  await f.importer.scan();
  
  const result = await f.importer.importTask('tripo', data.task_id);
  const model = await f.library.readModel(result.modelId);

  assert.equal(model.versions[0].status, 'ready');
  assert.equal(model.versions[0].accountKey, null);
  assert.equal(f.downloads(), 1);
  assert.equal(f.fake.requests.some((request) => request.method === 'POST'
    && request.path.startsWith('/v3/generation/')), false);
});

test('IM-10/11 preview-only остаётся remote; полный дубликат и поздний parent дополняют связь', async (t) => {
  const f = await fixture(t);

  await record(f, 'grinev-rig-c7d5a0ad', 2, {
    type: 'animate_rig',
    input: { input: fakeTaskId(1) },
    model: false
  });
  await fs.writeFile(path.join(f.root, 'grinev-rig-c7d5a0ad/preview.png'), pngHeader(2, 2));
  await f.importer.scan();

  const old = (await f.library.listModels()).entries[0];

  assert.equal(old.model.name, 'grinev-rig');
  assert.equal(old.versions[0].status, 'remote');
  assert.equal(old.versions[0].params.model, undefined);
  await record(f, 'full-child', 2, { type: 'animate_rig', input: { input: fakeTaskId(1) } });
  await record(f, 'late-parent', 1);
  await f.importer.scan();

  const entries = (await f.library.listModels()).entries;

  assert.equal(entries.length, 1);
  assert.equal(entries[0].versions.length, 2);
  assert.equal(entries[0].versions.find((v) => v.task.id === fakeTaskId(2)).status, 'ready');
});

test('IM-06/07/09 история накапливается; найденные файлы не скачиваются, autoImport управляем', async (t) => {
  const f = await fixture(t);
  const task = await record(f, 'disk', 1);

  f.fake.tasks.set(task.task_id, task);
  f.fake.setUsage([{
    task_id: task.task_id,
    type: task.type,
    credits_consumed: 35,
    created_at: task.created_at
  }]);
  await f.importer.scan();
  await Promise.all([f.importer.syncHistory({ autoImport: true }), f.importer.scan()]);
  assert.equal(f.downloads(), 0);
  assert.equal((await f.importer.externalTasks()).length, 0);
  f.fake.tasks.set(fakeTaskId(2), {
    task_id: fakeTaskId(2),
    type: 'text_to_model',
    status: 'success',
    output: { model_url: f.fake.cdnUrl('model.glb') }
  });
  f.fake.setFile('model.glb', makeGlb());
  f.fake.setUsage([{
    task_id: fakeTaskId(2),
    type: 'text_to_model',
    credits_consumed: 30
  }]);
  await f.importer.syncHistory({ autoImport: false });
  assert.equal((await f.importer.externalTasks()).length, 1);
  // Без даты списания второй заказ нельзя отнести к последним семи дням.
  // Он остаётся во внешнем списке, но не увеличивает точный недельный итог.
  assert.equal((await f.importer.week()).groups[0].actual, 35);
  await f.importer.importTask('tripo', fakeTaskId(2));
  assert.equal(f.downloads(), 1);
  assert.equal((await f.library.listModels()).entries.length, 2);
  assert.equal((await f.library.listModels()).entries.some((entry) => entry.model.origin === 'agent'), true);
});

test('IM-08/11 expired, exclusions, budgets и tombstone остаются видны', async (t) => {
  const f = await fixture(t, { limits: {
    entries: 30,
    depth: 8,
    deadlineMs: 20_000
  } });

  await record(f, 'chats/private', 4);
  await record(f, '.codex/private', 5);
  await record(f, 'real', 1);
  await fs.symlink(path.join(f.root, 'real'), path.join(f.root, 'alias'));
  await f.importer.scan();

  const model = (await f.library.listModels()).entries[0].model;

  await f.library.deleteModel(model.id);
  await f.importer.scan();
  assert.equal((await f.library.listModels()).entries.length, 0);
  f.fake.tasks.set(fakeTaskId(9), {
    task_id: fakeTaskId(9),
    type: 'text_to_model',
    status: 'expired'
  });
  f.fake.setUsage([{
    task_id: fakeTaskId(9),
    type: 'text_to_model',
    credits_consumed: 20
  }]);
  await f.importer.syncHistory({ autoImport: true });
  assert.match((await f.importer.externalTasks())[0].label, /удалил файлы/);
  await fs.mkdir(path.join(f.root, 'many'));
  await Promise.all(Array.from({ length: 40 }, (_, i) => fs.writeFile(path.join(f.root, 'many',
    `n${i}`), '')));
  assert.equal((await f.importer.scan()).partial, true);
});

test('IM-06 история не переносится на другой аккаунт при смене ключа во время await', async (t) => {
  const f = await fixture(t);
  const original = f.provider.history;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });

  f.fake.setUsage([{
    task_id: fakeTaskId(6),
    type: 'text_to_model',
    credits_consumed: 42
  }]);
  f.provider.history = async (captured) => {
    const result = await original(captured);

    entered();
    await held;

    return result;
  };

  const syncing = f.importer.syncHistory({ autoImport: true });

  await ready;
  f.fake.env.TRIPO_API_KEY = 'fixture-other-key';
  release();
  await syncing;
  assert.equal((await f.importer.externalTasks()).length, 0);
  assert.equal((await f.library.listModels()).entries.length, 0);
});

test('IM-04 проверка отсутствующего родителя учитывается skipped без модели', async (t) => {
  const f = await fixture(t);

  await record(f, 'orphan-check', 7, {
    type: 'animate_prerigcheck',
    input: { input: fakeTaskId(99) },
    output: { riggable: false },
    model: false
  });

  const result = await f.importer.scan();

  assert.equal(result.skipped, 1);
  assert.equal((await f.library.listModels()).entries.length, 0);
});

test('IM-11 remote сохраняет rig params и не переносит secret fields в provenance', async (t) => {
  const f = await fixture(t);
  const task = {
    task_id: fakeTaskId(8),
    type: 'animate_rig',
    status: 'success',
    input: {
      model: 'v2.0-20250506',
      rig_type: 'biped',
      api_key: 'fixture-secret'
    },
    output: { model_url: f.fake.cdnUrl('rig.glb') }
  };

  f.fake.tasks.set(task.task_id, task);
  f.fake.setFile('rig.glb', makeGlb());
  assert.equal(parseTripoTask(task).extra.params.api_key, undefined);
  await f.importer.importTask('tripo', task.task_id);

  const version = (await f.library.listModels()).entries[0].versions[0];

  assert.equal(version.params.model, 'v2.0-20250506');
  assert.equal(version.params.rig_type, 'biped');
  assert.equal(JSON.stringify(version).includes('fixture-secret'), false);
});

test('IM-19 поздний parent использует библиотечную копию после удаления исходника', async (t) => {
  const f = await fixture(t);

  await record(f, 'retained-child', 2, { type: 'animate_rig', input: { input: fakeTaskId(1) } });
  await f.importer.scan();
  await fs.unlink(path.join(f.root, 'retained-child/model.glb'));
  await record(f, 'retained-parent', 1);
  await f.importer.scan();

  const entries = (await f.library.listModels()).entries;
  const child = entries.flatMap((entry) => entry.versions)
    .find((version) => version.task.id === fakeTaskId(2));

  assert.equal(entries.length, 1);
  assert.equal(child.status, 'ready');
  assert.equal(child.files.some((file) => file.role === 'model'), true);
});

test('IM-23 поздний родитель сохраняет правки человека с объяснением', async (t) => {
  const fields = [
    { name: 'Имя человека' },
    { notes: 'Заметки человека' },
    { tags: ['важное'] },
    { category: 'character' },
    { project: 'demo' },
    { preview: true },
    { savedTo: true }
  ];

  for (const patch of fields) {
    const f = await fixture(t);

    await record(f, 'child', 2, { type: 'animate_rig', input: { original_model_id: fakeTaskId(1) } });
    await f.importer.scan();

    const original = (await f.library.listModels()).entries[0];
    const version = original.versions[0];

    if (patch.preview) {
      await f.library.writeVersionFile(original.model.id, version.id, 'preview.png', await pngImage(),
        { role: 'preview' });
    } else if (patch.savedTo) {
      await f.library.updateVersion(original.model.id, version.id, {
        savedTo: [{
          path: '/fixture/export.glb',
          sha256: 'a'.repeat(64),
          at: version.updatedAt
        }]
      });
    } else {
      await f.library.updateModel(original.model.id, patch);
    }

    const before = await f.library.readModel(original.model.id);

    await record(f, 'parent', 1);

    const result = await f.importer.scan();
    const after = await f.library.readModel(original.model.id);

    assert.deepEqual(after.model, before.model);
    assert.deepEqual(after.versions, before.versions);
    assert.equal(result.reasons.some((reason) => reason.includes('правки человека')), true);
    assert.equal((await f.library.listModels()).entries.length, 2);
  }
});

test('IM-24 соседняя модель с кириллицей и пробелом получает латинское имя в библиотеке', async (t) => {
  const f = await fixture(t);

  await record(f, 'unicode', 51, { model: false });
  await fs.writeFile(path.join(f.root, 'unicode', 'Пётр высокий.glb'), makeGlb());
  await f.importer.scan();

  const model = (await f.library.listModels()).entries[0];

  assert.equal(model.versions[0].status, 'ready');
  assert.equal(model.versions[0].files.find((file) => file.role === 'model').name, 'model.glb');
});

test('IM-25 автоскан хранит отметку в индексе, ручной скан работает после нового importer', async (t) => {
  let scans = 0;
  const f = await fixture(t);
  const roots = f.dependencies.roots;

  f.dependencies.roots = () => {
    scans += 1;

    return roots();
  };
  await record(f, 'first', 61);
  await f.importer.scan({ automatic: true });

  const firstScan = scans;

  await record(f, 'second', 62);

  const resumed = createImporter(f.dependencies);

  t.after(() => resumed.stop());
  await resumed.scan({ automatic: true });
  assert.equal(scans, firstScan);
  assert.equal((await f.library.listModels()).entries.length, 1);
  await resumed.scan();
  assert.equal((await f.library.listModels()).entries.length, 2);
  assert.equal(scans > firstScan, true);
});

test('IM-26 успешный CDN-импорт удаляет временную копию .jobs/imports', async (t) => {
  const f = await fixture(t);
  const data = await record(f, 'downloaded', 63, { model: false });

  f.fake.setFile('model.glb', makeGlb());
  f.fake.tasks.set(data.task_id, {
    ...data,
    output: { model_url: f.fake.cdnUrl('model.glb') }
  });

  const imported = await f.importer.importTask('tripo', data.task_id);
  const version = (await f.library.readModel(imported.modelId)).versions[0];

  assert.equal(version.status, 'ready');
  await assert.rejects(fs.stat(path.join(f.library.dir, '.jobs', 'imports', data.task_id)),
    { code: 'ENOENT' });

  const file = await f.library.openVersionFile(imported.modelId, version.id, 'model.glb');

  assert.equal(file.size > 20, true);
  await file.handle.close();
});

test('IM-20 malformed FBX не становится ready только по расширению', async (t) => {
  const f = await fixture(t);

  await record(f, 'invalid-fbx', 30, { model: false });
  await fs.writeFile(path.join(f.root, 'invalid-fbx/model.fbx'), 'not a model');
  await f.importer.scan();

  const versions = (await f.library.listModels()).entries.flatMap((entry) => entry.versions);

  assert.equal(versions.length, 1);
  assert.notEqual(versions[0].status, 'ready');
  assert.equal(f.fake.tasks.size, 0);
});
