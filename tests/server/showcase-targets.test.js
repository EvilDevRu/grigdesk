// Резолвер цели показа: что раздел считает готовой целью и что отдаёт наружу.
//
// Полномочия приходят из доверенного каталога профилей, а состояние стенда — из
// реестра фабрики. Проверяется, что раздел не додумывает адрес за профиль, не
// подменяет отсутствующий стенд адресом проекта и не отдаёт клиенту то, что нужно
// только исполнению: адрес серверной записи, разрешённые origins и вход.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseTargets, toPublicScope } from '../../server/src/lib/showcase/targets.ts';
import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';

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

async function fixture(t, {
  target = TARGET_CONTRACT,
  screens = SCREENS_CONTRACT,
  sandboxOverview,
} = {}) {
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
    sandboxOverview,
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

  const file = path.join(stateDir, `t${task}.env`);

  await writeFile(file, `${text}\n`, 'utf8');

  return new Date((await stat(file)).mtimeMs).toISOString();
}

/**
 * Карточка стенда, которым владеет попытка конвейера. Профиля и привязки у неё
 * нет намеренно: журнал раздела «Песочницы» такой стенд не поднимал, и связь с
 * профилем приходит только из реестра самой попытки.
 */
function pipelineSandbox(task) {
  return {
    task,
    profile: null,
    owner: 'pipeline',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    profileBinding: null,
    removable: false,
    removableReason: 'pipeline_owned',
    updatedAt: null,
  };
}

/** Реестр попытки — тот же плоский KEY=VALUE, что пишет движок. */
async function writePipelineRegistry(stateDir, task, values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');

  await writeFile(path.join(stateDir, `t${task}.pipeline`), `${text}\n`, 'utf8');
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

test('методы записи: по умолчанию чтение, POST только по объявлению цели', async (t) => {
  const ref = { kind: 'project', id: 'demo-profile' };
  const { targets } = await fixture(t);
  const internal = await targets.internalScope(ref, 'demo-profile');

  assert.deepEqual(internal.allowedMethods, ['GET', 'HEAD']);

  const declared = await fixture(t, {
    target: { ...TARGET_CONTRACT, allowedMethods: ['POST'] },
  });
  const withPost = await declared.targets.internalScope(ref, 'demo-profile');

  assert.deepEqual(withPost.allowedMethods, ['GET', 'HEAD', 'POST']);

  const resolved = await declared.targets.resolve(ref, 'demo-profile');

  assert.ok(!('allowedMethods' in resolved.scope), 'методы — внутренняя политика, наружу не уходят');
});

test('изменяющие методы объявить в цели нельзя', async (t) => {
  const { targets } = await fixture(t, {
    target: { ...TARGET_CONTRACT, allowedMethods: ['GET', 'DELETE'] },
  });

  // Контракт отвергает объявление целиком: неверный профиль — ошибка объявления,
  // которую видно в готовности, а не тихое сужение до чтения.
  await assert.rejects(
    () => targets.resolve({ kind: 'project', id: 'demo-profile' }, 'demo-profile'),
    (error) => /allowedMethods/.test(error.message),
  );
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

test('каталог связывает постоянный стенд и ручную песочницу с профилем', async (t) => {
  const sandbox = {
    task: '990003',
    profile: 'demo-profile',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    profileBinding: 'verified',
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );
  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'profile.sh'),
    'PROFILE_SERVICE_HOST="localhost"\n',
    'utf8',
  );
  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    '990003',
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const choices = await fx.targets.choices();
  const permanent = choices.find((item) => item.ref.kind === 'project');
  const manual = choices.find((item) => item.ref.kind === 'sandbox');

  assert.deepEqual(permanent, {
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    profileBinding: 'verified',
    label: 'demo-profile · постоянный стенд',
    taskTitle: null,
    viewUrl: 'http://127.0.0.1:5173',
    viewPort: null,
    status: 'ready',
    reason: '',
    screenCount: 0,
  });
  assert.equal(manual.profile, 'demo-profile');
  assert.equal(manual.profileBinding, 'verified');
  assert.equal(manual.viewUrl, null);
  assert.equal(manual.viewPort, 5199);
  assert.equal(manual.status, 'ready');
  assert.equal(manual.screenCount, 0);

  const internal = await fx.targets.selectedInternalScope(manual.ref);

  assert.equal(internal.recordUrl, 'http://localhost:5199');
  assert.equal(internal.viewUrl, null);
});

test('битое необязательное описание входа блокирует цель уже в каталоге', async (t) => {
  const fx = await fixture(t, { target: null, screens: null });

  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );
  await writeFile(path.join(fx.contractDir, 'login.json'), '{"version":1', 'utf8');

  const permanent = (await fx.targets.choices()).find((item) => item.ref.kind === 'project');

  assert.equal(permanent.status, 'blocked');
  assert.match(permanent.reason, /login\.json.*не является JSON/);
});

test('живой API не делает песочницу готовой, если FE не отвечает', async (t) => {
  const sandbox = {
    task: '990006',
    profile: 'demo-profile',
    profileBinding: 'inferred',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: false,
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  const manual = (await fx.targets.choices()).find((item) => item.ref.kind === 'sandbox');

  assert.equal(manual.status, 'blocked');
  assert.match(manual.reason, /Интерфейс стенда сейчас не отвечает/);
});

test('песочница остаётся заблокированной на время подъёма или сноса', async (t) => {
  const sandbox = {
    task: '990007',
    profile: 'demo-profile',
    profileBinding: 'verified',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: false,
    removableReason: 'job_running',
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  const manual = (await fx.targets.choices()).find((item) => item.ref.kind === 'sandbox');

  assert.equal(manual.status, 'blocked');
  assert.match(manual.reason, /идёт подъём или снос/);
});

test('начавшийся после каталога down блокирует resolve при неизменном env', async (t) => {
  const sandbox = {
    task: '990010',
    profile: 'demo-profile',
    profileBinding: 'inferred',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  let overviewCalls = 0;
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => {
      const running = overviewCalls > 0;

      overviewCalls += 1;

      return {
        sandboxes: [{
          ...sandbox,
          removable: !running,
          removableReason: running ? 'job_running' : null,
        }],
      };
    },
  });

  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    sandbox.task,
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const resolved = await fx.targets.resolveSelected({ kind: 'sandbox', id: sandbox.task });

  assert.equal(overviewCalls, 2);
  assert.equal(resolved.status, 'blocked');
  assert.match(resolved.reason, /идёт подъём или снос/);
});

test('предположенный профиль не расширяет безопасную policy песочницы', async (t) => {
  const sandbox = {
    task: '990008',
    profile: 'demo-profile',
    profileBinding: 'inferred',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: {
      ...TARGET_CONTRACT,
      environment: 'isolated-demo',
      allowedOrigins: ['http://127.0.0.1:9999'],
      capabilities: ['record', 'login', 'seed', 'mutations'],
    },
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  await writeFile(
    path.join(fx.contractDir, 'login.json'),
    JSON.stringify({
      version: 1,
      url: 'http://localhost:5199/login',
      userSelector: '#user',
      passwordSelector: '#password',
      submitSelector: '#submit',
      readySelector: '#ready',
      credentialsRef: 'demo-account',
    }),
    'utf8',
  );
  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'profile.sh'),
    'PROFILE_SERVICE_HOST="example.com"\n',
    'utf8',
  );
  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    sandbox.task,
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const manual = (await fx.targets.choices()).find((item) => item.ref.kind === 'sandbox');
  const internal = await fx.targets.selectedInternalScope(manual.ref);

  assert.equal(manual.status, 'ready');
  assert.equal(manual.screenCount, 0);
  assert.equal(internal.environment, 'read-only');
  assert.equal(internal.recordUrl, 'http://localhost:5199');
  assert.deepEqual(internal.capabilities, ['record']);
  assert.deepEqual(internal.screens, [{
    id: 'root',
    title: 'Главная',
    path: '/',
    readySelector: 'body',
    elements: [],
  }]);
  assert.equal(internal.login, null);
  assert.deepEqual(internal.allowedOrigins, ['http://localhost:5199']);
});

test('смена порта между снимком и raw registry блокирует запись', async (t) => {
  const sandbox = {
    task: '990004',
    profile: 'demo-profile',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    profileBinding: 'verified',
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  await writeSandbox(fx.stateDir, '990004', { FE_PORT: '5200', API_PORT: '8100' });

  const resolved = await fx.targets.resolveSelected({ kind: 'sandbox', id: '990004' });

  assert.equal(resolved.status, 'blocked');
  assert.match(resolved.reason, /Порт стенда изменился/);
});

test('пересоздание стенда с тем же портом блокирует старый снимок каталога', async (t) => {
  const sandbox = {
    task: '990009',
    profile: 'demo-profile',
    profileBinding: 'verified',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: '2026-01-01T10:00:00.000Z',
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  await writeSandbox(fx.stateDir, sandbox.task, { FE_PORT: '5199', API_PORT: '8099' });

  const resolved = await fx.targets.resolveSelected({ kind: 'sandbox', id: sandbox.task });

  assert.equal(resolved.status, 'blocked');
  assert.match(resolved.reason, /изменился после загрузки списка целей/);
});

test('исполнитель отклоняет fingerprint, изменившийся после readProject', async (t) => {
  const sandbox = {
    task: '990013',
    profile: 'demo-profile',
    profileBinding: 'inferred',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    sandbox.task,
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const ref = { kind: 'sandbox', id: sandbox.task };
  const first = await fx.targets.resolveSelected(ref);
  const envFile = path.join(fx.stateDir, `t${sandbox.task}.env`);
  const nextGeneration = new Date(Date.now() + 60_000);

  assert.equal(first.status, 'ready');
  await utimes(envFile, nextGeneration, nextGeneration);
  sandbox.updatedAt = new Date((await stat(envFile)).mtimeMs).toISOString();

  await assert.rejects(
    () => fx.targets.selectedInternalScope(
      ref,
      first.scope.profile,
      first.scope.targetFingerprint,
    ),
    (error) => error.code === 'target_changed' && error.status === 409,
  );
});

test('сохранённый ролик не перепривязывается к новому поколению того же task', async (t) => {
  const sandbox = {
    task: '990011',
    profile: 'demo-profile',
    profileBinding: 'inferred',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });
  const showcaseDir = path.join(path.dirname(fx.profilesDir), 'showcase');

  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    sandbox.task,
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const service = createShowcaseService({
    showcaseDir,
    authDir: path.join(path.dirname(fx.profilesDir), 'auth'),
    profilesDir: fx.profilesDir,
    stateDir: fx.stateDir,
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });
  const created = await service.createProject({
    ref: { kind: 'sandbox', id: sandbox.task },
    title: 'Привязанный ролик',
  });
  const envFile = path.join(fx.stateDir, `t${sandbox.task}.env`);
  const nextGeneration = new Date(Date.now() + 60_000);

  await utimes(envFile, nextGeneration, nextGeneration);
  sandbox.updatedAt = new Date((await stat(envFile)).mtimeMs).toISOString();

  const reopened = await service.readProject(created.id);

  assert.equal(created.target.status, 'ready');
  assert.equal(reopened.target.status, 'blocked');
  assert.match(reopened.target.reason, /пересоздан или изменился/);
});

test('старый task-ролик без сохранённого профиля не привязывается к новому стенду', async (t) => {
  const sandbox = {
    task: '990005',
    profile: 'demo-profile',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    profileBinding: 'verified',
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });
  const showcaseDir = path.join(path.dirname(fx.profilesDir), 'showcase');

  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    sandbox.task,
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const service = createShowcaseService({
    showcaseDir,
    authDir: path.join(path.dirname(fx.profilesDir), 'auth'),
    profilesDir: fx.profilesDir,
    stateDir: fx.stateDir,
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });
  const created = await service.createProject({
    ref: { kind: 'sandbox', id: sandbox.task },
    title: 'Старый ролик',
  });
  const file = path.join(showcaseDir, 'projects', created.id, 'project.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const legacyRef = { kind: 'task', id: sandbox.task };

  stored.ref = legacyRef;
  stored.target = {
    status: 'blocked',
    ref: legacyRef,
    reason: 'Старое состояние без binding.',
    nextAction: null,
  };
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

  const reopened = await service.readProject(created.id);

  assert.equal(reopened.target.status, 'blocked');
  assert.equal(reopened.target.profile, null);
  assert.match(reopened.target.reason, /не сохранена привязка/);
});

test('policy принимает и новые пропущенные, и старые null адресные поля', async (t) => {
  const policies = [
    {
      version: 1,
      environment: 'read-only',
      allowedOrigins: [],
      capabilities: ['record'],
    },
    {
      version: 1,
      environment: 'read-only',
      project: null,
      sandbox: null,
      allowedOrigins: [],
      capabilities: ['record'],
    },
  ];

  for (const target of policies) {
    const fx = await fixture(t, {
      target,
      screens: null,
      sandboxOverview: async () => ({ sandboxes: [] }),
    });

    await writeFile(
      path.join(fx.profilesDir, 'demo-profile', 'dashboard.env'),
      'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
      'utf8',
    );

    const resolved = await fx.targets.resolveSelected({
      kind: 'project',
      id: 'demo-profile',
    });

    assert.equal(resolved.status, 'ready');
  }
});

test('цель без showcase-файлов получает безопасный корневой экран', async (t) => {
  const fx = await fixture(t, { target: null, screens: null, sandboxOverview: async () => ({
    sandboxes: [],
  }) });

  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );

  const ref = { kind: 'project', id: 'demo-profile' };
  const resolved = await fx.targets.resolveSelected(ref);
  const internal = await fx.targets.selectedInternalScope(ref);

  assert.equal(resolved.status, 'ready');
  assert.equal(resolved.scope.profile, 'demo-profile');
  assert.deepEqual(resolved.scope.screens, [{ id: 'root', title: 'Главная', path: '/' }]);
  assert.deepEqual(internal.screens, [{
    id: 'root',
    title: 'Главная',
    path: '/',
    readySelector: 'body',
    elements: [],
  }]);
});

// По номеру стенда человек задачу не узнаёт: название из портала стоит и у цели,
// и в имени ролика. Портал спрашивается один раз на номер, а его беда — не отказ
// раздела: стенд остаётся подписан номером.
test('стенд задачи подписан её названием из портала, и ролик берёт его в имя', async (t) => {
  const sandbox = {
    task: '990003',
    profile: 'demo-profile',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    profileBinding: 'verified',
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });
  const asked = [];

  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );
  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'profile.sh'),
    'PROFILE_SERVICE_HOST="localhost"\n',
    'utf8',
  );
  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    '990003',
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const service = createShowcaseService({
    showcaseDir: path.join(path.dirname(fx.profilesDir), 'showcase'),
    authDir: path.join(path.dirname(fx.profilesDir), 'auth'),
    profilesDir: fx.profilesDir,
    stateDir: fx.stateDir,
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
    taskDetails: async (taskId) => {
      asked.push(taskId);

      if (asked.length > 1) {
        throw new Error('портал спрашивают повторно');
      }

      return { title: '  Массовый   съём частотности ', description: '<p>текст</p>' };
    },
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });

  const overview = await service.overview();
  const permanent = overview.targets.find((item) => item.ref.kind === 'project');
  const manual = overview.targets.find((item) => item.ref.kind === 'sandbox');

  assert.equal(permanent.taskTitle, null, 'постоянный стенд задаче не принадлежит');
  assert.equal(manual.taskTitle, 'Массовый съём частотности', 'название чистится от лишних пробелов');
  assert.equal(manual.label, 'demo-profile · стенд 990003', 'подпись стенда остаётся отдельно');

  const project = await service.createProject({ ref: manual.ref });

  assert.equal(project.title, 'Задача 990003 · Массовый съём частотности');
  assert.deepEqual(asked, ['990003'], 'портал спрошен один раз: название помнится');

  // Ролик, заведённый до того, как название стало известно, носит имя по номеру:
  // на экране оно догоняет название само, а имя, данное человеком, остаётся.
  const stale = await service.createProject({ ref: manual.ref, title: 'Задача 990003 · demo-profile' });
  const adopted = await service.openProject(stale.id);

  assert.equal(adopted.title, 'Задача 990003 · Массовый съём частотности');
  assert.equal(adopted.revision, stale.revision + 1, 'переименование — редакция, как любая правка');
  assert.equal(
    (await service.readProject(stale.id)).title,
    adopted.title,
    'имя сохранено, а не подставлено на лету',
  );

  const renamed = await service.renameProject(stale.id, adopted.revision, 'Съём частот за минуту');

  assert.equal((await service.openProject(stale.id)).title, 'Съём частот за минуту');
  assert.equal((await service.openProject(stale.id)).revision, renamed.revision);

  const listed = await service.overview();

  assert.deepEqual(
    listed.projects.map((item) => item.title).sort(),
    ['Задача 990003 · Массовый съём частотности', 'Съём частот за минуту'],
    'список показывает те же имена, что и экран ролика',
  );

  const offline = createShowcaseService({
    showcaseDir: path.join(path.dirname(fx.profilesDir), 'showcase-offline'),
    authDir: path.join(path.dirname(fx.profilesDir), 'auth'),
    profilesDir: fx.profilesDir,
    stateDir: fx.stateDir,
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
    taskDetails: async () => {
      throw new Error('портал недоступен');
    },
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });
  const quiet = await offline.overview();
  const fallback = await offline.createProject({ ref: manual.ref });

  assert.equal(quiet.targets.find((item) => item.ref.kind === 'sandbox').taskTitle, null);
  assert.equal(fallback.title, 'Задача 990003 · demo-profile', 'без портала остаётся профиль');
});

test('overview использует один снимок песочниц для каталога и всех роликов', async (t) => {
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [] }),
  });
  let overviewCalls = 0;

  await writeFile(
    path.join(fx.profilesDir, 'demo-profile', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );

  const service = createShowcaseService({
    showcaseDir: path.join(path.dirname(fx.profilesDir), 'showcase'),
    authDir: path.join(path.dirname(fx.profilesDir), 'auth'),
    profilesDir: fx.profilesDir,
    stateDir: fx.stateDir,
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    sandboxOverview: async () => {
      overviewCalls += 1;

      return { sandboxes: [] };
    },
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });
  const ref = { kind: 'project', id: 'demo-profile' };

  await service.createProject({ ref, title: 'Первый' });
  await service.createProject({ ref, title: 'Второй' });
  overviewCalls = 0;

  const overview = await service.overview();

  assert.equal(overview.projects.length, 2);
  assert.equal(overview.targets.length, 1);
  assert.equal(overviewCalls, 1);
});

test('overview не перечитывает sandbox catalog для каждого сохранённого ролика', async (t) => {
  const sandbox = {
    task: '990012',
    profile: 'demo-profile',
    profileBinding: 'inferred',
    owner: 'manual',
    slot: 1,
    fePort: 5199,
    apiPort: 8099,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: null,
  };
  const fx = await fixture(t, { target: null, screens: null });
  let overviewCalls = 0;

  sandbox.updatedAt = await writeSandbox(
    fx.stateDir,
    sandbox.task,
    { FE_PORT: '5199', API_PORT: '8099' },
  );

  const service = createShowcaseService({
    showcaseDir: path.join(path.dirname(fx.profilesDir), 'showcase'),
    authDir: path.join(path.dirname(fx.profilesDir), 'auth'),
    profilesDir: fx.profilesDir,
    stateDir: fx.stateDir,
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    sandboxOverview: async () => {
      overviewCalls += 1;

      return { sandboxes: [sandbox] };
    },
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });
  const ref = { kind: 'sandbox', id: sandbox.task };

  await service.createProject({ ref, title: 'Первый sandbox-ролик' });
  await service.createProject({ ref, title: 'Второй sandbox-ролик' });
  overviewCalls = 0;

  const overview = await service.overview();

  assert.equal(overview.projects.length, 2);
  assert.equal(overview.targets.length, 1);
  assert.equal(overviewCalls, 1);
});

test('стенд остановленной попытки становится целью, а профиль берётся у движка', async (t) => {
  const sandbox = pipelineSandbox('990010');
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  sandbox.updatedAt = await writeSandbox(fx.stateDir, '990010', { FE_PORT: '5199' });

  await writePipelineRegistry(fx.stateDir, '990010', {
    PROFILE: 'demo-profile',
    WF_STATUS: 'running',
    ORCH_PID: '',
    STALLED_HUMAN: '1',
    GATE_ACCEPT: 'waiting',
  });

  const choice = (await fx.targets.choices()).find((item) => item.ref.kind === 'sandbox');
  const resolved = await fx.targets.resolveSelected({ kind: 'sandbox', id: '990010' });
  const scope = await fx.targets.selectedInternalScope({ kind: 'sandbox', id: '990010' });

  assert.equal(choice.status, 'ready');
  assert.equal(choice.profile, 'demo-profile');
  assert.equal(choice.profileBinding, 'verified');
  assert.equal(choice.label, 'demo-profile · стенд 990010 · ждёт приёмки');
  assert.equal(resolved.status, 'ready');
  assert.equal(scope.recordUrl, 'http://127.0.0.1:5199');
  assert.ok(scope.capabilities.includes('record'), 'ролик снимается именно с этого стенда');
});

test('стенд идущей попытки виден в списке, но целью не становится', async (t) => {
  const sandbox = pipelineSandbox('990011');
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  sandbox.updatedAt = await writeSandbox(fx.stateDir, '990011', { FE_PORT: '5199' });

  await writePipelineRegistry(fx.stateDir, '990011', {
    PROFILE: 'demo-profile',
    WF_STATUS: 'running',
    ORCH_PID: '4242',
  });

  const choice = (await fx.targets.choices()).find((item) => item.ref.kind === 'sandbox');
  const resolved = await fx.targets.resolveSelected({ kind: 'sandbox', id: '990011' });

  assert.equal(choice.status, 'blocked');
  assert.equal(choice.label, 'demo-profile · стенд 990011 · идёт попытка');
  assert.match(choice.reason, /идущая попытка конвейера/);
  assert.equal(resolved.status, 'blocked');
  assert.match(resolved.reason, /идущая попытка конвейера/);
});

test('попытка, снова взявшаяся за задачу, отбирает стенд у уже выбранной цели', async (t) => {
  const sandbox = pipelineSandbox('990012');
  const fx = await fixture(t, {
    target: null,
    screens: null,
    sandboxOverview: async () => ({ sandboxes: [sandbox] }),
  });

  sandbox.updatedAt = await writeSandbox(fx.stateDir, '990012', { FE_PORT: '5199' });

  await writePipelineRegistry(fx.stateDir, '990012', {
    PROFILE: 'demo-profile',
    ORCH_PID: '',
    STALLED_HUMAN: '1',
    GATE_ACCEPT: 'waiting',
  });

  const before = await fx.targets.resolveSelected({ kind: 'sandbox', id: '990012' });

  await writePipelineRegistry(fx.stateDir, '990012', {
    PROFILE: 'demo-profile',
    ORCH_PID: '4242',
    STALLED_HUMAN: '',
    GATE_ACCEPT: 'passed',
  });

  const after = await fx.targets.resolveSelected({ kind: 'sandbox', id: '990012' });

  assert.equal(before.status, 'ready');
  assert.equal(after.status, 'blocked');
  assert.match(after.reason, /идущая попытка конвейера/);
});
