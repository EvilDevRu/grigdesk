import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { pluginBootFixture } from '../../server/helpers/pluginBootFixture.js';
import { launchDesktop } from './launch.mjs';
import { startStub } from './stub.mjs';
/**
 * Опрос наблюдаемого состояния без фиксированных пауз; срок — 15 секунд.
 * Образец — waitFor в tests/desktop/e2e/window.e2e.mjs.
 */

export async function waitFor(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;

  while(Date.now() < deadline) {
    if(await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail('Наблюдаемое состояние не достигнуто до срока проверки.');
}
/**
 * Сервер и профиль принадлежат только этому тесту; B24 отвечает синтетическими DTO.
 * Повторный запуск использует тот же профиль, не пересоздавая сервер и состояние API.
 */

export async function toolRun(t, options = {}) {
  const uiDir = process.env.GRIGDESK_E2E_WEB_DIST;
  const desktop = process.env.GRIGDESK_E2E_DESKTOP_APP;

  assert.equal(path.isAbsolute(uiDir || ''), true, 'Нужен собственный абсолютный UI dist');
  assert.equal(path.isAbsolute(desktop || ''), true, 'Нужна собственная исходная сборка Electron');
  await access(path.join(uiDir, 'index.html'));
  await access(path.join(desktop, 'main.cjs'));

  const root = await mkdtemp(path.join(os.tmpdir(), 'task-window-e2e-'));
  const cleanups = [];
  const errors = [];
  let services;
  const requests = [];
  let current;
  let page;

  t.after(async () => {
    try {
      await current?.app.close().catch(() => undefined);
    } finally {
      for(const cleanup of cleanups) {
        await cleanup();
      }

      await rm(root, { recursive: true, force: true });
    }
  });

  const boot = await pluginBootFixture({ after: (callback) => cleanups.push(callback) }, {
    root,
    apiSession: false,
  });
  const dataDir = path.join(root, 'desktop-profile');

  await waitFor(async () => {
    try {
      return (await readFile(boot.env.GRIGDESK_WINDOW_KEY_PATH, 'utf8')).length === 43;
    } catch {
      return false;
    }
  });

  if(options.secondProfile) {
    const secondary = await startStub({ authKey: 'second-profile-fixture-key' });

    cleanups.push(() => secondary.dispose());
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({

      version: 2,

      selected: 'first',

      window: {

        width: 1280,

        height: 860,

        maximized: false,

      },

      profiles: [
        {

          id: 'first',

          name: 'Первая',

          kind: 'local',

          address: boot.address,

          fp: null,

          port: 47101,

          createdAt: 0,

        },
        {

          id: 'second',

          name: 'Вторая',

          kind: 'local',

          address: secondary.address,

          fp: null,

          port: 47102,

          createdAt: 0,

        },
      ],

    }), { mode: 0o600 });
  }

  const ids = options.four ? [42, 43, 44, 45] : [42, 43, 44];
  const tasks = new Map(ids.map((id) => [String(id), {

    id,

    title: 'Задача ' + id,

    description: '<p>Синтетическое описание</p>',

    group: id === 42 ? '' : 'Проект',

    priority: 0,

    responsible: 'Исполнитель',

    responsibleId: 1,

    status: 'IN_PROGRESS',

    statusKind: 'active',

    unread: 0,

    timerRunning: false,

    timerElapsed: 0,

    timerStartedAt: null,

  }]));
  const seen = {

    scope: 'fixture',

    revision: 1,

    taskIds: [],

    initialized: true,

  };
  const favorites = {

    scope: 'fixture',

    revision: 1,

    taskIds: [],

  };
  const shelf = {

    scope: 'fixture',

    revision: 1,

    entries: ['42', '99'].map(shelfEntry),

  };
  const comments = new Map(ids.map((id) => [String(id), []]));
  const launched = new Map();
  const launchCalls = [];
  const shelfPuts = [];
  const surfaceStreams = [];
  const surfaceDashboards = [];
  const childDetails = [];
  const policyRequests = [];
  const activeStreams = new Map();

  /**
   * Перезапуск закрывает только свой Electron, сохраняя settings.json и собственный сервер.
   * Перехваты устанавливаются до reload каждого документа, включая новые карточки.
   */
  async function launch() {
    await current?.app.close().catch(() => undefined);
    current = await launchDesktop({

      root,

      dataDir,

      args: [desktop, '--password-store=gnome-libsecret', '--grigdesk-url=' + boot.address],

      isolateEnv: true,

      env: {

        GRIGDESK_HOME: root,

        GRIGDESK_WINDOW_KEY_PATH: boot.env.GRIGDESK_WINDOW_KEY_PATH,

        GRIGDESK_CLIENT_UI_DIR: uiDir,

      },

    });
    page = current.page;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => requests.push(request.url()));

    const context = page.context();

    await context.addInitScript(() => {
      const NativeEventSource = window.EventSource;

      window.__taskSources = [];
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          window.__taskSources.push(this);
        }
      };
    });
    await context.route('**/api/chat/store', async (route) => {
      if(route.request().method() !== 'GET') {
        await route.fallback();

        return;
      }

      const response = await route.fetch();
      const payload = await response.json();

      await route.fulfill({
        json: {

          ...payload,

          activeId: 'fixture-chat',

          sessions: [{

            id: 'fixture-chat',

            title: 'Синтетический разговор',
            // Ответ после reload новее снимка, созданного первым запуском main.
            // История проходит штатное сравнение свежести без очистки localStorage.

            updatedAt: Date.now(),

            messages: [{ role: 'user', text: 'Сохранить разговор при переходе' }, {
              role: 'assistant', text: '[Открыть файл](' + path.join(root, 'repo-task/src/a.ts') + ':4)',
            }],

          }],

        }
      });
    });
    await context.route('**/api/plugins', (route) => route.fulfill({
      json: {
        plugins: ['code', 'ssh', 'db', 'docker', 'studio3d', 'terminal', 'b24'].map((id) => ({

          id,

          name: id,

          enabled: true,

          system: true,

          values: {},

          placements: [],

          nav: {
            path: '/' + id,
            label: id,
            icon: id,
            group: 'dock',
            order: 1

          },

        })).concat([{

          id: 'shelf',

          nav: {
            path: '/shelf',
            label: 'Полка',
            icon: 'shelf',
            group: 'dock',
            order: 2

          },

          name: 'Полка',

          enabled: true,

          system: true,

          values: { browserNotifications: true },

          placements: [],

        }, {

          id: 'example',

          name: 'Пример',

          enabled: true,

          system: false,

          web: '/api/ext/example/web/',

          values: {},

          placements: [],

          nav: {

            path: '/example',

            label: 'Пример',

            icon: 'plugin',

            group: 'dock',

            order: 1

          },

        }]),
      }
    }));
    await context.route('**/api/tracker/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const detail = pathname.match(/^\/api\/tracker\/task\/([0-9]+)$/);
      const timer = pathname.match(/^\/api\/tracker\/task\/([0-9]+)\/timer\/(start|pause)$/);
      const favorite = pathname.match(/^\/api\/tracker\/task-favorites\/([0-9]+)$/);
      const shelfTask = pathname.match(/^\/api\/tracker\/task-shelf\/([0-9]+)$/);
      const comment = pathname.match(/^\/api\/tracker\/task\/([0-9]+)\/(comment|comments)$/);
      let result = {};

      if(pathname === '/api/tracker/dashboard') {
        result = {

          today: { hours: 0, tasks_count: 0 },

          month: { hours: 0, norm: 160 },

          tasks: [...tasks.values()],

          toReview: [],

          created: [],

          accomplice: [],

          auditor: [],

          stages: [],

          projects: [],

        };
      } else if(timer) {
        const task = tasks.get(timer[1]);

        task.timerRunning = timer[2] === 'start';
        task.timerStartedAt = task.timerRunning ? Math.floor(Date.now() / 1000) : null;
      } else if(detail) {
        const task = tasks.get(detail[1]) || {

          id: Number(detail[1]),

          title: 'Вне доски',

          group_name: 'Проект',

        };

        if(request.method() === 'PUT') {
          Object.assign(task, request.postDataJSON());
        }

        result = task;
      } else if(pathname === '/api/tracker/task-seen') {
        if(request.method() === 'POST') {
          seen.taskIds = [...new Set([...seen.taskIds, ...(request.postDataJSON().taskIds || [])])];
          seen.revision += 1;
        }

        result = seen;
      } else if(pathname === '/api/tracker/task-favorites' || favorite) {
        if(favorite && request.method() !== 'GET') {
          favorites.taskIds = favorites.taskIds.filter((id) => id !== favorite[1]);

          if(request.method() === 'PUT') {
            favorites.taskIds.push(favorite[1]);
          }

          favorites.revision += 1;
        }

        result = favorites;
      } else if(pathname === '/api/tracker/task-shelf' || shelfTask) {
        if(shelfTask) {
          const id = shelfTask[1];

          if(request.method() === 'DELETE') {
            shelf.entries = shelf.entries.filter((entry) => entry.taskId !== id);
          } else if(request.method() === 'PUT') {
            const body = request.postDataJSON();
            const old = shelf.entries.find((entry) => entry.taskId === id);

            shelfPuts.push({

              id,

              body,

              page: request.frame().page(),

            });

            if(old) {
              old.snapshot = body.snapshot;
            } else if(body.createIfMissing) {
              shelf.entries.push({

                ...shelfEntry(id),

                title: body.title,

                snapshot: body.snapshot,

              });
            }
          }

          shelf.revision += 1;
        }

        result = shelf;
      } else if(comment) {
        const rows = comments.get(comment[1]);

        if(request.method() === 'POST') {
          rows.push({

            mid: String(rows.length + 1),

            author: 'Фикстура',

            time: '',

            text: request.postDataJSON().text,

          });
        }

        result = { comments: rows };
      } else if(pathname === '/api/tracker/users') {
        result = { users: [{ id: 1, name: 'Исполнитель' }] };
      } else if(pathname === '/api/tracker/groups') {
        result = { groups: [] };
      }

      await route.fulfill({ json: result });
    });
    await context.route('**/api/tasks', (route) => route.fulfill({
      json: {
        tasks: [
          {

            task: '42',

            route: 'fixture',

            attempt: 'a1',

            daemonAlive: true,

          },
          ...launched.values(),
        ],
      }
    }));
    await context.route('**/api/tasks/*/graph', (route) => route.fulfill({
      json: {

        route: 'fixture',

        statuses: {},

        nodes: {},

        pos: { gate_fixture: [0, 0] },

      }
    }));
    await context.route('**/api/tasks/*/diff', (route) => route.fulfill({ json: { repos: [] } }));
    await context.route('**/api/tasks/*/launch-options*', (route) => route.fulfill({
      json: {

        profile: 'fixture',

        profiles: ['fixture'],

        routes: ['feature'],

        defaultRoute: 'feature',

        routeOptions: { feature: { deliveryMode: 'publish', instrumentationRequired: false } },

        repositories: [{ name: 'fixture', targetBranch: 'dev' }],

        profileContractError: null,

      }
    }));
    await context.route('**/api/tasks/*/launch', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[3];
      const body = route.request().postDataJSON();

      launchCalls.push({ id, body });
      launched.set(id, {

        task: id,

        route: body.route,

        attempt: 'synthetic-launch',

        daemonAlive: true,

      });
      await route.fulfill({
        json: {

          outcome: 'launched',

          profile: body.profile,

          route: body.route,

          attempt: 'synthetic-launch',

        }
      });
    });
    context.on('request', (request) => {
      let owner;

      try {
        owner = request.frame().page();
      } catch {
        return;
      }

      const url = new URL(request.url());
      const surface = request.frame().url().includes('?surface=task');
      const stream = url.pathname === '/api/events'
        || (url.pathname === '/__shell/state' && url.searchParams.has('rev'));

      if(stream) {
        activeStreams.set(request, owner);

        if(surface) {
          surfaceStreams.push(url.pathname);
        }
      }
      if(surface && url.pathname === '/api/tracker/dashboard') {
        surfaceDashboards.push(owner);
      }
      if(surface && request.method() === 'GET' && /^\/api\/tracker\/task\/\d+$/.test(url.pathname)) {
        childDetails.push({ owner, path: url.pathname });
      }
      if(url.pathname === '/api/settings/factory-debug' && request.method() === 'GET') {
        policyRequests.push(owner);
      }
    });
    context.on('requestfinished', (request) => activeStreams.delete(request));
    context.on('requestfailed', (request) => activeStreams.delete(request));

    const localeStatus = await page.evaluate(async () => (await fetch('/__shell/locale', {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ preference: 'ru' }),

    })).status);

    assert.equal(localeStatus, 200, 'Фикстура задаёт язык через native-источник bootstrapUiLocale');

    const { installServices, observeAlerts } = await import('./tool-window-services.mjs');

    services = await installServices(context);
    await observeAlerts(context);
    await installToolApi(context, root, options);
    await page.reload();
    await page.goto(new URL('/#/chats', page.url()).href);

    try {
      await page.locator('.tool-rail').waitFor();
      await writeFile(path.join(process.env.GRIGDESK_E2E_ARTIFACTS, 'tool-ready.json'),
        JSON.stringify({

          errors,

          plugins: await page.evaluate(() => {
            const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

            return pinia._s.get('plugins')?.list;
          }),

          body: await page.locator('body').innerText(),

          rail: await page.locator('.tool-rail-item').evaluateAll(items => items.map(item => item.outerHTML))

        }, null, 2));
    } catch(error) {
      await writeFile(path.join(process.env.GRIGDESK_E2E_ARTIFACTS, 'tool-preflight.json'),
        JSON.stringify({

          errors,

          requests,

          body: await page.locator('body').innerText()

        }, null, 2));

      throw error;
    }

    return current;
  }

  await launch();

  return {

    root,

    services,

    errors,

    app: current.app,

    page,

    tasks,

    dataDir,

    shelf,

    shelfPuts,

    launchCalls,

    surfaceStreams,

    surfaceDashboards,

    childDetails,

    policyRequests,

    activeStreams,

    relaunch: launch,

  };
}

/**
 * Запись вне доски и задача без group заставили бы непассивную полку читать детали.
 * Полный DTO совпадает с контрактом API и сохраняет начальную базу ворот конвейера.
 */
function shelfEntry(taskId) {
  return {

    taskId,

    title: 'Задача ' + taskId,

    addedAt: '2026-08-26T08:00:00.000Z',

    reason: 'manual',

    snapshot: {

      analysis: null,

      pipeline: {

        attempt: 'a1',

        daemon: 'running',

        result: null,

        stall: null,

        gateKnown: true,

        gate: null,

      },

      b24: {

        present: true,

        status: 'IN_PROGRESS',

        statusKind: 'active',

        unread: 0,

      },

    },

  };
}

/**
 * Одинаковые относительные имена существуют в двух собственных деревьях теста.
 * API возвращает байты выбранного root; смена root проверяется видимым текстом Monaco.
 */
export async function installToolApi(context, root, options) {
  const main = path.join(root, 'repo');
  const worktree = path.join(root, 'repo-task');

  for(const [folder, prefix] of [[main, 'MAIN'], [worktree, 'WORKTREE']]) {
    await mkdir(path.join(folder, 'src'), { recursive: true });
    await writeFile(path.join(folder, 'src/a.ts'), `${prefix}\nsecond\nthird\nfourth\nfifth\n`);
  }

  await context.route('**/api/projects', (route) => route.fulfill({
    json: {
      projects: [{ id: 'demo', repos: [{ key: 'demo', dir: main }] }],
    }
  }));
  await context.route('**/api/code/roots', (route) => route.fulfill({
    json: {
      roots: [
        {
          project: 'demo',
          repo: 'demo',
          root: main,
          main: true,
          branch: 'dev',
        },
        {
          project: 'demo',
          repo: 'demo',
          root: worktree,
          main: false,
          branch: 'task-42',
        },
      ],
    },
  }));
  await context.route('**/api/code/demo/**', async (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('root') === worktree ? worktree : main;
    let result;

    if(url.pathname.endsWith('/repos')) {
      result = {
        repos: [{

          key: 'demo',

          dir: main,

          trees: [
            {

              path: main,

              main: true,

              name: 'Основная',

              branch: 'dev',

              task: ''

            },
            {

              path: worktree,

              main: false,

              name: 'Задача',

              branch: 'task-42',

              task: 't42'

            },
          ]

        }]
      };
    } else if(url.pathname.endsWith('/ls')) {
      const dir = url.searchParams.get('dir') || '';

      result = { entries: dir ? [{ name: 'a.ts', dir: false }] : [{ name: 'src', dir: true }] };
    } else if(url.pathname.endsWith('/file')) {
      const content = await readFile(path.join(source, 'src/a.ts'), 'utf8');

      result = {

        size: content.length,

        binary: false,

        tooBig: false,

        content

      };
    } else if(url.pathname.endsWith('/git')) {
      result = {

        branch: source === worktree ? 'task-42' : 'dev',

        stat: '',

        files: [],

        staged: [],

        log: [],

        tracking: {

          detached: false,

          upstream: '',

          ahead: 0,

          behind: 0

        },

      };
    } else {
      result = { entries: [], patch: '' };
    }

    await route.fulfill({ json: result });
  });
  await context.route('**/api/ext/example/web/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<header id="plugin-heading">Заголовок страницы до правого края</header>'
      + '<p id="api-result"></p><script>fetch("/api/projects").then(r=>r.json()).then(v=>'
      + 'document.querySelector("#api-result").textContent=v.projects[0].id)</script>',
  }));

  if(options.configure) {
    await options.configure(context, { main, worktree });
  }
}
