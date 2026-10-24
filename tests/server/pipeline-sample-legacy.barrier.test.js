import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyResources } from '../../server/scripts/sea/resources.mts';
import { auditStage } from '../../server/scripts/sea/stage.mts';

/**
 * Барьер проверяет только прежние упаковщики и не зависит от новых fixtures образца.
 * Отдельный временный каталог позволяет прогнать его GREEN до любой реализации seed.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sample-legacy-barrier-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Пишет синтетический файл внутрь независимого каталога барьера.
 * Профили и пользовательские каталоги машины здесь не используются.
 */
async function put(root, relative, source) {
  const file = path.join(root, relative);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
}

test('SAMPLE-LEGACY-01: profiles и внешние ссылки запрещены независимо от seed', async (t) => {
  const root = await scratch(t);
  const source = path.join(root, 'source');
  const stage = path.join(root, 'stage');
  const links = path.join(root, 'links');

  await put(source, 'profiles/fixture/profile.sh', 'fixture');
  await put(stage, 'profiles/fixture/profile.sh', 'fixture');
  await assert.rejects(copyResources(source, stage, { schema: 1, entries: [{
    source: 'profiles/fixture',
    target: 'server/seed/sample',
    kind: 'dir',
  }] }), /Запрещ/);
  await assert.rejects(auditStage(stage, { required: [] }), /Запрещ|состав/);
  await mkdir(links);
  await symlink(source, path.join(links, 'outside-link'));
  await assert.rejects(copyResources(links, path.join(root, 'clean'), { schema: 1, entries: [{
    source: 'outside-link',
    target: 'server/seed/sample',
    kind: 'dir',
  }] }), /Ссылк|вид ресурса/);
});
