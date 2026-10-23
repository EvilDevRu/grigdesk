import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { buildRouteGraph } from '../../shared/pipeline/routeGraphView.ts';
import { clientBrowser } from './helpers/client-browser.mjs';

/**
 * Настоящий редактор работает с изолированным каталогом и контролируемыми записями.
 * PATCH меняет только копию фикстуры; реальные маршруты и публикации недоступны.
 */
async function fixture(t) {
  const draft = makeDraft();
  const hash = 'c'.repeat(64);
  const writes = [];

  draft.title = 'Основной каталог';
  draft.baseCatalogHash = hash;
  draft.routes.quick.route.nodes[0].label = 'Разработка';
  draft.routes.quick.route.nodes[1].label = 'Проверки';
  draft.routes.quick.route.nodes[3].label = 'Приёмка';

  const graph = buildRouteGraph(draft.routes.quick.route, 'quick', {
    workspaceMode: 'shared',
    outcomeLabels: 'all',
    nodeIds: true,
  });
  const responses = {
    '/api/profiles': { profiles: ['sample', 'design-system'] },
    '/api/routes/sample/revisions': {
      profile: 'sample',
      publishSupported: false,
      currentCatalogHash: hash,
      revisions: [{
        catalogHash: hash,
        createdAt: draft.updatedAt,
        isCurrent: true,
        integrity: 'ok',
        routes: { quick: hash },
      }],
    },
    '/api/routes/sample/editor': {
      profile: 'sample',
      source: { mode: 'editor', revision: 1 },
      currentCatalogHash: hash,
      capabilitiesHash: null,
      capabilities: {
        schema: 1,
        commands: [],
        contextSections: [],
        filesystem: [],
        timeoutClasses: [],
        retryStrategies: [],
      },
      issues: [],
    },
    '/api/routes/sample/drafts': { drafts: [{
      id: draft.id,
      profile: 'sample',
      title: draft.title,
      revision: 1,
      baseCatalogHash: hash,
      state: 'editing',
      updatedAt: draft.updatedAt,
    }] },
    [`/api/routes/sample/catalog/${hash}/graph`]: { graph },
  };
  const client = await clientBrowser(t, { responses });



  return {
    ...client,
    draft,
    writes,
  };
}

/**
 * Открывает выбранный режим напрямую, чтобы адрес и начальная узкая панель совпадали.
 * Подписка на ошибки проверяет настоящий Vue, включая ленивые дочерние компоненты.
 */
async function open(client, width, height, draftMode = true) {
  const touch = width < 500;
  const page = await client.browser.newPage({
    viewport: { width, height },
    isMobile: touch,
    hasTouch: touch,
  });
  const errors = [];

  const { draft, writes } = client;

  await page.route(`**/api/routes/sample/drafts/${draft.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();

      assert.equal(body.expectedRevision, draft.revision);
      writes.push(body);

      for (const operation of body.operations) {
        if (operation.kind === 'putRoute') {
          draft.routes[operation.routeId] = { route: operation.route, prompts: operation.prompts };
        }
      }

      draft.revision += 1;
    }

    await route.fulfill({ json: draft });
  });

  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${client.origin}#/routes?profile=sample${draftMode
    ? `&draft=${client.draft.id}&route=quick&node=build&tab=graph` : ''}`);
  await page.locator('[data-test="create-draft"]:enabled').waitFor({ state: 'attached' });

  return { page, errors };
}

/**
 * Внутренняя прокрутка SVG допустима; панели и поля не должны расширять рабочую область.
 * Видимые кнопки и заголовки измеряются после раскладки, а не по заявленным CSS-токенам.
 */
async function geometry(page) {
  return page.locator('.routes-page').evaluate((root) => {
    const visible = (node) => node.getBoundingClientRect().width > 0;
    const box = root.getBoundingClientRect();
    const panels = [...root.querySelectorAll('.panel-scroll, .list')].filter(visible);
    const rows = [...root.querySelectorAll('[data-context="workspace-catalog-row"]')].filter(visible);

    return {
      fits: root.scrollWidth <= root.clientWidth + 1 && box.right <= innerWidth + 1,
      panelsFit: panels.every((node) => node.scrollWidth <= node.clientWidth + 1),
      headers: [...root.querySelectorAll('.list > .ui-pane-header, .panel > .ui-pane-header')].filter(visible)
        .map((node) => node.getBoundingClientRect().height),
      rowsFit: rows.every((node) => node.scrollHeight <= node.clientHeight + 1),
    };
  });
}

test('маршруты: каталог, схема и инспектор помещаются на desktop и touch', async (t) => {
  const client = await fixture(t);

  for (const [width, height] of [[1440, 1000], [1280, 800], [1024, 768], [768, 1024],
    [390, 844], [320, 640]]) {
    const { page, errors } = await open(client, width, height);

    if (width < 1100) {
      await page.getByRole('tab', { name: 'Свойства', exact: true }).click();
    }

    await page.locator('[data-test="node-label"]').waitFor();

    const measured = await geometry(page);

    await page.screenshot({ path: `${client.artifacts}/routes-${width}-inspector.png` });
    assert.equal(measured.fits, true, `область ${width}`);
    assert.equal(measured.panelsFit, true, `панели ${width}`);
    assert.equal(measured.rowsFit, true, `строки ${width}`);

    if (width >= 1280) {
      assert.deepEqual(measured.headers, [36, 36]);
    } else {
      await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
      await page.screenshot({ path: `${client.artifacts}/routes-${width}-graph.png` });
      assert.equal((await geometry(page)).panelsFit, true, `схема ${width}`);
      await page.getByRole('tab', { name: 'Каталог', exact: true }).click();
      await page.screenshot({ path: `${client.artifacts}/routes-${width}-catalog.png` });
      assert.equal((await geometry(page)).fits, true, `каталог ${width}`);
    }

    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('маршруты: уплотнённая форма сохраняет правки и создаёт маршрут из секции каталога', async (t) => {
  const client = await fixture(t);
  const { page, errors } = await open(client, 1280, 800);

  await page.locator('[data-test="node-label"]').fill('Разработка и проверка');
  await page.locator('[data-test="node-save-label"]').click();
  await page.waitForResponse((response) => response.request().method() === 'PATCH');
  assert.equal(client.writes.length, 1);
  assert.equal(client.draft.routes.quick.route.nodes[0].label, 'Разработка и проверка');

  await page.locator('.route-catalog-properties > summary').click();
  await page.locator('.route-catalog__operation > summary').click();
  await page.locator('[data-test="route-new-id"]').fill('review');
  await page.locator('[data-test="route-new-title"]').fill('Проверка результата');
  await page.locator('[data-test="route-create"]').click();
  await page.waitForURL(/route=review/);
  await page.locator('.ui-pane-header h2').filter({ hasText: 'Проверка результата' }).waitFor();
  await page.screenshot({ path: `${client.artifacts}/routes-create.png` });
  assert.equal((await geometry(page)).panelsFit, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('маршруты: узкая навигация сохраняет ввод инспектора и опубликованный вид доступен', async (t) => {
  const client = await fixture(t);
  const { page, errors } = await open(client, 390, 844);

  await page.getByRole('tab', { name: 'Свойства', exact: true }).click();
  await page.locator('[data-test="node-label"]').fill('Незавершённая подпись');
  await page.getByRole('tab', { name: 'Каталог', exact: true }).click();
  await page.getByRole('tab', { name: 'Свойства', exact: true }).click();
  assert.equal(await page.locator('[data-test="node-label"]').inputValue(), 'Незавершённая подпись');
  assert.equal(await page.locator('[data-test="node-label"]').evaluate((node) =>
    node.getBoundingClientRect().height), 44);
  assert.deepEqual(errors, []);
  await page.close();

  const published = await open(client, 1280, 800, false);

  await published.page.locator('.published-canvas svg').waitFor();
  await published.page.screenshot({ path: `${client.artifacts}/routes-published.png` });
  assert.equal((await geometry(published.page)).panelsFit, true);
  assert.deepEqual(published.errors, []);
  await published.page.close();
});

test('маршруты: длинные названия и JSON помещаются в узкий док на desktop', async (t) => {
  const client = await fixture(t);

  client.draft.routes.quick.route.title = 'Проверка результата и подготовка документации '.repeat(4);
  client.draft.routes.quick.route.nodes[0].label = 'Разработка_с_очень_длинным_названием_этапа'.repeat(3);

  const { page, errors } = await open(client, 1280, 800);

  await page.locator('.routes-page').evaluate((root) => {
    root.style.width = '600px';
  });
  await page.getByRole('tab', { name: 'Свойства', exact: true }).click();
  await page.locator('[data-test="node-label"]').waitFor();
  await page.screenshot({ path: `${client.artifacts}/routes-narrow-dock.png` });
  assert.equal((await geometry(page)).panelsFit, true);
  await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
  await page.locator('[data-test="route-json-tab"]').click();
  await page.locator('.route-json-editor .monaco-editor').waitFor();
  assert.equal((await geometry(page)).panelsFit, true);
  await page.screenshot({ path: `${client.artifacts}/routes-json.png` });
  assert.deepEqual(errors, []);
  await page.close();
});
