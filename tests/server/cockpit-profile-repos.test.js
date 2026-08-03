import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectRepos } from '../../server/src/lib/projects.js';

test('проект с техническими BE/FE-алиасами одного монорепозитория получает один собственный ключ', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-project-repos-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'cockpit');
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, 'profile.sh'),
    'PROFILE_TRIAGE_REPOS="be:/srv/cockpit fe:/srv/cockpit"\n',
  );

  const repos = await projectRepos({
    config: {
      factoryHome: root,
      profilesDir,
    },
    prefs: { read: () => ({ projects: {} }) },
    id: 'cockpit',
    isFactory: true,
  });

  assert.deepEqual(repos, [{
    key: 'cockpit',
    dir: '/srv/cockpit',
    from: 'factory',
  }]);
});

test('разные физические репозитории проекта сохраняют исходные ключи и порядок', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-project-repos-distinct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'multi');
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, 'profile.sh'),
    'PROFILE_TRIAGE_REPOS="be:/srv/backend fe:/srv/frontend"\n',
  );

  const repos = await projectRepos({
    config: {
      factoryHome: root,
      profilesDir,
    },
    prefs: { read: () => ({ projects: {} }) },
    id: 'multi',
    isFactory: true,
  });

  assert.deepEqual(repos, [
    { key: 'be', dir: '/srv/backend', from: 'factory' },
    { key: 'fe', dir: '/srv/frontend', from: 'factory' },
  ]);
});
