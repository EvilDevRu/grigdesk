// Раздел «Песочницы»: состояние отделено от ввода-вывода. Стор держит только состав
// раздела, а сеть, события сервера и тексты отказов живут в слое операций
// (`web/src/actions/sandboxes`). Проверяется поведение этой пары, а не сеть.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const ACTIONS_PATH = webFile('src/actions/sandboxes/index.ts');
const STORE_PATH = webFile('src/stores/sandboxes.ts');

const JOB = {
  task: '990000',
  profile: 'demo-profile',
  action: 'up',
  state: 'running',
  index: 4,
  total: 11,
  label: 'клон db: данные',
  message: '',
  startedAt: '2026-09-07T10:00:00.000Z',
  finishedAt: null,
};

const ENTRY = {
  task: '990000',
  profile: 'demo-profile',
  owner: 'manual',
  slot: 0,
  fePort: 5190,
  apiPort: 8090,
  repos: [{ name: 'backend', path: '/srv/worktrees/backend', branch: 'route-task-990000' }],
  standAlive: true,
  removable: true,
  removableReason: null,
  updatedAt: '2026-09-07T10:15:00.000Z',
};

const OVERVIEW = {
  profiles: [
    { id: 'demo-profile', canRaise: true, reason: null },
    { id: 'plain-profile', canRaise: false, reason: 'профиль не объявил up.sh и down.sh' },
  ],
  sandboxes: [ENTRY],
  jobs: [JOB],
  manualRange: { from: 990000, to: 999999 },
};

/**
 * Слой операций поднимается на двойниках общего HTTP-клиента и общего SSE, стор —
 * настоящий. Подписчик события сохраняется, чтобы тест мог прислать кадр прогресса
 * так же, как это делает сервер.
 */
async function sectionFixture(t, api) {
  globalThis.__sandboxStoreHarness = { api, listeners: new Set() };

  const module = await compileModule(ACTIONS_PATH, {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__sandboxStoreHarness.api;',
      '../../composables/useSse.ts': (
        'export const sseSubscribe = (fn) => {'
        + ' globalThis.__sandboxStoreHarness.listeners.add(fn);'
        + ' return () => globalThis.__sandboxStoreHarness.listeners.delete(fn);'
        + '};'
      ),
    },
  });

  setActivePinia(createPinia());

  const store = module.useSandboxesStore();
  const emit = (name, data) => {
    for (const fn of globalThis.__sandboxStoreHarness.listeners) {
      fn(name, data);
    }
  };

  t.after(() => {
    delete globalThis.__sandboxStoreHarness;
  });

  return { store, emit, ...module };
}

// Граница, ради которой раздел разделён: состояние не должно уметь ходить в сеть,
// иначе смена транспорта снова начнёт править стор.
test('стор состояния не знает ни про HTTP, ни про события сервера', async () => {
  const source = await readFile(STORE_PATH, 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(([, from]) => from);

  assert.deepEqual(imports.sort(), ['../../../shared/plugins/sandboxes/sandboxContracts', 'pinia']);
});

test('обзор раскладывается на профили, стенды и задания', async (t) => {
  const { store, loadSandboxes } = await sectionFixture(t, {
    get: async () => OVERVIEW,
    post: async () => ({ task: '990000', job: JOB }),
  });

  await loadSandboxes();

  assert.equal(store.loaded, true);
  assert.deepEqual(store.capableProfiles.map((item) => item.id), ['demo-profile']);
  assert.deepEqual(store.manualSandboxes.map((item) => item.task), ['990000']);
  assert.deepEqual(store.pipelineSandboxes, []);
  assert.equal(store.sandboxes[0].feAlive, null);
  assert.equal(store.sandboxes[0].profileBinding, null);
  assert.equal(store.jobOf('990000').label, 'клон db: данные');
  assert.equal(store.manualRange.from, 990000);
});

test('ответ не по контракту не становится состоянием раздела', async (t) => {
  let payload = OVERVIEW;
  const { store, loadSandboxes } = await sectionFixture(t, {
    get: async () => payload,
    post: async () => ({ task: '990000', job: JOB }),
  });

  await loadSandboxes();
  payload = { ...OVERVIEW, sandboxes: [{ ...ENTRY, owner: 'непонятно' }] };
  await loadSandboxes();

  assert.deepEqual(store.manualSandboxes.map((item) => item.task), ['990000']);
  assert.equal(store.manualSandboxes[0].owner, 'manual');
  assert.match(store.error, /песочниц/i);
});

test('прогресс подъёма приходит событием и обновляет только задание', async (t) => {
  let loads = 0;
  const { store, emit, loadSandboxes, watchSandboxes } = await sectionFixture(t, {
    get: async () => {
      loads += 1;

      return OVERVIEW;
    },
    post: async () => ({ task: '990000', job: JOB }),
  });

  watchSandboxes();
  await loadSandboxes();
  emit('sandbox-progress', { ...JOB, index: 9, label: 'контейнеры' });

  assert.equal(loads, 1);
  assert.equal(store.jobOf('990000').index, 9);
  assert.equal(store.jobOf('990000').label, 'контейнеры');

  emit('sandbox-progress', { task: '990000', index: 'десять' });

  assert.equal(store.jobOf('990000').index, 9);
});

test('отказ службы показывается текстом, понятным человеку', async (t) => {
  const failure = Object.assign(new Error('HTTP 409'), {
    status: 409,
    data: { error: 'pipeline_owned', message: 'стендом владеет попытка конвейера' },
  });
  const { store, loadSandboxes, dismantleSandbox } = await sectionFixture(t, {
    get: async () => OVERVIEW,
    post: async () => {
      throw failure;
    },
  });

  await loadSandboxes();

  await dismantleSandbox('990000');

  assert.match(store.error, /конвейер/i);
  assert.deepEqual(store.busyTasks, []);
});

test('успешный снос перечитывает обзор и снимает занятость стенда', async (t) => {
  const calls = [];
  const { store, loadSandboxes, dismantleSandbox } = await sectionFixture(t, {
    get: async () => {
      calls.push(['get']);

      return OVERVIEW;
    },
    post: async (path, body) => {
      calls.push(['post', path, body]);

      return { task: '990000', job: { ...JOB, action: 'down' } };
    },
  });

  await loadSandboxes();
  await dismantleSandbox('990000', true);

  assert.deepEqual(calls[1], ['post', '/api/sandboxes/990000/down', { force: true }]);
  assert.equal(calls.filter(([kind]) => kind === 'get').length, 2);
  assert.deepEqual(store.busyTasks, []);
});

test('подъём отправляет выбранный профиль и применяет начатое задание', async (t) => {
  const calls = [];
  const { store, raiseSandbox } = await sectionFixture(t, {
    get: async () => OVERVIEW,
    post: async (path, body) => {
      calls.push(['post', path, body]);

      return { task: '990000', job: JOB };
    },
  });

  await raiseSandbox('demo-profile', null);

  assert.deepEqual(calls[0], ['post', '/api/sandboxes', { profile: 'demo-profile', task: null }]);
  assert.equal(store.jobOf('990000').state, 'running');
  assert.equal(store.error, '');
});

// Действие человека и событие сервера приходят почти одновременно: раздел не должен
// читать одно и то же состояние двумя запросами подряд.
test('одновременные обновления схлопываются в один запрос обзора', async (t) => {
  let loads = 0;
  const { emit, loadSandboxes, watchSandboxes } = await sectionFixture(t, {
    get: async () => {
      loads += 1;

      return OVERVIEW;
    },
    post: async () => ({ task: '990000', job: JOB }),
  });

  watchSandboxes();

  const first = loadSandboxes();

  emit('sandboxes-changed', { task: '990000' });
  await first;

  assert.equal(loads, 1);
});

for (const event of ['projects-changed', 'hello']) {
  test(`PD-raise-catalog: ${event} перечитывает варианты без потери стендов`, async (t) => {
    let calls = 0;
    const { store, loadSandboxes, watchSandboxes, emit } = await sectionFixture(t, {
      get: async () => {
        calls += 1;

        return calls === 1 ? OVERVIEW : { ...OVERVIEW, profiles: [] };
      },
    });

    await loadSandboxes();
    assert.deepEqual(store.sandboxes.map((item) => item.task), [ENTRY.task]);
    assert.deepEqual(store.jobs.map((item) => item.task), [JOB.task]);

    const initialSandboxes = JSON.parse(JSON.stringify(store.sandboxes));
    const initialJobs = JSON.parse(JSON.stringify(store.jobs));

    watchSandboxes();
    emit(event, {
      id: 'demo-profile',
      revision: 3,
      kind: 'deleted'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(store.capableProfiles, []);
    assert.deepEqual(store.sandboxes, initialSandboxes);
    assert.deepEqual(store.jobs, initialJobs);
  });
}

test('PD-raise-catalog: поздний общий обзор не возвращает удалённый профиль', async (t) => {
  const slow = Promise.withResolvers();
  let calls = 0;
  const { store, loadSandboxes, watchSandboxes, emit } = await sectionFixture(t, {
    get: async () => {
      calls += 1;

      if (calls === 2) {
        await slow.promise;

        return OVERVIEW;
      }

      return calls === 1 ? OVERVIEW : { ...OVERVIEW, profiles: [] };
    },
  });

  await loadSandboxes();
  assert.deepEqual(store.sandboxes.map((item) => item.task), [ENTRY.task]);

  const initialSandboxes = JSON.parse(JSON.stringify(store.sandboxes));

  watchSandboxes();

  const old = loadSandboxes();

  emit('projects-changed', {
    id: 'demo-profile',
    revision: 3,
    kind: 'deleted'
  });
  slow.resolve();
  await old;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(store.capableProfiles, []);
  assert.deepEqual(store.sandboxes, initialSandboxes);
});
