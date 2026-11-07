// Раздел «Проекты»: состояние отделено от ввода-вывода.
//
// Стор держит только состав раздела, сеть и события сервера живут в слое операций
// (`web/src/actions/projects`). Проверяется поведение этой пары на двойниках общего
// клиента и общего SSE: настоящими остаются декодеры контракта и стор.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const ACTIONS_PATH = webFile('src/actions/projects/index.ts');

const SUMMARY = {
  id: 'demo',
  title: 'Демо-проект',
  tags: ['метка'],
  repos: [{ key: 'be', dir: '/srv/be', exists: true }],
  defaultRepoKey: 'be',
  archivedAt: null,
  revision: 3,
  updatedAt: '2026-09-22T10:00:00.000Z',
  profile: { present: false, pathsSource: 'passport' },
  importStatus: 'none',
  routes: [],
  warnings: [],
};

const DETAIL = {
  ...SUMMARY,
  description: 'Описание проекта',
  createdAt: '2026-09-22T09:00:00.000Z',
  import: { status: 'none', fingerprint: null, at: null, error: null, candidates: null },
  profile: {
    present: false,
    pathsSource: 'passport',
    readable: null,
    repos: [],
    capabilities: [],
    mismatch: [],
  },
};

const CHECK = { dir: '/srv/be', state: 'git', message: 'Рабочая копия git' };

// Двойник общего SSE: подписчик складывается в набор, чтобы тест мог прислать кадр.
const SSE_STUB = 'export const sseSubscribe = (fn) => {'
  + ' globalThis.__projectsStoreHarness.listeners.add(fn);'
  + ' return () => globalThis.__projectsStoreHarness.listeners.delete(fn);'
  + '};';

/**
 * Слой операций поднимается на двойниках HTTP-клиента и SSE, стор — настоящий.
 * Подписчик события сохраняется, чтобы тест мог прислать кадр так же, как сервер.
 */
async function sectionFixture(t, api) {
  globalThis.__projectsStoreHarness = { api, listeners: new Set() };

  const module = await compileModule(ACTIONS_PATH, {
    stubs: {
      // Спецификаторы — ровно те, что просят транспорт раздела и подписка на события.
      './apiClient.ts': 'export const api = globalThis.__projectsStoreHarness.api;',
      '../../composables/useSse': SSE_STUB,
      '../../composables/useSse.ts': SSE_STUB,
    },
  });

  setActivePinia(createPinia());

  const store = module.useProjectsStore();
  const emit = (name, data) => {
    for (const fn of globalThis.__projectsStoreHarness.listeners) {
      fn(name, data);
    }
  };

  t.after(() => {
    delete globalThis.__projectsStoreHarness;
  });

  return { store, emit, ...module };
}

function deferred() {
  let resolve;

  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function apiWith({ summaries = [SUMMARY], detail = DETAIL, check = [CHECK], put } = {}) {
  return {
    get: async (path) => {
      if (path === '/api/projects') return { projects: summaries };
      if (path.startsWith('/api/projects/')) return detail;

      throw new Error(`неожиданный путь ${path}`);
    },
    post: async (path) => {
      if (path === '/api/project-tools/repositories/check') return { results: check };

      return detail;
    },
    put: put ?? (async () => detail),
  };
}

test('loadProjects складывает проверенные сводки, отказ декодера не стирает список', async (t) => {
  let payload = { projects: [SUMMARY] };
  const { store, loadProjects } = await sectionFixture(t, {
    ...apiWith(),
    get: async () => payload,
  });

  await loadProjects();

  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].title, 'Демо-проект');
  assert.equal(store.error, '');

  payload = { projects: [{ ...SUMMARY, revision: 1.5 }] };
  await loadProjects();

  assert.match(store.error, /проект/i);
  assert.equal(store.items[0].title, 'Демо-проект', 'прежний список остаётся на месте');
});

test('projects-changed перечитывает список, hello — список и открытый паспорт', async (t) => {
  const calls = [];
  const api = apiWith();
  const { store, loadProjects, loadProject, watchProjects, emit } = await sectionFixture(t, {
    ...api,
    get: async (path) => {
      calls.push(path);

      return api.get(path);
    },
  });

  watchProjects();
  await loadProjects();
  await loadProject('demo');
  calls.length = 0;

  emit('projects-changed', { id: 'demo', revision: 4, kind: 'updated' });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(calls, ['/api/projects']);
  assert.equal(store.opened.revision, 3);

  emit('hello', null);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(calls, ['/api/projects', '/api/projects', '/api/projects/demo']);
});

test('поздний ответ старого запроса не заменяет свежий', async (t) => {
  const slow = deferred();
  let call = 0;
  const api = apiWith();
  const { store, loadProjects } = await sectionFixture(t, {
    ...api,
    get: async (path) => {
      call += 1;

      if (call === 1) {
        await slow.promise;

        return { projects: [{ ...SUMMARY, title: 'Старый ответ' }] };
      }

      return api.get(path);
    },
  });

  const first = loadProjects();
  const second = loadProjects();

  await second;
  slow.resolve();
  await first;

  assert.equal(store.items[0].title, 'Демо-проект', 'поздний ответ старого запроса отброшен');
});

test('событие и перечитывание не трогают draft', async (t) => {
  const { store, loadProject, watchProjects, emit } = await sectionFixture(t, apiWith());

  watchProjects();
  await loadProject('demo');
  store.draft.title = 'Правка человека';

  emit('projects-changed', { id: 'demo', revision: 4, kind: 'updated' });
  emit('hello', null);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.equal(store.draft.title, 'Правка человека');
  assert.equal(store.draft.defaultRepoRequired, false);
});

test('saveProject при 409 revision_conflict кладёт currentRevision и изменённые поля', async (t) => {
  const conflict = Object.assign(new Error('Паспорт изменился'), {
    status: 409,
    data: {
      error: 'revision_conflict',
      message: 'Паспорт изменился после того, как форма его прочитала.',
      currentRevision: 5,
    },
  });
  const { store, loadProject, saveProject } = await sectionFixture(t, apiWith({
    put: async () => {
      throw conflict;
    },
  }));

  await loadProject('demo');
  store.draft.title = 'Правка';
  store.draft.description = 'Правка описания';

  await saveProject('demo', store.draft);

  assert.deepEqual(store.conflict, {
    currentRevision: 5,
    changedFields: ['title', 'description'],
  });
  assert.match(store.error, /Обновите|изменил/i);
});

test('saveProject отправляет ревизию снимка и обновляет его после сохранения', async (t) => {
  const sent = [];
  const { store, loadProject, saveProject } = await sectionFixture(t, {
    ...apiWith(),
    put: async (path, body) => {
      sent.push({ path, body });

      return { ...DETAIL, title: body.title, revision: 4 };
    },
  });

  await loadProject('demo');
  store.draft.title = 'Новое название';
  await saveProject('demo', store.draft);

  assert.equal(sent[0].body.expectedRevision, 3);
  assert.equal(sent[0].body.title, 'Новое название');
  assert.equal('defaultRepoRequired' in sent[0].body, false);
  assert.equal(store.opened.revision, 4);
  assert.equal(store.draft.title, 'Новое название');
  assert.equal(store.conflict, null);
});

test('checkRepositories: устаревший результат не применяется к уже изменённому пути', async (t) => {
  const slow = deferred();
  let call = 0;
  const { store, checkRepositories } = await sectionFixture(t, {
    ...apiWith(),
    post: async () => {
      call += 1;

      if (call === 1) {
        await slow.promise;

        return { results: [{ dir: '/srv/старый', state: 'git', message: 'Рабочая копия git' }] };
      }

      return { results: [CHECK] };
    },
  });

  const first = checkRepositories(['/srv/старый'], { debounceMs: 0 });

  // Даём таймеру сработать: запрос по старому пути уже ушёл и ждёт ответа.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  const second = checkRepositories(['/srv/be'], { debounceMs: 0 });

  await second;
  slow.resolve();
  await first;

  assert.deepEqual(store.checks, { '/srv/be': { state: 'git', message: 'Рабочая копия git' } });
});

test('повторный вызов проверки в окне склейки отменяет предыдущий запрос', async (t) => {
  const dirs = [];
  const { checkRepositories } = await sectionFixture(t, {
    ...apiWith(),
    post: async (path, body) => {
      dirs.push(body.repos.map((repo) => repo.dir));

      return { results: [CHECK] };
    },
  });

  const first = checkRepositories(['/srv/старый'], { debounceMs: 20 });
  const second = checkRepositories(['/srv/be'], { debounceMs: 20 });

  await Promise.all([first, second]);

  assert.deepEqual(dirs, [['/srv/be']]);
});

test('PD-delete-transport: DELETE кодирует ID, передаёт revision и принимает пустой 204', async (t) => {
  const sent = [];

  globalThis.__pdDeleteApi = {

    del: async (...args) => {
      sent.push(args);

      return undefined;
    },
  };
  t.after(() => {
    delete globalThis.__pdDeleteApi;
  });

  const { projectsApi } = await compileModule(webFile('src/shared/projectsApi.ts'), {
    stubs: { './apiClient.ts': 'export const api = globalThis.__pdDeleteApi;' },
  });

  assert.equal(typeof projectsApi.remove, 'function', 'транспорт удаления отсутствует');
  await projectsApi.remove('id/with space', 3);
  assert.deepEqual(sent, [['/api/projects/id%2Fwith%20space', { expectedRevision: 3 }]]);
});

for (const operation of ['list', 'detail', 'dependencies', 'save', 'archive']) {
  test(`PD-race: поздний ${operation} после deleted не возвращает выбор`, async (t) => {
    const slow = deferred();
    const entered = deferred();
    let pending = false;
    let deleted = false;
    const api = apiWith();
    const dependencies = {
      items: [],
      archivable: true,
      deletable: true,
      reasons: []
    };
    const fixture = await sectionFixture(t, {
      ...api,
      get: async (url) => {
        const kind = url.endsWith('/dependencies')
          ? 'dependencies' : url === '/api/projects' ? 'list' : 'detail';

        if (pending && kind === operation) {
          pending = false;
          entered.resolve();
          await slow.promise;

          return kind === 'list' ? { projects: [SUMMARY] } : kind === 'dependencies' ? dependencies : DETAIL;
        }
        if (url === '/api/projects') {
          return { projects: deleted ? [] : [SUMMARY] };
        }

        return kind === 'dependencies' ? dependencies : DETAIL;
      },
      put: async () => {
        entered.resolve();
        await slow.promise;

        return DETAIL;
      },
      post: async () => {
        entered.resolve();
        await slow.promise;

        return { ...DETAIL, archivedAt: '2026-10-20T10:00:00.000Z' };
      },
    });
    const { store, loadProject, loadProjects, loadDependencies,
      saveProject, archiveProject, watchProjects, emit } =
      fixture;

    await loadProjects();
    await loadProject('demo');
    watchProjects();
    pending = true;

    const request = operation === 'list' ? loadProjects()
      : operation === 'detail' ? loadProject('demo')
        : operation === 'dependencies' ? loadDependencies('demo')
          : operation === 'save' ? saveProject('demo', store.draft)
            : archiveProject('demo', { expectedRevision: 3 });

    await entered.promise;
    deleted = true;
    emit('projects-changed', {
      id: 'demo',
      revision: 4,
      kind: 'deleted'
    });
    slow.resolve();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.opened?.id ?? null, null);
    assert.equal(store.items.some((item) => item.id === 'demo'), false);
    assert.equal(store.dependencies, null);
  });
}

test('PD-hello: успешный свежий список обнаруживает пропущенное удаление', async (t) => {
  let removed = false;
  const api = apiWith();
  const { store, loadProjects, loadProject, watchProjects, emit } = await sectionFixture(t, {
    ...api,
    get: async (url) => url === '/api/projects' ? { projects: removed ? [] : [SUMMARY] } : DETAIL,
  });

  await loadProjects();
  await loadProject('demo');
  watchProjects();
  removed = true;
  emit('hello', null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.opened?.id ?? null, null);
  assert.equal(store.draft, null);
});

test('PD-neighbor: updated и чужой deleted сохраняют dirty', async (t) => {
  const { store, loadProject, watchProjects, emit } = await sectionFixture(t, apiWith());

  await loadProject('demo');
  store.draft.title = 'Несохранённый текст';
  watchProjects();
  emit('projects-changed', {
    id: 'demo',
    revision: 4,
    kind: 'updated'
  });
  emit('projects-changed', {
    id: 'other',
    revision: 2,
    kind: 'deleted'
  });
  emit('projects-changed', { unexpected: 'данные' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.opened.id, 'demo');
  assert.equal(store.draft.title, 'Несохранённый текст');
});

test('PD-failure: ошибка DELETE сохраняет паспорт, показывает причину и допускает повтор', async (t) => {
  let fail = true;
  let checks = 0;
  const { store, loadProject, removeProject } = await sectionFixture(t, {
    ...apiWith(),
    get: async (url) => {
      if (url.endsWith('/dependencies')) {
        checks += 1;

        return {
          items: [],
          archivable: true,
          deletable: false,
          reasons: ['Подключение SSH']
        };
      }

      return url === '/api/projects' ? { projects: [] } : DETAIL;
    },
    del: async () => {
      if (fail) {
        throw Object.assign(new Error('Переназначьте подключение SSH'), {
          status: 409,
          data: { error: 'has_dependencies', message: 'Переназначьте подключение SSH' },
        });
      }
    },
  });

  await loadProject('demo');
  assert.equal(typeof removeProject, 'function', 'операция удаления отсутствует');

  const rejected = await removeProject('demo', { expectedRevision: 3 });

  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /Переназначьте подключение SSH/);
  assert.equal(store.opened.id, 'demo');
  assert.equal(checks, 1);
  fail = false;

  const repeated = await removeProject('demo', { expectedRevision: 3 });

  assert.equal(repeated.ok, true);
  assert.equal(store.opened, null);
});
