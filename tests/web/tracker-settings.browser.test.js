import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { trackerCatalog } from './helpers/trackerBoard.js';
import { selectUiOption } from './helpers/selectUiOption.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));

/**
 * Те же системные пути, что у check-ui-geometry; отсутствие Chromium — явный skip.
 * Наличие браузера не превращает отсутствие новой кнопки в пропуск теста.
 */
function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/google-chrome',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);

      return candidate;
    } catch {
      // Кандидат может отсутствовать в минимальном образе стенда.
    }
  }

  return null;
}

/**
 * Отдельный Vite обслуживает реальный BoardView, всё API перехватывает Playwright.
 * Entry и cache лежат во временной папке, рабочая сборка и действующий сервер не затрагиваются.
 */
async function browserFixture(t, binary) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tracker-browser-'));
  const entry = path.join(root, 'entry.ts');
  const vite = await import('../../web/node_modules/vite/dist/node/index.js');
  const vue = (await import('../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs')).default;
  const server = await vite.createServer({
    configFile: false,
    root: webRoot,
    cacheDir: path.join(root, 'cache'),
    resolve: { dedupe: ['vue', 'pinia', 'vue-router'] },
    plugins: [vue(), {
      name: 'tracker-fixture-page',
      configureServer(devServer) {
        devServer.middlewares.use('/tracker-fixture', async (_request, response) => {
          const html = await devServer.transformIndexHtml('/tracker-fixture',
            `<html><body><div id="app"></div>`
            + `<script type="module" src="/@fs/${entry}"></script></body></html>`);

          response.setHeader('content-type', 'text/html');
          response.end(html);
        });
      },
    }],
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [webRoot, fileURLToPath(new URL('../../shared/', import.meta.url)), root] }
    },
  });
  let browser;

  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(entry, `
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import BoardView from '/src/views/BoardView.vue';
import { setUiLocale } from '/src/services/locale.ts';
import '/src/styles/index.css';
setUiLocale(new URL(location.href).searchParams.get('locale') || 'ru');
createApp(BoardView).use(createPinia()).mount('#app');
`);
  await server.listen();

  const address = server.httpServer.address();

  browser = await requireFromServer('playwright-core').chromium.launch({
    executablePath: binary,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  return { browser, url: `http://127.0.0.1:${address.port}/tracker-fixture` };
}

test('TRACKER-SETTINGS-02 / B-BROWSER-SKIP-01: ru/en, 1440/390/320, выбор и git-ошибка без overflow',
  { timeout: 90_000 }, async (t) => {
    const binary = chromeBinary();

    if (!binary) {
      t.skip('chromium unavailable');

      return;
    }

    const fixture = await browserFixture(t, binary);

    for (const locale of ['ru', 'en']) {
      for (const [width, height] of [[1440, 1000], [390, 844], [320, 568]]) {
        await t.test(`${locale}/${width}`, async () => {
        const page = await fixture.browser.newPage({ viewport: { width, height } });
        const writes = [];

        try {
          await page.route('**/api/**', async (route) => {
            const request = route.request();
            const url = new URL(request.url());

            if (!url.pathname.startsWith('/api/')) {
              await route.continue();

              return;
            }

            if (url.pathname === '/api/events') {
              await route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: 'retry: 60000\nevent: hello\ndata: {}\n\n',
              });

              return;
            }

            let data = {};
            let status = 200;

            if (request.method() === 'POST') {
              writes.push({ path: url.pathname, body: request.postDataJSON() });
            }

            if (url.pathname === '/api/trackers') {
              data = trackerCatalog();
            } else if (url.pathname === '/api/trackers/sources') {
              data = { sources: [] };
            } else if (url.pathname === '/api/trackers/settings') {
              data = {
                revision: 1,
                externalId: null,
                settings: {}
              };
            } else if (url.pathname === '/api/grigdesk-tasks') {
              data = {
                tasks: [],
                revision: 0,
                trackerConfigured: false,
                personalStateVersion: 1,
              };
            } else if (url.pathname.endsWith('/projects')) {
              data = { projects: [] };
            } else if (url.pathname === '/api/driver-installs/installed') {
              data = { drivers: {} };
            } else if (url.pathname === '/api/driver-installs/versions') {
              data = {
                source: { kind: 'git', url: request.postDataJSON().url },
                versions: [{
                  version: '1.0.0',
                  tag: 'v1.0.0',
                  sha: 'a'.repeat(40),
                }],
              };
            } else if (url.pathname === '/api/driver-installs/jobs') {
              status = 502;
              data = { error: 'source_unavailable', message: 'Fixture git unavailable' };
            } else if (url.pathname.includes('/driver-installs/jobs/')) {
              data = { job: null };
            } else if (url.pathname === '/api/plugins') {
              data = { plugins: [] };
            } else if (url.pathname === '/api/tracker/dashboard') {
              data = {
                userId: 7,
                tasks: [],
                toReview: [],
                created: [],
                today: { hours: 0, tasks_count: 0 },
                month: {
                  hours: 0,
                  norm: 160,
                  completedTasks: 0
                },
                charts: {},
              };
            } else if (url.pathname === '/api/tasks') {
              data = { tasks: [] };
            }

            await route.fulfill({ status, json: data });
          });

          const errors = [];

          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') {
              errors.push(message.text());
            }
          });
          page.on('requestfailed', (request) => {
            errors.push(`${request.url()}: ${request.failure()?.errorText}`);
          });
          await page.goto(`${fixture.url}?locale=${locale}`);
          await page.locator('.board [data-role="board-new-task"]').waitFor({ timeout: 10_000 }).catch(() => {
            assert.fail(`Board fixture не загрузилась: ${JSON.stringify(errors)}`);
          });
          assert.deepEqual(errors, [], 'Реальная доска загружена без ошибок fixture');

          const settings = page.locator('.board-heading').getByRole('button', {
            name: /настро[йи].*(доск|трекер)|board settings|tracker settings|set up tracker/iu,
          });

          assert.equal(await settings.count(), 1, 'Кнопка настроек трекера доступна без Б24');
          await settings.click();

          const dialog = page.getByRole('dialog').last();

          await dialog.waitFor();

          assert.equal(await dialog.getByRole('region', { name: 'GrigDesk', exact: true }).count(), 0);

          assert.equal(await page.locator('[data-role="tracker-settings"]').count(), 1);

          const driver = dialog.locator('[data-driver="grigdesk-b24"]');

          if (await driver.isVisible()) {
            await driver.click();
          } else {
            await selectUiOption(page, dialog.getByRole('combobox'), 'grigdesk-b24');
          }

          const enabled = dialog.locator('[data-role="tracker-board-enabled"]');

          if (!await enabled.isChecked()) {
            await dialog.locator('label.ui-checkbox:has([data-role="tracker-board-enabled"])').click();
          }

          assert.equal(await enabled.isChecked(), true);

          await dialog.getByRole('button', { name: /сохранить|save/iu }).click();
          assert.ok(writes.some((call) => call.path === '/api/trackers/settings'
            && call.body.externalId === 'grigdesk-b24'));
          await dialog.getByRole('button', { name: /^(Добавить трекер|Add tracker)$/u }).click();

          const installDialog = page.getByRole('dialog').last();

          await installDialog.locator('[data-role="driver-custom-source"]').click();
          await installDialog.locator('input[type="url"], input[name="url"], input[name="repo"]')
            .fill('https://git.fixture/unavailable.git');
          await installDialog.getByRole('button', { name: /^(Далее|Next)$/u }).click();
          await installDialog.getByRole('combobox').waitFor();
          await installDialog.getByRole('button', { name: /^(проверить пакет|review package)$/iu }).click();
          await installDialog.getByText('Fixture git unavailable').waitFor();
          assert.equal(writes.filter((call) => call.path === '/api/driver-installs/jobs').length, 1);

          const overflow = await page.evaluate(() => ({
            root: document.documentElement.scrollWidth > window.innerWidth + 1,
            dialogs: [...document.querySelectorAll('[role="dialog"]')]
              .some((node) => node.scrollWidth > node.clientWidth + 1),
          }));

          assert.deepEqual(overflow, { root: false, dialogs: false }, `${locale}/${width}`);
        } finally {
          await page.close();
        }
        });
      }
    }
  });
