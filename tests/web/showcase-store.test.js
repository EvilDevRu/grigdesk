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

const BUILD_RUN = {
  id: '0123456789abcdef',
  projectId: 'project-1',
  state: 'running',
  sequence: 2,
  stage: 'record-if-needed',
  initialRevision: 2,
  children: [],
  cancelRequested: false,
  error: null,
  startedAt: '2026-09-09T10:00:00.000Z',
  updatedAt: '2026-09-09T10:01:00.000Z',
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

const TARGET = {
  ref: { kind: 'project', id: 'parser' },
  profile: 'parser',
  label: 'parser · постоянный стенд',
  viewUrl: 'http://127.0.0.1:13000',
  viewPort: null,
  status: 'ready',
  reason: '',
  screenCount: 0,
};

const OVERVIEW = {
  targets: [
    TARGET,
    {
      ref: { kind: 'sandbox', id: '990002' },
      profile: 'arsenkin',
      label: 'arsenkin · стенд t990002',
      viewUrl: null,
      viewPort: null,
      status: 'blocked',
      reason: 'Порты стенда не отвечают.',
      screenCount: 3,
    },
  ],
  profiles: [
    { id: 'demo-profile', ready: true, reason: '' },
    { id: 'plain-profile', ready: false, reason: 'Профиль не объявил контракт презентаций.' },
  ],
  projects: [PROJECT, BLOCKED_PROJECT],
  jobs: [JOB],
  buildRuns: [],
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
      './apiClient.ts': 'export const api = globalThis.__showcaseStoreHarness.api;',
      '../../composables/useSse.ts': (
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

  assert.deepEqual(imports.sort(), [
    '../../../shared/showcaseContracts',
    '../../../shared/showcaseTimeline',
    'pinia',
  ]);
});

test('обзор раскладывается на цели, ролики и задания', async (t) => {
  const { store, loadShowcase } = await sectionFixture(t, {
    get: async () => OVERVIEW,
  });

  await loadShowcase(store);

  assert.equal(store.loaded, true);
  assert.deepEqual(store.readyTargets.map((item) => item.ref), [TARGET.ref]);
  assert.deepEqual(store.projects.map((item) => item.id), ['project-1', 'project-2']);
  assert.deepEqual(store.blockedProjects.map((item) => item.id), ['project-2']);
  assert.deepEqual(store.jobsOf('project-1').map((item) => item.id), ['job-1']);
  assert.equal(store.limits.maxScenes, 20);
});

test('создание отправляет только выбранную цель и название', async (t) => {
  let createdBody = null;
  const created = {
    schemaVersion: 1,
    id: 'created-project',
    title: 'Ролик парсера',
    revision: 1,
    ref: TARGET.ref,
    target: {
      status: 'blocked',
      ref: TARGET.ref,
      reason: 'Тестовая цель ещё не перечитана.',
      nextAction: null,
    },
    brief: [],
    scenes: [],
    decisions: [],
    latestFinal: null,
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
  };
  const { store, createShowcaseProject } = await sectionFixture(t, {
    get: async () => OVERVIEW,
    post: async (path, body) => {
      assert.equal(path, '/api/showcase');
      createdBody = body;

      return created;
    },
  });

  await createShowcaseProject(store, { ref: TARGET.ref, title: 'Ролик парсера' });

  assert.deepEqual(createdBody, {
    kind: 'project',
    id: 'parser',
    title: 'Ролик парсера',
  });
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
    sequence: 3,
    label: 'ролик собран',
  });

  assert.equal(store.jobsOf('project-1')[0].state, 'succeeded');
  assert.equal(store.jobsOf('project-1')[0].sequence, 3);
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
    sequence: 3,
    label: 'ролик собран',
  });
  emit('showcase-progress', {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'running',
    sequence: 2,
    label: 'пишем сцену',
  });

  assert.equal(store.jobsOf('project-1')[0].state, 'succeeded');
  assert.equal(store.jobsOf('project-1')[0].sequence, 3);
});

test('дыра sequence задания не склеивается и перечитывает полный snapshot', async (t) => {
  let calls = 0;
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async () => {
      calls += 1;

      return OVERVIEW;
    },
  });

  watchShowcase(store);
  await loadShowcase(store);

  emit('showcase-progress', {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'succeeded',
    sequence: 5,
    label: 'пропущены два события',
  });
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(store.jobsOf('project-1')[0].sequence, 2);
  assert.equal(store.jobsOf('project-1')[0].state, 'running');
  assert.equal(calls, 2);
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

test('изменение песочниц обновляет каталог целей без ручного нажатия', async (t) => {
  let calls = 0;
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async (path) => {
      if (path === '/api/showcase') {
        calls += 1;
      }

      return OVERVIEW;
    },
  });

  watchShowcase(store);
  await loadShowcase(store);
  emit('sandboxes-changed', { task: '990001' });
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(calls, 2);
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

test('изменение ролика перечитывает открытую карточку, а не только список', async (t) => {
  const reads = [];
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async (path) => {
      reads.push(path);

      if (path === '/api/showcase/project-1') {
        return {
          schemaVersion: 1,
          id: 'project-1',
          title: PROJECT.title,
          revision: 7,
          ref: PROJECT.ref,
          target: { status: 'blocked', ref: PROJECT.ref, reason: 'нет стенда', nextAction: null },
          brief: [],
          scenes: [],
          decisions: [],
          latestFinal: null,
          createdAt: '2026-09-09T10:00:00.000Z',
          updatedAt: '2026-09-09T11:00:00.000Z',
        };
      }

      return OVERVIEW;
    },
  });

  watchShowcase(store);
  await loadShowcase(store);
  store.setOpened({ id: 'project-1', revision: 2 });
  emit('showcase-changed', { projectId: 'project-1', revision: 7 });
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  // Редакция в карточке отстаёт от сервера после каждого завершённого задания;
  // без перечитывания любая правка отвечала бы конфликтом редакций.
  assert.ok(reads.includes('/api/showcase/project-1'));
  assert.equal(store.opened.revision, 7);

  emit('showcase-changed', { projectId: 'project-2', revision: 3 });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(reads.filter((path) => path === '/api/showcase/project-1').length, 1);
});

// Полный запуск принадлежит серверу. Двойной клик не должен заводить второй run,
// а браузер после 202 не ждёт record/voice, чтобы решить, что запускать дальше.
test('сквозная сборка создаёт один сохраняемый run одним POST', async (t) => {
  const posts = [];
  let acceptBuild;
  const response = new Promise((resolve) => {
    acceptBuild = resolve;
  });
  const { store, loadShowcase, buildShowcaseFilm } = await sectionFixture(t, {
    get: async (path) => (path === '/api/showcase' ? { ...OVERVIEW, jobs: [] } : OVERVIEW),
    post: async (path, body) => {
      posts.push([path, body]);

      return response;
    },
  });

  await loadShowcase(store);
  store.setOpened({ id: 'project-1', revision: 2 });

  const first = buildShowcaseFilm(store);
  const second = buildShowcaseFilm(store);

  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(posts.length, 1, 'два нажатия делят один запрос');
  assert.equal(posts[0][0], '/api/showcase/project-1/build');
  assert.equal(posts[0][1].revision, 2);
  assert.match(posts[0][1].requestId, /^[A-Za-z0-9_-]{8,128}$/);

  acceptBuild({ run: BUILD_RUN });

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(store.latestBuildOf('project-1')?.id, BUILD_RUN.id);
  assert.deepEqual(
    posts.map(([path]) => path),
    ['/api/showcase/project-1/build'],
    'record, voice и assemble из браузера не запускаются',
  );
});

test('snapshot запуска переживает F5, а старое SSE не откатывает sequence', async (t) => {
  const overview = { ...OVERVIEW, jobs: [], buildRuns: [BUILD_RUN] };
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async () => overview,
  });

  watchShowcase(store);
  await loadShowcase(store);

  assert.equal(store.activeBuildOf('project-1')?.id, BUILD_RUN.id);
  assert.equal(store.isBusy('project-1'), true);

  emit('showcase-build-progress', {
    runId: BUILD_RUN.id,
    projectId: 'project-1',
    state: 'running',
    sequence: 3,
    stage: 'validate',
    error: null,
  });
  emit('showcase-build-progress', {
    runId: BUILD_RUN.id,
    projectId: 'project-1',
    state: 'running',
    sequence: 2,
    stage: 'record-if-needed',
    error: null,
  });

  assert.equal(store.latestBuildOf('project-1')?.sequence, 3);
  assert.equal(store.latestBuildOf('project-1')?.stage, 'validate');

  await loadShowcase(store);
  assert.equal(store.latestBuildOf('project-1')?.sequence, 3, 'старый snapshot тоже не откатывает SSE');
});

test('дыра sequence полного запуска восстанавливается обзором', async (t) => {
  let calls = 0;
  const overview = { ...OVERVIEW, jobs: [], buildRuns: [BUILD_RUN] };
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async () => {
      calls += 1;

      return overview;
    },
  });

  watchShowcase(store);
  await loadShowcase(store);

  emit('showcase-build-progress', {
    runId: BUILD_RUN.id,
    projectId: BUILD_RUN.projectId,
    state: 'running',
    sequence: 6,
    stage: 'validate',
    error: null,
  });
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(store.latestBuildOf('project-1')?.sequence, 2);
  assert.equal(store.latestBuildOf('project-1')?.stage, 'record-if-needed');
  assert.equal(calls, 2);
});

test('отмена останавливает весь run и сохраняет новый snapshot', async (t) => {
  const cancelling = {
    ...BUILD_RUN,
    state: 'cancelling',
    sequence: 3,
    cancelRequested: true,
    updatedAt: '2026-09-09T10:02:00.000Z',
  };
  const posts = [];
  const { store, cancelShowcaseBuild } = await sectionFixture(t, {
    post: async (path, body) => {
      posts.push([path, body]);

      return { run: cancelling };
    },
  });

  store.applyBuildRun(BUILD_RUN);

  assert.equal(await cancelShowcaseBuild(store, BUILD_RUN.id), true);
  assert.deepEqual(posts, [[`/api/showcase/builds/${BUILD_RUN.id}/cancel`, {}]]);
  assert.equal(store.latestBuildOf('project-1')?.state, 'cancelling');
  assert.equal(store.latestBuildOf('project-1')?.cancelRequested, true);
});

test('v1 manifest загружается один раз и становится единственной точной шкалой', async (t) => {
  const manifestId = `manifest-${'a'.repeat(32)}`;
  const videoId = 'final-abcdefabcdef';
  const manifest = {
    version: 1,
    projectId: 'projectabcdef',
    inputHash: 'b'.repeat(32),
    mode: 'exact',
    totalMs: 10_000,
    video: {
      id: videoId,
      contentHash: 'c'.repeat(32),
      byteSize: 2048,
      durationMs: 10_000,
    },
    subtitles: null,
    scenes: [{
      id: 'scene-1',
      order: 1,
      caption: 'Обзор',
      startMs: 0,
      endMs: 10_000,
      durationMs: 10_000,
      planHash: 'd'.repeat(32),
      mode: 'exact',
      quality: 'word-exact',
      phrases: [{ id: 'phrase-1', text: 'Открываем обзор.', startMs: 400, endMs: 2_000 }],
      cues: [],
    }],
    subtitleCues: [],
  };
  const gets = [];
  let acceptManifest;
  const response = new Promise((resolve) => {
    acceptManifest = resolve;
  });
  const { store, loadShowcaseManifest } = await sectionFixture(t, {
    get: async (path) => {
      gets.push(path);

      return response;
    },
  });

  store.setOpened({
    id: manifest.projectId,
    latestFinal: { manifestVersion: 1, manifestId, video: { id: videoId } },
  });

  const first = loadShowcaseManifest(store);
  const second = loadShowcaseManifest(store);

  acceptManifest(manifest);

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(gets, [
    `/api/showcase/${manifest.projectId}/manifests/${manifestId}`,
  ]);
  assert.equal(store.manifestStatus, 'ready');
  assert.equal(store.currentManifest?.scenes[0].phrases[0].startMs, 400);
});

test('битый v1 manifest отключает точные переходы, но не портит проект', async (t) => {
  const manifestId = `manifest-${'a'.repeat(32)}`;
  const { store, loadShowcaseManifest } = await sectionFixture(t, {
    get: async () => ({ version: 1, projectId: 'projectabcdef' }),
  });

  store.setOpened({
    id: 'projectabcdef',
    latestFinal: {
      manifestVersion: 1,
      manifestId,
      video: { id: 'final-abcdefabcdef' },
    },
  });
  store.setError('прежняя ошибка');

  assert.equal(await loadShowcaseManifest(store), false);
  assert.equal(store.manifestStatus, 'failed');
  assert.equal(store.currentManifest, null);
  assert.equal(store.opened?.id, 'projectabcdef');
  assert.equal(store.error, 'прежняя ошибка', 'производный JSON не отправляет проект в quarantine');
});

// Сводка хода несёт подпись и причину: без них человек видел бы красную точку с
// прежней подписью, а за текстом отказа ходил бы отдельным чтением обзора.
test('сводка прогресса приносит подпись хода и причину отказа', async (t) => {
  const { store, emit, loadShowcase, watchShowcase } = await sectionFixture(t, {
    get: async () => OVERVIEW,
  });

  watchShowcase(store);
  await loadShowcase(store);

  emit('showcase-progress', {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'running',
    sequence: 3,
    label: 'пишем сцену «Обзор»',
    index: 2,
    total: 3,
  });
  assert.equal(store.jobsOf('project-1')[0].progress.label, 'пишем сцену «Обзор»');
  assert.deepEqual(
    store.jobsOf('project-1')[0].progress,
    { index: 2, total: 3, label: 'пишем сцену «Обзор»' },
  );
  assert.equal(store.jobsOf('project-1')[0].error, null);

  emit('showcase-progress', {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'failed',
    sequence: 4,
    label: 'сцена не записалась',
    error: 'сцена «Обзор» не записалась: браузер умер.',
  });
  assert.equal(store.jobsOf('project-1')[0].state, 'failed');
  assert.equal(store.jobsOf('project-1')[0].error, 'сцена «Обзор» не записалась: браузер умер.');
});

test('словарь ударений уходит текстом целиком и возвращается с ошибками строк', async (t) => {
  const saved = [];
  const { store, loadShowcaseDictionary, saveShowcaseDictionary } = await sectionFixture(t, {
    get: async () => ({ text: '', entries: [], errors: [] }),
    put: async (path, body) => {
      saved.push([path, body]);

      return {
        text: body.text,
        entries: ['дин+амика'],
        errors: [{ line: 2, text: 'плохо', reason: 'нет знака ударения «+»' }],
      };
    },
  });

  await loadShowcaseDictionary(store);

  assert.deepEqual(store.dictionary, { text: '', entries: [], errors: [] });
  assert.equal(await saveShowcaseDictionary(store, 'дин+амика\nплохо\n'), true);
  assert.deepEqual(saved, [['/api/showcase/voices/dictionary', { text: 'дин+амика\nплохо\n' }]]);
  assert.deepEqual(store.dictionary.entries, ['дин+амика']);
  assert.equal(store.dictionary.errors[0].line, 2, 'негодная строка показана, а не потеряна');
  assert.equal(store.error, '');
});

const READY_PROJECT = {
  schemaVersion: 1,
  id: 'project-1',
  title: 'Ролик о готовой работе',
  revision: 4,
  ref: { kind: 'sandbox', id: '990001' },
  target: {
    status: 'ready',
    ref: { kind: 'sandbox', id: '990001' },
    scope: {
      targetKind: 'sandbox',
      targetLabel: 'стенд 990001',
      profile: 'demo-profile',
      viewUrl: null,
      environment: 'read-only',
      capabilities: ['record'],
      screens: [],
      targetFingerprint: 'target',
      policyRevision: 'policy',
      dataRevision: 'data',
      buildRevision: null,
    },
  },
  brief: [],
  scenes: [],
  decisions: [],
  latestFinal: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
};

const SOURCE_OPTIONS = {
  taskAvailable: true,
  noteMax: 2000,
  defaults: {
    task: true,
    note: '',
    code: true,
    repos: [],
  },
  requiresExplicitSelectionConfirmation: false,
  selectedOutsideCatalog: [],
  repos: [],
};

test('выбор «О чём ролик» читается справкой, а сохраняется с редакцией ролика', async (t) => {
  const requests = [];
  const source = {
    task: false,
    note: 'Упор на фильтры',
    code: true,
    repos: null,
  };
  const { store, loadShowcaseSource, saveShowcaseSource, showcaseSourceOutdated } = await sectionFixture(t, {
    get: async (path) => {
      requests.push(['get', path]);

      return SOURCE_OPTIONS;
    },
    put: async (path, body) => {
      requests.push(['put', path, body]);

      return {
        ...READY_PROJECT,
        revision: 5,
        source,
      };
    },
  });

  store.setOpened(READY_PROJECT);

  const read = await loadShowcaseSource(store.opened);
  const saved = await saveShowcaseSource(store, {
    id: READY_PROJECT.id,
    revision: READY_PROJECT.revision,
    source,
  });

  assert.equal(read.error, '');
  assert.equal(read.options.noteMax, 2000);
  assert.equal(saved.revision, 5, 'операция отдаёт сохранённый ролик');
  assert.deepEqual(requests, [
    ['get', '/api/showcase/project-1/source'],
    ['put', '/api/showcase/project-1/source', { expectedRevision: 4, source }],
  ]);
  assert.equal(store.opened.revision, 5);
  assert.deepEqual(store.opened.source, source);
  assert.equal(showcaseSourceOutdated(store.opened), false, 'без сцен устаревать нечему');
  assert.equal(
    showcaseSourceOutdated({ ...store.opened, scenes: [{ id: 'scene-1' }] }),
    true,
    'сцены собраны по другому выбору',
  );
});

test('отказ чтения выбора остаётся у блока, а не становится ошибкой раздела', async (t) => {
  const { store, loadShowcaseSource } = await sectionFixture(t, {
    get: async () => {
      throw { data: { error: 'target_busy', message: 'Стенд сейчас поднимается или сносится.' } };
    },
  });

  store.setOpened(READY_PROJECT);

  const read = await loadShowcaseSource(store.opened);

  assert.equal(read.options, null);
  assert.equal(read.error, 'Стенд сейчас поднимается или сносится.');
  assert.equal(store.error, '', 'общая строка ошибки раздела не загорается');
});

/**
 * Обещание с ручным исходом: тест держит ответ сервера, пока человек переходит к другому
 * ролику, и только потом отпускает его.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

const OTHER_PROJECT = {
  ...READY_PROJECT,
  id: 'project-2',
  title: 'Другой ролик',
};

test('поздний ответ сохранения выбора не открывает прежний ролик поверх нового', async (t) => {
  const answer = deferred();
  const failure = deferred();
  const replies = [answer, failure];
  const source = {
    task: true,
    note: 'Упор на фильтры',
    code: true,
    repos: null,
  };
  const { store, saveShowcaseSource } = await sectionFixture(t, {
    put: async () => replies.shift().promise,
  });

  store.setOpened(READY_PROJECT);

  const late = saveShowcaseSource(store, {
    id: READY_PROJECT.id,
    revision: 4,
    source,
  });

  store.setOpened(OTHER_PROJECT);
  answer.resolve({
    ...READY_PROJECT,
    revision: 5,
    source,
  });

  assert.equal((await late).revision, 5, 'сохранение своего ролика состоялось');
  assert.equal(store.opened.id, 'project-2', 'открытым остался ролик, к которому перешёл человек');

  store.setOpened(READY_PROJECT);

  const refused = saveShowcaseSource(store, {
    id: READY_PROJECT.id,
    revision: 5,
    source,
  });

  store.setOpened(OTHER_PROJECT);
  failure.reject({ data: { error: 'script_busy', message: 'Сценарий этого ролика уже готовится.' } });

  assert.equal(await refused, null);
  assert.equal(store.error, '', 'отказ прежнего ролика не зажигает ошибку нового');
});

test('конфликт редакции перечитывает ролик и называет причину, а не применяет выбор', async (t) => {
  const requests = [];
  const fresh = {
    ...READY_PROJECT,
    revision: 7,
  };
  const { store, saveShowcaseSource } = await sectionFixture(t, {
    put: async () => {
      const message = 'Ролик изменился в другом месте: сейчас редакция 7.';

      throw { data: { error: 'revision_conflict', message } };
    },
    get: async (path) => {
      requests.push(path);

      return fresh;
    },
  });

  store.setOpened(READY_PROJECT);

  const saved = await saveShowcaseSource(store, {
    id: READY_PROJECT.id,
    revision: 4,
    source: null,
  });

  assert.equal(saved, null);
  assert.deepEqual(requests, ['/api/showcase/project-1'], 'запись перечитана с сервера');
  assert.equal(store.opened.revision, 7);
  assert.match(store.error, /редакция 7/);
});

test('список выбора читается для ролика, который назвал вид, а не для открытого сейчас', async (t) => {
  const requests = [];
  const { store, loadShowcaseSource } = await sectionFixture(t, {
    get: async (path) => {
      requests.push(path);

      return SOURCE_OPTIONS;
    },
  });

  store.setOpened(READY_PROJECT);
  await loadShowcaseSource(OTHER_PROJECT);

  assert.deepEqual(requests, ['/api/showcase/project-2/source']);
});
