import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  diagnosisSuggestion,
  FactoryLaunchContractError,
  instrumentationSuggestions,
  loadFactoryLaunchProfile,
  normalizeFactoryLaunchInputs,
} from '../../server/src/lib/factory-launch-contract.js';

async function fixture(t, { deliveryActions = 'task-comment' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-launch-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'demo');
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, 'profile.sh'), `
PROFILE_TRIAGE_REPOS="be:/srv/backend fe:/srv/frontend"
profile_repositories() {
  printf 'backend\\t/srv/backend\\t/work/backend-t%s\\n' "$1"
  printf 'frontend\\t/srv/frontend\\t/work/frontend-t%s\\n' "$1"
}
profile_delivery_targets() {
  printf 'backend\\tmaster\\n'
  printf 'frontend\\tmain\\n'
}
${deliveryActions === null ? '' : `profile_delivery_actions() { printf '${deliveryActions}\\n'; }`}
`);
  const config = { factoryHome: root, profilesDir };
  return loadFactoryLaunchProfile(config, 'demo', '7802');
}

test('launch profile связывает canonical repo, triage alias и delivery defaults', async (t) => {
  const profile = await fixture(t);
  assert.deepEqual(profile.repositories, [
    {
      name: 'backend', source: '/srv/backend', workspace: '/work/backend-t7802',
      triageKey: 'be', targetBranch: 'master',
    },
    {
      name: 'frontend', source: '/srv/frontend', workspace: '/work/frontend-t7802',
      triageKey: 'fe', targetBranch: 'main',
    },
  ]);
  assert.equal(profile.taskComment, undefined);
  assert.deepEqual(profile.deliveryActions, ['task-comment']);

  assert.deepEqual(instrumentationSuggestions({
    files: ['be:app/Restore.php', 'fe:src/Restore.vue', '../bad'],
  }, profile.repositories), [
    'backend:app/Restore.php',
    'frontend:src/Restore.vue',
  ]);
});

test('delivery actions принимаются только из словаря движка и без повторов', async (t) => {
  // Хук необъявлен — дополнительные действия не выдаются (поведение до введения хука).
  assert.deepEqual((await fixture(t, { deliveryActions: null })).deliveryActions, []);
  await assert.rejects(() => fixture(t, { deliveryActions: 'task-close' }),
    /profile_delivery_actions: неизвестное или повторное действие task-close/);
  await assert.rejects(() => fixture(t, { deliveryActions: 'task-comment\\ntask-comment' }),
    /profile_delivery_actions: неизвестное или повторное действие task-comment/);
});

test('publish/debug launch берёт delivery contract из профиля и требует exact instrumentation scope', async (t) => {
  const profile = await fixture(t);
  assert.deepEqual(normalizeFactoryLaunchInputs({
    route: 'debug',
    deliveryMode: 'publish',
    repositories: profile.repositories,
    instrumentationFiles: ['backend:app/Restore.php'],
    diagnosisKind: 'data',
    diagnosisSignal: 'после восстановления строки удваиваются',
    profileDeliveryActions: profile.deliveryActions,
  }), {
    deliveryTargets: ['backend=master', 'frontend=main'],
    taskComment: true,
    instrumentationFiles: ['backend:app/Restore.php'],
    diagnosisKind: 'data',
    diagnosisSignal: 'после восстановления строки удваиваются',
  });

  // Профиль без хука task-comment: publish доставляет код, но комментарий не разрешён.
  assert.equal(normalizeFactoryLaunchInputs({
    route: 'feature',
    deliveryMode: 'publish',
    repositories: profile.repositories,
  }).taskComment, false);

  // Маршрут без ship не получает ни targets, ни комментарий во внешней задаче.
  assert.deepEqual(normalizeFactoryLaunchInputs({
    route: 'hunt',
    deliveryMode: 'disabled',
    repositories: profile.repositories,
  }), {
    deliveryTargets: [],
    taskComment: false,
    instrumentationFiles: [],
    diagnosisKind: '',
    diagnosisSignal: '',
  });

  for (const input of [
    {
      route: 'feature', deliveryMode: 'publish', repositories: profile.repositories,
      deliveryTargets: ['backend=master'],
    },
    {
      route: 'feature', deliveryMode: 'publish', repositories: profile.repositories,
      deliveryTargets: ['backend=release', 'frontend=main'],
    },
    {
      route: 'debug', deliveryMode: 'publish', repositories: profile.repositories,
      deliveryTargets: ['backend=master', 'frontend=main'], instrumentationFiles: [],
    },
    {
      route: 'debug', deliveryMode: 'publish', repositories: profile.repositories,
      deliveryTargets: ['backend=master', 'frontend=main'],
      instrumentationFiles: ['backend:../.env'],
    },
    {
      route: 'hunt', deliveryMode: 'disabled', repositories: profile.repositories,
      deliveryTargets: ['backend=master'],
    },
  ]) {
    assert.throws(() => normalizeFactoryLaunchInputs(input), FactoryLaunchContractError);
  }

  assert.throws(() => normalizeFactoryLaunchInputs({
    route: 'feature',
    deliveryMode: 'publish',
    repositories: profile.repositories.map((repo) => (
      repo.name === 'frontend' ? { ...repo, targetBranch: '' } : repo
    )),
  }), /profile_delivery_targets: не заданы ветки для frontend/);
});

test('debug diagnosis suggestion uses task analysis without inventing filesystem paths', () => {
  assert.deepEqual(diagnosisSuggestion({
    areas: ['BE', 'user_db-migration'],
    title: 'После восстановления число ключевых фраз удваивается',
  }), {
    kind: 'data',
    signal: 'После восстановления число ключевых фраз удваивается',
  });
});
