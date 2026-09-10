// Резолвер цели показа: что раздел считает готовой целью и что отдаёт наружу.
//
// Полномочия приходят из доверенного каталога профилей, а состояние стенда — из
// реестра фабрики. Проверяется, что раздел не додумывает адрес за профиль, не
// подменяет отсутствующий стенд адресом проекта и не отдаёт клиенту то, что нужно
// только исполнению: адрес серверной записи, разрешённые origins и вход.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseTargets, toPublicScope } from '../../server/src/lib/showcase/targets.ts';

const TARGET_CONTRACT = {
  version: 1,
  environment: 'read-only',
  project: {
    record: 'http://127.0.0.1:5173',
    view: 'http://127.0.0.1:5173',
  },
  sandbox: {
    recordTemplate: 'http://127.0.0.1:{fePort}',
    viewTemplate: 'http://127.0.0.1:{fePort}',
  },
  allowedOrigins: [],
  capabilities: ['record'],
};

const SCREENS_CONTRACT = {
  version: 1,
  screens: [
    {
      id: 'overview',
      title: 'Обзор',
      path: '/',
      readySelector: '[data-testid="ready"]',
      elements: [{ id: 'run', selector: '[data-testid="run"]' }],
    },
  ],
};

async function fixture(t, { target = TARGET_CONTRACT, screens = SCREENS_CONTRACT } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-targets-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, 'profiles');
  const stateDir = path.join(root, 'state');
  const contractDir = path.join(profilesDir, 'demo-profile', 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  if (target) {
    await writeFile(path.join(contractDir, 'target.json'), JSON.stringify(target), 'utf8');
  }

  if (screens) {
    await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify(screens), 'utf8');
  }

  const targets = createShowcaseTargets({
    profilesDir,
    stateDir,
    listProjects: async () => ['demo-profile'],
    dataRevisionOf: async () => 'начальные',
  });

  return { targets, stateDir, profilesDir, contractDir };
}

async function writeSandbox(stateDir, task, values = {}) {
  const env = {
    TASK: task,
    SB_K: '1',
    FE_PORT: '5192',
    API_PORT: '8092',
    WORKSPACE_MODE: 'isolated',
    STAND_OWNERSHIP: 'task',
    REPO_COUNT: '1',
    REPO_0_NAME: 'backend',
    REPO_0_SOURCE: '/srv/source/backend',
    REPO_0_WT: `/srv/worktrees/backend-t${task}`,
    REPO_0_BRANCH: `route-task-${task}`,
    ...values,
  };
  const text = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');

  await writeFile(path.join(stateDir, `t${task}.env`), `${text}\n`, 'utf8');
}

test('профиль без объявления показа не становится целью', async (t) => {
  const { targets } = await fixture(t, { target: null });
  const resolved = await targets.resolve({ kind: 'project', id: 'demo-profile' }, 'demo-profile');

  assert.equal(resolved.status, 'blocked');
  assert.equal(resolved.nextAction.kind, 'configure-profile');
  assert.match(resolved.reason, /не объявил контракт/);
});

test('профиль без карты экранов не пускает браузер', async (t) => {
  const { targets } = await fixture(t, { screens: { version: 1, screens: [] } });
  const resolved = await targets.resolve({ kind: 'project', id: 'demo-profile' }, 'demo-profile');

  assert.equal(resolved.status, 'blocked');
  assert.match(resolved.reason, /не объявил экраны/);
});

test('задача без стенда ведёт в «Песочницы», а не на адрес проекта', async (t) => {
  const { targets } = await fixture(t);
  const resolved = await targets.resolve({ kind: 'task', id: '990001' }, 'demo-profile');

  assert.equal(resolved.status, 'blocked');
  assert.equal(resolved.nextAction.kind, 'open-sandboxes');
  assert.match(resolved.reason, /не найден в реестре/);
});

test('стенд, которым владеет конвейер, разделу не принадлежит', async (t) => {
  const { targets, stateDir } = await fixture(t);

  await writeSandbox(stateDir, '990002');
  await writeFile(path.join(stateDir, 't990002.pipeline'), '', 'utf8');

  const resolved = await targets.resolve({ kind: 'sandbox', id: '990002' }, 'demo-profile');

  assert.equal(resolved.status, 'blocked');
  assert.match(resolved.reason, /владеет попытка конвейера/);
});

test('адрес стенда собирается по шаблону профиля из портов реестра', async (t) => {
  const { targets, stateDir } = await fixture(t);

  await writeSandbox(stateDir, '990003', { FE_PORT: '5199' });

  const resolved = await targets.resolve({ kind: 'sandbox', id: '990003' }, 'demo-profile');

  assert.equal(resolved.status, 'ready');
  assert.equal(resolved.scope.viewUrl, 'http://127.0.0.1:5199');
  assert.equal(resolved.scope.targetLabel, 'стенд 990003');
});

test('шаблон с неизвестной подстановкой не собирает чужой адрес молча', async (t) => {
  const { targets, stateDir } = await fixture(t, {
    target: {
      ...TARGET_CONTRACT,
      sandbox: {
        recordTemplate: 'http://127.0.0.1:{unknownPort}',
        viewTemplate: null,
      },
    },
  });

  await writeSandbox(stateDir, '990004');

  const resolved = await targets.resolve({ kind: 'sandbox', id: '990004' }, 'demo-profile');

  assert.equal(resolved.status, 'blocked');
  assert.match(resolved.reason, /собрался неполным/);
});

test('смена портов стенда меняет отпечаток цели', async (t) => {
  const { targets, stateDir } = await fixture(t);

  await writeSandbox(stateDir, '990005', { FE_PORT: '5192' });

  const before = await targets.resolve({ kind: 'sandbox', id: '990005' }, 'demo-profile');

  await writeSandbox(stateDir, '990005', { FE_PORT: '5193' });

  const after = await targets.resolve({ kind: 'sandbox', id: '990005' }, 'demo-profile');

  assert.equal(before.status, 'ready');
  assert.equal(after.status, 'ready');
  assert.notEqual(
    before.scope.targetFingerprint,
    after.scope.targetFingerprint,
    'переиспользованный слот обязан отличаться от прежней цели',
  );
});

test('правка объявления профиля меняет ревизию политики', async (t) => {
  const { targets, contractDir } = await fixture(t);
  const before = await targets.resolve({ kind: 'project', id: 'demo-profile' }, 'demo-profile');

  await writeFile(
    path.join(contractDir, 'screens.json'),
    JSON.stringify({
      ...SCREENS_CONTRACT,
      screens: [
        ...SCREENS_CONTRACT.screens,
        {
          id: 'list',
          title: 'Список',
          path: '/list',
          readySelector: '#items',
          elements: [],
        },
      ],
    }),
    'utf8',
  );

  const after = await targets.resolve({ kind: 'project', id: 'demo-profile' }, 'demo-profile');

  assert.notEqual(before.scope.policyRevision, after.scope.policyRevision);
});

test('наружу не уходят адрес записи, разрешённые origins и вход', async (t) => {
  const { targets } = await fixture(t, {
    target: {
      ...TARGET_CONTRACT,
      allowedOrigins: ['http://127.0.0.1:9999'],
    },
  });
  const resolved = await targets.resolve({ kind: 'project', id: 'demo-profile' }, 'demo-profile');
  const serialized = JSON.stringify(resolved);

  assert.equal(resolved.status, 'ready');
  assert.ok(!('recordUrl' in resolved.scope), 'адрес серверной записи остаётся внутри');
  assert.ok(!('allowedOrigins' in resolved.scope), 'список назначений остаётся внутри');
  assert.ok(!('login' in resolved.scope), 'селекторы и ссылка на учётку остаются внутри');
  assert.ok(!serialized.includes('9999'), 'разрешённые адреса не должны утекать в ответ');
});

test('возможность входа объявляется только вместе с его описанием', async (t) => {
  const { targets } = await fixture(t, {
    target: {
      ...TARGET_CONTRACT,
      capabilities: ['record', 'login'],
    },
  });
  const resolved = await targets.resolve({ kind: 'project', id: 'demo-profile' }, 'demo-profile');

  assert.equal(resolved.status, 'ready');
  assert.deepEqual(
    resolved.scope.capabilities,
    ['record'],
    'без login.json обещать вход нельзя, даже если профиль его перечислил',
  );
});

test('публичная проекция области не проносит внутренние поля', () => {
  const scope = {
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    targetLabel: 'demo-profile',
    environment: 'read-only',
    recordUrl: 'http://127.0.0.1:5173',
    viewUrl: 'http://127.0.0.1:5173',
    allowedOrigins: ['http://127.0.0.1:5173'],
    capabilities: ['record'],
    screens: [{
      id: 'overview',
      title: 'Обзор',
      path: '/',
      readySelector: '[data-testid="ready"]',
      elements: [{ id: 'run', selector: '[data-testid="run"]' }],
    }],
    login: {
      version: 1,
      url: 'http://127.0.0.1:5173/login',
      userSelector: '#user',
      passwordSelector: '#password',
      submitSelector: '#submit',
      readySelector: '#ready',
      credentialsRef: 'demo-account',
    },
    sandbox: null,
    targetFingerprint: 'fingerprint',
    policyRevision: 'policy',
    dataRevision: 'начальные',
    buildRevision: null,
  };
  const serialized = JSON.stringify(toPublicScope(scope));

  assert.ok(!serialized.includes('credentialsRef'), 'ссылка на учётку наружу не уходит');
  assert.ok(!serialized.includes('#password'), 'селекторы входа наружу не уходят');
  assert.ok(!serialized.includes('data-testid="run"'), 'селекторы элементов остаются на сервере');
  assert.ok(serialized.includes('Обзор'), 'названия экранов человеку показать нужно');
});
