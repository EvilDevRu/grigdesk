import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import vue from '../../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { chromium } from '../../../desktop/node_modules/playwright-core/index.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { freePort } from '../../server/helpers/pluginBootFixture.js';

export const chatSession = {
  id: 'geometry-chat',
  title: 'Проверка узкого экрана',
  model: '',
  messages: [{ role: 'assistant', text: '```text\n' + 'long_code_'.repeat(1200) + '\n```' }],
};

/**
 * Настоящие Vue-экраны работают с локальными синтетическими API без живого сервера.
 * Vite не читает конфигурацию проекта с proxy и не наблюдает всё рабочее дерево.
 */
export async function clientBrowser(t, options = {}) {
  const root = path.resolve(import.meta.dirname, '../../..');
  const artifacts = options.artifacts || path.join(process.env.GRIGDESK_ARTIFACTS_DIR
    || path.join(os.homedir(), '.grigdesk/artifacts'), 'client-responsive');
  const profile = {
    id: 'geometry-machine',
    name: 'Тестовая машина',
    kind: 'remote',
    address: 'https://machine.example:443',
    status: 'online',
  };
  const shell = {
    rev: 1,
    profile,
    profiles: [profile],
    status: 'online',
    detail: null,
    localAvailable: false,
    serverApi: { major: 0, minor: 1 },
    appApi: { major: 0, minor: 1 },
    capabilities: [],
  };
  const pending = new Set();

  await mkdir(artifacts, { recursive: true });

  const cacheDir = await mkdtemp(path.join(artifacts, 'vite-cache-'));

  const server = await createServer({
    root: path.join(root, 'web'),
    configFile: false,
    envFile: false,
    cacheDir,
    plugins: [{
      name: 'client-fixture-api',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const url = new URL(req.url, 'http://fixture');

          if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/__shell/')) {
            next();

            return;
          }

          res.setHeader('Content-Type', 'application/json');

          if (url.pathname.startsWith('/__shell/') && options.shell === null) {
            req.resume();
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not_found' }));

            return;
          }

          if (url.pathname === '/api/events') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write('event: hello\ndata: {"boot":"fixture"}\n\n');
            pending.add(res);
            res.on('close', () => pending.delete(res));

            return;
          }

          if (url.pathname === '/__shell/state' && url.searchParams.has('rev')) {
            pending.add(res);
            res.on('close', () => pending.delete(res));

            return;
          }

          if (url.pathname === '/api/grigdesk-tasks/11') {
            req.resume();
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'grigdesk_task_not_found' }));

            return;
          }

          const responses = {
            '/api/grigdesk-tasks': {
              tasks: [],
              revision: 0,
              b24Configured: true
            },
            '/api/grigdesk-tasks/projects': { projects: [] },
            '/__shell/state': options.shell || shell,
            '/api/auth/state': {
              authenticated: true,
              configured: true,
              method: 'device',
            },
            '/api/providers': { providers: [], models: [] },
            '/api/b24/task-favorites': {
              scope: 'fixture',
              revision: 1,
              taskIds: [],
            },
            '/api/b24/task-seen': {
              scope: 'fixture',
              revision: 1,
              taskIds: [],
              initialized: true,
            },
            '/api/b24/task/11': {
              id: 11,
              title: 'Задача для узкого экрана',
              description: '<p>Полное описание задачи на телефоне.</p>',
              status_label: 'В работе',
            },
            '/api/chat/store': { sessions: [chatSession], activeId: chatSession.id },
            '/api/b24/dashboard': {
              today: { hours: 1, tasks_count: 1 },
              month: { hours: 1, norm: 160 },
              tasks: [{
                id: 11,
                title: 'Задача для узкого экрана',
                group: 'Фикстура',
                timerElapsed: 0,
              }],
              toReview: [],
              created: [],
              stages: [],
              projects: [],
            },
          };

          req.resume();
          res.end(JSON.stringify(options.responses?.[url.pathname] || responses[url.pathname]
            || (url.pathname.startsWith("/api/b24/task-seen/") ? responses["/api/b24/task-seen"] : {})));
        });
      },
    }, vue()],
    define: {
      __GRIGDESK_VERSION__: JSON.stringify('fixture'),
      __GRIGDESK_SHA__: JSON.stringify('fixture'),
    },
    server: {
      host: '127.0.0.1',
      port: await freePort(),
      strictPort: true,
      hmr: false,
      watch: null,
      fs: { allow: [root] },
    },
    optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router'] },
  });

  await mkdir(artifacts, { recursive: true });
  await server.listen();

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks'],
  });

  t.after(async () => {
    await browser.close();

    for (const res of pending) {
      res.destroy();
    }

    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  return {
    browser,
    origin: server.resolvedUrls.local[0],
    cacheDir: server.config.cacheDir,
    artifacts,
  };
}

/**
 * Увеличиваются размеры букв и строк реальных элементов без увеличения площадок кнопок.
 * Снимок вычисляется до записи стилей, поэтому наследуемый текст не масштабируется дважды.
 */
export async function scaleClientText(page, scale, selector = "body") {
  await page.evaluate(({ factor, selector }) => {
    const elements = [...document.querySelector(selector).querySelectorAll('*')].filter((element) => (
      !(element instanceof SVGElement) && ([...element.childNodes].some((node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
    ));
    const sizes = elements.map((element) => {
      const style = getComputedStyle(element);

      return {
        element,
        font: parseFloat(style.fontSize),
        line: parseFloat(style.lineHeight),
      };
    });

    for (const { element, font, line } of sizes) {
      element.style.fontSize = `${font * factor}px`;

      if (Number.isFinite(line)) {
        element.style.lineHeight = `${line * factor}px`;
      }
    }
  }, { factor: scale, selector });
}
