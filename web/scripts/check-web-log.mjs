#!/usr/bin/env node
// Изолированная браузерная приёмка общего журнала окна: production Vue, настоящие
// ядро, ловушки, транспорт и API-клиент, свой приёмник и временный профиль Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { build } from '../node_modules/vite/dist/node/index.js';
import vue from '../node_modules/@vitejs/plugin-vue/dist/index.mjs';
import authPlugin from '../../server/src/plugins/auth.ts';
import webLogModule from '../../server/src/modules/web-log/index.ts';
import { createApiRouteRegistry } from '../../server/src/lib/webLog/apiRoutes.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'web');
const fixture = path.join(root, 'tests/web/fixtures/web-log');
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const staticPlugin = requireFromServer('@fastify/static');
const { chromium } = requireFromServer('playwright-core');

function chromeBinary() {
  for (const candidate of [process.env.CHROME_BIN, '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome/Chromium не найден; задайте CHROME_BIN.');
}

/**
 * Сборка fixture использует production Vue и настоящий код журнала,
 * но пишет результат только в собственный каталог артефактов.
 */
async function buildFixture(outDir) {
  await build({
    root: fixture,
    configFile: false,
    mode: 'production',
    logLevel: 'warn',
    plugins: [vue()],
    resolve: { alias: {
      vue: path.join(web, 'node_modules/vue'),
      pinia: path.join(web, 'node_modules/pinia'),
      'vue-router': path.join(web, 'node_modules/vue-router'),
    } },
    build: { outDir, emptyOutDir: true, minify: true,
      rollupOptions: { input: path.join(fixture, 'index.html') } },
  });
}

/** Запуск CLI журнала на каталоге приёмника fixture. */
function runCli(logDir, args) {
  return spawnSync(process.execPath, ['server/scripts/web-log.mjs', ...args], {
    cwd: root, env: { ...process.env, GRIGDESK_WEB_LOG_DIR: logDir }, encoding: 'utf8',
  });
}

/**
 * Каждый прогон получает свой каталог в папке артефактов: сборка и принятый журнал
 * остаются для разбора, а профиль Chrome удаляется в finally при любом исходе.
 */
async function main() {
  const parent = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'web-log');

  await mkdir(parent, { recursive: true });

  const artifacts = await mkdtemp(path.join(parent, 'browser-'));
  const outDir = path.join(artifacts, 'dist');
  const profile = path.join(artifacts, 'chrome-profile');
  const logDir = path.join(artifacts, 'received');
  await mkdir(logDir, { recursive: true });
  let app;
  let context;
  let page;
  let online = true;
  let level = 'off';
  const consoleErrors = [];
  const entries = () => page.evaluate(() => window.__webLogFixture.runtime.log.snapshot().entries);
  const waitEntry = (predicate, arg) => page.waitForFunction(([source, value]) => {
    const test = new Function('entry', 'value', `return (${source})(entry, value);`);
    return window.__webLogFixture.runtime.log.snapshot().entries.some((entry) => test(entry, value));
  }, [predicate.toString(), arg], { timeout: 15_000 });
  try {
    await buildFixture(outDir);
    app = Fastify({ logger: false });
    const apiRoutes = createApiRouteRegistry();
    app.addHook('onRoute', (route) => apiRoutes.add(route.url));
    await app.register(authPlugin, { authStore: {
      isConfigured: () => true, isValidSession: (sid) => sid === 'fixture-session',
    } });
    app.addHook('preHandler', async (request, reply) => {
      if (!online && request.method === 'POST' && request.routeOptions?.url === '/api/web-log') {
        return reply.code(503).send({ error: 'fixture_offline' });
      }
    });
    await app.register(webLogModule, { dir: logDir, policy: { level: async () => level }, apiRoutes });
    app.get('/api/settings/factory-debug', async () => ({ effective: level }));
    app.get('/api/fixture/items/:id', async (_request, reply) => reply.code(502)
      .send({ error: 'fixture_bad_gateway' }));
    await app.register(staticPlugin, { root: outDir, prefix: '/' });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: chromeBinary(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 900, height: 700 },
    });
    await context.addCookies([{ name: 'grigdesk_sid', value: 'fixture-session', url: address }]);
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__webLogFixture, { timeout: 15_000 });
    await page.waitForFunction(() => window.__webLogFixture.runtime.log.level() === 'off');
    assert.equal(await page.evaluate(() => window.__webLogFixture.runtime.mark('Выключено')), null);
    assert.equal((await entries()).length, 0, 'при off журнал ничего не собирает');

    level = 'verbose';
    await page.evaluate(() => window.__webLogFixture.runtime.refreshPolicy());
    await page.waitForFunction(() => window.__webLogFixture.runtime.log.level() === 'verbose');
    await page.evaluate(() => window.__webLogFixture.runtime.loadApiRoutes());

    // Ошибка обработчика Vue: запись с источником и компонентом, консоль её видит.
    await page.click('#explode');
    await waitEntry((entry) => entry.ev === 'vue.error' && entry.data.info === 'native-event'
      && entry.data.component === 'App');
    assert.ok(consoleErrors.some((text) => text.includes('synthetic_handler_failure')),
      'errorHandler журнала не должен глушить вывод ошибки Vue в консоль');

    // Ошибка действия store называет store и action.
    await page.evaluate(() => {
      try {
        window.__webLogFixture.storeFailure();
      } catch {
        /* ожидаемый сбой */
      }
    });
    await waitEntry((entry) => entry.ev === 'store.error' && entry.data.store === 'fixture'
      && entry.data.action === 'explode' && entry.data.error.name === 'TypeError');

    // Отказ API: шаблон из живого каталога сервера, без id и query, и без дубля в store.error.
    await page.evaluate(() => window.__webLogFixture.apiFailure());
    await waitEntry((entry) => entry.ev === 'api.fail' && entry.data.path === '/api/fixture/items/:id'
      && entry.data.status === 502);
    const afterApi = await entries();
    assert.equal(afterApi.some((entry) => entry.ev === 'store.error'
      && entry.data.action === 'loadItem'), false, 'отказ API не дублируется записью store.error');
    assert.doesNotMatch(JSON.stringify(afterApi), /private-42|token=secret/u);

    await page.evaluate(() => window.__webLogFixture.openLayer());
    await page.evaluate(() => window.__webLogFixture.closeLayer());
    await waitEntry((entry) => entry.ev === 'ui.layer' && entry.data.op === 'close'
      && entry.data.kind === 'dialog');

    await page.evaluate(() => window.__webLogFixture.navigate('/chats'));
    await waitEntry((entry) => entry.ev === 'router.nav' && entry.data.to === '/chats'
      && entry.data.result === 'success');
    await page.evaluate(() => window.__webLogFixture.navigate('/chats'));
    await waitEntry((entry) => entry.ev === 'router.nav' && entry.data.result === 'duplicated');

    // Отметка при недоступном приёмнике переживает F5 с тем же page/seq.
    online = false;
    const key = await page.evaluate(() => window.__webLogFixture.runtime.mark('Проверка fixture'));
    assert.ok(key);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__webLogFixture);
    const restored = await page.evaluate((wanted) => window.__webLogFixture.runtime.transport
      .snapshot().pending.some((entry) => entry.page === wanted.page && entry.seq === wanted.seq), key);
    assert.equal(restored, true, 'очередь сохранила исходный ключ после F5');
    online = true;
    await page.waitForFunction(() => window.__webLogFixture.runtime.transport
      .snapshot().pending.length === 0, { timeout: 30_000 });

    const day = new Date().toISOString().slice(0, 10);
    const cli = runCli(logDir, ['--day', day, '--page', key.page, '--json', '--dump']);
    assert.equal(cli.status, 0, cli.stderr);
    const rows = cli.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    const marks = rows.filter((row) => row.ev === 'mark' && row.seq === key.seq);
    assert.equal(marks.length, 1, 'reader объединил возможные повторы beacon/POST');
    assert.ok(rows.some((row) => row.contextOf?.seq === key.seq), 'CLI раскрыл плоский дамп');
    const text = runCli(logDir, ['--day', day, '--level', 'warn', '--dump']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /предыстория \(\d+\):/u);
    assert.match(text.stdout, /\/api\/fixture\/items\/:id/u);
    const file = await readFile(path.join(logDir, `${day}.ndjson`), 'utf8');
    assert.ok(file.includes('"ev":"mark"'));
    assert.doesNotMatch(file, /private-42|token=secret/u);

    const download = await fetch(`${address}/api/web-log/download?day=${day}`, {
      headers: { cookie: 'grigdesk_sid=fixture-session' },
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), file);

    // Сбой первого render до появления оболочки тоже записывается.
    await page.goto(`${address}?fail=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__webLogFixture);
    await waitEntry((entry) => entry.ev === 'vue.error' && entry.data.info === 'render'
      && entry.data.component === 'FixtureFailMount');

    process.stdout.write(`Браузерный журнал: OK; артефакты ${artifacts}\n`);
  } finally {
    if (page && !page.isClosed()) {
      await page.evaluate(() => window.__webLogFixture?.dispose()).catch(() => undefined);
    }
    await context?.close();
    await app?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`Браузерная проверка журнала не прошла: ${error.message}\n`);
  process.exitCode = 1;
});
