import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from '../../../desktop/node_modules/playwright-core/index.mjs';
import ruCore from '../../../shared/i18n/assets/locales/ru/core.json' with { type: 'json' };
import { toolRun, waitFor, installToolApi } from './tool-window-fixture.mjs';

/**
 * Кнопка ищется в живом доке после успешного открытия настоящей панели.
 * RED допускается только на отсутствии «Открепить», а не на незапущенном интерфейсе.
 */
async function detachTool(t, f, id = 'code', prepare = async () => { }) {
  await f.page.locator('.tool-rail-item').first().waitFor();

  const labels = {
    ...ruCore.builtinNavigation,
    ssh: 'SSH',
    example: 'Пример'
  };
  const button = f.page.getByRole('button', { name: new RegExp('^' + labels[id]) });

  assert.ok(await button.count(), JSON.stringify(await f.page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    return {
      plugins: pinia._s.get('plugins')?.list, labels: [...document.querySelectorAll('.tool-rail-item')]
        .map(item => item.getAttribute('aria-label'))
    };
  })));
  await button.first().click();
  await f.page.locator('.dock-actions').waitFor();

  await prepare(f.page);

  const detach = f.page.getByRole('button', { name: /Открепить/ });

  assert.equal(await detach.count(), 1, `Нет «Открепить» в работающей панели ${id}`);

  const opened = f.app.waitForEvent('window');

  await detach.click();

  const child = await opened;

  child.setDefaultTimeout(15000);
  await child.getByRole('button', { name: /Вернуть в колонку/ }).waitFor();
  assert.equal(f.app.windows().filter((page) => {
    const target = new URL(page.url()).searchParams.get('id');

    return page.url().includes('surface=tool') && (target === id || target === 'plugin:' + id);
  }).length, 1);

  return child;
}

/**
 * Наблюдение использует уже смонтированный product store и Monaco-модель страницы.
 * Импорт второго UI-графа в тест не подменяет ни контекст, ни обработку команд.
 */
async function codeState(page) {
  return page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__;
    const context = app.config.globalProperties.$pinia._s.get('uiContext');
    const editor = document.querySelector('.monaco-editor');

    return {

      text: editor?.textContent?.replace(/\u00a0/g, ' ') || '',

      file: document.querySelector('.ehead .epath')?.textContent,

      context: context?.capture({ path: '/chats' }),

      panels: document.querySelectorAll('.code-panel').length,

    };
  });
}

test('TOOL-E01: Code transfer, четыре входа, одна instance, контекст/драфт/Escape/return', async (t) => {
  const f = await toolRun(t);
  const worktree = path.join(f.root, 'repo-task');
  const draft = 'Переносимый черновик коммита';
  const child = await detachTool(t, f, 'code', async (page) => {
    await page.locator('#code-context').selectOption(JSON.stringify(['demo', worktree]));
    await page.locator('[data-dir-path="src"]').click();
    await page.locator('[data-file-path="src/a.ts"]').click();
    await waitFor(async () => (await codeState(page)).text.includes('WORKTREE'));
    await page.locator('[data-tab="changes"]').click();
    await page.locator('[data-action="commit-disclosure"]').click();
    await page.locator('textarea.commit-message').fill(draft);
    await page.locator('[data-tab="files"]').click();
  });

  assert.equal(await f.page.locator('.code-panel').count(), 0);
  assert.equal(await child.locator('.code-panel').count(), 1);
  assert.equal(await child.locator('#code-context').inputValue(), JSON.stringify(['demo', worktree]));
  assert.match((await codeState(child)).text, /WORKTREE/);

  const instance = new URL(child.url()).searchParams.get('instance');

  assert.ok(instance);
  await child.keyboard.press('Escape');
  assert.equal(child.isClosed(), false);

  const header = child.locator('.tool-window-titlebar');

  assert.equal(await header.evaluate(element => getComputedStyle(element).webkitAppRegion), 'drag');
  assert.equal(await child.getByRole('button', { name: /Вернуть в колонку/ })
    .evaluate(element => getComputedStyle(element).webkitAppRegion), 'no-drag');
  t.diagnostic('Физическое перемещение окна без оконного менеджера: NOT RUN; CSS drag/no-drag проверен.');

  // Четыре настоящих входа: рейка, настроенная клавиша, ссылка ленты и hash.
  await f.page.getByRole('button', { name: /^Код/ }).first().click();
  await f.page.keyboard.press('Control+Shift+1');
  await f.page.locator('[data-code-link="true"]').first().click();
  await waitFor(async () => (
    (await codeState(f.page)).context?.promptContext?.details?.toolWindow?.code?.line === 4
  ));
  await f.page.evaluate(({ root }) => {
    location.hash = '/code?' + new URLSearchParams({

      project: 'demo',

      repo: 'demo',

      root,

      path: 'src/a.ts',

      line: '5',

    });
  }, { root: worktree });
  await waitFor(async () => (
    (await codeState(f.page)).context?.promptContext?.details?.toolWindow?.code?.line === 5
  ));
  assert.equal(f.app.windows().length, 2);
  assert.equal(new URL(child.url()).searchParams.get('instance'), instance);
  assert.equal(await f.page.locator('.code-panel').count(), 0);

  // Обновление после хода использует тот же файл в текущем рабочем дереве.
  await writeFile(path.join(worktree, 'src/a.ts'), 'WORKTREE updated\nsecond\nthird\nfourth\nfifth\n');
  await f.page.evaluate(() => window.__taskSources.forEach(source => {
    source.dispatchEvent(new MessageEvent('chat-done', { data: '{}' }));
  }));
  await waitFor(async () => (await codeState(child)).text.includes('WORKTREE updated'));
  await f.page.getByRole('button', { name: /^Терминал/ }).first().click();
  await waitFor(async () => (
    (await codeState(f.page)).context?.promptContext?.details?.tool?.id === 'terminal'
  ));

  const captured = (await codeState(f.page)).context;

  assert.equal(captured.promptContext.details.tool.id, 'terminal');
  assert.equal(captured.promptContext.details.toolWindow.code.file, 'src/a.ts');
  await child.getByRole('button', { name: /Вернуть в колонку/ }).click();
  await waitFor(() => child.isClosed());
  assert.equal(await f.page.locator('.code-panel').count(), 1);
  assert.equal(await f.page.locator('#code-context').inputValue(), JSON.stringify(['demo', worktree]));
  await f.page.locator('[data-tab="changes"]').click();
  assert.equal(await f.page.locator('textarea.commit-message').inputValue(), draft);
});

test('TOOL-E02: Полка/SSH/БД/Docker/plugin живут в child без второго клиента или оповещения', async (t) => {
  const f = await toolRun(t);
  const child = await detachTool(t, f, 'shelf');

  await child.locator('[data-task-id="42"]').waitFor();
  assert.match(await child.locator('[data-task-id="42"]').innerText(), /Задача 42/);
  assert.equal(await f.page.locator('.task-shelf-panel').count(), 0);
  await waitFor(() => f.page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const shelf = pinia._s.get('taskShelf');

    return shelf.rows.find(row => row.taskId === '42')?.state === 'neutral'
      && shelf._runtime['42']?.primed.includes('b24');
  }));
  f.tasks.get('42').unread = 1;
  f.tasks.get('42').title = 'Очень длинное название задачи '.repeat(40);
  await f.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(window => (
      window.webContents.getURL().includes('surface=tool')
    ));

    win.setBounds({ width: 600, height: 800 });
  });
  await f.page.evaluate(async () => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    await pinia._s.get('board').load(true);
    pinia._s.get('taskShelf').reconcile();
  });
  await child.locator('[data-task-id="42"] .shelf-event').waitFor();

  const titleFits = await child.locator('[data-task-id="42"] .shelf-title').evaluate(element => {
    const style = getComputedStyle(element);

    return style.whiteSpace !== 'nowrap' && style.textOverflow !== 'ellipsis';
  });

  assert.equal(titleFits, true, 'Длинное название видно целиком в окне шириной 600');

  const notices = await Promise.all([f.page, child].map(page => page.evaluate(() => window.__toolAlerts)));

  assert.equal(notices[0].notifications, 1);
  assert.equal(notices[1].notifications, 0);
  assert.ok(notices[0].sounds <= 1);
  assert.equal(notices[1].sounds, 0);
  await child.getByRole('button', { name: 'Отметить событие просмотренным' }).first().click();
  await child.getByRole('button', { name: 'Убрать с полки' }).last().click();
  await waitFor(async () => await child.locator('[data-task-id="99"]').count() === 0);

  const shelves = await Promise.all([f.page, child].map(page => page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    return pinia._s.get('taskShelf').rows;
  })));

  assert.deepEqual(shelves[0], shelves[1]);
  await child.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await waitFor(() => child.isClosed());

  const ssh = await detachTool(t, f, 'ssh');

  await ssh.locator('[data-ssh-session-target]').filter({ hasText: 'SSH до события' }).waitFor();
  assert.equal(f.services.sockets.filter(item => item.url.includes('/ssh/') && !item.closed).length, 1);
  f.services.sshLabel = 'SSH после события';
  await f.page.evaluate(() => window.__taskSources.forEach(source => {
    source.dispatchEvent(new MessageEvent('ssh-sessions', { data: '{}' }));
  }));
  await ssh.locator('[data-ssh-session-target]').filter({ hasText: 'SSH после события' }).waitFor();
  await ssh.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await waitFor(() => ssh.isClosed());
  await waitFor(() => (
    f.services.sockets.filter(item => item.url.includes('/ssh/') && !item.closed).length === 0
  ));
  assert.deepEqual(f.services.closedSessions, []);

  const db = await detachTool(t, f, 'db');

  f.services.dbLabel = 'БД после события';
  f.services.queries = [{

    id: 'query-a',
    sessionId: 'db-a',
    actor: 'human',
    text: 'SELECT 42',
    state: 'done',

    startedAt: '2026-08-26T08:00:00.000Z',
    result: null,

  }];
  await f.page.evaluate(() => window.__taskSources.forEach(source => {
    source.dispatchEvent(new MessageEvent('db-sessions', { data: '{}' }));
    source.dispatchEvent(new MessageEvent('db-queries', { data: '{}' }));
  }));
  await db.getByRole('tab').filter({ hasText: 'БД после события' }).waitFor();
  await db.getByText('SELECT 42', { exact: true }).waitFor();
  await db.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await waitFor(() => db.isClosed());

  const docker = await detachTool(t, f, 'docker');

  await docker.getByText('fixture-container', { exact: true }).waitFor();
  assert.equal(f.services.sockets.filter(item => item.url.includes('/docker/') && !item.closed).length, 1);

  const stats = f.services.sockets.find(item => item.url.includes('/docker/') && !item.closed);

  stats.socket.send(JSON.stringify({

    t: 'stats',

    at: '2026-08-26T08:00:00.000Z',

    items: {
      'container-a': {

        cpuPercent: 42,

        memoryUsed: 100,

        memoryLimit: 1000,

        memoryPercent: 10,

        networkRx: 0,

        networkTx: 0,

        blockRead: 0,

        blockWrite: 0,

        pids: 1,

      }
    },

  }));
  await waitFor(async () => (await docker.locator('body').innerText()).includes('42'));
  await docker.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await waitFor(() => docker.isClosed());
  await waitFor(() => (
    f.services.sockets.filter(item => item.url.includes('/docker/') && !item.closed).length === 0
  ));

  const plugin = await detachTool(t, f, 'example');

  await plugin.frameLocator('iframe').locator('#api-result').filter({ hasText: 'demo' }).waitFor();
  assert.deepEqual(f.surfaceStreams, []);
});

test('TOOL-E03: geometry каждого tool, обычное close, restart и закрытие main', async (t) => {
  const f = await toolRun(t, { secondProfile: true });
  const child = await detachTool(t, f);

  await f.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((window) => (
      window.webContents.getURL().includes('surface=tool')
    ));

    win.setBounds({

      x: 40,

      y: 50,

      width: 1000,

      height: 750

    });
  });
  await child.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await waitFor(() => child.isClosed());
  await f.page.getByRole('button', { name: /^Код/ }).first().click();
  assert.equal(await f.page.locator('.code-panel').count(), 1);
  assert.equal(f.app.windows().length, 1);

  const shelf = await detachTool(t, f, 'shelf');

  await f.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((window) => (
      window.webContents.getURL().includes('surface=tool')
    ));

    win.setBounds({

      x: 100,

      y: 60,

      width: 600,

      height: 800

    });
  });
  await shelf.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await waitFor(() => shelf.isClosed());
  await waitFor(async () => {
    const saved = JSON.parse(await readFile(path.join(f.dataDir, 'settings.json'), 'utf8'));

    return saved.surfaceWindows?.tools?.code?.width === 1000
      && saved.surfaceWindows?.tools?.shelf?.width === 600;
  });

  const settings = JSON.parse(await readFile(path.join(f.dataDir, 'settings.json'), 'utf8'));

  assert.equal(settings.surfaceWindows.tools.code.width, 1000);
  assert.equal(settings.surfaceWindows.tools.shelf.width, 600);

  const again = await detachTool(t, f, 'code');
  const width = await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find(window => window.webContents.getURL().includes('surface=tool')).getBounds().width);

  assert.equal(width, 1000);
  await again.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await waitFor(() => again.isClosed());

  const restarted = await f.relaunch();

  assert.equal(restarted.app.windows().length, 1);

  const finalChild = await detachTool(t, { ...f, ...restarted });

  const switched = await restarted.page.evaluate(async () => (await fetch('/__shell/select', {

    method: 'POST',

    headers: { 'Content-Type': 'application/json' },

    body: JSON.stringify({ id: 'second' }),

  })).status);

  assert.equal(switched, 200);
  await waitFor(() => finalChild.isClosed());

  const initial = await f.relaunch();
  const last = await detachTool(t, { ...f, ...initial });

  const pending = [];

  await initial.page.context().route(/surface=tool.*id=shelf/, route => {
    pending.push(route);
  });
  await initial.page.getByRole('button', { name: /^Полка/ }).first().click();
  await initial.page.getByRole('button', { name: /Открепить/ }).click();
  await waitFor(() => pending.length === 1);
  await initial.app.close();

  for(const route of pending) {
    await route.abort().catch(() => undefined);
  }

  assert.equal(last.isClosed(), true);
  assert.equal(finalChild.isClosed(), true);
});

test('TOOL-E04: browser/Android/legacy, исключения, карточка и угол plugin iframe', async (t) => {
  const f = await toolRun(t);
  const browser = await chromium.launch({ chromiumSandbox: true });

  t.after(() => browser.close());

  const storageState = await f.page.context().storageState();
  const pipeCookies = await f.app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => (
      !window.webContents.getURL().includes('surface=')
    ));

    return main.webContents.session.cookies.get({ name: 'grigdesk_pipe' });
  });

  storageState.cookies = pipeCookies.map(cookie => ({

    name: cookie.name,

    value: cookie.value,

    domain: cookie.domain,

    path: cookie.path,

    httpOnly: cookie.httpOnly,

    secure: cookie.secure,

    expires: cookie.expirationDate ?? -1,

    sameSite: 'Lax',

  }));

  for(const userAgent of ['Mozilla/5.0 Chrome', 'Android GrigDesk', 'Electron GrigDeskWindow/main']) {
    const context = await browser.newContext({

      storageState,

      userAgent,

      viewport: { width: 1280, height: 900 }

    });

    t.after(() => context.close());
    await context.route('**/api/plugins', route => route.fulfill({
      json: {
        plugins: [{

          id: 'code',

          name: 'Код',

          enabled: true,

          system: true,

          values: {},

          placements: [],

          nav: {

            path: '/code',

            label: 'Код',

            icon: 'code',

            group: 'dock',

            order: 1

          },

        }]
      }
    }));

    const shellState = await f.page.evaluate(async () => (await fetch('/__shell/state')).json());

    await context.route('**/__shell/state*', async route => {
      if(new URL(route.request().url()).searchParams.has('rev')) {
        await route.abort();

        return;
      }

      await route.fulfill({ json: { ...shellState, capabilities: [] } });
    });
    await installToolApi(context, f.root, {});

    const page = await context.newPage();

    await page.goto(f.page.url().split('#')[0] + '#/code?project=demo&repo=demo&root='
      + encodeURIComponent(path.join(f.root, 'repo-task')) + '&path=src%2Fa.ts&line=3');
    await page.waitForTimeout(1000);
    await writeFile(path.join(process.env.GRIGDESK_E2E_ARTIFACTS, 'browser-preflight.json'),
      JSON.stringify({

        userAgent,

        url: page.url(),

        body: await page.locator('body').innerText()

      }, null, 2));
    await page.locator('.code-panel .monaco-editor').waitFor();
    assert.equal(await page.getByRole('button', { name: /Открепить/ }).count(), 0);
    assert.match((await codeState(page)).text, /WORKTREE/);
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }

  for(const name of ['Терминал', '3D']) {
    await f.page.getByRole('button', { name: new RegExp('^' + name) }).first().click();
    assert.equal(await f.page.getByRole('button', { name: /Открепить/ }).count(), 0);
  }

  await f.page.goto(f.page.url().split('#')[0] + '#/board');
  await f.page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).waitFor();

  const opened = f.app.waitForEvent('window');

  await f.page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();

  const card = await opened;

  await card.locator('.task-card-document').waitFor();
  await card.locator('#task-tab-comments').click();
  await card.locator('[data-role="task-comment"]').fill('Черновик карточки');
  await f.page.locator('[data-role="task-title"]').filter({ hasText: 'Задача 42' }).click();
  assert.equal(f.app.windows().length, 2);
  assert.equal(await card.locator('[data-role="task-comment"]').inputValue(), 'Черновик карточки');
  await card.keyboard.press('Escape');
  await waitFor(() => card.isClosed());

  const child = await detachTool(t, f, 'example');
  const iframe = child.frameLocator('iframe');

  await iframe.locator('#api-result').filter({ hasText: 'demo' }).waitFor();
  await child.getByRole('button', { name: /Вернуть в колонку/ }).click();
  await waitFor(() => child.isClosed());

  const actions = await f.page.locator('.dock-actions').boundingBox();
  const frame = await f.page.locator('iframe').boundingBox();

  assert.ok(actions && frame);
  assert.ok(actions.y + actions.height <= frame.y || actions.x >= frame.x + frame.width,
    'Кнопки дока не должны перекрывать заголовок iframe');
});
