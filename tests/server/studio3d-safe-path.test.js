import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  insideRoot,
  isExternalName,
  isSafeName,
  openVerified,
  pinDirectory,
  safeCopy,
} from '../../server/src/lib/studio3d/safePath.ts';

test('LB-04 canonical root нельзя заменить ссылкой на новый корень перед открытием', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-root-swap-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');

  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'model.glb'), 'outside');
  await fs.rename(root, `${root}.old`);
  await fs.symlink(outside, root);
  await assert.rejects(openVerified(root, path.join(root, 'model.glb')));
  await assert.rejects(pinDirectory(root, root));
});

/**
 * Обе папки принадлежат одной изолированной фикстуре: «снаружи» не содержит живых файлов.
 * Подмены symlink и inode проверяют поведение операции копирования, а не её исходник.
 */
async function pathFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-studio-path-'));
  const root = path.join(dir, 'library');
  const outside = path.join(dir, 'outside');
  const source = path.join(root, 'model.glb');

  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(source, 'fixture bytes');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  return {
    root,
    outside,
    source
  };
}

test('LB-03 безопасное имя запрещает traversal, dotfile и кодированные пути', () => {
  assert.equal(isSafeName('model.glb'), true);

  for (const name of ['../x', 'a/b', '.hidden', '', 'a\0b', 'a'.repeat(122), 'a..b', '%2e%2e.glb']) {
    assert.equal(isSafeName(name), false, name);
  }
});

test('LB-03 внешнее имя допускает кириллицу, сохраняя запрет скрытого имени и traversal', () => {
  assert.equal(isExternalName('Пётр высокий.glb'), true);
  assert.equal(isExternalName('Персонажи'), true);

  for (const name of ['../x', 'a/b', 'a\\b', '.hidden', '', 'a\0b', 'a\nb', 'a..b']) {
    assert.equal(isExternalName(name), false, name);
  }

  assert.equal(isSafeName('Пётр высокий.glb'), false);
});

test('LB-04 realpath сравнивает сегменты и существующего предка', async (t) => {
  const { root, outside, source } = await pathFixture(t);

  await fs.symlink(outside, path.join(root, 'escape'));
  assert.equal(await insideRoot(root, source), true);
  assert.equal(await insideRoot(root, path.join(root, 'new', 'model.glb')), true);
  assert.equal(await insideRoot(root, path.join(root, '..', 'outside', 'model.glb')), false);
  assert.equal(await insideRoot(root, path.join(root, 'escape', 'model.glb')), false);
  assert.equal(await insideRoot(root, `${root}2/model.glb`), false);
});

test('LB-04b hardlink и symlink источника не копируются', async (t) => {
  const { root, outside, source } = await pathFixture(t);
  const linked = path.join(root, 'linked.glb');
  const dest = path.join(outside, 'copy.glb');

  await fs.link(source, linked);
  await assert.rejects(safeCopy({
    sourceRoot: root,
    source: linked,
    targetRoot: outside,
    target: dest
  }));
  await fs.unlink(linked);
  await fs.symlink(source, linked);
  await assert.rejects(safeCopy({
    sourceRoot: root,
    source: linked,
    targetRoot: outside,
    target: dest
  }));
  await assert.rejects(fs.stat(dest));
});

test('LB-04b подмена предка между resolve/open не читает внешний файл', async (t) => {
  const { root, outside } = await pathFixture(t);
  const original = path.join(root, 'nested');
  const parked = path.join(root, 'parked');
  const source = path.join(original, 'model.glb');
  const target = path.join(root, 'copy.glb');

  await fs.mkdir(original);
  await fs.writeFile(source, 'inside');
  await fs.writeFile(path.join(outside, 'model.glb'), 'outside');
  await assert.rejects(safeCopy({
    sourceRoot: root,
    source,
    targetRoot: root,
    target,
    beforeOpen: async () => {
      await fs.rename(original, parked);
      await fs.symlink(outside, original);
    }
  }));
  await assert.rejects(fs.stat(target));
});

test('LB-04b правка source во время copy отменяет публикацию', async (t) => {
  const { root, outside, source } = await pathFixture(t);
  const target = path.join(outside, 'copy.glb');

  await assert.rejects(safeCopy({
    sourceRoot: root,
    source,
    targetRoot: outside,
    target,
    beforePublish: async () => fs.writeFile(source, 'changed bytes')
  }));
  await assert.rejects(fs.stat(target));
});

test('LB-04b stream error сохраняет changed и закрывает descriptor единственным владельцем', async (t) => {
  const { root, outside, source } = await pathFixture(t);
  const target = path.join(outside, 'copy.glb');
  const original = fsModule.createReadStream;

  fsModule.createReadStream = (...args) => {
    const stream = original(...args);
    
    stream.once('data', () => fsModule.appendFileSync(source, 'grown during copy'));
    
    return stream;
  };
  syncBuiltinESMExports();
  
  try {
    await assert.rejects(safeCopy({
      sourceRoot: root,
      source,
      targetRoot: outside,
      target
    }),
      (error) => error.code === 'changed');
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    fsModule.createReadStream = original;
    syncBuiltinESMExports();
  }
});

test('LB-04b две публикации без overwrite атомарно создают один результат', async (t) => {
  const { root, outside, source } = await pathFixture(t);
  const target = path.join(outside, 'copy.glb');
  const options = {
    sourceRoot: root,
    source,
    targetRoot: outside,
    target
  };
  const results = await Promise.allSettled([safeCopy(options), safeCopy(options)]);

  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'fixture bytes');
});

test('LB-04b expectedSha256 не стирает файл, изменившийся после подтверждения', async (t) => {
  const { root, outside, source } = await pathFixture(t);
  const target = path.join(outside, 'copy.glb');
  const expectedSha256 = createHash('sha256').update('old bytes').digest('hex');

  await fs.writeFile(target, 'new human edit');
  await assert.rejects(safeCopy({
    sourceRoot: root,
    source,
    targetRoot: outside,
    target,
    overwrite: true,
    expectedSha256
  }), (error) => error.code === 'changed');
  assert.equal(await fs.readFile(target, 'utf8'), 'new human edit');
});

test('LB-04b подмена папки назначения до публикации не пишет наружу', async (t) => {
  const { root, outside, source } = await pathFixture(t);
  const directory = path.join(root, 'target');

  await fs.mkdir(directory);
  await assert.rejects(safeCopy({
    sourceRoot: root,
    source,
    targetRoot: root,
    target: path.join(directory, 'copy.glb'),
    beforePublish: async () => {
      await fs.rename(directory, path.join(root, 'parked'));
      await fs.symlink(outside, directory);
    }
  }));
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(path.join(root, 'parked')), []);
});

test('LB-04b expectedSha256 проверяется после copy, правка человека сохраняется', async (t) => {
  const { root, outside, source } = await pathFixture(t);
  const target = path.join(outside, 'copy.glb');
  const expectedSha256 = createHash('sha256').update('confirmed bytes').digest('hex');

  await fs.writeFile(target, 'confirmed bytes');
  await assert.rejects(safeCopy({
    sourceRoot: root,
    source,
    targetRoot: outside,
    target,
    overwrite: true,
    expectedSha256,
    beforePublish: async () => fs.writeFile(target, 'new human edit')
  }), (error) => error.code === 'changed');
  assert.equal(await fs.readFile(target, 'utf8'), 'new human edit');
});
