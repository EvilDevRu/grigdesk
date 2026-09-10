// Раздел «Презентации»: состояние отделено от ввода-вывода. Стор держит только
// состав раздела, а сеть, события сервера и тексты отказов живут в слое операций
// (`web/src/actions/showcase`). Проверяется поведение этой пары, а не сеть.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const ACTIONS_PATH = webFile('src/actions/showcase/index.ts');
const STORE_PATH = webFile('src/stores/showcase.ts');

const JOB = {
  id: 'job-1',
  projectId: 'project-1',
  kind: 'record',
  state: 'running',
  attempt: 1,
  sequence: 2,
  progress: { index: 1, total: 3, label: 'пишем сцену' },
  error: null,
  startedAt: '2026-09-09T10:00:00.000Z',
  finishedAt: null,
};

const PROJECT = {
  id: 'project-1',
  title: 'Ролик о готовой работе',
  ref: { kind: 'sandbox', id: '990001' },
  targetLabel: 'стенд 990001',
  revision: 2,
  sceneCount: 3,
  state: 'building',
  hasFinal: false,
  updatedAt: '2026-09-09T11:00:00.000Z',
};

const BLOCKED_PROJECT = {
  ...PROJECT,
  id: 'project-2',
  title: 'Ролик без стенда',
  targetLabel: '',
  state: 'blocked',
  updatedAt: '2026-09-09T09:00:00.000Z',
};

const OVERVIEW = {
  profiles: [
    { id: 'demo-profile', ready: true, reason: '' },
    { id: 'plain-profile', ready: false, reason: 'Профиль не объявил контракт презентаций.' },
  ],
  projects: [PROJECT, BLOCKED_PROJECT],
  jobs: [JOB],
  limits: {
    maxScenes: 20,
    maxSceneSeconds: 120,
    maxTotalSeconds: 600,
    retentionDays: 30,
  },
};

/**
 * Слой операций поднимается на двойниках общего HTTP-клиента и общего SSE, стор —
 * настоящий. Подписчик события сохраняется, чтобы тест мог прислать сводку прогресса
 * так же, как это делает сервер.
 */
async function sectionFixture(t, api) {
  globalThis.__showcaseStoreHarness = { api, listeners: new Set() };

  const module = await compileModule(ACTIONS_PATH, {
    stubs: {
      './api-client.js': 'export const api = globalThis.__showcaseStoreHarness.api;',
      '../../composables/useSse.js': (
        'export const sseSubscribe = (fn) => {'
        + ' globalThis.__showcaseStoreHarness.listeners.add(fn);'
        + ' return () => globalThis.__showcaseStoreHarness.listeners.delete(fn);'
        + '};'
      ),
    },
  });

  setActivePinia(createPinia());

  const store = module.useShowcaseStore();
  const emit = (name, data) => {
    for (const fn of globalThis.__showcaseStoreHarness.listeners) {
      fn(name, data);
    }
  };

  t.after(() => {
    delete globalThis.__showcaseStoreHarness;
  });

  return { store, emit, ...module };
}

// Граница, ради которой раздел разделён: состояние не должно уметь ходить в сеть,
// иначе смена транспорта снова начнёт править стор.
test('стор состояния не знает ни про HTTP, ни про события сервера', async () => {
  const source = await readFile(STORE_PATH, 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(([, from]) => from);

  assert.deepEqual(imports.sort(), ['../../../shared/showcaseContracts', 'pinia']);
});

test('обзор раскладывается на профили, ролики и задания', async (t) => {
  const { store, loadShowcase } = await sectionFixture(t, {
    get: async () => OVERVIEW,
  });

  await loadShowcase(store);

  assert.equal(store.loaded, true);
  assert.deepEqual(store.readyProfiles.map((item) => item.id), ['demo-profile']);
  assert.deepEqual(store.projects.map((item) => item.id), ['project-1', 'project-2']);
  assert.deepEqual(store.blockedProjects.map((item) => item.id), ['project-2']);
  assert.deepEqual(store.jobsOf('project-1').map((item) => item.id), ['job-1']);
  assert.equal(store.limits.maxScenes, 20);
});

test('ответ не по контракту не становится состоянием раздела', async (t) => {
  let payload = OVERVIEW;
  const { store, loadShowcase } = await sectionFixture(t, {
    get: async () => payload,
  });

  await loadShowcase(store);

  payload = { ...OVERVIEW, projects: [{ ...PROJECT, state: 'почти готово' }] };
  await loadShowcase(store);

  assert.deepEqual(
    store.projects.map((item) => item.id),
    ['project-1', 'project-2'],
    'состояние остаётся прежним, а не заменяется наполовину разобранным ответом',
  );
  assert.match(store.error, /список роликов/i);
});

test('одновременные обзоры разделяют один запрос', async (t) => {
  let calls = 0;
  const { store, loadShowcase } = await sectionFixture(t, {
    get: async () => {
      calls += 1;

      return OVERVIEW;
    },
  });

  await Promise.all([loadShowcase(store), loadShowcase(store), loadShowcase(store)]);

  assert.equal(calls, 1);
});

test('сводка прогресса обновляет своё задание, не трогая остальные', async (t) => {
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async () => OVERVIEW,
  });

  watchShowcase(store);
  await loadShowcase(store);

  emit('showcase-progress', {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'succeeded',
    sequence: 5,
    label: 'ролик собран',
  });

  assert.equal(store.jobsOf('project-1')[0].state, 'succeeded');
  assert.equal(store.jobsOf('project-1')[0].sequence, 5);
});

// Отчёт прошлой попытки доезжает позже нового статуса: применить его значило бы
// вернуть на экран уже неверную работу.
test('поздняя сводка с меньшим номером не откатывает статус', async (t) => {
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async () => OVERVIEW,
  });

  watchShowcase(store);
  await loadShowcase(store);

  emit('showcase-progress', {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'succeeded',
    sequence: 5,
    label: 'ролик собран',
  });
  emit('showcase-progress', {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'running',
    sequence: 3,
    label: 'пишем сцену',
  });

  assert.equal(store.jobsOf('project-1')[0].state, 'succeeded');
  assert.equal(store.jobsOf('project-1')[0].sequence, 5);
});

test('испорченная сводка не подменяет задание и перечитывает обзор', async (t) => {
  let calls = 0;
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async () => {
      calls += 1;

      return OVERVIEW;
    },
  });

  watchShowcase(store);
  await loadShowcase(store);
  emit('showcase-progress', { jobId: 'job-1', state: 'что-то' });
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(store.jobsOf('project-1')[0].state, 'running');
  assert.ok(calls > 1, 'сомнительная сводка приводит к перечитыванию обзора');
});

test('удаление ролика закрывает его карточку и перечитывает список', async (t) => {
  let deleted = '';
  const { store, deleteShowcaseProject } = await sectionFixture(t, {
    get: async () => ({ ...OVERVIEW, projects: [BLOCKED_PROJECT] }),
    del: async (path) => {
      deleted = path;
    },
  });

  store.setOpened({ id: 'project-1' });

  const removed = await deleteShowcaseProject(store, 'project-1');

  assert.equal(removed, true);
  assert.equal(deleted, '/api/showcase/project-1');
  assert.equal(store.opened, null);
  assert.deepEqual(store.projects.map((item) => item.id), ['project-2']);
  assert.equal(store.isBusy('project-1'), false);
});

test('отказ ручки становится текстом раздела, а не молчаливой пустотой', async (t) => {
  const { store, deleteShowcaseProject } = await sectionFixture(t, {
    get: async () => OVERVIEW,
    del: async () => {
      throw { data: { error: 'plugin_disabled' } };
    },
  });

  const removed = await deleteShowcaseProject(store, 'project-1');

  assert.equal(removed, false);
  assert.match(store.error, /выключен/i);
});
