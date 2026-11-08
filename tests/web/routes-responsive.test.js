import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAgentNode, makeDraft } from '../fixtures/routes-editor.mjs';
import { buildRouteGraph } from '../../shared/pipeline/routeGraphView.ts';
import { clientBrowser } from './helpers/client-browser.mjs';

/**
 * Настоящий редактор работает с изолированным каталогом и контролируемыми записями.
 * PATCH меняет только копию фикстуры; реальные маршруты и публикации недоступны.
 */
async function fixture(t, draft = makeDraft()) {
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
      assert.deepEqual(measured.headers, [40, 36]);
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

  for (const width of [390, 1000]) {
    const { page, errors } = await open(client, width, 844);
    const pending = {
      'node-label': 'Незавершённая подпись',
      'node-description': 'Несохранённое описание',
      'node-new-id': 'pending_build',
      'node-run-key': 'PENDING_BUILD',
    };

    await page.getByRole('tab', { name: 'Свойства', exact: true }).click();
    await page.getByText('Технические параметры', { exact: true }).click();

    for (const [field, value] of Object.entries(pending)) {
      await page.locator(`[data-test="${field}"]`).fill(value);
    }

    for (const name of ['Каталог', 'Маршрут', 'Свойства']) {
      await page.getByRole('tab', { name, exact: true }).click();
    }

    for (const [field, value] of Object.entries(pending)) {
      assert.equal(await page.locator(`[data-test="${field}"]`).inputValue(), value);
    }

    assert.equal(new URL(page.url()).hash.includes('node=build'), true);
    assert.equal(client.writes.length, 0, 'неприменённые поля не отправлены в PATCH');

    if (width === 390) {
      assert.equal(await page.locator('[data-test="node-label"]').evaluate((node) =>
        node.getBoundingClientRect().height), 44);
    }

    assert.deepEqual(errors, []);
    await page.close();
  }

  const published = await open(client, 1280, 800, false);

  await published.page.locator('.published-canvas svg').waitFor();
  await published.page.screenshot({ path: `${client.artifacts}/routes-published.png` });
  assert.equal((await geometry(published.page)).panelsFit, true);
  assert.deepEqual(published.errors, []);
  await published.page.close();
});

test('маршруты: схема начальной разведки не сжимается сеткой маршрута', async (t) => {
  const client = await fixture(t);
  const { page, errors } = await open(client, 1440, 900);

  await page.goto(`${client.origin}#/routes?profile=sample&draft=${client.draft.id}`
    + '&scope=bootstrap&node=scout&tab=graph');
  await page.locator('.route-bootstrap-editor .route-canvas__graph svg').waitFor();

  const measured = await page.locator('.route-bootstrap-editor .route-canvas__graph')
    .evaluate((node) => ({ height: node.clientHeight, content: node.scrollHeight }));

  assert.ok(measured.height >= 60, JSON.stringify(measured));
  assert.ok(measured.content <= measured.height + 1, JSON.stringify(measured));
  assert.deepEqual(errors, []);
  await page.close();
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

/**
 * Длинная машина имеет согласованные entry, sequence, переходы и файлы инструкций.
 * Общая фикстура остаётся прежней: большой граф используется только в G1.
 */
function longDraft() {
  const draft = makeDraft();
  const nodes = Array.from({ length: 36 }, (_, index) => makeAgentNode({
    id: index === 0 ? 'build' : `stage${String(index).padStart(2, '0')}`,
  }));

  for (const [index, node] of nodes.entries()) {
    node.label = `Этап ${index + 1}`;
    node.on.done = index + 1 < nodes.length ? { next: nodes[index + 1].id } : { stop: 'done' };
  }

  draft.routes.quick.route.nodes = nodes;
  draft.routes.quick.route.entry = nodes[0].id;
  draft.routes.quick.route.sequence = { main: nodes.map((node) => node.id), tail: [] };
  draft.routes.quick.prompts = Object.fromEntries(nodes.map((node) => [
    node.prompt.blocks[0].file, `Инструкция ${node.id}.\n`,
  ]));

  return draft;
}

/**
 * Снимает геометрию до действий Playwright, способных автоматически прокрутить страницу.
 * Видимость учитывает окно и внешний clip панели, а выбор — clip самого холста.
 */
async function workspaceGeometry(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.panel-scroll');
    const canvas = document.querySelector('.route-editor-workspace .route-canvas__graph');
    const field = document.querySelector('[data-test="node-label"]');
    const list = document.querySelector('.route-stage-list');
    const selected = canvas?.querySelector('.ng.selected');
    const bounds = (node) => {
      const { left, top, right, bottom, height } = node.getBoundingClientRect();

      return {
        left,
        top,
        right,
        bottom,
        height,
      };
    };
    const clip = bounds(panel);
    const visibleHeight = (box) => Math.max(0,
      Math.min(box.bottom, clip.bottom, innerHeight) - Math.max(box.top, clip.top, 0));
    const graph = bounds(canvas);
    const input = bounds(field);
    const stageList = bounds(list);
    const chosen = selected ? bounds(selected) : null;

    return {
      graph,
      input,
      graphVisible: visibleHeight(graph),
      inputVisible: visibleHeight(input),
      listVisible: visibleHeight(stageList),
      selected: selected?.getAttribute('data-node'),
      selectedVisible: chosen !== null && chosen.right > graph.left && chosen.left < graph.right
        && chosen.bottom > graph.top && chosen.top < graph.bottom,
      panelScroll: panel.scrollTop,
      documentScroll: document.scrollingElement.scrollTop,
    };
  });
}

/**
 * Поле и схема должны быть видны одновременно, до любой автоматической прокрутки.
 * Минимальные высоты защищают от формальной сетки с практически исчезнувшим графом.
 */
function assertWorkspaceVisible(measured, width) {
  assert.ok(measured.graphVisible > 0, `схема видна при ${width}: ${JSON.stringify(measured)}`);
  assert.ok(measured.inputVisible >= measured.input.height - 1,
    `поле целиком видно при ${width}: ${JSON.stringify(measured)}`);
  assert.ok(measured.graph.right <= measured.input.left,
    `схема и поле в соседних колонках при ${width}`);
  assert.ok(Math.min(measured.graph.bottom, measured.input.bottom)
    > Math.max(measured.graph.top, measured.input.top), 'схема и поле пересекаются по вертикали');
  assert.ok(measured.graph.height >= (width === 1280 ? 150 : 200), 'высота схемы не ужата');
  assert.ok(measured.listVisible >= 90, 'у списка этапов есть видимая область');
}

function assertExternalScroll(before, after) {
  assert.ok(Math.abs(after.panelScroll - before.panelScroll) <= 1, 'внешняя панель не прокрутилась');
  assert.ok(Math.abs(after.documentScroll - before.documentScroll) <= 1, 'документ не прокрутился');
}

for (const [width, height] of [[1440, 900], [1280, 800]]) {
  test(`RE93027-G1: длинный маршрут сохраняет схему рядом с полями при выборе этапа (${width})`,
    async (t) => {
      const client = await fixture(t, longDraft());
      const { page, errors } = await open(client, width, height);

      await page.locator('.route-canvas__graph svg').waitFor();
      await page.locator('[data-test="node-label"]').waitFor({ state: 'attached' });

      const before = await workspaceGeometry(page);

      assertWorkspaceVisible(before, width);

      const visibleNode = await page.locator('.route-canvas__graph').evaluate((viewport) => {
        const clip = viewport.getBoundingClientRect();
        const candidates = [...viewport.querySelectorAll('.ng.clickable:not(.selected)')];
        const node = candidates.find((item) => {
          const box = item.getBoundingClientRect();

          return box.left >= clip.left && box.right <= clip.right
            && box.top >= clip.top && box.bottom <= clip.bottom;
        });

        return node?.getAttribute('data-node');
      });

      assert.ok(visibleNode, 'есть другой видимый этап для настоящего клика по схеме');
      await page.locator(`.route-canvas__graph [data-node="${visibleNode}"]`).click();
      await page.waitForURL(new RegExp(`node=${visibleNode}`));

      const afterCanvas = await workspaceGeometry(page);

      assertWorkspaceVisible(afterCanvas, width);
      assertExternalScroll(before, afterCanvas);
      assert.equal(afterCanvas.selected, visibleNode);
      assert.equal(afterCanvas.selectedVisible, true);

      const last = page.locator('[data-test="stage-select-stage35"]');

      await last.evaluate((button) => {
        let container = button.parentElement;

        while (container && !container.classList.contains('panel-scroll')) {
          const style = getComputedStyle(container);

          if (/(auto|scroll)/.test(style.overflowY) && container.scrollHeight > container.clientHeight) {
            container.scrollTop = container.scrollHeight;
          }

          container = container.parentElement;
        }
      });
      await last.click();
      await page.waitForURL(/node=stage35/);
      await page.waitForFunction(() => document.querySelector('.route-canvas .ng.selected')
        ?.getAttribute('data-node') === 'stage35');

      const afterList = await workspaceGeometry(page);

      assertWorkspaceVisible(afterList, width);
      assertExternalScroll(before, afterList);
      assert.equal(afterList.selected, 'stage35');
      assert.equal(afterList.selectedVisible, true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${client.artifacts}/routes-g1-${width}.png` });
      await page.close();
    });
}

for (const [width, height] of [[1440, 900], [1280, 800], [390, 844]]) {
  test(`RE93027-I2: инструкция правится рядом со схемой (${width})`, async (t) => {
    const client = await fixture(t);
    const { page, errors } = await open(client, width, height);
    const node = client.draft.routes.quick.route.nodes[0];
    const file = node.prompt.blocks[0].file;
    const neighbor = node.prompt.blocks[1].file;
    const previous = client.draft.routes.quick.prompts[file];
    const neighborText = client.draft.routes.quick.prompts[neighbor];

    if (width === 390) {
      await page.getByRole('tab', { name: 'Свойства', exact: true }).click();
    }

    await page.locator('[data-test="node-label"]').fill('Неприменённое название');

    if (width !== 390) {
      await page.locator('[data-test="zoom-in"]').click();
    }

    const scale = await page.locator('.route-canvas svg.graph').getAttribute('style');
    const instruction = page.locator('.route-editor-inspectors')
      .getByRole('tab', { name: 'Инструкция', exact: true });

    assert.equal(await instruction.count(), 1, 'в панели этапа нужна вкладка «Инструкция»');
    await instruction.click();
    await page.locator('.route-editor-inspectors .route-prompt-editor .monaco-editor').waitFor();
    assert.ok(page.url().includes('tab=prompt'));
    assert.ok(page.url().includes('node=build'));

    if (width !== 390) {
      const graph = await page.locator('.route-canvas__graph').boundingBox();
      const prompt = await page.locator('.route-editor-inspectors .monaco-editor').boundingBox();

      assert.ok(graph && prompt && graph.y < height && graph.y + graph.height > 0);
      assert.ok(graph.x + graph.width <= prompt.x, 'инструкция рядом со схемой');
      assert.ok(Math.min(graph.y + graph.height, prompt.y + prompt.height)
        > Math.max(graph.y, prompt.y), 'инструкция и схема пересекаются по вертикали');
      assert.equal(await page.locator('.route-canvas svg.graph').getAttribute('style'), scale);
      assert.equal(await page.locator('.route-canvas .ng.selected').getAttribute('data-node'), 'build');
    }

    const editor = page.locator('.route-prompt-editor .monaco-editor .view-lines');
    const response = page.waitForResponse((item) => item.request().method() === 'PATCH');

    // Клик по тексту передаёт фокус рабочему вводу Monaco при включённом EditContext.
    // Служебный textarea предназначен для IME и не меняет модель обычным insertText.
    await editor.click({ position: { x: 80, y: 12 } });
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Дополнение к инструкции.\n');
    await response;
    assert.equal(client.writes.length, 1);
    assert.deepEqual(client.writes[0].operations.map((operation) => operation.routeId), ['quick']);
    assert.equal(client.draft.routes.quick.prompts[file], `${previous}Дополнение к инструкции.\n`);
    assert.equal(client.draft.routes.quick.prompts[neighbor], neighborText);

    if (width === 390) {
      for (const name of ['Каталог', 'Маршрут', 'Свойства']) {
        await page.getByRole('tab', { name, exact: true }).click();
      }
    }

    await page.getByRole('tab', { name: 'Свойства и переходы', exact: true }).click();
    assert.equal(await page.locator('[data-test="node-label"]').inputValue(), 'Неприменённое название');
    assert.ok(page.url().includes('node=build'));
    assert.equal(client.draft.routes.quick.route.nodes[0].label, 'Разработка', 'ввод ещё не применён');

    if (width === 390) {
      await page.goto(`${client.origin}#/routes?profile=sample&draft=${client.draft.id}`
        + '&route=quick&node=build&tab=prompt');
      await page.locator('.route-editor-inspectors .route-prompt-editor .monaco-editor').waitFor();
      assert.equal(await page.locator('.routes-page').getAttribute('data-pane'), 'inspector',
        'прямой tab=prompt открывает область свойств');
    }

    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${client.artifacts}/routes-i2-${width}.png` });
    await page.close();
  });
}
