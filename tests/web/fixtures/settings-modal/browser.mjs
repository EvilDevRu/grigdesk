import path from 'node:path';
import fs from 'node:fs/promises';
import { createServer } from '../../../../web/node_modules/vite/dist/node/index.js';
import vue from '../../../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { chromium } from '../../../../desktop/node_modules/playwright-core/index.mjs';

/**
 * Стенд использует отдельный entry, порт и кэш; конфиг с живым API не загружается.
 * Любой неизвестный API отклоняется и остаётся в проверяемом списке запроса.
 */
export async function startSettingsBrowser(t, responses = {}) {
  const root = process.cwd();
  const artifacts = path.join(process.env.GRIGDESK_ARTIFACTS_DIR, 'browser');

  await fs.mkdir(artifacts, { recursive: true });

  const server = await createServer({
    configFile: false,
    envFile: false,
    root: path.join(root, 'tests/web/fixtures/settings-modal'),
    cacheDir: path.join(artifacts, 'vite-cache'),
    plugins: [vue(), {
      name: 'settings-fixture-events',
      configureServer(vite) {
        vite.middlewares.use('/api/events', (_request, response) => {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write('event: hello\ndata: {"boot":"settings-fixture"}\n\n');
        });
      },
    }],
    resolve: {
      dedupe: ['vue', 'pinia', 'vue-router'],
      alias: {
        vue: path.join(root, 'web/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
        pinia: path.join(root, 'web/node_modules/pinia/dist/pinia.mjs'),
        'vue-router': path.join(root, 'web/node_modules/vue-router/dist/vue-router.mjs'),
      },
    },
    optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router'] },
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: null,
      fs: { allow: [root, artifacts] },
    },
  });

  let browser;

  t.after(async () => {
    await browser?.close();
    await server.close();
  });
  await server.listen();

  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : { channel: 'chromium' }),
    chromiumSandbox: true,
    args: ['--disable-features=LocalNetworkAccessChecks'],
  });


  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const unexpected = [];
  const errors = [];
  const knownResponses = {
    '/api/devices': {
      listener: {
        state: 'online',
        addresses: ['192.0.2.10:8145'],
      },
      devices: [],
      currentDeviceId: null,
    },
    '/api/devices/access': {
      name: 'Тестовый сервер',
      source: 'env',
      direct: {
        enabled: true,
        state: 'online',
        addresses: ['192.0.2.10:8145'],
        error: null,
      },
      networks: [{ name: 'lan', address: '192.0.2.10' }],
      relays: [],
    },
    ...responses,
  };

  await context.addInitScript(() => {
    window.addEventListener('unhandledrejection', (event) => {
      throw new Error(`Необработанный rejection: ${event.reason}`);
    });
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/events') {
      return route.continue();
    }

    const response = knownResponses[url.pathname];

    if (response !== undefined) {
      const json = typeof response === 'function' ? await response(request) : response;

      return route.fulfill({ json });
    }

    unexpected.push(`${request.method()} ${url.pathname}${url.search}`);

    return route.fulfill({ status: 500, json: { error: 'Неизвестный API стенда' } });
  });

  const page = await context.newPage();

  page.on('pageerror', (error) => errors.push(error.message));

  const address = server.httpServer.address();

  await page.goto(`http://127.0.0.1:${address.port}`);

  return {
    page,
    context,
    unexpected,
    errors,
    artifacts,
  };
}
