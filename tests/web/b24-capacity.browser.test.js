import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { B24Adapter } from '../../server/src/adapters/b24.ts';
import { TaskFavoritesService } from '../../server/src/lib/taskFavoritesService.ts';
import b24Module from '../../server/src/modules/b24/index.ts';
import favoritesModule from '../../server/src/modules/task-favorites/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');
const { chromium } = require('playwright-core');
const { build } = require('esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Синтетический портал держит ответы до cleanup, независимо от настоящего Б24.
 * Проверка доступности остальных API выполняется, пока барьер остаётся закрытым.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('BROWSER-01: медленный портал, SSE и shell не запирают обычный API и метки', {
  timeout: 15000,
}, async (t) => {
  const portal = deferred();
  const shell = deferred();
  const firstPortal = deferred();
  const shellStarted = deferred();
  let browser;
  let portalStarts = 0;
  const app = Fastify({ logger: false });
  const adapter = new B24Adapter({
    credsStore: { read: () => null },
    cookiePath: '/tmp/unused-b24-browser-cookie',
    readTimeoutMs: 65_000,
  });
  const client = {
    baseUrl: 'https://portal.example.test',
    discoverUserId: async () => 77,
    taskDetails: () => portal.promise,
    findUsers: () => portal.promise,
    listGroups: () => portal.promise,
  };

  adapter.client = () => client;
  adapter._getDashboard = () => portal.promise;

  t.after(async () => {
    portal.resolve({ tasks: [] });
    shell.resolve({ rev: 1 });
    await browser?.close();
    app.server.closeAllConnections();
    await app.close();
  });
  await adapter.accountIdentity();

  const favorites = new TaskFavoritesService({
    b24: adapter,
    store: { list: async () => ({ revision: 1, taskIds: [] }) },
  });

  app.addHook('onRequest', async (request) => {
    if (['/api/b24/dashboard', '/api/b24/task/42', '/api/b24/users', '/api/b24/groups']
      .includes(request.url)) {
      portalStarts += 1;
      firstPortal.resolve();
    }
  });
  app.register(b24Module, { b24: adapter });
  app.register(favoritesModule, { favorites });
  app.get('/api/providers', async () => ({ ok: true }));
  app.get('/__shell/state', async () => {
    shellStarted.resolve();

    return shell.promise;
  });
  app.get('/api/events', (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
    reply.raw.write('event: hello\ndata: {}\n\n');
  });

  const bundle = await build({
    stdin: {
      contents: 'import { api } from "./web/src/shared/apiClient.ts"; window.fixtureApi = api;',
      resolveDir: root,
      sourcefile: 'b24-capacity-fixture.ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent',
  });

  app.get('/', async (_request, reply) => reply.type('text/html').send(
    '<!doctype html><title>Fixture</title><script src="/fixture.js"></script>',
  ));
  app.get('/fixture.js', async (_request, reply) => reply.type('text/javascript')
    .send(bundle.outputFiles[0].text));

  const origin = await app.listen({ host: '127.0.0.1', port: 0 });

  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage({ viewport: { width: 392, height: 839 }, isMobile: true });

  await page.goto(origin);
  await page.evaluate(() => {
    window.events = new EventSource('/api/events');
    void fetch('/__shell/state');
  });
  await shellStarted.promise;
  await page.waitForFunction(() => window.events.readyState === EventSource.OPEN);
  await page.evaluate(() => {
    window.results = {};

    for (const path of ['/api/b24/dashboard', '/api/b24/task/42', '/api/b24/users', '/api/b24/groups']) {
      void window.fixtureApi.get(path, { timeoutMs: 0, retry: false }).catch(() => undefined);
    }
  });
  await firstPortal.promise;
  await page.evaluate(() => {
    void window.fixtureApi.get('/api/providers').then(() => {
      window.results.providers = true;
    });
    void window.fixtureApi.get('/api/b24/task-favorites').then(() => {
      window.results.favorites = true;
    });
  });
  await page.waitForFunction(() => window.results.providers && window.results.favorites,
    null, { timeout: 3000 });
  assert.equal(portalStarts, 1);
});
