import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../../../web/node_modules/vite/dist/node/index.js';
import vue from '../../../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { chromium } from '../../../../desktop/node_modules/playwright-core/index.mjs';

const root = process.cwd();
const run = process.env.DENSITY_RUN_DIR;

if (!run || !path.isAbsolute(run)) {
  throw new Error('Задай абсолютный DENSITY_RUN_DIR');
}

const data = JSON.parse(fs.readFileSync(path.join(root, 'tests/web/fixtures/desktop-density/data.json')));
const unexpected = [];
const requests = [];
const responses = {
  '/api/chat/store': data.store,
  '/api/chat/pending': { pending: [] },
  '/api/chat/waiting': { waiting: [] },
  '/api/chat/active': data.active,
  '/api/settings/speech': {},
  '/api/chat/in-turn': { entries: [], nextAfterSequence: null },
  '/api/tasks': { tasks: [] },
  '/api/analysis': { tasks: [] },
  '/api/code/roots': { roots: [] },
  '/api/plugins': { plugins: [] },
  '/api/providers': { providers: [
      {
        id: 'claude',
        name: 'Claude',
        available: true,
        models: [{ id: 'claude-fixture', name: 'Синтетическая длинная модель для проверки шапки' }],
        color: '#d4a574'
      },
      {
        id: 'codex',
        name: 'Codex',
        available: true,
        models: [{ id: 'codex-fixture', name: 'Codex fixture' }]
      }
    ] },
  '/api/providers/usage': { usage: {} },
  '/api/system/version': {
    current: 'fixture',
    latest: 'fixture',
    updateAvailable: false
  },
  '/api/health': { ok: true, host: 'synthetic.test' },
};
const server = await createServer({
  configFile: false,
  envFile: false,
  root: path.join(root, 'tests/web/fixtures/desktop-density'),
  cacheDir: path.join(run, 'vite-cache'),
  plugins: [vue(), { name: 'synthetic-sse', configureServer(server) {
        server.middlewares.use('/api/events', (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('event: hello\ndata: {"boot":"fixture"}\n\n');
        });
      } }],
  resolve: { dedupe: ['vue', 'pinia', 'vue-router'], alias: {
      vue: path.join(root, 'web/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      pinia: path.join(root, 'web/node_modules/pinia/dist/pinia.mjs'),
      'vue-router': path.join(root, 'web/node_modules/vue-router/dist/vue-router.mjs')
    } },
  define: { __APP_VERSION__: JSON.stringify('fixture'), __APP_COMMIT__: JSON.stringify('fixture') },
  optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router'] },
  server: {
    host: '127.0.0.1',
    port: 0,
    watch: null,
    fs: { allow: [root] }
  },
});

await server.listen();

const port = server.httpServer.address().port;
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks']
});
const context = await browser.newContext();
const errors = [];

await context.route('**/api/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());

  requests.push(`${request.method()} ${url.pathname}`);

  if (url.pathname === '/api/events') {
    return route.continue();
  }
  if (Object.hasOwn(responses, url.pathname)) {
    return route.fulfill({ json: responses[url.pathname] });
  }

  unexpected.push(`${request.method()} ${url.pathname}${url.search}`);

  return route.fulfill({ status: 500, json: { error: 'Unexpected synthetic request' } });
});

const page = await context.newPage();

page.on('pageerror', e => errors.push(e.message));

try {
  await page.goto(`http://127.0.0.1:${port}/#/chats`);
  await page.locator('.cs').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);

  const measurements = {};

  for (const [width, height] of [[1280, 860], [1920, 1080], [600, 700]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    measurements[`${width}x${height}`] = await page.evaluate(() => {
      const selectors = [
        '.topbar', '.sidebar', '.tool-rail', '.navitem', '.cl .top', '.cl .row', '.cl .ava',
        '.content', '.cs-top', '.cs-body', '.cs-input', '.flow', '.ui-input',
        '.ui-select__trigger', '.cs .ui-button', '.tool-dock-actions',
      ];

      return Object.fromEntries(selectors.map(selector => {
        const el = document.querySelector(selector);

        if (!el) {
          return [selector, null];
        }

        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);

        return [selector, {
            x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          padding: s.padding,
          margin: s.margin,
          gap: s.gap,
          color: s.color,
          background: s.backgroundColor,
          font: s.fontSize,
          lineHeight: s.lineHeight
          }];
      }));
    });
    await page.screenshot({ path: path.join(run, `baseline-${width}x${height}.png`) });


  }

  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => window.densityFixture.router.push('/density-controls'));
  await page.locator('.dock-actions').waitFor();
  measurements.controls = await page.evaluate(() => Object.fromEntries(
    ['.ui-input', '.ui-button', '.ui-select[data-context]', '.dock-actions button'].map(selector => {
    const el = document.querySelector(selector);
    const s = getComputedStyle(el);

    return [selector, {
        height: el.getBoundingClientRect().height,
      font: s.fontSize,
      lineHeight: s.lineHeight,
      color: s.color
      }];
  })));
  fs.writeFileSync(path.join(run, 'baseline-measurements.json'), JSON.stringify(measurements, null, 2));
}
finally {
  fs.writeFileSync(path.join(run, 'renderer-requests.json'), JSON.stringify({
    requests,
    unexpected,
    errors
  }, null, 2));
  await browser.close();
  await server.close();
}

if (unexpected.length || errors.length) {
  throw new Error(JSON.stringify({ unexpected, errors }));
}
