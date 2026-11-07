#!/usr/bin/env node
// Изолированная приёмка настоящего RoutesView, API и SVG в Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createServer } from '../node_modules/vite/dist/node/index.js';
import vue from '../node_modules/@vitejs/plugin-vue/dist/index.mjs';
import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { makeCatalogInput, makeDraft } from '../../tests/fixtures/routes-editor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'web');
const fixture = path.join(root, 'tests/web/fixtures/routes-editor-browser');
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const { chromium } = requireFromServer('playwright-core');

function chromeBinary() {
  for (const candidate of [process.env.CHROME_BIN, '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome/Chromium не найден; задайте CHROME_BIN.');
}

async function publishLegacy(store) {
  const content = makeCatalogInput();
  const routes = {};
  for (const [id, value] of Object.entries(content.routes)) {
    routes[id] = (await store.publishRoute('sample', id, value)).routeHash;
  }
  return store.publishCatalog('sample', {
    catalog: { schema: 2, profile: 'sample', routes,
      bootstrap: { file: 'bootstrap/scout.json' } },
    bootstrap: content.bootstrap, prompts: content.bootstrapPrompts,
  }, { expectedCatalogHash: null });
}

async function pressButton(locator) {
  await locator.focus();
  await locator.press('Enter');
}

function largeDraft(currentHash) {
  const draft = makeDraft();
  draft.baseCatalogHash = currentHash;
  draft.baseSourceRevision = 1;
  const largeRoute = draft.routes.quick.route;
  const build = largeRoute.nodes.find((node) => node.id === 'build');
  for (let index = 1; index <= 96; index += 1) {
    const id = `status_${String(index).padStart(3, '0')}`;
    largeRoute.nodes.push({ id, executor: 'status', phase: 'main',
      key: `STATUS_${String(index).padStart(3, '0')}`, owner: 'build' });
    build.emits.push(id);
  }
  for (let index = 2; index <= 50; index += 1) {
    const id = `route_${String(index).padStart(2, '0')}`;
    const copy = structuredClone(draft.routes.quick);
    copy.route.id = id;
    copy.route.title = `Маршрут ${index}`;
    copy.route.nodes = copy.route.nodes.slice(0, 4);
    copy.route.nodes[0].emits = [];
    draft.routes[id] = copy;
  }
  return draft;
}

/**
 * Каждый прогон получает свой каталог в папке артефактов: стенд, снимки и report.json
 * остаются для разбора, а профиль Chromium удаляется в finally при любом исходе.
 */
async function main() {
  const parent = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'routes-editor');

  await mkdir(parent, { recursive: true });

  const artifacts = await mkdtemp(path.join(parent, 'browser-'));
  const profilesDir = path.join(artifacts, 'profiles');
  const routesDir = path.join(artifacts, 'routes');
  const authoringDir = path.join(artifacts, 'authoring');
  const profile = path.join(artifacts, 'chromium-profile');
  await mkdir(path.join(profilesDir, 'sample', 'routes'), { recursive: true });
  await writeFile(path.join(profilesDir, 'sample', 'graph.json'), '{}');
  await writeFile(path.join(profilesDir, 'sample', 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [{ id: 'project-check',
      label: 'Проверка', filesystem: ['state-only'] }], contextSections: [] }));
  const store = new RoutesStore({ baseDir: routesDir });
  await publishLegacy(store);
  await store.switchEditorSource('sample', { mode: 'editor',
    expectedSourceRevision: 0,
    expectedCatalogHash: (await store.readCurrent('sample')).catalogHash });
  const app = Fastify({ logger: false });
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write('event: hello\ndata: {"boot":"routes-fixture"}\n\n');
    request.raw.on('close', () => reply.raw.end());
  });
  await app.register(routesModule, { config: { routesDir,
    routesAuthoringDir: authoringDir, profilesDir },
  prefs: { read: () => ({ projects: { sample: {} } }),
    write: () => { throw new Error('fixture не меняет настройки'); } } });
  let vite;
  let context;
  const report = { machine: { platform: process.platform,
    arch: process.arch, node: process.version, chrome: chromeBinary() },
  fixture: { profiles: 1, routes: 50, nodesInOpenMachine: 100 },
  viewport: [], measurements: {}, checks: [], browserErrors: [] };
  try {
    const apiAddress = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ root: fixture, configFile: false, plugins: [vue()],
      resolve: { alias: {
        vue: path.join(web, 'node_modules/vue'),
        pinia: path.join(web, 'node_modules/pinia'),
        'vue-router': path.join(web, 'node_modules/vue-router'),
      } },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root] },
        proxy: { '/api': apiAddress } },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: chromeBinary(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.browserErrors.push(error.message));
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`${base}/#/routes?profile=sample`, { waitUntil: 'domcontentloaded' });
    const create = page.getByRole('button', { name: 'Создать черновик из current' });
    await create.waitFor({ timeout: 20_000 });
    // Кнопка доступна после начальной загрузки: раньше она закрыла бы новый черновик.
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
      button.textContent.includes('Создать черновик из current') && !button.disabled),
    undefined, { timeout: 20_000 });
    report.measurements.initialMonacoRequests = requests.filter((url) =>
      url.toLowerCase().includes('monaco')).length;
    assert.equal(report.measurements.initialMonacoRequests, 0,
      'Monaco загружается только при открытии инструкции или JSON');
    await pressButton(create);
    await page.waitForURL(/draft=/, { timeout: 15_000 }).catch(async (error) => {
      console.error('H4 create draft state', JSON.stringify({
        browserErrors: report.browserErrors,
        url: page.url(),
        store: await page.evaluate(() => {
          const store = window.__routesEditorFixture.store;

          return {
            opened: store.opened,
            error: store.error,
            dirty: store.dirty,
            saving: store.saving,
            dialog: document.querySelector('[role="dialog"]')?.textContent ?? null,
          };
        }),
      }));
      throw error;
    });
    await page.locator('[data-test="node-label"]').waitFor();
    const label = page.locator('[data-test="node-label"]');
    await label.focus();
    await label.press('ControlOrMeta+A');
    await page.keyboard.type('Проверено браузером');
    await pressButton(page.locator('[data-test="node-save-label"]'));
    await page.keyboard.press('ControlOrMeta+s');
    await page.getByText('Сохранено', { exact: true }).waitFor({ timeout: 15_000 });
    report.checks.push('RE-H4-01: клавиатурой создан и сохранён черновик');

    for (let opened = 0; opened < 2; opened += 1) {
      await pressButton(page.getByRole('button', { name: 'Инструкция' }).first());
      await page.waitForFunction(async () =>
        (await window.__routesEditorFixture.monacoModels()) === 1,
      undefined, { timeout: 15_000 });
      await page.evaluate(() => window.__routesEditorFixture.router.push({
        path: '/routes', query: { ...window.__routesEditorFixture.router.currentRoute.value.query,
          tab: 'graph' },
      }));
      await page.waitForFunction(async () =>
        (await window.__routesEditorFixture.monacoModels()) === 0,
      undefined, { timeout: 15_000 });
    }
    report.checks.push('RE-H4-05: Monaco ленивый, модели освобождаются после двух открытий');

    // Холст — та же схема, что у конвейера: натуральный масштаб, где текст читается,
    // масштаб кнопками и выбор узла клавиатурой.
    const svg = page.locator('.route-canvas svg.graph');
    const svgWidth = () => svg.evaluate((element) => element.getBoundingClientRect().width);
    const naturalWidth = await svgWidth();
    const canvasLabel = page.locator('.route-canvas [data-node="build"] .nlbl');
    report.measurements.canvasLabelPx = await canvasLabel.evaluate((element) =>
      Math.round(element.getBoundingClientRect().height * 10) / 10);
    assert.ok(report.measurements.canvasLabelPx >= 12, 'подпись узла читается без увеличения');
    await pressButton(page.locator('[data-test="zoom-in"]'));
    assert.ok(await svgWidth() > naturalWidth, 'zoom меняет реальный размер схемы');
    await pressButton(page.locator('[data-test="zoom-reset"]'));
    assert.equal(await svgWidth(), naturalWidth, '100% возвращает натуральный размер');
    await pressButton(page.locator('[data-test="fit-all"]'));
    const node = page.locator('.route-canvas [data-node="build"]');
    await pressButton(node);
    await page.waitForFunction(() => window.__routesEditorFixture.router.currentRoute.value.query.node
      === 'build');
    assert.equal(await node.getAttribute('aria-current'), 'true', 'выбранный узел отмечен');
    report.checks.push('RE-H4-03: масштаб, выбор узла и читаемый текст схемы в Chromium');

    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => { window.__routesEditorFixture.store.dirty = true; });
      const boxes = await page.evaluate(() => {
        const names = ['.routes-page', '.list', '.panel', '.route-editor-workspace__sidebar',
          '.route-editor-actions', '.route-editor-header button'];
        return Object.fromEntries(names.map((name) => {
          const box = document.querySelector(name)?.getBoundingClientRect();
          return [name, box ? { x: box.x, right: box.right, width: box.width } : null];
        }));
      });
      const saveLabel = await page.evaluate(() => {
        const button = document.querySelector('.route-editor-header button');
        const style = getComputedStyle(button);
        const context = document.createElement('canvas').getContext('2d');
        context.font = style.font;
        const required = context.measureText(button.textContent.trim()).width
          + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        return { available: button.clientWidth, required };
      });
      for (const [name, box] of Object.entries(boxes)) {
        assert.ok(box && box.width > 0 && box.x >= -1 && box.right <= width + 1,
          `${name} выходит за экран ${width}: ${JSON.stringify(box)}`);
      }
      assert.ok(saveLabel.available + 1 >= saveLabel.required,
        `подпись кнопки сохранения обрезана на ${width}px: ${JSON.stringify(saveLabel)}`);
      report.viewport.push({ width, boxes, saveLabel });
      await page.screenshot({ path: path.join(artifacts, `viewport-${width}.png`) });
      await page.evaluate(() => { window.__routesEditorFixture.store.dirty = false; });
    }
    report.checks.push('RE-H4-02: список, inspector и действия на 390/768/1440 px');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => {
      const store = window.__routesEditorFixture.store;
      return !store.dirty && !store.saving;
    }, undefined, { timeout: 15_000 });
    await pressButton(page.getByRole('button', { name: 'Проверить черновик' }));
    await page.waitForFunction(() => window.__routesEditorFixture.store.canPublish,
      undefined, { timeout: 15_000 }).catch(async (error) => {
      console.error('H4 validation state', JSON.stringify(await page.evaluate(() => {
        const store = window.__routesEditorFixture.store;
        return { error: store.error, saveError: store.saveError,
          validationIssues: store.validationIssues, validatedRevision: store.validatedRevision,
          validatedGeneration: store.validatedGeneration, editGeneration: store.editGeneration,
          serverRevision: store.serverSnapshot?.revision,
          capabilitiesHash: store.editorInfo?.capabilitiesHash,
          validatedCapabilitiesHash: store.validatedCapabilitiesHash,
          dirty: store.dirty, saving: store.saving, canPublish: store.canPublish };
      })));
      throw error;
    });
    await page.getByRole('button', { name: 'Сравнить с current' }).waitFor();
    await pressButton(page.getByRole('button', { name: 'Сравнить с current' }));
    await page.locator('[data-test="open-publish"]').waitFor();
    await pressButton(page.locator('[data-test="open-publish"]'));
    const dialog = page.getByRole('dialog', { name: 'Подтверждение публикации маршрутов' });
    await dialog.waitFor();
    assert.equal(await dialog.evaluate((element) => document.activeElement === element), true);
    await pressButton(dialog.locator('[data-test="confirm-publish"]'));
    await dialog.waitFor({ state: 'detached', timeout: 20_000 });
    const published = await store.readCurrent('sample');
    assert.ok(published);
    report.checks.push('RE-H4-01: проверка, compare и публикация клавиатурой');

    const draftValue = largeDraft(published.catalogHash);
    const drafts = new DraftStore({ baseDir: authoringDir, routesStore: store });
    const heavy = await drafts.create('sample', { title: 'Нагрузочный черновик',
      baseCatalogHash: published.catalogHash, baseSourceRevision: 1,
      document: { routes: draftValue.routes, bootstrap: draftValue.bootstrap,
        bootstrapPrompts: draftValue.bootstrapPrompts,
        presentation: draftValue.presentation, provenance: draftValue.provenance } });
    await page.goto(`${base}/#/routes?profile=sample&draft=${heavy.id}&route=quick`,
      { waitUntil: 'domcontentloaded' });
    await page.locator('[data-test="stage-select-status_096"]').waitFor({ timeout: 20_000 });
    await page.waitForFunction((id) => window.__routesEditorFixture.store.opened?.draftId === id
      && document.querySelector('.route-canvas'), heavy.id);
    report.measurements.selectMs = await page.evaluate(async () => {
      const button = document.querySelector('[data-test="stage-select-status_096"]');
      const start = performance.now();
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Math.round((performance.now() - start) * 10) / 10;
    });
    await page.waitForFunction(() => window.__routesEditorFixture.router.currentRoute.value.query.node
      === 'status_096', undefined, { timeout: 5_000 }).catch(async (error) => {
      console.error('H4 selection state', JSON.stringify(await page.evaluate(() => ({
        query: window.__routesEditorFixture.router.currentRoute.value.query,
        opened: window.__routesEditorFixture.store.opened,
        dirty: window.__routesEditorFixture.store.dirty,
        stageDisabled: document.querySelector('[data-test="stage-select-status_096"]')?.disabled,
      }))));
      throw error;
    });

    let releaseSave;
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    let savePending = false;
    const saveUrl = `**/api/routes/sample/drafts/${heavy.id}`;
    await page.route(saveUrl, async (route) => {
      if (route.request().method() === 'PATCH') {
        savePending = true;
        await saveGate;
      }
      await route.continue();
    });
    await pressButton(page.locator('[data-test="stage-select-build"]'));
    await page.waitForFunction(() => window.__routesEditorFixture.router.currentRoute.value.query.node
      === 'build');
    const heavyLabel = page.locator('[data-test="node-label"]');
    await heavyLabel.focus({ timeout: 5_000 }).catch(async (error) => {
      console.error('H4 heavy editor state', JSON.stringify(await page.evaluate(() => ({
        query: window.__routesEditorFixture.router.currentRoute.value.query,
        opened: window.__routesEditorFixture.store.opened,
        error: window.__routesEditorFixture.store.error,
        text: document.body.innerText.slice(0, 2500),
      }))));
      throw error;
    });
    await heavyLabel.press('ControlOrMeta+A');
    await page.keyboard.type('Нагрузочный узел');
    await pressButton(page.locator('[data-test="node-save-label"]'));
    const savingRequest = page.waitForRequest((request) => request.url().endsWith(
      `/api/routes/sample/drafts/${heavy.id}`) && request.method() === 'PATCH');
    await pressButton(page.locator('.route-editor-header button'));
    await savingRequest;
    const search = page.locator('[data-test="search-nodes"]');
    const saveInputStart = Date.now();
    await search.focus();
    await page.keyboard.type('build');
    report.measurements.inputDuringSaveMs = Date.now() - saveInputStart;
    assert.equal(await search.inputValue(), 'build');
    assert.equal(savePending, true, 'ввод доступен до ответа PATCH');
    releaseSave();
    await page.waitForFunction(() => !window.__routesEditorFixture.store.saving
      && !window.__routesEditorFixture.store.dirty,
    undefined, { timeout: 15_000 });
    await page.unroute(saveUrl);

    let releaseValidation;
    const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
    let validationPending = false;
    const validationUrl = `**/api/routes/sample/drafts/${heavy.id}/validate`;
    await page.route(validationUrl, async (route) => {
      validationPending = true;
      await validationGate;
      await route.continue();
    });
    const validatingResponse = page.waitForResponse((response) => response.url().endsWith(
      `/api/routes/sample/drafts/${heavy.id}/validate`));
    const validatingRequest = page.waitForRequest((request) => request.url().endsWith(
      `/api/routes/sample/drafts/${heavy.id}/validate`));
    await pressButton(page.getByRole('button', { name: 'Проверить черновик' }));
    await validatingRequest;
    const validateInputStart = Date.now();
    await search.focus();
    await search.press('ControlOrMeta+A');
    await page.keyboard.type('check');
    report.measurements.inputDuringValidateMs = Date.now() - validateInputStart;
    assert.equal(await search.inputValue(), 'check');
    assert.equal(validationPending, true, 'ввод доступен до ответа validate');
    releaseValidation();
    await validatingResponse;
    await page.unroute(validationUrl);
    report.measurements.eventSources = await page.evaluate(() =>
      window.__routesEditorFixture.sources);
    assert.ok(report.measurements.eventSources.peak <= 1,
      'одна вкладка открывает максимум один EventSource');
    report.checks.push('RE-H4-04/05: нагрузочная fixture, ввод во время API, общий SSE');
    assert.deepEqual(report.browserErrors, [], 'Vue не выдаёт ошибки в браузере');
    console.log(JSON.stringify({ artifact: artifacts, ...report }, null, 2));
  } finally {
    await context?.close();
    await vite?.close();
    await app.close();
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
