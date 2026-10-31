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
async function waitFor(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await predicate()) {
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
async function taskRun(t, options = {}) {
  const uiDir = process.env.GRIGDESK_E2E_WEB_DIST;
  const desktop = process.env.GRIGDESK_E2E_DESKTOP_APP;

  assert.equal(path.isAbsolute(uiDir || ''), true, 'Нужен собственный абсолютный UI dist');
  assert.equal(path.isAbsolute(desktop || ''), true, 'Нужна собственная исходная сборка Electron');
  await access(path.join(uiDir, 'index.html'));
  await access(path.join(desktop, 'main.cjs'));

  const root = await mkdtemp(path.join(os.tmpdir(), 'task-window-e2e-'));
  const cleanups = [];
  let current;
  let page;

  t.after(async () => {
    try {
      await current?.app.close().catch(() => undefined);
    } finally {
      for (const cleanup of cleanups) {
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

  if (options.secondProfile) {
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
    responsible: { id: 1, name: 'Исполнитель' },
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
      if (route.request().method() !== 'GET') {
        await route.fallback();

        return;
      }

      const response = await route.fetch();
      const payload = await response.json();

      await route.fulfill({ json: {
        ...payload,
        activeId: 'fixture-chat',
        sessions: [{
          id: 'fixture-chat',
          title: 'Синтетический разговор',
          // Ответ после reload новее снимка, созданного первым запуском main.
          // История проходит штатное сравнение свежести без очистки localStorage.
          updatedAt: Date.now(),
          messages: [{ role: 'user', text: 'Сохранить разговор при переходе' }],
        }],
      } });
    });
    await context.route('**/api/plugins', (route) => route.fulfill({ json: {
      plugins: [{
        id: 'shelf',
        name: 'Полка',
        enabled: true,
        system: true,
        values: { browserNotifications: true },
        placements: [],
      }],
    } }));
    await context.route('**/api/tracker/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const detail = pathname.match(/^\/api\/tracker\/task\/([0-9]+)$/);
      const timer = pathname.match(/^\/api\/tracker\/task\/([0-9]+)\/timer\/(start|pause)$/);
      const favorite = pathname.match(/^\/api\/tracker\/task-favorites\/([0-9]+)$/);
      const shelfTask = pathname.match(/^\/api\/tracker\/task-shelf\/([0-9]+)$/);
      const comment = pathname.match(/^\/api\/tracker\/task\/([0-9]+)\/(comment|comments)$/);
      let result = {};

      if (pathname === '/api/tracker/dashboard') {
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
      } else if (timer) {
        const task = tasks.get(timer[1]);

        task.timerRunning = timer[2] === 'start';
        task.timerStartedAt = task.timerRunning ? Math.floor(Date.now() / 1000) : null;
      } else if (detail) {
        const task = tasks.get(detail[1]) || {
          id: Number(detail[1]),
          title: 'Вне доски',
          group_name: 'Проект',
        };

        if (request.method() === 'PUT') {
          Object.assign(task, request.postDataJSON());
        }

        result = task;
      } else if (pathname === '/api/tracker/task-seen') {
        if (request.method() === 'POST') {
          seen.taskIds = [...new Set([...seen.taskIds, ...(request.postDataJSON().taskIds || [])])];
          seen.revision += 1;
        }

        result = seen;
      } else if (pathname === '/api/tracker/task-favorites' || favorite) {
        if (favorite && request.method() !== 'GET') {
          favorites.taskIds = favorites.taskIds.filter((id) => id !== favorite[1]);

          if (request.method() === 'PUT') {
            favorites.taskIds.push(favorite[1]);
          }

          favorites.revision += 1;
        }

        result = favorites;
      } else if (pathname === '/api/tracker/task-shelf' || shelfTask) {
        if (shelfTask) {
          const id = shelfTask[1];

          if (request.method() === 'DELETE') {
            shelf.entries = shelf.entries.filter((entry) => entry.taskId !== id);
          } else if (request.method() === 'PUT') {
            const body = request.postDataJSON();
            const old = shelf.entries.find((entry) => entry.taskId === id);

            shelfPuts.push({
              id,
              body,
              page: request.frame().page(),
            });

            if (old) {
              old.snapshot = body.snapshot;
            } else if (body.createIfMissing) {
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
      } else if (comment) {
        const rows = comments.get(comment[1]);

        if (request.method() === 'POST') {
          rows.push({
            mid: String(rows.length + 1),
            author: 'Фикстура',
            time: '',
            text: request.postDataJSON().text,
          });
        }

        result = { comments: rows };
      } else if (pathname === '/api/tracker/users') {
        result = { users: [{ id: 1, name: 'Исполнитель' }] };
      } else if (pathname === '/api/tracker/groups') {
        result = { groups: [] };
      }

      await route.fulfill({ json: result });
    });
    await context.route('**/api/tasks', (route) => route.fulfill({ json: {
      tasks: [
        {
          task: '42',
          route: 'fixture',
          attempt: 'a1',
          daemonAlive: true,
        },
        ...launched.values(),
      ],
    } }));
    await context.route('**/api/tasks/*/graph', (route) => route.fulfill({ json: {
      route: 'fixture',
      statuses: { gate_fixture: 'wait' },
      nodes: { gate_fixture: ['human', 'GATE_PLAN'] },
      pos: { gate_fixture: [0, 0] },
    } }));
    await context.route('**/api/tasks/*/diff', (route) => route.fulfill({ json: { repos: [] } }));
    await context.route('**/api/tasks/*/launch-options*', (route) => route.fulfill({ json: {
      profile: 'fixture',
      profiles: ['fixture'],
      routes: ['feature'],
      defaultRoute: 'feature',
      routeOptions: { feature: { deliveryMode: 'publish', instrumentationRequired: false } },
      repositories: [{ name: 'fixture', targetBranch: 'dev' }],
      profileContractError: null,
    } }));
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
      await route.fulfill({ json: {
        outcome: 'launched',
        profile: body.profile,
        route: body.route,
        attempt: 'synthetic-launch',
      } });
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

      if (stream) {
        activeStreams.set(request, owner);

        if (surface) {
          surfaceStreams.push(url.pathname);
        }
      }
      if (surface && url.pathname === '/api/tracker/dashboard') {
        surfaceDashboards.push(owner);
      }
      if (surface && request.method() === 'GET' && /^\/api\/tracker\/task\/\d+$/.test(url.pathname)) {
        childDetails.push({ owner, path: url.pathname });
      }
      if (url.pathname === '/api/settings/factory-debug' && request.method() === 'GET') {
        policyRequests.push(owner);
      }
    });
    context.on('requestfinished', (request) => activeStreams.delete(request));
    context.on('requestfailed', (request) => activeStreams.delete(request));
    await page.reload();
    await page.goto(new URL('/#/board', page.url()).href);
    await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).waitFor();

    return current;
  }

  await launch();

  return {
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
 * Читаем только синтетические поля уже смонтированных stores, не импортируя второй граф.
 * Проверка видит обновления потребителей production-связей без добавления product hooks.
 */
async function stateOf(page) {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const shelf = pinia._s.get('taskShelf');
    const board = pinia._s.get('board');

    return {
      favorites: pinia._s.get('taskFavorites')?.taskIds || [],
      seen: pinia._s.get('taskSeen')?.taskIds || [],
      shelf: shelf?.entries.map((entry) => entry.taskId) || [],
      shelfLoaded: shelf?.loaded,
      shelfRevision: shelf?.revision,
      shelfBusy: shelf?.loading || Object.keys(shelf?.pending || {}).length > 0,
      gateState: shelf?.rows.find((row) => row.taskId === '42')?.state,
      timer: board?.data?.tasks.find((task) => String(task.id) === '42')?.timerRunning,
      dictionary: pinia._s.get('chat')?.speech.dictionary,
      conversation: pinia._s.get('chat')?.sessions.find((session) => session.id === 'fixture-chat')
        ?.messages[0]?.text,
    };
  });
}

/**
 * Настоящий EventSource главного окна остаётся сетевым: подаём только синтетическое событие полки.
 * Остальные сетевые события проверяются отдельным штатным POST настроек сервера фикстуры.
 */
async function publishShelf(page) {
  await page.evaluate(() => {
    for (const source of window.__taskSources) {
      source.dispatchEvent(new MessageEvent('task-shelf-changed', { data: '{}' }));
    }
  });
}

/**
 * Диагностическая настройка штатно порождает настоящее SSE-событие сервера.
 * Каждый документ обязан вслед за ним перечитать policy своим существующим подписчиком.
 */
async function checkNetworkEvent(page, documents, policyRequests) {
  const before = documents.map((entry) => policyRequests.filter((owner) => owner === entry).length);
  const status = await page.evaluate(async () => (await fetch('/api/settings/factory-debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'global', clear: true }),
  })).status);

  assert.equal(status, 200);
  await waitFor(async () => documents.every((entry, index) =>
    policyRequests.filter((owner) => owner === entry).length > before[index]));
}

/**
 * Клик по задаче на доске главного окна ждёт новое окно и заголовок его карточки.
 * Повтор уже открытой задачи окна не создаёт, поэтому helper — только для первого открытия.
 */
async function openTaskWindow(app, page, id) {
  const opened = app.waitForEvent('window');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача ' + id }).click();

  const taskPage = await opened;

  await taskPage.locator('#task-modal-title').filter({ hasText: 'Задача ' + id }).waitFor();

  return taskPage;
}

test('TW-E01: второе окно, сохранность повтора, редактирование и синхронизация доски',
  { timeout: 90000 }, async (t) => {
  const { app, page, surfaceStreams, surfaceDashboards } = await taskRun(t);
  const mainToken = await page.evaluate(() => {
    window.taskWindowMainToken = crypto.randomUUID();

    return window.taskWindowMainToken;
  });
  const opened = app.waitForEvent('window');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();

  const taskPage = await opened;

  await taskPage.locator('.task-card-document').waitFor();
  assert.equal(await page.locator('[data-role="task-modal"]').count(), 0);
  assert.equal(app.windows().length, 2);
  // Карточка отметила задачу просмотренной — метка «Новая» в главном окне гаснет без перезагрузки.
  await waitFor(async () => await page.locator('.newbadge').count() === 2);

  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()
      .find((item) => item.webContents.getURL().includes('?surface=task'));
    const prefs = win.webContents.getLastWebPreferences();

    return {
      parent: win.getParentWindow() === null,
      modal: win.isModal(),
      onTop: win.isAlwaysOnTop(),
      node: prefs.nodeIntegration,
      preload: Boolean(prefs.preload),
      sandbox: prefs.sandbox,
      isolated: prefs.contextIsolation,
    };
  });

  assert.equal(preferences.parent, true);
  assert.equal(preferences.modal, false);
  assert.equal(preferences.onTop, false);
  assert.equal(preferences.node, false);
  assert.equal(preferences.preload, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.isolated, true);

  const nodeGlobals = await taskPage.evaluate(() => [typeof require, typeof process]);

  assert.deepEqual(nodeGlobals, ['undefined', 'undefined']);
  assert.match(await taskPage.evaluate(() => navigator.userAgent), /GrigDeskWindow\/surface/);

  // Системных кнопок нет: окно двигают за шапку карточки, её кнопки остаются кликабельными.
  const titlebar = await taskPage.evaluate(() => ({
    overlay: navigator.windowControlsOverlay?.visible ?? false,
    strip: document.querySelector('.task-window-titlebar') !== null,
    drag: getComputedStyle(document.querySelector('.task-card-document .mhead'))
      .getPropertyValue('-webkit-app-region'),
    actions: getComputedStyle(document.querySelector('.task-card-document .mhead-actions'))
      .getPropertyValue('-webkit-app-region'),
  }));

  assert.equal(titlebar.overlay, false);
  assert.equal(titlebar.strip, false);
  assert.equal(titlebar.drag, 'drag');
  assert.equal(titlebar.actions, 'no-drag');
  await taskPage.getByRole('tab', { name: /Комментарии/ }).click();
  await taskPage.locator('[data-role="task-comment"]').fill('Несохранённый комментарий');

  const token = await taskPage.evaluate(() => {
    window.taskWindowDocumentToken = crypto.randomUUID();

    return window.taskWindowDocumentToken;
  });
  const repeated = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/__shell/surfaces/open');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();
  assert.equal((await (await repeated).json()).opened, true);
  assert.equal(app.windows().length, 2);
  assert.equal(await taskPage.evaluate(() => window.taskWindowDocumentToken), token);
  assert.equal(
    await taskPage.locator('[data-role="task-comment"]').inputValue(),
    'Несохранённый комментарий',
  );
  await taskPage.locator('[data-role="task-edit-open"]').click();
  await taskPage.locator('[data-role="task-edit-title"]').fill('Обновлённая задача 42');
  await taskPage.locator('[data-role="task-edit-save"]').click();
  await page.locator('[data-role="task-title"]').filter({ hasText: 'Обновлённая задача 42' }).waitFor();
  assert.equal(await page.evaluate(() => window.taskWindowMainToken), mainToken);
  assert.deepEqual(surfaceStreams, []);
  assert.equal(surfaceDashboards.length, 1);

  const closed = taskPage.waitForEvent('close');

  await taskPage.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await closed;
  assert.equal(app.windows().length, 1);
  assert.equal(await page.evaluate(() => window.taskWindowMainToken), mainToken);
});
test('TW-E02: у каждой задачи своё окно, три окна не исчерпывают соединения главного',
  { timeout: 120000 }, async (t) => {
  const f = await taskRun(t);
  const { app, page, surfaceStreams, surfaceDashboards } = f;
  const pages = [];

  for (const id of ['42', '43', '44']) {
    pages.push(await openTaskWindow(app, page, id));

    if (id === '42') {
      await app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()
          .find((entry) => entry.webContents.getURL().includes('?surface=task&id=42'));
        const area = screen.getPrimaryDisplay().workArea;
        const width = Math.min(1000, area.width);
        const height = Math.min(800, area.height);

        win.setBounds({
          x: area.x + area.width - width,
          y: area.y + area.height - height,
          width,
          height,
        });
      });
    }
    if (id === '43') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find((entry) => entry.webContents.getURL().includes('?surface=task&id=43')).maximize());
    }
  }

  assert.equal(app.windows().length, 4);
  await checkNetworkEvent(page, [page, ...pages], f.policyRequests);
  await waitFor(async () => [...f.activeStreams.values()].filter((owner) => owner === page).length === 2);

  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((win) => win.webContents.getURL().includes('?surface=task'))
    .map((win) => ({
      ...win.getBounds(),
      id: new URL(win.webContents.getURL()).searchParams.get('id'),
      maximized: win.isMaximized(),
    })));

  assert.equal(new Set(bounds.map((rect) => rect.x + ':' + rect.y)).size, 3);

  const previous = bounds.find((rect) => rect.id === '43');
  const next = bounds.find((rect) => rect.id === '44');
  const covers = next.x <= previous.x && next.y <= previous.y
    && next.x + next.width >= previous.x + previous.width
    && next.y + next.height >= previous.y + previous.height;

  assert.equal(next.maximized, false);
  assert.equal(covers, false);
  await waitFor(async () => (await Promise.all(pages.map(stateOf)))
    .every((state) => state.shelfLoaded && !state.shelfBusy));

  const detailCount = f.childDetails.length;

  f.shelf.revision += 1;
  await publishShelf(page);
  await waitFor(async () => (await Promise.all(pages.map(stateOf)))
    .every((state) => state.shelfRevision === f.shelf.revision));
  await checkNetworkEvent(page, [page, ...pages], f.policyRequests);
  assert.equal(f.childDetails.length, detailCount);
  await pages[0].getByRole('tab', { name: /Комментарии/ }).click();
  await pages[0].locator('[data-role="task-comment"]').fill('Черновик только задачи 42');

  const repeated = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/__shell/surfaces/open');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();
  assert.equal((await (await repeated).json()).opened, true);
  assert.equal(app.windows().length, 4);
  assert.equal(
    await pages[0].locator('[data-role="task-comment"]').inputValue(),
    'Черновик только задачи 42',
  );
  await pages[1].getByRole('tab', { name: /Комментарии/ }).click();
  assert.equal(await pages[1].locator('[data-role="task-comment"]').inputValue(), '');
  await pages[2].locator('[data-role="task-edit-open"]').click();
  await pages[2].locator('[data-role="task-edit-title"]').fill('Обновлённая задача 44');
  await pages[2].locator('[data-role="task-edit-save"]').click();
  await page.locator('[data-role="task-title"]').filter({ hasText: 'Обновлённая задача 44' }).waitFor();
  assert.deepEqual(surfaceStreams, []);
  assert.equal(surfaceDashboards.length, 1);
});
test('TW-E03: вложенный диф и два Escape закрывают по одному слою', { timeout: 90000 }, async (t) => {
  const { app, page } = await taskRun(t);
  const opened = app.waitForEvent('window');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();

  const taskPage = await opened;

  await taskPage.locator('.task-card-document').waitFor();
  await taskPage.getByRole('button', { name: 'Ещё', exact: true }).click();
  await taskPage.getByRole('button', { name: /Диф/ }).click();
  await taskPage.getByRole('dialog', { name: '#42 · диф', exact: true }).waitFor();
  await taskPage.keyboard.press('Escape');
  await taskPage.getByRole('dialog', { name: '#42 · диф', exact: true }).waitFor({
    state: 'hidden',
  });
  assert.equal(taskPage.isClosed(), false);
  assert.equal(app.windows().length, 2);

  const closed = taskPage.waitForEvent('close');

  await taskPage.keyboard.press('Escape');
  await closed;
  assert.equal(app.windows().length, 1);
});
test('TW-E04: переход подтверждается после main router, ошибка сохраняет карточку',
  { timeout: 120000 }, async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? 'ошибка загрузки раздела' : 'подтверждённый переход', async (t) => {
      const { app, page } = await taskRun(t);
      const token = await page.evaluate(() => {
        window.pipelineNavigationToken = crypto.randomUUID();

        return window.pipelineNavigationToken;
      });
      const first = await openTaskWindow(app, page, '42');

      await waitFor(async () => (await stateOf(page)).conversation === 'Сохранить разговор при переходе');

      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();

      t.after(() => release.resolve());
      await page.context().route('**/assets/PipelineView-*.js', async (route) => {
        entered.resolve();
        await release.promise;

        if (fail) {
          await route.abort('failed');
        } else {
          await route.continue();
        }
      });

      const delivered = first.waitForResponse('**/__shell/surfaces/main');

      await first.getByRole('button', { name: /Идёт на конвейере/ }).click();
      await entered.promise;
      assert.equal(first.isClosed(), false);
      assert.equal(new URL(page.url()).hash, '#/board');
      release.resolve();

      if (fail) {
        assert.equal((await (await delivered).json()).opened, false);
        assert.equal(new URL(page.url()).hash, '#/board');
        assert.equal(first.isClosed(), false);
        assert.equal(app.windows().length, 2);
      } else {
        await waitFor(async () => first.isClosed());
        await page.waitForURL(/#\/pipeline$/);
        assert.equal(app.windows().length, 1);
      }

      assert.equal(await page.evaluate(() => window.pipelineNavigationToken), token);
      assert.equal((await stateOf(page)).conversation, 'Сохранить разговор при переходе');
    });
  }
});
test('TW-E05: геометрия карточки сохраняется на диск и восстанавливается, main прежний',
  { timeout: 90000 }, async (t) => {
  const { app, page, dataDir, relaunch } = await taskRun(t);
  const mainBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]
    .getNormalBounds());
  const opened = app.waitForEvent('window');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();

  const taskPage = await opened;

  await taskPage.locator('.task-card-document').waitFor();

  const expected = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()
      .find((entry) => entry.webContents.getURL().includes('?surface=task'));
    const area = screen.getPrimaryDisplay().workArea;

    win.setBounds({
      x: area.x + 10,
      y: area.y + 10,
      width: Math.max(600, Math.min(900, area.width - 20)),
      height: Math.max(600, Math.min(700, area.height - 20)),
    });

    return win.getNormalBounds();
  });
  const closed = taskPage.waitForEvent('close');

  await taskPage.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await closed;
  // Кнопка закрывает окно через window.close() страницы: Electron присылает только 'closed'.
  await waitFor(async () => {
    try {
      const stored = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));

      return isDeepStrictEqual(stored.surfaceWindows?.task, {
        ...expected,
        maximized: false,
      });
    }
    catch {
      return false;
    }
  });

  const savedMain = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).window;
  const unchangedMain = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find((win) => !win.webContents.getURL().includes('?surface=task')).getNormalBounds());

  assert.deepEqual(unchangedMain, mainBounds);

  const restarted = await relaunch();
  const second = await openTaskWindow(restarted.app, restarted.page, '42');

  await second.locator('.task-card-document').waitFor();

  const state = await restarted.app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();

    return {
      task: windows.find((win) => win.webContents.getURL().includes('?surface=task'))
        .getNormalBounds(),
      main: windows.find((win) => !win.webContents.getURL().includes('?surface=task'))
        .getNormalBounds(),
    };
  });

  assert.deepEqual(state.task, expected);
  assert.equal(state.main.width, mainBounds.width);
  assert.equal(state.main.height, mainBounds.height);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).window,
    savedMain,
  );
});
test('TW-E06: смена профиля закрывает все окна прежней машины', { timeout: 90000 }, async (t) => {
  const { app, page } = await taskRun(t, { secondProfile: true });
  const previousOrigin = new URL(page.url()).origin;
  const first = await openTaskWindow(app, page, '42');
  const second = await openTaskWindow(app, page, '43');
  const loading = Promise.withResolvers();
  const release = Promise.withResolvers();

  t.after(() => release.resolve());
  await page.context().route('**/*surface=task&id=44*', async (route) => {
    loading.resolve();
    await release.promise;
    await route.continue().catch(() => undefined);
  });

  const pending = app.waitForEvent('window');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 44' }).click();
  await loading.promise;

  const third = await pending;
  const closed = Promise.all([first, second, third].map((entry) => entry.waitForEvent('close')));

  await page.evaluate(() => {
    void fetch('/__shell/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'second' }),
    });
  });
  await closed;
  release.resolve();
  await page.waitForURL((url) => url.origin !== previousOrigin);
  assert.equal(app.windows().length, 1);
});
test('TW-E07: закрытие главного окна завершает приложение и дочернюю карточку',
  { timeout: 90000 }, async (t) => {
  const { app, page } = await taskRun(t);
  const opened = app.waitForEvent('window');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();

  const taskPage = await opened;

  await taskPage.locator('.task-card-document').waitFor();

  const exited = app.waitForEvent('close');

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => !win.webContents.getURL().includes('?surface=task'))
      .close();
  });
  await exited;
  assert.equal(taskPage.isClosed(), true);
});
test('TW-E08: таймер переключается сразу и приходит снимком остальным документам',
  { timeout: 120000 }, async (t) => {
  const f = await taskRun(t);
  const first = await openTaskWindow(f.app, f.page, '42');
  const second = await openTaskWindow(f.app, f.page, '43');

  for (const running of [true, false]) {
    const before = f.surfaceDashboards.length;

    await first.getByRole('button', { name: running ? /Начать учёт/ : /Остановить учёт/ }).click();
    await first.getByRole('button', { name: running ? /Остановить учёт/ : /Начать учёт/ }).waitFor();

    for (const document of [f.page, first, second]) {
      await waitFor(async () => (await stateOf(document)).timer === running);
    }

    assert.equal(f.surfaceDashboards.length - before, 1);
  }

  const detailCount = f.childDetails.length;

  f.shelf.revision += 1;
  await publishShelf(f.page);
  await waitFor(async () => (await Promise.all([first, second].map(stateOf)))
    .every((state) => state.shelfRevision === f.shelf.revision));
  await checkNetworkEvent(f.page, [f.page, first, second], f.policyRequests);
  assert.equal(f.childDetails.length, detailCount);
  assert.deepEqual(f.surfaceStreams, []);
});

test('TW-E09: действия карточки, полка и речь обновляют остальные документы',
  { timeout: 120000 }, async (t) => {
  const f = await taskRun(t);

  await waitFor(async () => (await stateOf(f.page)).gateState === 'lit');

  const first = await openTaskWindow(f.app, f.page, '42');
  const second = await openTaskWindow(f.app, f.page, '43');

  await waitFor(async () => (await stateOf(f.page)).gateState === 'neutral');
  assert.equal(f.shelfPuts.filter((call) => call.id === '42' && call.page === first).length, 0);
  assert.equal(f.shelfPuts.some((call) => call.id === '42'
    && call.page === f.page && call.body.snapshot.pipeline.gate === 'GATE_PLAN'), true);
  await first.getByRole('tab', { name: /Комментарии/ }).click();
  await first.locator('[data-role="task-comment"]').fill('Синтетический комментарий');
  await first.getByRole('button', { name: 'Отправить', exact: true }).click();
  await first.locator('.comtext').filter({ hasText: 'Синтетический комментарий' }).waitFor();
  assert.equal(await first.locator('[data-role="task-comment"]').inputValue(), '');
  await first.getByRole('button', { name: /Добавить.*в избранное/ }).click();
  await first.getByRole('button', { name: /Убрать.*из избранного/ }).waitFor();

  for (const document of [f.page, second]) {
    await waitFor(async () => (await stateOf(document)).favorites.includes('42'));
  }

  await first.getByRole('button', { name: /Убрать.*из избранного/ }).click();

  for (const document of [f.page, second]) {
    await waitFor(async () => !(await stateOf(document)).favorites.includes('42'));
  }

  await waitFor(async () => (await Promise.all([first, second].map(stateOf)))
    .every((state) => state.shelfLoaded && !state.shelfBusy));

  const before = f.childDetails.length;

  await second.getByRole('button', { name: 'Ещё', exact: true }).click();
  await second.locator('[data-role="task-shelf-toggle"]').click();
  await waitFor(async () => (await stateOf(second)).shelf.includes('43'));
  await publishShelf(f.page);

  for (const document of [f.page, first]) {
    await waitFor(async () => (await stateOf(document)).shelf.includes('43'));
  }

  assert.equal(f.childDetails.length, before);
  await second.getByRole('button', { name: 'Ещё', exact: true }).click();
  await second.locator('[data-role="task-shelf-toggle"]').click();
  await waitFor(async () => !(await stateOf(second)).shelf.includes('43'));
  await publishShelf(f.page);

  for (const document of [f.page, first, second]) {
    await waitFor(async () => !(await stateOf(document)).shelf.includes('43'));
  }

  assert.equal(f.childDetails.length, before);
  await second.locator('[data-role="task-launch-open"]').click();
  await second.locator('[data-role="task-launch-note"]').first().fill('Проверить синтетический результат');
  await second.locator('[data-role="task-launch-submit"]').click();
  await second.getByText(/Запущено \(профиль fixture/).waitFor();
  assert.equal(f.launchCalls.length, 1);
  assert.equal(f.launchCalls[0].id, '43');
  assert.equal(f.launchCalls[0].body.profile, 'fixture');
  assert.equal(f.launchCalls[0].body.route, 'feature');

  const response = await f.page.evaluate(async () => {
    const result = await fetch('/api/settings/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dictionary: 'Термины синтетического проекта' }),
    });

    return { status: result.status, snapshot: await result.json() };
  });

  assert.equal(response.status, 200);

  for (const document of [f.page, first, second]) {
    await waitFor(async () => (await stateOf(document)).dictionary === response.snapshot.settings.dictionary);
  }

  assert.deepEqual(f.surfaceStreams, []);
  assert.equal(f.surfaceDashboards.length, 0);
});

test('TW-E10: отказ даёт диалог main, потеря ответа сохраняет единственное окно',
  { timeout: 120000 }, async (t) => {
  const { app, page } = await taskRun(t);
  const context = page.context();

  await context.route('**/*surface=task&id=43*', (route) => route.abort('failed'));
  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 43' }).click();
  await page.locator('[role="dialog"] #task-modal-title').filter({ hasText: 'Задача 43' }).waitFor();
  assert.equal(app.windows().length, 1);
  await page.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();

  const first = await openTaskWindow(app, page, '42');
  let lose = true;

  await context.route('**/__shell/surfaces/open', async (route) => {
    if (!lose || route.request().postDataJSON().id !== '44') {
      await route.continue();

      return;
    }

    lose = false;

    const response = await route.fetch();

    assert.equal((await response.json()).opened, true);
    await route.abort('failed');
  });

  const opened = app.waitForEvent('window');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 44' }).click();

  const fourth = await opened;

  await fourth.locator('.task-card-document').waitFor();
  await page.getByText(/ещё раз/).waitFor();
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  await fourth.getByRole('tab', { name: /Комментарии/ }).click();
  await fourth.locator('[data-role="task-comment"]').fill('Текст после неизвестного исхода');

  const repeated = page.waitForResponse('**/__shell/surfaces/open');

  await page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 44' }).click();
  assert.equal((await (await repeated).json()).opened, true);
  assert.equal(app.windows().length, 3);
  assert.equal(
    await fourth.locator('[data-role="task-comment"]').inputValue(),
    'Текст после неизвестного исхода',
  );
  await first.evaluate(async () => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    await pinia._s.get('ui').openTask('43');
  });
  await page.locator('[role="dialog"] #task-modal-title').filter({ hasText: 'Задача 43' }).waitFor();
  assert.equal(first.isClosed(), false);

  const ownTitle = await first.locator('#task-modal-title').textContent();

  assert.equal(ownTitle.trim(), 'Задача 42');
  assert.equal(app.windows().length, 3);
});

test('TW-E11: быстрые открытия не упираются в пул', { timeout: 120000 }, async (t) => {
  const f = await taskRun(t, { four: true });

  const started = Date.now();

  await f.page.locator('[data-role="task-title"]').evaluateAll((elements) => {
    for (const element of elements) {
      element.click();
    }
  });
  await waitFor(async () => f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((win) => win.webContents.getURL().includes('?surface=task') && win.isVisible()).length === 4),
  10000);
  assert.equal(Date.now() - started < 10000, true);

  const documents = [f.page, ...f.app.windows().filter((page) => page.url().includes('?surface=task'))];

  for (const document of documents.slice(1)) {
    await document.locator('.task-card-document').waitFor();
  }

  assert.equal(await f.page.locator('[role="dialog"]').count(), 0);
  await checkNetworkEvent(f.page, documents, f.policyRequests);
  assert.deepEqual(f.surfaceStreams, []);
});
