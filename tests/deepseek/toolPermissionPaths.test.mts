import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { toolPermissionPathFacts } from '../../deepseek/src/host/toolPermissionPaths.mjs';

test('новый файл внутри workspace допустим, соседний префикс и .. остаются снаружи', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permission-path-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(toolPermissionPathFacts(root, 'src/new.ts').inside, true);
  assert.equal(toolPermissionPathFacts(root, 'src/new.ts').uncertain, false);
  assert.equal(toolPermissionPathFacts(root, '../outside').inside, false);
  assert.equal(toolPermissionPathFacts(root, `${root}-other/file`).inside, false);
  assert.equal(toolPermissionPathFacts(root, '.env.local').sensitive, true);
});

test('symlink перед .. и hardlink не скрывают внешний или чувствительный путь', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'permission-links-'));
  const root = path.join(parent, 'project');
  const external = path.join(parent, 'external', 'child');

  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.mkdir(root);
  await fs.mkdir(external, { recursive: true });
  await fs.symlink(external, path.join(root, 'link'));
  await fs.writeFile(path.join(root, '.env'), 'synthetic');
  await fs.link(path.join(root, '.env'), path.join(root, 'innocent'));

  assert.equal(toolPermissionPathFacts(root, 'link/../new').inside, false);
  assert.equal(toolPermissionPathFacts(root, 'link/../new').uncertain, true);
  assert.equal(toolPermissionPathFacts(root, 'innocent').uncertain, true);

  const before = toolPermissionPathFacts(root, 'link/file').fingerprint;

  await fs.unlink(path.join(root, 'link'));
  await fs.symlink(root, path.join(root, 'link'));
  assert.notEqual(toolPermissionPathFacts(root, 'link/file').fingerprint, before);
});
