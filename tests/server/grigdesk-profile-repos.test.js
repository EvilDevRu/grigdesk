import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectRepos } from '../../server/src/lib/projects.ts';

test('проект с BE/FE-алиасами одного каталога отдаёт обе записи с исходными ключами', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-project-repos-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'grigdesk');
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, 'profile.sh'),
    'PROFILE_TRIAGE_REPOS="be:/srv/grigdesk fe:/srv/grigdesk"\n',
  );

  const repos = await projectRepos({
    config: {
      factoryHome: root,
      profilesDir,
    },
    prefs: { read: () => ({ projects: {} }) },
    id: 'grigdesk',
    isFactory: true,
  });

  // Схлопывание алиасов снято: ключ паспорта — это ключ плагина «Код», и он должен
  // совпадать с тем, что объявил профиль, иначе пути фабрики и Кода разъедутся.
  assert.deepEqual(repos, [
    { key: 'be', dir: '/srv/grigdesk', from: 'factory' },
    { key: 'fe', dir: '/srv/grigdesk', from: 'factory' },
  ]);
});

test('разные физические репозитории проекта сохраняют исходные ключи и порядок', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-project-repos-distinct-'));
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
