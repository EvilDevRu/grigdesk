import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import { listFactoryProfiles, listProjects, profileHasCapability } from '../../server/src/lib/profiles.ts';

test('server discovers only directory-based profiles with graph.json', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-profiles-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const stateDir = path.join(root, 'state');

  await mkdir(path.join(profilesDir, 'factory-project'), { recursive: true });
  await mkdir(path.join(profilesDir, 'incomplete'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(profilesDir, 'factory-project', 'graph.json'), '{}\n');

  // Проект, заведённый в кокпите, живёт реестром prefs — каталога на диске у него нет.
  const prefs = { read: () => ({ projects: { 'cockpit-project': { repos: [] } } }) };

  assert.deepEqual(await listFactoryProfiles(profilesDir), ['factory-project']);
  assert.deepEqual(await listProjects({ profilesDir }, prefs), [
    'cockpit-project',
    'factory-project',
  ]);

  const adapter = new FactoryStateAdapter({ stateDir, profilesDir });
  assert.deepEqual(adapter.discoverProfiles(), ['factory-project']);
});

// Проверка жила в тесте плагина «Демо» (удалён вместе с плагином), а сама функция общая:
// по ней кокпит решает, предлагать ли профилю маршрут v2. Имя профиля приходит из запроса,
// поэтому «..» в нём обязано давать false, а не читать чужой graph.json.
test('capability читается только из валидного graph.json профиля', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-profile-capability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');

  await mkdir(path.join(profilesDir, 'capable'), { recursive: true });
  await mkdir(path.join(profilesDir, 'plain'), { recursive: true });
  await writeFile(path.join(profilesDir, 'capable', 'graph.json'), JSON.stringify({ capabilities: ['route-v2'] }));
  await writeFile(path.join(profilesDir, 'plain', 'graph.json'), JSON.stringify({ capabilities: [] }));

  assert.equal(await profileHasCapability(profilesDir, 'capable', 'route-v2'), true);
  assert.equal(await profileHasCapability(profilesDir, 'plain', 'route-v2'), false);
  assert.equal(await profileHasCapability(profilesDir, '../capable', 'route-v2'), false);
  assert.equal(await profileHasCapability(profilesDir, 'missing', 'route-v2'), false);
});
