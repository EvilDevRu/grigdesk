import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishUiRelease, sealUiRelease, verifyUiRelease } from '../../desktop/src/uiRelease.ts';

/**
 * Каждый тест получает собственные исходники и каталог опубликованных версий.
 * Изменение рабочего файла моделирует пересборку без обращения к живому интерфейсу.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-release-'));
  const source = path.join(root, 'source');
  const releases = path.join(root, 'releases');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'index.html'), '<script src="./assets/app.js"></script>');
  await writeFile(path.join(source, 'assets/app.js'), 'export default 1;');

  return {
    root,
    source,
    releases,
  };
}

test('версия зависит от содержимого, опубликованные версии сосуществуют', async (t) => {
  const { source, releases } = await fixture(t);
  const first = await sealUiRelease(source);

  assert.deepEqual(await sealUiRelease(source), first);
  assert.deepEqual(await publishUiRelease(source, releases), first);
  await writeFile(path.join(source, 'assets/app.js'), 'export default 2;');

  const second = await sealUiRelease(source);

  assert.notEqual(second.id, first.id);
  await publishUiRelease(source, releases);
  await rm(source, { recursive: true });
  assert.deepEqual(await verifyUiRelease(path.join(releases, first.id)), first);
  assert.deepEqual(await verifyUiRelease(path.join(releases, second.id)), second);
});

test('конкурентная публикация принимает только целую идентичную версию', async (t) => {
  const { source, releases } = await fixture(t);
  const release = await sealUiRelease(source);
  const results = await Promise.all(Array.from({ length: 4 }, () => publishUiRelease(source, releases)));

  assert.ok(results.every((item) => item.id === release.id));
  assert.deepEqual(await verifyUiRelease(path.join(releases, release.id)), release);
});

test('повреждение опубликованного релиза не затирается новым запуском', async (t) => {
  const { source, releases } = await fixture(t);
  const release = await sealUiRelease(source);

  await publishUiRelease(source, releases);

  const target = path.join(releases, release.id, 'assets/app.js');

  await writeFile(target, 'повреждение');
  await assert.rejects(publishUiRelease(source, releases), /повреждены/);
  assert.equal(await readFile(target, 'utf8'), 'повреждение');
});

test('добавленные файлы, ссылки и выход из каталога отвергаются', async (t) => {
  const { source, releases } = await fixture(t);
  const release = await sealUiRelease(source);
  const extra = path.join(source, 'extra');

  await writeFile(extra, 'лишний файл');
  await assert.rejects(publishUiRelease(source, releases), /повреждены/);
  await rm(extra);
  await symlink('index.html', extra);
  await assert.rejects(publishUiRelease(source, releases), /ссылку/);
  await rm(extra);
  release.files[0].path = '../outside';
  await writeFile(path.join(source, 'release.json'), JSON.stringify(release));
  await assert.rejects(publishUiRelease(source, releases), /список ресурсов/);
});
