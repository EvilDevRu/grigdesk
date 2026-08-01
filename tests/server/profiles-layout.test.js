import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factory-state.js';
import { listFactoryProfiles, listProjects } from '../../server/src/lib/profiles.js';

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
