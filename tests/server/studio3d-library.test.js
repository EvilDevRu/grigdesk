import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createLibrary } from '../../server/src/lib/studio3d/library.ts';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Библиотека и все входы принадлежат отдельной временной папке теста.
 * Close освобождает только её owner lock до удаления синтетических данных.
 */
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-studio-library-'));
  let sequence = 0;
  const library = createLibrary({
    dir,
    ensureGitignore: true,
    now: () => Date.parse('2026-10-11T10:00:00Z'),
    randomHex: () => (++sequence).toString(16).padStart(4, '0'),
    ...options
  });

  await library.ensure();
  t.after(async () => {
    await library.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { dir, library };
}

test('LB-05 ensure сохраняет UUID, ignore по opt-in, модель имеет полную schema', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.createModel({ name: 'Пётр' });
  const json = JSON.parse(await fs.readFile(path.join(dir, model.id, 'model.json'), 'utf8'));

  assert.equal(model.id, 'petr-0001');
  assert.deepEqual(json, model);
  assert.equal(json.schema, 1);
  assert.equal(json.notes, '');
  assert.equal(json.mainVersion, null);
  assert.equal(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), '*\n!.gitignore\n');

  const identity = JSON.parse(await fs.readFile(path.join(dir, '.library.json'), 'utf8'));

  assert.equal(identity.libraryId, library.libraryId);
  await library.ensure();
  assert.equal(library.libraryId, identity.libraryId);
});

test('LB-05 внешняя библиотека не получает gitignore без opt-in', async (t) => {
  const { dir } = await fixture(t, { ensureGitignore: false });

  await assert.rejects(fs.stat(path.join(dir, '.gitignore')));
});

test('LB-06 seq, folder и parent выделяются последовательно под lock', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.createModel({ name: 'Герой' });
  const first = await library.addVersion(model.id, { kind: 'model', operation: 'image-to-model' });
  const rest = await Promise.all([
    library.addVersion(model.id, { kind: 'model', parent: first.id }),
    library.addVersion(model.id, { kind: 'model', parent: first.id }),
  ]);

  assert.equal(first.id, 'v01-image-to-model-0002');
  assert.deepEqual(rest.map((version) => version.seq), [2, 3]);

  for (const version of [first, ...rest]) {
    const json = JSON.parse(await fs.readFile(path.join(dir, model.id, version.id, 'version.json'), 'utf8'));

    assert.equal(json.id, version.id);
  }

  assert.equal(rest[1].parent, first.id);
});

test('LB-07 двадцать updater-ов сохраняют независимые поля без временного мусора', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.createModel({ name: 'Запись' });
  const version = await library.addVersion(model.id, { kind: 'model' });

  await Promise.all(Array.from({ length: 20 }, (_, index) => library.updateVersion(model.id, version.id,
    (current) => ({ params: { ...current.params, [`field_${index}`]: index } }))));

  const entry = await library.readModel(model.id);

  assert.equal(Object.keys(entry.versions[0].params).length, 20);
  assert.equal((await fs.readdir(path.join(dir, model.id, version.id))).some((name) => name.endsWith('.tmp')),
    false);
});

test('LB-08 manifest ограничивает filePath, запись возвращает размер и SHA', async (t) => {
  const { library } = await fixture(t);
  const model = await library.createModel({ name: 'Файл' });
  const version = await library.addVersion(model.id, { kind: 'model' });
  const saved = await library.writeVersionFile(model.id, version.id, 'model.glb', Buffer.from('fixture'),
    { role: 'model' });

  assert.equal(saved.size, 7);
  assert.match(saved.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(await library.filePath(model.id, version.id, 'model.glb'), 'utf8'),
    'fixture');
  await assert.rejects(library.filePath(model.id, version.id, '../model.json'));
  await assert.rejects(library.filePath(model.id, version.id, 'version.json'));
  await assert.rejects(library.filePath(model.id, 'v99-file-abcd', 'model.glb'));
});

test('LB-09 copyIn независим от inode источника и отвергает правку при copy', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.createModel({ name: 'Копия' });
  const version = await library.addVersion(model.id, { kind: 'model' });
  const source = path.join(dir, 'source.glb');

  await fs.writeFile(source, 'source bytes');

  const saved = await library.copyIn(model.id, version.id, {
    sourceRoot: dir,
    source,
    name: 'model.glb',
    role: 'model'
  });

  await fs.writeFile(source, 'changed bytes');
  assert.equal(await fs.readFile(await library.filePath(model.id, version.id, 'model.glb'), 'utf8'),
    'source bytes');
  assert.equal(saved.size, 12);
  await assert.rejects(library.copyIn(model.id, version.id, {
    sourceRoot: dir,
    source,
    name: 'other.glb',
    role: 'model',
    beforePublish: () => fs.writeFile(source, 'second change')
  }));
  await assert.rejects(fs.stat(path.join(dir, model.id, version.id, 'other.glb')));
});

test('LB-10 parent с потомком не удаляется, основная выбирается после удаления', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.createModel({ name: 'Дерево' });
  const first = await library.addVersion(model.id, { kind: 'model', status: 'ready' });
  const child = await library.addVersion(model.id, {
    kind: 'model',
    parent: first.id,
    status: 'ready'
  });

  await library.updateModel(model.id, { mainVersion: child.id });
  await assert.rejects(library.deleteVersion(model.id, first.id), (error) => error.code === 'has_children');
  await library.deleteVersion(model.id, child.id);
  assert.equal((await library.readModel(model.id)).model.mainVersion, first.id);
  await library.deleteModel(model.id);
  await assert.rejects(fs.stat(path.join(dir, model.id)));
});

test('LB-11 lighten сохраняет preview и JSON, main требует force', async (t) => {
  const { library } = await fixture(t);
  const model = await library.createModel({ name: 'Облегчение' });
  const version = await library.addVersion(model.id, { kind: 'model', status: 'ready' });

  await library.writeVersionFile(model.id, version.id, 'model.glb', Buffer.from('model'), { role: 'model' });
  await library.writeVersionFile(model.id, version.id, 'base.glb', Buffer.from('base'),
    { role: 'base-model' });
  await library.writeVersionFile(model.id, version.id, 'preview.webp', Buffer.from('preview'),
    { role: 'preview' });
  await assert.rejects(library.lighten(model.id, version.id), (error) => error.code === 'main_version');
  assert.equal(await library.lighten(model.id, version.id, { force: true }), 9);

  const current = (await library.readModel(model.id)).versions[0];

  assert.equal(current.status, 'lightened');
  assert.deepEqual(current.files.map((file) => file.role), ['preview']);
  assert.equal(await fs.readFile(await library.filePath(model.id, version.id, 'preview.webp'), 'utf8'),
    'preview');
});

test('LB-12 список изолирует broken, incoming только модели, diskUsage включает скрытое', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.createModel({ name: 'Список' });

  await fs.mkdir(path.join(dir, 'broken-aaaa'));
  await fs.writeFile(path.join(dir, 'broken-aaaa', 'model.json'), '{broken');
  await fs.writeFile(path.join(dir, model.id, 'incoming', 'a.glb'), 'GLB');
  await fs.writeFile(path.join(dir, model.id, 'incoming', 'a.txt'), 'text');
  await fs.mkdir(path.join(dir, '.jobs', 'job-input'), { recursive: true });
  await fs.writeFile(path.join(dir, '.jobs', 'job-input', 'snapshot.png'), Buffer.alloc(2000));
  await fs.mkdir(path.join(dir, '.uploads', 'upload-one'), { recursive: true });
  await fs.writeFile(path.join(dir, '.uploads', 'upload-one', 'image.png.part'), Buffer.alloc(3000));

  const listing = await library.listModels();
  const usage = await library.diskUsage();

  assert.equal(listing.entries.length, 1);
  assert.deepEqual(listing.broken, ['broken-aaaa']);
  assert.deepEqual(await library.incoming(model.id), ['a.glb']);
  assert.equal(usage.bytes >= 5000, true);
  assert.equal(usage.inputBytes >= 2000, true);
  assert.equal(usage.temporaryBytes >= 3000, true);
  assert.equal(usage.bytes, usage.modelBytes + usage.inputBytes + usage.temporaryBytes);
});

test('LB-12 settings сохраняет независимые записи, uploads уборка уважает lease', async (t) => {
  const { dir, library } = await fixture(t);

  await Promise.all([
    library.saveSettings({ saveFolders: { projectA: { repoA: 'assets/characters' } } }),
    library.saveSettings({ saveFolders: { projectB: { repoB: 'assets/props' } } }),
  ]);
  assert.deepEqual((await library.settings()).saveFolders, {
    projectA: { repoA: 'assets/characters' },
    projectB: { repoB: 'assets/props' }
  });

  const uploadDir = path.join(dir, '.uploads', 'upload-one');

  await fs.mkdir(uploadDir);
  await fs.writeFile(path.join(uploadDir, 'image.png'), 'fixture');
  await fs.utimes(uploadDir, 1, 1);

  const release = library.leaseUpload('upload-one', 'fixture-job');

  await library.cleanUploads(86_400_000);
  assert.equal((await fs.stat(uploadDir)).isDirectory(), true);
  release();
  await library.cleanUploads(86_400_000);
  await assert.rejects(fs.stat(uploadDir));
});

test('LB-13 чужой parent/main, цикл, активная версия и вход под lease защищены', async (t) => {
  const { library } = await fixture(t);
  const first = await library.createModel({ name: 'Первая' });
  const other = await library.createModel({ name: 'Другая' });
  const firstVersion = await library.addVersion(first.id, { kind: 'model', status: 'ready' });

  await assert.rejects(library.addVersion(other.id, { kind: 'model', parent: firstVersion.id }));
  await assert.rejects(library.updateModel(other.id, { mainVersion: firstVersion.id }));

  const child = await library.addVersion(first.id, {
    kind: 'model',
    parent: firstVersion.id,
    status: 'ready'
  });

  await assert.rejects(library.updateVersion(first.id, firstVersion.id, { parent: child.id }));

  const release = library.leaseVersion(first.id, child.id, 'fixture-input');

  await assert.rejects(library.deleteModel(first.id), (error) => error.code === 'active_jobs');
  await assert.rejects(library.lighten(first.id, child.id, { force: true }),
    (error) => error.code === 'active_jobs');
  release();
  await library.updateVersion(first.id, child.id, { status: 'unknown' });
  await assert.rejects(library.deleteVersion(first.id, child.id), (error) => error.code === 'active_jobs');
});

test('LB-13 коллизия ID выделяет другое имя, битая schema не читается', async (t) => {
  const values = ['0001', '0001', '0002'];
  const { dir, library } = await fixture(t, { randomHex: () => values.shift() ?? '0003' });

  assert.equal((await library.createModel({ name: 'Имя' })).id, 'imya-0001');
  assert.equal((await library.createModel({ name: 'Имя' })).id, 'imya-0002');
  await fs.writeFile(path.join(dir, 'imya-0001', 'model.json'), JSON.stringify({
    schema: 99,
    id: 'imya-0001'
  }));
  await assert.rejects(library.readModel('imya-0001'));
});

test('LB-14 один owner в двух процессах, close освобождает тот же UUID, lost identity закрывает мутации',
  async (t) => {
    const { dir, library } = await fixture(t);
    const code = "import { createLibrary } from './server/src/lib/studio3d/library.ts'; "
      + 'const library = createLibrary({dir:process.env.STUDIO_FIXTURE_DIR,lockTimeoutMs:30}); '
      + 'try { await library.ensure(); console.log(library.libraryId); await library.close(); } '
      + 'catch(error) { console.log(error.code); process.exitCode=3; }';
    const launch = () => execute(process.execPath, ['--input-type=module', '-e', code], {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, STUDIO_FIXTURE_DIR: dir }
    });

    await assert.rejects(launch(), (error) => error.code === 3 && error.stdout.trim() === 'owner_busy');

    const identity = library.libraryId;

    await library.close();
    assert.equal((await launch()).stdout.trim(), identity);
    await library.ensure();
    await fs.unlink(path.join(dir, '.owner.lock'));
    await fs.writeFile(path.join(dir, '.owner.lock'), 'replacement');
    await assert.rejects(library.createModel({ name: 'Не писать' }), (error) => error.code === 'owner_lost');
  });

test('LB-13 manifest SHA отвергает правку файла той же длины', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.createModel({ name: 'Целостность' });
  const version = await library.addVersion(model.id, { kind: 'model' });

  await library.writeVersionFile(model.id, version.id, 'model.glb', Buffer.from('old bytes'));
  await fs.writeFile(path.join(dir, model.id, version.id, 'model.glb'), 'new bytes');
  await assert.rejects(library.filePath(model.id, version.id, 'model.glb'),
    (error) => error.code === 'changed');
});

test('LB-10 сбой durable смены main не удаляет текущую версию', async (t) => {
  let failing = false;
  const { dir, library } = await fixture(t, { beforePersist: async (file) => {
    if (failing && file.endsWith('/model.json')) {
      throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    }
  } });
  const model = await library.createModel({ name: 'Надёжность' });
  const first = await library.addVersion(model.id, { kind: 'model' });
  const current = await library.addVersion(model.id, { kind: 'model' });

  await library.updateModel(model.id, { mainVersion: current.id });

  failing = true;

  await assert.rejects(library.deleteVersion(model.id, current.id), (error) => error.code === 'ENOSPC');
  assert.equal((await fs.stat(path.join(dir, model.id, current.id))).isDirectory(), true);
  assert.equal((await library.readModel(model.id)).model.mainVersion, current.id);
  assert.equal(first.seq, 1);
});

test('JB-18 planned ID не публикует модель до intent, materialize сохраняет его при replay', async (t) => {
  const { dir, library } = await fixture(t);
  const model = await library.planModel({ name: 'План' });
  const planned = await library.planVersion(model, {
    kind: 'model',
    operation: 'text-to-model',
    status: 'waiting',
    intentId: '00000000-0000-4000-8000-000000000001',
    childId: 'child-1'
  });

  await assert.rejects(fs.stat(path.join(dir, model.id)));
  await library.materializeModel(model);
  await library.materializeVersion(model.id, planned);
  await library.materializeVersion(model.id, planned);

  const entry = await library.readModel(model.id);

  assert.equal(entry.versions.length, 1);
  assert.equal(entry.versions[0].id, planned.id);
  assert.equal(entry.versions[0].intentId, planned.intentId);
});

test('JB-18 двадцать planned seq не конфликтуют с обычным addVersion', async (t) => {
  const { library } = await fixture(t);
  const model = await library.createModel({ name: 'Резерв' });
  const planned = await Promise.all(Array.from({ length: 20 }, () => library.planVersion(model.id,
    { kind: 'model', status: 'waiting' })));
  const usual = await library.addVersion(model.id, { kind: 'model' });

  assert.equal(new Set(planned.map((version) => version.seq)).size, 20);
  assert.equal(usual.seq, 21);

  for (const version of planned) {
    await library.materializeVersion(model.id, version);
  }

  assert.equal((await library.readModel(model.id)).versions.length, 21);
});
